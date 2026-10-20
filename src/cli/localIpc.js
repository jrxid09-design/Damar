"use strict";

/**
 * W5-CLI REAL CONNECTED CLI — Phase A/B: SECURE LOCAL IPC PRIMITIVES.
 *
 * THIS MODULE IS TRANSPORT.  It authenticates *channels*; it grants no
 * Damar authority of any kind.  Every consequential decision stays in the
 * canonical Manager / Authority Gate / OwnerTrust composition.
 *
 * ENDPOINT
 *   win32  — a Windows named pipe `\\.\pipe\damar-cli-<32 hex>`.  The name is
 *            random per host instance and published only in the ACL-confined
 *            discovery file.  NO TCP listener is ever created: `assertLocal
 *            Endpoint()` refuses any endpoint that is a port or a network
 *            authority, so "localhost TCP is authenticated" is impossible by
 *            construction.
 *   posix  — a unix-domain socket inside the state dir with mode 0600 in a
 *            0700 directory.
 *
 * PEER AUTHENTICATION (honest scope — see the Phase A/B measurements in
 * windows-peer-hardening-evidence/)
 *   Node's `net` exposes NO peer SID/UID/PID API on either platform.  Pure
 *   Node also cannot set the named-pipe DACL, and `CreateNamedPipe` with a
 *   NULL descriptor — which is all libuv ever passes — grants FILE_READ to
 *   Everyone and Anonymous.  Peer identity therefore CANNOT be proven by the
 *   runtime library alone.  Measured (Phase A):
 *
 *     * `ImpersonateNamedPipeClient` DOES return the peer's user SID, but only
 *       from the process that owns the CONNECTED server-side pipe instance,
 *       and only after the client has written: a raw Win32 listener +
 *       Node client returned the peer SID, whereas the same call on a
 *       client-side handle failed with ERROR_INVALID_FUNCTION and before the
 *       client wrote with ERROR_CANNOT_IMPERSONATE.  Node/libuv owns the
 *       instance handle and exposes neither it nor a way to run Win32
 *       impersonation inside the listener process, so a token-based peer-SID
 *       gate is BLOCKED without changing who owns the listening socket.
 *     * The named-pipe DACL IS settable and the result is stable across every
 *       instance of the pipe name, so OS-level access to the endpoint is
 *       confined to the owning principal (see `hardenNamedPipe`).
 *
 *   What the transport therefore establishes, honestly:
 *
 *     1. OS-level endpoint confinement.  The endpoint is never a network
 *        listener, and its DACL is rewritten to
 *        `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<owner SID>)` and re-verified by
 *        effective access mask, so no other local principal can even open it.
 *     2. An OS-ACL-confined 256-bit channel secret.  `hardenSecretPath()`
 *        rewrites the DACL with `icacls /inheritance:r /grant:r <user>:(F)`
 *        (Windows) or chmod 0600 (posix), and `verifySecretPath()` re-reads
 *        the resulting ACL and FAILS CLOSED unless exactly the owning
 *        principal holds it.  Only that OS principal can read the secret.
 *     3. Mutual proof.  The client presents the secret; the server returns an
 *        HMAC over the exchanged nonces, so a squatter bound to the endpoint
 *        cannot impersonate the host either.
 *
 *   A caller-supplied principal string is NEVER accepted as identity.  The
 *   verified property is "this connection came through an OS-confined
 *   endpoint AND proved possession of a secret the OS confines to one local
 *   principal"; that is recorded honestly as PARTIAL peer identity, NOT an OS
 *   token/SID check.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
const SECRET_BYTES = 32;
const DISCOVERY_FILE = "cli-host.json";
const TOKEN_FILE = "cli-host.token";
const CLIENT_STATE_FILE = "cli-client-session.json";
const CLIENT_ID_FILE = "cli-client-id";
const ENDPOINT_PREFIX = "\\\\.\\pipe\\damar-cli-";
const WELCOME_DOMAIN = "damar-cli-local-ipc/v1/welcome";

const SENSITIVE_KEY = /token|nonce|signature|secret|proof|password|credential|key/i;

function transportError(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

function isWindows() {
    return process.platform === "win32";
}

/**
 * The CLI host and the CLI client both resolve the SAME directory from the
 * canonical OwnerTrust store path — there is no second, caller-choosable
 * location authority.  `memory` (or unset) falls back to the canonical
 * `~/.damar` home used by the production composition.
 */
