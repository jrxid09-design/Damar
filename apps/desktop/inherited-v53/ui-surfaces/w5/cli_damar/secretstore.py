"""OS-protected secret storage for provider credentials.

This protects provider API keys *at rest*. It is **not** Damar owner authority:
it never decides what the agent may do, it only keeps credentials out of the
plaintext config file.

Windows uses a narrowly scoped DPAPI-backed local store: each secret is sealed
with CryptProtectData under the current user and written to
``~/.damar/secrets/<name>.bin``. Only the same Windows user can unseal it.

Outside Windows, or if the OS primitive is unavailable, the store reports
``available == False`` and the caller is expected to fall back to environment
variables (ENV_ONLY) - never to plaintext config.

Also hosts the process-local secret registry used to redact credentials from
logs, session files, exports and diagnostics.
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import os
import re
from ctypes import wintypes
from pathlib import Path
from typing import Any, Optional

REF_PREFIX = "damar:"
_REDACTED = "[redacted]"

# --- process-local secret registry (redaction) -----------------------------

_KNOWN_SECRETS: set[str] = set()


def register_secret(value: Optional[str]) -> None:
    """Remember a live credential value so it can be scrubbed from output."""
    if value:
        text = str(value).strip()
        if len(text) >= 8:
            _KNOWN_SECRETS.add(text)


def known_secrets() -> set[str]:
    return set(_KNOWN_SECRETS)


def redact(text: str) -> str:
    """Replace any registered credential value in ``text`` with [redacted]."""
    if not text or not _KNOWN_SECRETS:
        return text
    out = str(text)
    # Longest first so a value that contains another is fully covered.
    for secret in sorted(_KNOWN_SECRETS, key=len, reverse=True):
        if secret in out:
            out = out.replace(secret, _REDACTED)
    return out


def redact_obj(value: Any) -> Any:
    """Recursively redact strings inside dicts/lists/tuples."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {key: redact_obj(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_obj(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_obj(item) for item in value)
    return value


# --- secret reference helpers ---------------------------------------------

def make_ref(name: str) -> str:
    return REF_PREFIX + str(name)


def parse_ref(ref: Optional[str]) -> Optional[str]:
    if isinstance(ref, str) and ref.startswith(REF_PREFIX) and len(ref) > len(REF_PREFIX):
        return ref[len(REF_PREFIX):]
    return None


def _safe_name(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]", "_", str(name))
    if len(slug) > 96:
        slug = slug[:80] + "-" + hashlib.sha256(str(name).encode("utf-8")).hexdigest()[:12]
    return slug or "default"


# --- Windows DPAPI ---------------------------------------------------------

class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi_available() -> bool:
    if os.name != "nt":
        return False
    try:
        ctypes.windll.crypt32  # type: ignore[attr-defined]
        return True
    except (AttributeError, OSError):
        return False


def _to_blob(data: bytes) -> _DataBlob:
    buffer = ctypes.create_string_buffer(data, len(data))
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))


def _from_blob(blob: _DataBlob) -> bytes:
    try:
        return ctypes.string_at(blob.pbData, blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob.pbData)


def _protect(data: bytes) -> bytes:
    blob_in = _to_blob(data)
    blob_out = _DataBlob()
    flags = 0x1  # CRYPTPROTECT_UI_FORBIDDEN
    if not ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(blob_in), None, None, None, None, flags, ctypes.byref(blob_out)):
        raise OSError("CryptProtectData failed")
    return _from_blob(blob_out)


def _unprotect(data: bytes) -> bytes:
    blob_in = _to_blob(data)
    blob_out = _DataBlob()
    flags = 0x1
    if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None, flags, ctypes.byref(blob_out)):
        raise OSError("CryptUnprotectData failed")
    return _from_blob(blob_out)


# --- store -----------------------------------------------------------------

class SecretStore:
    """DPAPI-backed per-user credential store. ``available`` gates usage."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    @property
    def available(self) -> bool:
        return _dpapi_available()

    def _path(self, name: str) -> Path:
        return self.root / (_safe_name(name) + ".bin")

    def set(self, name: str, value: str) -> bool:
        if not self.available:
            return False
        try:
            sealed = _protect(str(value).encode("utf-8"))
            self.root.mkdir(parents=True, exist_ok=True)
            path = self._path(name)
            temp = path.with_name(path.name + ".tmp")
            temp.write_bytes(base64.b64encode(sealed))
            os.replace(temp, path)
            return True
        except (OSError, ValueError):
            return False

    def get(self, name: str) -> Optional[str]:
        if not self.available:
            return None
        path = self._path(name)
        try:
            sealed = base64.b64decode(path.read_bytes())
            return _unprotect(sealed).decode("utf-8")
        except (OSError, ValueError, UnicodeDecodeError):
            return None

    def exists(self, name: str) -> bool:
        return self._path(name).exists()

    def delete(self, name: str) -> bool:
        try:
            self._path(name).unlink()
            return True
        except OSError:
            return False


def default_store() -> SecretStore:
    """Store rooted beside the config, honouring DAMAR_HOME."""
    root = os.environ.get("DAMAR_HOME") or os.path.join(str(Path.home()), ".damar")
    return SecretStore(Path(root) / "secrets")
