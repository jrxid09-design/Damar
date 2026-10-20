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
 * PEER AUTHENTICATION (honest scope — see evidence 09-transport-design.md)
 *   Node's `net` exposes NO peer SID/UID/PID API on either platform, and the
 *   Windows named-pipe DACL is not settable from pure Node.  Therefore peer
 *   identity CANNOT be proven by the runtime library.  What this transport
 *   does instead:
 *
 *     1. OS-level endpoint confinement.  The endpoint is never a network
 *        listener, so no remote principal can reach it.
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
 *   verified property is "this connection proved possession of a secret that
 *   the OS confines to one local principal"; that is recorded honestly as
 *   PARTIAL peer identity, NOT a SID/UID check.
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

function welcomeProof(token, clientNonce, serverNonce) {
    return crypto
        .createHmac("sha256", Buffer.from(token, "utf8"))
        .update(`${WELCOME_DOMAIN}|${clientNonce}|${serverNonce}`, "utf8")
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