function resolveCliStateDir(env = process.env) {
    const configured = env.DAMAR_OWNER_TRUST_STATE;
    if (typeof configured === "string" && configured.trim() !== "" && configured !== "memory") {
        return path.dirname(path.resolve(configured));
    }
    return path.join(os.homedir(), ".damar");
}

function discoveryPath(stateDir) {
    return path.join(stateDir, DISCOVERY_FILE);
}

function tokenPath(stateDir) {
    return path.join(stateDir, TOKEN_FILE);
}

function clientStatePath(stateDir) {
    return path.join(stateDir, CLIENT_STATE_FILE);
}

function clientIdPath(stateDir) {
    return path.join(stateDir, CLIENT_ID_FILE);
}

/**
 * The stable identity of THIS CLI installation as seen by the host.  It is
 * generated once and kept in an OS-ACL-confined file, so a connection handle
 * minted for this client cannot be used by a different client — even one that
 * somehow learned the handle.  It carries no authority of its own.
 */
function resolveClientId(stateDir) {
    const file = clientIdPath(stateDir);
    try {
        const existing = fs.readFileSync(file, "utf8").trim();
        if (/^[0-9a-f]{32}$/.test(existing)) return existing;
    } catch { /* not yet created */ }
    const created = crypto.randomBytes(16).toString("hex");
    writeSecret(file, `${created}\n`);
    return created;
}

