"""Containment for every process DAMAR's agent starts in a workspace (allowlisted commands and the file writer).

Usage: python -I job-run.py --ledger <grants.jsonl> --grant-rw <workspace> [--grant-rx <dir>]... -- <exe> [args...]

Two independent boundaries, both mandatory (fails closed with exit 125 if either cannot be established):
1. Windows Job Object (resource and lifetime): the wrapper puts itself into a new job with KILL_ON_JOB_CLOSE, a
   32-process limit and a 1 GiB job memory limit; the command inherits the job, so when the wrapper exits (command
   finished, or the Core host killed it on timeout/cancel) Windows terminates every process still in it.
2. AppContainer "DAMAR.Sandbox" with NO capabilities (authority): the command runs under a sandbox SID that has no
   network access (internet and loopback) and can open only objects whose ACL names that SID (or ALL APPLICATION
   PACKAGES, e.g. read-only system folders). The wrapper grants exactly: Modify on the workspace, Read+Execute on the
   interpreter / script folders it needs. Writes anywhere else, including through a junction or symlink swapped into
   the workspace at the last moment, are refused by the kernel. Grants are idempotent and recorded in the ledger so they
   can be revoked (scripts/revoke-sandbox-grants.cjs).
stdin/stdout/stderr and the (already stripped) environment are inherited; TEMP/TMP point to the container's own folder.
"""
import ctypes
import json
import os
import subprocess
import sys
import time
import uuid
from ctypes import wintypes as w

KILL_ON_JOB_CLOSE, ACTIVE_PROCESS, JOB_MEMORY = 0x2000, 0x0008, 0x0200
EXTENDED_LIMIT_INFORMATION = 9
CONTAINER = "DAMAR.Sandbox"
PSID = ctypes.c_void_p


class Basic(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", w.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class Extended(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IoCounters), ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


class SecurityCapabilities(ctypes.Structure):
    _fields_ = [("AppContainerSid", PSID), ("Capabilities", ctypes.c_void_p), ("CapabilityCount", w.DWORD), ("Reserved", w.DWORD)]


class StartupInfo(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR), ("dwX", w.DWORD), ("dwY", w.DWORD),
                ("dwXSize", w.DWORD), ("dwYSize", w.DWORD), ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
                ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD), ("lpReserved2", ctypes.c_void_p),
                ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]


class StartupInfoEx(ctypes.Structure):
    _fields_ = [("StartupInfo", StartupInfo), ("lpAttributeList", ctypes.c_void_p)]


