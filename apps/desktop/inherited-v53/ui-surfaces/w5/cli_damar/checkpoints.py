"""Per-session file checkpoints: snapshot a file before DAMAR mutates it so
/rewind, /undo and /redo can move the workspace back and forward truthfully.

Layout: ~/.damar/checkpoints/<session-id>/index.jsonl - one JSON line per
*currently applied* mutation, holding the before state and (once committed) the
after state, both base64, plus hashes so a redo can be proven.

Design rules:
  * fail-closed: if the before-snapshot cannot be taken, the caller must refuse
    the mutation rather than continue with silently non-reversible state.
  * bounded: oversized files and an over-quota session are rejected.
  * path-safe: a restore only ever touches a canonical path inside the bound
    workspace; traversal, symlink escape, workspace mismatch and malformed
    records are refused.
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Optional

MAX_SNAPSHOT_BYTES = 1_048_576          # 1 MiB per file snapshot
SESSION_QUOTA_BYTES = 32 * 1_048_576    # 32 MiB of journal per session


class CheckpointError(RuntimeError):
    """Raised when a snapshot cannot be taken or a record fails validation."""


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Checkpoints:
    def __init__(self, root: Path, session_id: str, workspace: Optional[Path] = None,
                 max_file_bytes: int = MAX_SNAPSHOT_BYTES,
                 quota_bytes: int = SESSION_QUOTA_BYTES) -> None:
        self.root = Path(root)
        self.session_id = session_id
        self.workspace = Path(workspace).resolve() if workspace is not None else None
        self.max_file_bytes = int(max_file_bytes)
        self.quota_bytes = int(quota_bytes)

    # -- paths ---------------------------------------------------------------
    def session_dir(self) -> Path:
        return self.root / self.session_id

    def index_path(self) -> Path:
        return self.session_dir() / "index.jsonl"

    def _safe_path(self, entry: dict) -> Path:
        """Validate a serialized record before ever touching the filesystem."""
        if self.workspace is not None:
            if entry.get("workspace") and Path(str(entry["workspace"])).resolve() != self.workspace:
                raise CheckpointError("workspace mismatch in checkpoint record")
        raw = str(entry.get("path") or "")
        if not raw:
            raise CheckpointError("malformed checkpoint record: no path")
        candidate = Path(raw)
        if not candidate.is_absolute():
            raise CheckpointError("malformed checkpoint record: non-absolute path")
        if ".." in candidate.parts:
            raise CheckpointError("checkpoint path escapes via '..'")
        resolved = candidate.resolve()
        if self.workspace is not None:
            try:
                resolved.relative_to(self.workspace)
            except ValueError as exc:
                raise CheckpointError(
                    f"checkpoint path outside bound workspace: {raw}") from exc
        return resolved

    # -- journal -------------------------------------------------------------
    def entries(self) -> list[dict]:
        try:
            lines = self.index_path().read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        out: list[dict] = []
        for line in lines:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                out.append(item)
        return out

    def _write_entries(self, entries: list[dict]) -> None:
        self.session_dir().mkdir(parents=True, exist_ok=True)
        with self.index_path().open("w", encoding="utf-8") as handle:
            for item in entries:
                handle.write(json.dumps(item) + "\n")

    def _journal_bytes(self) -> int:
        try:
            return self.index_path().stat().st_size
        except OSError:
            return 0

    # -- record --------------------------------------------------------------
    def begin(self, path: Path, tool: str) -> str:
        """Snapshot ``path`` before a mutation. Raises CheckpointError if the
        snapshot cannot be taken (the caller must then refuse the mutation)."""
        target = Path(path)
        try:
            resolved = target.resolve()
        except OSError as exc:
            raise CheckpointError(f"cannot resolve path ({exc})") from exc
        if self.workspace is not None:
            try:
                resolved.relative_to(self.workspace)
            except ValueError as exc:
                raise CheckpointError(f"path outside workspace ({resolved})") from exc

        existed = resolved.exists()
        before: bytes = b""
        if existed:
            try:
                if resolved.stat().st_size > self.max_file_bytes:
                    raise CheckpointError(
                        f"file is {resolved.stat().st_size} bytes, over the "
                        f"{self.max_file_bytes}-byte snapshot limit")
                before = resolved.read_bytes()
            except OSError as exc:
                raise CheckpointError(f"cannot read file for snapshot ({exc})") from exc

        entry = {
            "op_id": uuid.uuid4().hex,
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "tool": tool,
            "workspace": str(self.workspace) if self.workspace is not None else "",
            "path": str(resolved),
            "existed": existed,
            "before_hash": _hash(before) if existed else "",
            "before_b64": base64.b64encode(before).decode("ascii") if existed else "",
            "existed_after": None,
            "after_hash": "",
            "after_b64": "",
        }
        estimated = len(json.dumps(entry)) + 1
        if self._journal_bytes() + estimated > self.quota_bytes:
            raise CheckpointError(
                f"session checkpoint quota ({self.quota_bytes} bytes) would be exceeded")
        try:
            self.session_dir().mkdir(parents=True, exist_ok=True)
            with self.index_path().open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry) + "\n")
        except OSError as exc:
            raise CheckpointError(f"cannot write checkpoint journal ({exc})") from exc
        return entry["op_id"]

    def commit(self, op_id: str) -> bool:
        """Record the after-state so a redo can be replayed. Returns success."""
        entries = self.entries()
        changed = False
        for entry in entries:
            if entry.get("op_id") != op_id:
                continue
            resolved = self._safe_path(entry)
            after: Optional[bytes] = None
            if resolved.exists():
                try:
                    if resolved.stat().st_size <= self.max_file_bytes:
                        after = resolved.read_bytes()
                except OSError:
                    after = None
            entry["existed_after"] = resolved.exists()
            if after is not None:
                entry["after_b64"] = base64.b64encode(after).decode("ascii")
                entry["after_hash"] = _hash(after)
            changed = True
            break
        if changed:
            self._write_entries(entries)
        return changed

    # -- restore -------------------------------------------------------------
    def _apply(self, entry: dict, side: str) -> Path:
        """Apply the before/after state of one entry. ``side`` is before|after."""
        resolved = self._safe_path(entry)
        existed = entry.get("existed") if side == "before" else entry.get("existed_after")
        blob = entry.get("before_b64") if side == "before" else entry.get("after_b64")
        if existed:
            if not blob:
                raise CheckpointError(f"checkpoint has no {side} content to restore")
            resolved.parent.mkdir(parents=True, exist_ok=True)
            resolved.write_bytes(base64.b64decode(blob))
        else:
            if resolved.exists():
                resolved.unlink()
        return resolved

    def rewind_to(self, mark: int) -> tuple[list[dict], str]:
        """Undo every entry at or past ``mark``. Returns (redo_records, message)."""
        entries = self.entries()
        mark = max(0, min(int(mark), len(entries)))
        if mark >= len(entries):
            return [], "nothing to undo"
        to_undo = entries[mark:]
        applied: list[dict] = []
        for entry in reversed(to_undo):
            try:
                path = self._apply(entry, "before")
            except (CheckpointError, OSError, ValueError) as exc:
                return [], f"undo failed: {exc}"
            applied.append(entry)
            kind = "removed" if not entry.get("existed") else "restored"
            print_note = f"{kind} {path}"
            applied[-1]["_note"] = print_note
        self._write_entries(entries[:mark])
        applied.reverse()  # forward order for redo
        notes = "; ".join(item.get("_note", "") for item in applied)
        for item in applied:
            item.pop("_note", None)
        return applied, f"undo: {notes}" if notes else "nothing to undo"

    def redo(self, records: list[dict]) -> tuple[bool, str]:
        """Reapply forward. Fails truthfully if the after-state was not kept."""
        if not records:
            return False, "nothing to redo"
        for entry in records:
            if entry.get("existed_after") is None:
                return False, "redo unavailable: checkpoint has no after-state"
            try:
                self._apply(entry, "after")
            except (CheckpointError, OSError, ValueError) as exc:
                return False, f"redo failed: {exc}"
        self._write_entries(self.entries() + list(records))
        return True, f"redo: reapplied {len(records)} change(s)"

    def restore(self, n: int = 1) -> str:
        """Permanently rewind the n most recent changes (/rewind)."""
        entries = self.entries()
        if not entries:
            return "no checkpoints for this session"
        if n < 1 or n > len(entries):
            return f"checkpoint {n} out of range (1..{len(entries)})"
        records, message = self.rewind_to(len(entries) - n)
        if not records:
            return message
        entry = entries[-n]
        return (f"{message} - back to its state before "
                f"{entry.get('tool', '?')} ({entry.get('ts', '')})")

    def restore_all(self) -> int:
        count = len(self.entries())
        for _ in range(count):
            self.restore(1)
        return count