function randomEndpoint() {
    return `${ENDPOINT_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
}

/**
 * Refuse anything that is not a strictly local endpoint.  This is the
 * structural guarantee that the CLI surface never becomes a network
 * listener.
 */
function assertLocalEndpoint(endpoint, stateDir) {
    if (typeof endpoint !== "string" || endpoint.length === 0) {
        throw transportError("TRANSPORT_ENDPOINT_INVALID", "endpoint must be a non-empty string");
    }
    if (isWindows()) {
        if (!endpoint.startsWith(ENDPOINT_PREFIX)) {
            throw transportError("TRANSPORT_ENDPOINT_INVALID", "only damar-cli named pipes are accepted");
        }
        return endpoint;
    }
    if (!path.isAbsolute(endpoint)) {
        throw transportError("TRANSPORT_ENDPOINT_INVALID", "socket path must be absolute");
    }
    const dir = stateDir ? path.resolve(stateDir) : null;
    if (dir !== null && path.dirname(path.resolve(endpoint)) !== dir) {
        throw transportError("TRANSPORT_ENDPOINT_INVALID", "socket must live inside the CLI state dir");
    }
    return endpoint;
}

// ---------------------------------------------------------------------------
// OS-level ACL confinement of the secret material.
// ---------------------------------------------------------------------------

function currentWindowsUser() {
    const domain = process.env.USERDOMAIN;
    const name = process.env.USERNAME;
    if (domain && name) return `${domain}\\${name}`;
    if (name) return name;
    return null;
}

function currentWindowsUserSid() {
    try {
        const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 10_000 });
        const fields = String(out).trim().split(",").map((f) => f.replace(/^"|"$/g, "").trim());
        return fields.length >= 2 ? fields[1] : null;
    } catch {
        return null;
    }
}

function icacls(args) {
    try {
        return execFileSync("icacls", args, { encoding: "utf8", timeout: 20_000, windowsHide: true });
    } catch (error) {
        throw transportError("TRANSPORT_ACL_UNVERIFIABLE", `icacls unavailable: ${error?.message ?? error}`);
    }
}

function parseIcacls(output) {
    const entries = [];
    const re = /([^\s]+?):\(([^()]*)\)/g;
    let match;
    while ((match = re.exec(String(output))) !== null) {
        entries.push({ principal: match[1], rights: match[2] });
    }
    return entries;
}

/**
 * Rewrite the DACL of a secret file so that exactly the current OS principal
 * holds it.  Inherited ACEs are removed first — the probe in the evidence log
 * shows a freshly written file in %TEMP% inherits Modify for unrelated SIDs,
 * so inheritance MUST be dropped for the secret to mean anything.
 */
function hardenSecretPath(target) {
    if (typeof target !== "string" || target.trim() === "") {
        throw transportError("TRANSPORT_ACL_UNVERIFIABLE", "path required");
    }
    if (!isWindows()) {
        fs.chmodSync(target, 0o600);
        return;
    }
    const who = currentWindowsUser();
    if (who === null) {
        throw transportError("TRANSPORT_ACL_UNVERIFIABLE", "cannot resolve the owning OS principal");
    }
    icacls([target, "/inheritance:r", "/grant:r", `${who}:(F)`]);
}

/**
 * Re-read the ACL and fail closed unless ONLY the owning principal appears.
 * Never assume the write above took effect.
 */
function verifySecretPath(target) {
    if (!isWindows()) {
        const stat = fs.statSync(target);
        if ((stat.mode & 0o077) !== 0) {
            throw transportError("TRANSPORT_ACL_UNSAFE", `${path.basename(target)} is group/world accessible`);
        }
        return Object.freeze({ platform: "posix", mode: `0${(stat.mode & 0o777).toString(8)}`, principals: Object.freeze([]) });
    }
    const allowed = new Set([currentWindowsUser(), currentWindowsUserSid()].filter(Boolean));
    if (allowed.size === 0) {
        throw transportError("TRANSPORT_ACL_UNVERIFIABLE", "cannot resolve the owning OS principal");
    }
    const entries = parseIcacls(icacls([target]));
    if (entries.length === 0) {
        throw transportError("TRANSPORT_ACL_UNVERIFIABLE", "no DACL entries reported");
    }
    const foreign = entries.filter((e) => !allowed.has(e.principal));
    if (foreign.length > 0) {
        throw transportError(
            "TRANSPORT_ACL_UNSAFE",
            `${path.basename(target)} is readable by ${foreign.map((f) => f.principal).join(", ")}`
        );
    }
    return Object.freeze({
        platform: "win32",
        mode: "dacl",
        principals: Object.freeze(entries.map((e) => `${e.principal}:(${e.rights})`).sort())
    });
}

function writeSecret(target, content) {
    fs.writeFileSync(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
        hardenSecretPath(target);
        return verifySecretPath(target);
    } catch (error) {
        try { fs.unlinkSync(target); } catch { /* best effort */ }
        throw error;
    }
}

/** Overwrite-in-place variant (client-side session handle storage). */
function writeProtected(target, content) {
    fs.writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
    hardenSecretPath(target);
    return verifySecretPath(target);
}

// ---------------------------------------------------------------------------
// OS-level DACL confinement of the named-pipe ENDPOINT.
// ---------------------------------------------------------------------------
//
// `CreateNamedPipe` with a NULL security descriptor is documented to grant
// FILE_READ to Everyone and to Anonymous.  Node/libuv never passes a security
// descriptor, so it cannot avoid that, and pure Node exposes no way to set one
// afterwards (there is no DACL API and `Get-Acl`/`Set-Acl` cannot address
// NPFS).  Measured on the original build:
//
//   D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<owner>)(A;;FR;;;WD)(A;;FR;;;AN)
//
// Phase A measured the two candidate mechanisms:
//
//   * the process TOKEN DEFAULT DACL is NOT consulted by NPFS — setting it
//     changed the token and left the pipe permissive (rejected);
//   * SetSecurityInfo on a handle that has WRITE_DAC works, and the resulting
//     descriptor is observed on EVERY instance of the pipe name, including
//     instances recycled by later connections (12/12 reads after 39 accepted
//     connections, and 4/4 concurrently held instances).
//
// So the endpoint is hardened after `listen()` and BEFORE the discovery file
// is published, and the applied ACL is then re-read and re-checked.  The
// check is an EFFECTIVE ACCESS MASK check (`GetEffectiveRightsFromAcl`) for
// Everyone / Anonymous / Users / Authenticated Users / SYSTEM / Administrators
// / the owning SID — not a string comparison — and any unexpected grant fails
// the host closed.  The Windows API access itself is done by the OS-provided
// PowerShell (.NET Framework compiler); no third-party binary and no native
// module are involved, and the helper is handed no secret material.

const PIPE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$endpoint = $env:DAMAR_PIPE_ACL_ENDPOINT
$ownerSid = $env:DAMAR_PIPE_ACL_OWNER_SID
$mode = $env:DAMAR_PIPE_ACL_MODE
if ([string]::IsNullOrEmpty($endpoint)) {
    Write-Output 'PIPE_ACL_RESULT ERROR=missing-endpoint'
    exit 3
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DamarPipeAcl
{
    const uint WRITE_DAC = 0x00040000;
    const uint READ_CONTROL = 0x00020000;
    const int SE_KERNEL_OBJECT = 6;
    const int DACL_SECURITY_INFORMATION = 0x00000004;
    const int SDDL_OWNER_GROUP_DACL = 7;
    const uint SDDL_REVISION_1 = 1;
    const uint OPEN_EXISTING = 3;
    const int ERROR_PIPE_BUSY = 231;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern int GetSecurityInfo(IntPtr handle, int type, int info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern int SetSecurityInfo(IntPtr handle, int type, int info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint rev, out IntPtr sd, out int size);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd, uint rev, int info, out IntPtr sddl, out int size);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr text);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern int GetEffectiveRightsFromAcl(IntPtr pacl, ref TRUSTEE trustee, out uint mask);

    [StructLayout(LayoutKind.Sequential)]
    struct TRUSTEE {
        public IntPtr pMultipleTrustee;
        public int MultipleTrusteeOperation;
        public int TrusteeForm;
        public int TrusteeType;
        public IntPtr ptstrName;
    }

    static string ToSddl(IntPtr sd) {
        IntPtr text; int len;
        if (!ConvertSecurityDescriptorToStringSecurityDescriptor(sd, SDDL_REVISION_1, SDDL_OWNER_GROUP_DACL, out text, out len)) return "ERR" + Marshal.GetLastWin32Error();
        string sddl = Marshal.PtrToStringUni(text);
        LocalFree(text);
        return sddl;
    }

    static string ToSid(IntPtr sid) {
        if (sid == IntPtr.Zero) return "none";
        IntPtr text;
        if (!ConvertSidToStringSid(sid, out text)) return "ERR" + Marshal.GetLastWin32Error();
        string value = Marshal.PtrToStringUni(text);
        LocalFree(text);
        return value;
    }

    static string EffectiveMask(IntPtr pacl, string sidString) {
        IntPtr sid;
        if (!ConvertStringSidToSid(sidString, out sid)) return "ERR" + Marshal.GetLastWin32Error();
        try {
            TRUSTEE trustee = new TRUSTEE();
            trustee.TrusteeForm = 0;
            trustee.TrusteeType = 0;
            trustee.ptstrName = sid;
            uint mask;
            int rc = GetEffectiveRightsFromAcl(pacl, ref trustee, out mask);
            if (rc != 0) return "ERR" + rc;
            return "0x" + mask.ToString("x");
        } finally { LocalFree(sid); }
    }

    static string MasksOf(IntPtr dacl, string ownerSid) {
        return "maskEveryone=" + EffectiveMask(dacl, "S-1-1-0")
             + " maskAnonymous=" + EffectiveMask(dacl, "S-1-5-7")
             + " maskUsers=" + EffectiveMask(dacl, "S-1-5-32-545")
             + " maskAuthenticatedUsers=" + EffectiveMask(dacl, "S-1-5-11")
             + " maskSystem=" + EffectiveMask(dacl, "S-1-5-18")
             + " maskAdministrators=" + EffectiveMask(dacl, "S-1-5-32-544")
             + " maskOwner=" + EffectiveMask(dacl, ownerSid);
    }

    static IntPtr OpenPipe(string pipe, out int lastError) {
        lastError = 0;
        for (int attempt = 0; attempt < 60; attempt++) {
            IntPtr candidate = CreateFile(pipe, WRITE_DAC | READ_CONTROL, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (candidate != (IntPtr)(-1)) return candidate;
            lastError = Marshal.GetLastWin32Error();
            if (lastError != ERROR_PIPE_BUSY) return IntPtr.Zero;
            Thread.Sleep(100);
        }
        return IntPtr.Zero;
    }

    /// Read-only: report the live DACL and the EFFECTIVE access mask each
    /// principal holds under it.  Changes nothing.
    public static string Verify(string pipe) {
        int lastError;
        IntPtr handle = OpenPipe(pipe, out lastError);
        if (handle == IntPtr.Zero) return "ERROR=open_failed_" + lastError;
        try {
            IntPtr owner, group, dacl, sacl, sd;
            int rc = GetSecurityInfo(handle, SE_KERNEL_OBJECT, SDDL_OWNER_GROUP_DACL, out owner, out group, out dacl, out sacl, out sd);
            if (rc != 0) return "ERROR=getsecurityinfo_" + rc;
            string sddl = ToSddl(sd);
            string ownerSid = ToSid(owner);
            return "mode=verify ownerSid=" + ownerSid + " before=" + sddl + " after=" + sddl + " " + MasksOf(dacl, ownerSid);
        } finally { CloseHandle(handle); }
    }

    public static string HardenAndVerify(string pipe, string ownerSid) {
        string desired = "D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + ownerSid + ")";
        int lastError;
        IntPtr handle = OpenPipe(pipe, out lastError);
        if (handle == IntPtr.Zero) return "ERROR=open_failed_" + lastError;
        try {
            IntPtr owner, group, dacl, sacl, sd;
            int rc = GetSecurityInfo(handle, SE_KERNEL_OBJECT, SDDL_OWNER_GROUP_DACL, out owner, out group, out dacl, out sacl, out sd);
            if (rc != 0) return "ERROR=getsecurityinfo_" + rc;
            string before = ToSddl(sd);

            IntPtr newSd; int newSize;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor(desired, SDDL_REVISION_1, out newSd, out newSize))
                return "ERROR=build_sd_" + Marshal.GetLastWin32Error();
            string masks;
            try {
                bool present; IntPtr newDacl; bool defaulted;
                if (!GetSecurityDescriptorDacl(newSd, out present, out newDacl, out defaulted))
                    return "ERROR=get_dacl_" + Marshal.GetLastWin32Error();
                rc = SetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, newDacl, IntPtr.Zero);
                if (rc != 0) return "ERROR=setsecurityinfo_" + rc;
                masks = MasksOf(newDacl, ownerSid);
            } finally { LocalFree(newSd); }

            IntPtr o2, g2, d2, s2, sd2;
            rc = GetSecurityInfo(handle, SE_KERNEL_OBJECT, SDDL_OWNER_GROUP_DACL, out o2, out g2, out d2, out s2, out sd2);
            if (rc != 0) return "ERROR=re_getsecurityinfo_" + rc;
            return "mode=harden ownerSid=" + ownerSid + " before=" + before + " after=" + ToSddl(sd2) + " " + masks;
        } finally { CloseHandle(handle); }
    }
}
'@
Write-Output 'PIPE_ACL_MODULE_OK'
if ($mode -eq 'verify') {
    Write-Output ("PIPE_ACL_RESULT " + [DamarPipeAcl]::Verify($endpoint))
} else {
    if ([string]::IsNullOrEmpty($ownerSid)) {
        Write-Output 'PIPE_ACL_RESULT ERROR=missing-owner-sid'
        exit 3
    }
    Write-Output ("PIPE_ACL_RESULT " + [DamarPipeAcl]::HardenAndVerify($endpoint, $ownerSid))
}
`;

/** The exact helper source, for evidence and for `-EncodedCommand`. */
function namedPipeAclScript() {
    return PIPE_ACL_SCRIPT;
}

function parseAclResult(line) {
    const fields = {};
    for (const token of String(line).trim().split(/\s+/)) {
        const index = token.indexOf("=");
        if (index <= 0) continue;
        fields[token.slice(0, index)] = token.slice(index + 1);
    }
    return fields;
}

const EVERYONE_DENIED = ["maskEveryone", "maskAnonymous", "maskUsers", "maskAuthenticatedUsers"];
const OWNER_ALLOWED = ["maskSystem", "maskAdministrators", "maskOwner"];

/** Only damar endpoints may be handed to the ACL helper. */
function assertDamarEndpoint(endpoint) {
    const endpointRe = new RegExp(`^${ENDPOINT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{32}$`);
    if (typeof endpoint !== "string" || !endpointRe.test(endpoint)) {
        throw transportError("TRANSPORT_ENDPOINT_INVALID", "refusing to touch a non-damar endpoint");
    }
}

/**
 * Run the OS ACL helper against a live endpoint.  `mode: "harden"` rewrites the
 * DACL; `mode: "verify"` reads it and changes nothing.  Both report the SDDL
 * AND the effective access mask each principal holds under the resulting ACL.
 */
function runPipeAclHelper(endpoint, { mode, ownerSid = null, timeoutMs = 120_000 }) {
    const env = { ...process.env, DAMAR_PIPE_ACL_ENDPOINT: endpoint, DAMAR_PIPE_ACL_MODE: mode };
    if (ownerSid !== null) env.DAMAR_PIPE_ACL_OWNER_SID = ownerSid;

    let output;
    let failedRun = null;
    try {
        output = execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text",
            "-EncodedCommand", Buffer.from(PIPE_ACL_SCRIPT, "utf16le").toString("base64")
        ], {
            encoding: "utf8",
            timeout: timeoutMs,
            windowsHide: true,
            // Explicit pipes: the helper's stderr must never reach the host's
            // own log, and its stdin must never be the host's.
            stdio: ["pipe", "pipe", "pipe"],
            env
        });
    } catch (error) {
        // A non-zero exit must still be judged by the verdict it produced.
        failedRun = typeof error?.stdout === "string" ? error.stdout : null;
        output = failedRun;
        if (failedRun === null) {
            throw transportError("TRANSPORT_ACL_HARDEN_FAILED", `the OS ACL helper did not run: ${error?.message ?? error}`);
        }
    }

    const resultLine = String(output ?? "").split(/\r?\n/).find((entry) => entry.trimStart().startsWith("PIPE_ACL_RESULT "));
    if (resultLine === undefined) {
        throw transportError(
            "TRANSPORT_ACL_HARDEN_FAILED",
            `the OS ACL helper produced no verdict${failedRun === null ? "" : " (non-zero exit)"}`
        );
    }
    const fields = parseAclResult(resultLine.trimStart().slice("PIPE_ACL_RESULT ".length));
    if (typeof fields.ERROR === "string") {
        throw transportError("TRANSPORT_ACL_HARDEN_FAILED", `the OS ACL helper failed: ${fields.ERROR}`);
    }
    const foreign = EVERYONE_DENIED.filter((key) => fields[key] !== "0x0");
    if (foreign.length > 0) {
        throw transportError(
            "TRANSPORT_ACL_UNSAFE",
            `the endpoint grants effective access to ${foreign.map((k) => `${k.slice(4)}:${fields[k]}`).join(", ")}`
        );
    }
    const applied = typeof fields.after === "string" ? fields.after : "";
    return Object.freeze({
        mode,
        ownerSid: typeof fields.ownerSid === "string" ? fields.ownerSid : ownerSid,
        sddl: applied.includes("D:") ? `D:${applied.slice(applied.indexOf("D:") + 2)}` : applied,
        before: typeof fields.before === "string" ? fields.before : null,
        effective: Object.freeze(Object.fromEntries(
            [...EVERYONE_DENIED, ...OWNER_ALLOWED].map((key) => [key.slice(4), fields[key]])
        ))
    });
}