class ProcessInformation(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


def fail(code):
    sys.stderr.write(code + "\n")
    return 125


def parse(argv):
    if "--" not in argv:
        return None
    sep = argv.index("--")
    opts, command = argv[:sep], argv[sep + 1:]
    ledger, rw, rx = None, [], []
    i = 0
    while i < len(opts):
        key = opts[i]
        if i + 1 >= len(opts) or key not in ("--ledger", "--grant-rw", "--grant-rx"):
            return None
        value = os.path.abspath(opts[i + 1])
        if key == "--ledger":
            ledger = value
        elif key == "--grant-rw":
            rw.append(value)
        else:
            rx.append(value)
        i += 2
    if not ledger or len(rw) != 1 or not command or not all(os.path.isdir(p) for p in rw + rx):
        return None
    return ledger, rw[0], rx, command


def container_sid(userenv, advapi32):
    userenv.CreateAppContainerProfile.argtypes = [w.LPCWSTR, w.LPCWSTR, w.LPCWSTR, ctypes.c_void_p, w.DWORD, ctypes.POINTER(PSID)]
    userenv.CreateAppContainerProfile.restype = ctypes.c_long
    userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [w.LPCWSTR, ctypes.POINTER(PSID)]
    userenv.DeriveAppContainerSidFromAppContainerName.restype = ctypes.c_long
    advapi32.ConvertSidToStringSidW.argtypes = [PSID, ctypes.POINTER(w.LPWSTR)]
    sid = PSID()
    if userenv.CreateAppContainerProfile(CONTAINER, "DAMAR sandbox", "DAMAR agent command sandbox (no capabilities)", None, 0, ctypes.byref(sid)) != 0:
        if userenv.DeriveAppContainerSidFromAppContainerName(CONTAINER, ctypes.byref(sid)) != 0:
            return None, None
    text = w.LPWSTR()
    if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        return None, None
    return sid, text.value


def grant(ledger, sid_text, path, rights):
    """Idempotent: icacls merges an existing ACE, so the grant is applied every time (a grant revoked through another
    ledger is restored) and recorded once per (sid, path, rights) until a revocation row follows it."""
    seen = set()
    try:
        with open(ledger, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line); key = (r["sid"], r["path"].lower(), r["rights"])
                    if r.get("revoked"):   # scripts/revoke-sandbox-grants.cjs removed it; grant again when needed
                        seen.discard(key)
                    else:
                        seen.add(key)
                except (ValueError, KeyError):
                    continue
    except OSError:
        pass
    result = subprocess.run(["icacls", path, "/grant", "*%s:(OI)(CI)%s" % (sid_text, rights), "/Q"], capture_output=True, text=True)
    if result.returncode != 0:
        # System-owned folders (e.g. Program Files) cannot be granted, but already allow every sandboxed app to read:
        # accept that for read-only needs only; anything else fails closed.
        if rights != "(RX)":
            return False
        listing = subprocess.run(["icacls", path], capture_output=True, text=True).stdout
        return any("ALL APPLICATION PACKAGES" in line and ("(RX)" in line or "(R)" in line or "(F)" in line) for line in listing.splitlines())
    if (sid_text, path.lower(), rights) in seen:
        return True
    os.makedirs(os.path.dirname(ledger), exist_ok=True)
    with open(ledger, "a", encoding="utf-8") as f:
        f.write(json.dumps({"t": int(time.time() * 1000), "sid": sid_text, "path": path, "rights": rights}) + "\n")
    return True


def main() -> int:
    parsed = parse(sys.argv[1:])
    if not parsed:
        return fail("SANDBOX_ARGUMENTS_INVALID")
    ledger, workspace, readable, command = parsed
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

    # 1. Job Object (the wrapper first, so the sandboxed child is created inside it).
    kernel32.CreateJobObjectW.restype = w.HANDLE
    kernel32.GetCurrentProcess.restype = w.HANDLE
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        return fail("JOB_CONTAINMENT_UNAVAILABLE")
    info = Extended()
    info.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE | ACTIVE_PROCESS | JOB_MEMORY
    info.BasicLimitInformation.ActiveProcessLimit = 32
    info.JobMemoryLimit = 1 << 30
    if not kernel32.SetInformationJobObject(w.HANDLE(job), EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info)):
        return fail("JOB_CONTAINMENT_UNAVAILABLE")
    if not kernel32.AssignProcessToJobObject(w.HANDLE(job), w.HANDLE(kernel32.GetCurrentProcess())):
        return fail("JOB_CONTAINMENT_UNAVAILABLE")

    # 2. AppContainer identity and the exact grants. Creating an AppContainer process reads %LOCALAPPDATA% (fails with
    # ERROR_ENVVAR_NOT_FOUND 203 when the caller stripped it); restore it from the known folder, never from input.
    if not os.environ.get("LOCALAPPDATA"):
        local = ctypes.c_wchar_p()
        folder_id = (ctypes.c_byte * 16).from_buffer_copy(uuid.UUID("F1B32785-6FBA-4FCF-9D55-7B8E7F157091").bytes_le)
        if ctypes.windll.shell32.SHGetKnownFolderPath(folder_id, 0, None, ctypes.byref(local)) != 0 or not local.value:
            return fail("SANDBOX_UNAVAILABLE")
        os.environ["LOCALAPPDATA"] = local.value
    sid, sid_text = container_sid(userenv, advapi32)
    if not sid:
        return fail("SANDBOX_UNAVAILABLE")
    if not grant(ledger, sid_text, workspace, "(M)") or not all(grant(ledger, sid_text, p, "(RX)") for p in readable):
        return fail("SANDBOX_GRANT_FAILED")
    folder = w.LPWSTR()
    userenv.GetAppContainerFolderPath.argtypes = [w.LPCWSTR, ctypes.POINTER(w.LPWSTR)]
    if userenv.GetAppContainerFolderPath(sid_text, ctypes.byref(folder)) == 0 and folder.value:
        os.environ["TEMP"] = os.environ["TMP"] = folder.value

    # 3. Start the command in the container (no capabilities), inheriting stdio, cwd and environment.
    attribute_security_capabilities = 0x00020009
    extended_startupinfo_present, startf_usestdhandles = 0x00080000, 0x100
    size = ctypes.c_size_t()
    kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
    attributes = (ctypes.c_byte * size.value)()
    if not kernel32.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
        return fail("SANDBOX_UNAVAILABLE")
    capabilities = SecurityCapabilities(sid, None, 0, 0)
    kernel32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
    if not kernel32.UpdateProcThreadAttribute(attributes, 0, attribute_security_capabilities, ctypes.byref(capabilities), ctypes.sizeof(capabilities), None, None):
        return fail("SANDBOX_UNAVAILABLE")
    startup = StartupInfoEx()
    startup.StartupInfo.cb = ctypes.sizeof(startup)
    startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
    startup.StartupInfo.dwFlags = startf_usestdhandles
    kernel32.GetStdHandle.restype = w.HANDLE
    for field, which in (("hStdInput", -10), ("hStdOutput", -11), ("hStdError", -12)):
        handle = kernel32.GetStdHandle(which)
        if handle:
            kernel32.SetHandleInformation(w.HANDLE(handle), 1, 1)   # HANDLE_FLAG_INHERIT
        setattr(startup.StartupInfo, field, handle)
    process = ProcessInformation()
    kernel32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p]
    command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(command))
    if not kernel32.CreateProcessW(command[0], command_line, None, None, True, extended_startupinfo_present, None, None, ctypes.byref(startup), ctypes.byref(process)):
        sys.stderr.write("SPAWN_FAILED %d\n" % ctypes.get_last_error())
        return 126
    kernel32.CloseHandle(process.hThread)
    kernel32.WaitForSingleObject(process.hProcess, 0xFFFFFFFF)
    code = w.DWORD()
    kernel32.GetExitCodeProcess(process.hProcess, ctypes.byref(code))
    kernel32.CloseHandle(process.hProcess)
    return code.value if code.value != 125 else 124   # 125 is reserved for "containment unavailable"


if __name__ == "__main__":
    sys.exit(main())