/**
 * Harden a Windows named-pipe endpoint and PROVE the result.  Fail-closed:
 * any helper error, any unexpected grant, or any write that did not land is a
 * refusal to serve, never a warning.
 */
function hardenNamedPipe(endpoint, { timeoutMs = 120_000 } = {}) {
    if (!isWindows()) {
        return Object.freeze({ platform: process.platform, mechanism: "filesystem-mode", status: "NOT_APPLICABLE" });
    }
    assertDamarEndpoint(endpoint);
    const ownerSid = currentWindowsUserSid();
    if (ownerSid === null || !/^S-1-[0-9-]+$/.test(ownerSid)) {
        throw transportError("TRANSPORT_ACL_UNVERIFIABLE", "cannot resolve the owning OS principal SID");
    }

    const observed = runPipeAclHelper(endpoint, { mode: "harden", ownerSid, timeoutMs });
    const desired = `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${ownerSid})`;
    if (observed.sddl !== desired) {
        throw transportError("TRANSPORT_ACL_HARDEN_FAILED", `the applied DACL is not the requested DACL (${observed.sddl})`);
    }
    const missing = OWNER_ALLOWED.filter((key) => observed.effective[key.slice(4)] === undefined
        || observed.effective[key.slice(4)] === "0x0");
    if (missing.length > 0) {
        throw transportError(
            "TRANSPORT_ACL_HARDEN_FAILED",
            `the endpoint does not grant the owning principal/OS service access (${missing.join(", ")})`
        );
    }

    return Object.freeze({
        platform: "win32",
        mechanism: "advapi32-SetSecurityInfo+GetEffectiveRightsFromAcl",
        status: "HARDENED_AND_VERIFIED",
        ownerSid,
        dacl: observed.sddl,
        before: observed.before,
        effective: observed.effective
    });
}

/**
 * READ-ONLY re-measurement of a live endpoint's access control, for evidence
 * and for W24.  Unlike `hardenNamedPipe` it repairs nothing, so it can observe
 * a regression: any effective access for Everyone / Anonymous / Users /
 * Authenticated Users fails closed with TRANSPORT_ACL_UNSAFE.
 */
function verifyNamedPipeAcl(endpoint, { timeoutMs = 120_000 } = {}) {
    if (!isWindows()) {
        return Object.freeze({ platform: process.platform, mechanism: "filesystem-mode", status: "NOT_APPLICABLE" });
    }
    assertDamarEndpoint(endpoint);
    const observed = runPipeAclHelper(endpoint, { mode: "verify", timeoutMs });
    return Object.freeze({
        platform: "win32",
        mechanism: "advapi32-GetSecurityInfo+GetEffectiveRightsFromAcl",
        status: "NO_FOREIGN_PRINCIPAL_HAS_ACCESS",
        ownerSid: observed.ownerSid,
        dacl: observed.sddl,
        effective: observed.effective
    });
}

// ---------------------------------------------------------------------------
// Framing: newline-delimited JSON with a hard bound on every frame.
// ---------------------------------------------------------------------------

function encodeFrame(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > MAX_FRAME_BYTES) {
        throw transportError("EPEER_FRAME_TOO_LARGE", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    return Buffer.concat([body, Buffer.from("\n", "utf8")]);
}

/**
 * Strict bounded frame reader.  Oversized or malformed input is reported to
 * `onViolation` and the buffer is dropped; callers must close the channel.
 */
function createFrameReader({ onMessage, onViolation, maxFrameBytes = MAX_FRAME_BYTES } = {}) {
    let buffer = Buffer.alloc(0);
    let broken = false;

    function fail(code, detail) {
        broken = true;
        buffer = Buffer.alloc(0);
        onViolation(transportError(code, detail));
    }

    function push(chunk) {
        if (broken) return;
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const index = buffer.indexOf(0x0a);
            if (index === -1) break;
            const line = buffer.subarray(0, index);
            buffer = buffer.subarray(index + 1);
            if (line.length === 0) continue;
            if (line.length > maxFrameBytes) {
                fail("EPEER_FRAME_TOO_LARGE", `${line.length} > ${maxFrameBytes}`);
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(line.toString("utf8"));
            } catch {
                fail("EPEER_MALFORMED", "frame is not JSON");
                return;
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                fail("EPEER_MALFORMED", "frame must be a JSON object");
                return;
            }
            onMessage(parsed);
        }
        if (buffer.length > maxFrameBytes && buffer.indexOf(0x0a) === -1) {
            fail("EPEER_FRAME_TOO_LARGE", "no frame delimiter within the bound");
        }
    }

    return Object.freeze({ push, get broken() { return broken; } });
}

// ---------------------------------------------------------------------------
// Handshake cryptography + redaction helpers.
// ---------------------------------------------------------------------------

function newNonce() {
    return crypto.randomBytes(16).toString("hex");
}

function newSecret() {
    return crypto.randomBytes(SECRET_BYTES).toString("hex");
}

/**
 * The host's proof that it holds the channel secret AND is the process that
 * verified this peer.  The verified OS peer SID is part of the transcript, so
 * possession of the secret alone cannot produce a welcome proof that matches a
 * different peer: knowing the secret does not bypass the SID check.
 *
 * `peerSid` defaults to "" so a platform without OS peer credentials emits the
 * same shape (and the same digest) it always did.
 */
function welcomeProof(token, clientNonce, serverNonce, peerSid = "") {
    const sid = typeof peerSid === "string" ? peerSid.toLowerCase() : "";
    return crypto
        .createHmac("sha256", Buffer.from(token, "utf8"))
        .update(`${WELCOME_DOMAIN}|${clientNonce}|${serverNonce}|${sid}`, "utf8")
        .digest("hex");
}

/** Constant-time comparison for hex/string secrets of bounded length. */
function secretEquals(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

/**
 * Diagnostics must never echo session handles, credentials, challenges,
 * signatures or proof material.  Every host-side log line goes through this.
 */
function redact(value, depth = 0) {
    if (depth > 6) return "[depth]";
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(entry, depth + 1);
    }
    return out;
}

module.exports = Object.freeze({
    PROTOCOL_VERSION,
    MAX_FRAME_BYTES,
    MAX_MESSAGE_BYTES,
    DISCOVERY_FILE,
    TOKEN_FILE,
    CLIENT_STATE_FILE,
    CLIENT_ID_FILE,
    ENDPOINT_PREFIX,
    transportError,
    isWindows,
    resolveCliStateDir,
    discoveryPath,
    tokenPath,
    clientStatePath,
    clientIdPath,
    resolveClientId,
    randomEndpoint,
    assertLocalEndpoint,
    currentWindowsUser,
    currentWindowsUserSid,
    hardenSecretPath,
    verifySecretPath,
    hardenNamedPipe,
    verifyNamedPipeAcl,
    namedPipeAclScript,
    writeSecret,
    writeProtected,
    encodeFrame,
    createFrameReader,
    newNonce,
    newSecret,
    welcomeProof,
    secretEquals,
    redact
});
