"use strict";

/**
 * W5-CLI WINDOWS NATIVE PEER IDENTITY — Phase A/B/C/D/E: THE TRANSPORT THAT
 * KNOWS WHO THE PEER ACTUALLY IS.
 *
 * Node cannot ask a connected named-pipe client for its Windows token.  It owns
 * the connected instance through libuv, and libuv does not expose it, so
 * `ImpersonateNamedPipeClient` is unreachable from JavaScript.  Every previous
 * attempt to close that gap from inside the Node process failed (see
 * `windows-peer-hardening-evidence/03-windows-peer-sid-verification.md`).
 *
 * So a small in-box-compiled helper owns the public endpoint instead:
 *
 *   - it creates the pipe with a restrictive DACL AT CREATION TIME and refuses
 *     remote clients;
 *   - it impersonates the connected peer, reads the REAL token SID, compares it
 *     against the authorized principal the host passed in, and reverts;
 *   - it hands each verified peer to this process over private, inherited pipes
 *     that belong only to the host/helper process pair.
 *
 * This module is the host side of that boundary.  It is TRANSPORT ONLY:
 *
 *   - it never derives authorization from anything the client says.  The SID
 *     arrives on a channel no other process can write to, and it is still
 *     re-compared here against the authorized principal (two independent
 *     checks, helper and host);
 *   - peer metadata is validated as a strict, closed shape.  A second peer on a
 *     live slot, data before a peer, a close while idle, an oversized frame or
 *     an unknown field is a protocol violation and fails the whole transport
 *     closed — a stale or forged peer can never be resurrected onto a slot;
 *   - it decides nothing about approval.  Bytes are relayed opaquely; every
 *     authorization decision still happens in the canonical Manager.
 *
 * When the native helper cannot be established on Windows, this module throws.
 * There is no automatic downgrade to a shared-secret-only transport.
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Duplex } = require("node:stream");

const { transportError } = require("./localIpc");

/** Frame kinds, both directions.  Mirrors `src/cli/native/damar-peer-host.cs`. */
const K_DATA = 1;
const K_META = 2;
const K_CLOSED = 3;
const U_DATA = 1;
const U_DROP = 3;

const MAX_SLOT_FRAME = 1n << 20n;
const MAX_META_BYTES = 4096;
const CONNECT_READY_TIMEOUT_MS = 20_000;
const HELPER_SHUTDOWN_GRACE_MS = 2_000;
const SID_RE = /^S-1-[0-9-]{1,180}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const PEER_FIELDS = Object.freeze(["t", "v", "sid", "pid", "level", "session", "integrity", "conn", "nonce"]);

/**
 * The helper source is compiled by the in-box C# compiler only.  The compiled
 * artifact is named after the source hash, so a changed source can never be
 * masked by a stale binary.
 */
function resolvePeerHostExe({ stateDir, env = process.env, sourcePath } = {}) {
    const source = sourcePath ?? path.join(__dirname, "native", "damar-peer-host.cs");
    if (env.DAMAR_PEER_HOST_EXE) {
        if (!fs.existsSync(env.DAMAR_PEER_HOST_EXE)) {
            throw transportError("TRANSPORT_PEER_HELPER_UNAVAILABLE",
                `DAMAR_PEER_HOST_EXE does not exist: ${env.DAMAR_PEER_HOST_EXE}`);
        }
        return Object.freeze({ path: env.DAMAR_PEER_HOST_EXE, source: null, compiled: false });
    }
    if (!fs.existsSync(source)) {
        throw transportError("TRANSPORT_PEER_HELPER_UNAVAILABLE", `missing native peer host source: ${source}`);
    }
    const digest = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex").slice(0, 12);
    const target = path.join(stateDir, "native", `damar-peer-host-${digest}.exe`);
    if (fs.existsSync(target)) return Object.freeze({ path: target, source, compiled: false });

    const compiler = resolveCompiler();
    const out = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = require("node:child_process").spawnSync(
        compiler,
        ["/nologo", "/platform:anycpu", "/optimize+", `/out:${out}`, source],
        { encoding: "utf8", timeout: 180_000, windowsHide: true }
    );
    if (result.error || result.status !== 0 || !fs.existsSync(out)) {
        try { fs.rmSync(out, { force: true }); } catch { /* best effort */ }
        throw transportError("TRANSPORT_PEER_HELPER_BUILD_FAILED",
            `could not build the native peer host with ${compiler}: ${(result.stderr || result.stdout || result.error || "").trim().slice(0, 400)}`);
    }
    fs.renameSync(out, target);
    return Object.freeze({ path: target, source, compiled: true });
}

function resolveCompiler(env = process.env) {
    const framework = path.join(env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    if (fs.existsSync(framework)) return framework;
    const x86 = path.join(env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
    if (fs.existsSync(x86)) return x86;
    throw transportError("TRANSPORT_PEER_HELPER_BUILD_FAILED", "no in-box C# compiler (csc.exe) is available");
}

/**
 * A peer's identity as reported over the private host/helper channel.
 * Strict and closed on purpose: a field outside this list is a violation.
 */
function validatePeerMeta(text, authorizedSid) {
    let meta;
    try {
        meta = JSON.parse(text);
    } catch {
        return { ok: false, reason: "META_MALFORMED" };
    }
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return { ok: false, reason: "META_NOT_OBJECT" };
    for (const key of Object.keys(meta)) {
        if (!PEER_FIELDS.includes(key)) return { ok: false, reason: `META_UNKNOWN_FIELD:${key}` };
    }
    if (meta.t !== "peer") return { ok: false, reason: `META_UNEXPECTED_TYPE:${String(meta.t)}` };
    if (meta.v !== 1) return { ok: false, reason: "META_VERSION_UNSUPPORTED" };
    if (typeof meta.sid !== "string" || !SID_RE.test(meta.sid)) return { ok: false, reason: "META_SID_INVALID" };
    if (typeof authorizedSid !== "string" || meta.sid.toLowerCase() !== authorizedSid.toLowerCase()) {
        return { ok: false, reason: "META_SID_NOT_AUTHORIZED" };
    }
    if (!Number.isInteger(meta.pid) || meta.pid < -1) return { ok: false, reason: "META_PID_INVALID" };
    if (!Number.isInteger(meta.level) || meta.level < -1 || meta.level > 3) return { ok: false, reason: "META_LEVEL_INVALID" };
    if (!Number.isInteger(meta.session) || meta.session < -1) return { ok: false, reason: "META_SESSION_INVALID" };
    if (meta.integrity !== null && (typeof meta.integrity !== "string" || !SID_RE.test(meta.integrity))) {
        return { ok: false, reason: "META_INTEGRITY_INVALID" };
    }
    if (!Number.isInteger(meta.conn) || meta.conn < 1) return { ok: false, reason: "META_CONN_INVALID" };
    if (typeof meta.nonce !== "string" || !NONCE_RE.test(meta.nonce)) return { ok: false, reason: "META_NONCE_INVALID" };
    return { ok: true, meta };
}

/**
 * The per-slot socket the rest of the host sees.  It is a real Duplex, so the
 * certified channel code keeps working unchanged, and it carries the one thing
 * it did not have before: the verified Windows identity of whoever is on it.
 */
class PeerSlotSocket extends Duplex {
    constructor(slot, { sid, pid, level, session, integrity, conn, nonce, transport }) {
        super({ allowHalfOpen: true });
        this.slot = slot;
        this.generation = slot.generation;
        this.verifiedPeer = Object.freeze({
            sid, pid, level, session, integrity, conn, nonce,
            transport: "windows-native-peer-host"
        });
        this._transport = transport;
        this._timeoutMs = 0;
        this._timer = null;
        this._closed = false;
    }

    get peerIdentity() { return this.verifiedPeer; }

    // The certified channel code treats the socket as a net.Socket.
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }

    setTimeout(ms, listener) {
        if (typeof listener === "function") this.once("timeout", listener);
        this._timeoutMs = Number(ms) || 0;
        this._arm();
        return this;
    }

    _arm() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._timeoutMs > 0 && !this._closed) {
            this._timer = setTimeout(() => this.emit("timeout"), this._timeoutMs);
            if (typeof this._timer.unref === "function") this._timer.unref();
        }
    }

    _touch() { this._arm(); }

    _read() {
        // Backpressure release: let the private slot pipe produce again.
        this.slot.resume();
    }

    _write(chunk, _encoding, callback) {
        this._touch();
        if (this.slot.state !== "active" || this.slot.generation !== this.generation) {
            callback(transportError("TRANSPORT_PEER_GONE", "the peer channel ended with its connection"));
            return;
        }
        const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.slot.upstream.write(frame(U_DATA, body), (error) => callback(error ?? null));
    }

    _destroy(error, callback) {
        this._closed = true;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        this.slot.detach(this, error);
        callback(error ?? null);
    }

    /** Called by the slot when the peer's own connection ended. */
    _peerEnded() {
        this._closed = true;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        // End the readable side, then this side: both halves are done, so the
        // stream closes exactly as a net.Socket does when its peer goes away.
        // Buffered frames are drained first — a client that writes its last
        // request and then exits never loses it.
        this.push(null);
        if (!this.writableEnded) {
            try { this.end(); } catch { /* already ending */ }
        }
    }

    _deliver(chunk) {
        this._touch();
        if (!this.push(chunk)) this.slot.pause();
    }
}

function frame(kind, payload) {
    const body = payload ? (Buffer.isBuffer(payload) ? payload : Buffer.from(payload)) : Buffer.alloc(0);
    const head = Buffer.allocUnsafe(5);
    head.writeUInt8(kind, 0);
    head.writeUInt32LE(body.length, 1);
    return Buffer.concat([head, body]);
}

/**
 * Create the native peer transport.  Mirrors enough of `net.Server` for
 * `ipcServer.js` to swap it in: `.on("connection"|"error")`, `.listen()`,
 * `.close()`, `.maxConnections`.
 */
function createNativePeerTransport({
    endpoint,
    authorizedSid,
    stateDir,
    slots = 64,
    preAuthMs = 5000,
    helperExe,
    limits = {},
    logger = null,
    events = null
} = {}) {
    if (process.platform !== "win32") {
        throw transportError("TRANSPORT_PEER_VERIFICATION_UNAVAILABLE",
            "the native Windows peer transport is only available on win32");
    }
    if (typeof authorizedSid !== "string" || !SID_RE.test(authorizedSid)) {
        throw transportError("TRANSPORT_PEER_POLICY_INVALID", "the authorized peer principal is not a Windows SID");
    }
    const maxFrameBytes = limits.maxFrameBytes ?? 64 * 1024;
    if (!Number.isInteger(slots) || slots < 1 || slots > 128) {
        throw transportError("TRANSPORT_PEER_POLICY_INVALID", `unsupported slot count: ${slots}`);
    }

    const emitter = new (require("node:events").EventEmitter)();
    const slotStates = [];
    const record = (reason, detail = {}) => {
        const entry = Object.freeze({ t: "transport", reason, ...detail });
        if (typeof events === "function") { try { events(entry); } catch { /* never break serving on a log sink */ } }
    };
    const note = (reason, detail = {}) => {
        if (logger && typeof logger.note === "function") logger.note(reason, detail);
    };
    /** Opt-in diagnostics.  Never carries frame contents or secret material. */
    const trace = process.env.DAMAR_PEER_TRACE === "1"
        ? (reason, detail = {}) => record(reason, detail)
        : () => {};

    let child = null;
    let resolved = helperExe ? { path: helperExe, source: null, compiled: false } : null;
    let closing = false;
    let serving = false;
    let readyInfo = null;
    const stdio = ["pipe", "pipe", "pipe"];
    for (let i = 0; i < slots * 2; i += 1) stdio.push("pipe");

    /** Fail the whole transport closed: no degraded mode, no partial service. */
    function failClosed(code, message, cause) {
        const error = transportError(code, message);
        if (cause) error.cause = cause;
        for (const slot of slotStates) {
            try { slot.upstream?.destroy(); } catch { /* best effort */ }
            try { slot.downstream?.destroy(); } catch { /* best effort */ }
            if (slot.socket) {
                slot.state = "dead";
                try { slot.socket.destroy(error); } catch { /* best effort */ }
            }
        }
        try { child?.kill(); } catch { /* best effort */ }
        record(code, { message });
        emitter.emit("error", error);
    }

    function describeSlot(index) {
        const downstream = child.stdio[3 + index];
        const upstream = child.stdio[3 + slots + index];
        const slot = {
            index,
            downstream,
            upstream,
            state: "idle",
            generation: 0,
            socket: null,
            paused: false,
            decoder: null,
            pause() { if (!this.paused) { this.paused = true; this.downstream.pause(); } },
            resume() { if (this.paused) { this.paused = false; this.downstream.resume(); } },
            detach(socket, error) {
                // Only ever affects the connection that owns this generation, so
                // a stale socket can never drop a live successor peer.
                if (this.socket === socket && this.state === "active") {
                    if (this.generation === socket.generation) {
                        this.state = "dropping";
                        try { this.upstream.write(frame(U_DROP)); } catch { /* best effort */ }
                    }
                }
                if (error && this.state !== "dead" && !closing) record("slot_destroyed", { slot: index, code: error.code ?? null });
            }
        };
        slot.decoder = createSlotDecoder(slot);
        return slot;
    }

    function createSlotDecoder(slot) {
        let buffer = Buffer.alloc(0);
        return function onData(chunk) {
            buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
            for (;;) {
                if (buffer.length < 5) return;
                const kind = buffer.readUInt8(0);
                const length = buffer.readUInt32LE(1);
                if (BigInt(length) > MAX_SLOT_FRAME) {
                    failClosed("TRANSPORT_PEER_PROTOCOL_VIOLATION", `oversized frame from the peer host on slot ${slot.index}`);
                    return;
                }
                if (buffer.length < 5 + length) return;
                const payload = buffer.subarray(5, 5 + length);
                buffer = buffer.subarray(5 + length);
                if (!handleFrame(slot, kind, payload)) return;
            }
        };
    }

    /** Returns false when the transport has failed closed. */
    function handleFrame(slot, kind, payload) {
        trace("frame", { slot: slot.index, kind, len: payload.length, state: slot.state });
        if (kind === K_META) {
            if (slot.state === "active") {
                // A second peer on a live slot could re-attribute a connection
                // to different bytes.  Never tolerated.
                failClosed("TRANSPORT_PEER_PROTOCOL_VIOLATION", `second peer announcement on live slot ${slot.index}`);
                return false;
            }
            if (payload.length > MAX_META_BYTES) {
                failClosed("TRANSPORT_PEER_PROTOCOL_VIOLATION", `oversized peer metadata on slot ${slot.index}`);
                return false;
            }
            const text = payload.toString("utf8");
            let parsed;
            try { parsed = JSON.parse(text); } catch { parsed = null; }
            if (parsed && parsed.t === "deny") {
                // The helper refused the peer before forwarding a single byte.
                record("peer_denied", { slot: slot.index, helperReason: String(parsed.reason ?? "UNKNOWN").slice(0, 120) });
                slot.state = "idle";
                return true;
            }
            const verdict = validatePeerMeta(text, authorizedSid);
            if (!verdict.ok) {
                failClosed("TRANSPORT_PEER_UNVERIFIED", `peer metadata rejected on slot ${slot.index}: ${verdict.reason}`);
                return false;
            }
            slot.generation += 1;
            const socket = new PeerSlotSocket(slot, { ...verdict.meta, transport: transport });
            slot.socket = socket;
            slot.state = "active";
            record("peer_verified", { slot: slot.index, conn: verdict.meta.conn, sid: verdict.meta.sid });
            emitter.emit("connection", socket, socket.verifiedPeer);
            return true;
        }

        if (slot.state === "idle" || slot.state === "dead") {
            // Data with no announced peer: a peer could otherwise be resurrected
            // onto a slot it never owned.
            failClosed("TRANSPORT_PEER_PROTOCOL_VIOLATION", `frame before peer announcement on slot ${slot.index}`);
            return false;
        }

        if (kind === K_DATA) {
            if (payload.length > maxFrameBytes) {
                failClosed("TRANSPORT_PEER_PROTOCOL_VIOLATION", `client frame exceeds the bound on slot ${slot.index}`);
                return false;
            }
            if (slot.state === "active" && slot.socket) slot.socket._deliver(Buffer.from(payload));
            return true;   // bytes still in flight from a dropped peer are discarded
        }

        if (kind === K_CLOSED) {
            const socket = slot.socket;
            slot.socket = null;
            slot.state = "idle";
            slot.resume();
            if (socket) socket._peerEnded();
            return true;
        }

        failClosed("TRANSPORT_PEER_PROTOCOL_VIOLATION", `unknown frame kind ${kind} on slot ${slot.index}`);
        return false;
    }

    function onStdout(chunk) {
        stdoutBuffer += chunk.toString("utf8");
        let index;
        while ((index = stdoutBuffer.indexOf("\n")) !== -1) {
            const line = stdoutBuffer.slice(0, index).trim();
            stdoutBuffer = stdoutBuffer.slice(index + 1);
            if (line.length === 0) continue;
            let parsed;
            try { parsed = JSON.parse(line); } catch { record("helper_output_unparsable"); continue; }
            if (parsed.t === "ready") {
                readyInfo = parsed;
                // Everything the helper measured about its own endpoint is
                // carried through: the access control it APPLIED at creation,
                // the principal it will accept, and the remote-client refusal.
                record("helper_ready", {
                    pid: parsed.pid,
                    slots: parsed.slots,
                    dacl: parsed.dacl,
                    expectedDacl: parsed.expectedDacl ?? null,
                    authorizedSid: parsed.authorizedSid ?? null,
                    rejectRemoteClients: parsed.rejectRemoteClients === true,
                    endpoint: parsed.endpoint ?? null
                });
                continue;
            }
            if (parsed.t === "fatal") {
                record("helper_fatal", { reason: parsed.reason });
                failClosed("TRANSPORT_PEER_HELPER_FAILED", `the native peer host reported ${parsed.reason}`);
                return;
            }
            if (parsed.t === "log") {
                record("helper_log", { reason: parsed.reason, conn: parsed.conn ?? null, ms: Number.isInteger(parsed.ms) ? parsed.ms : null });
            }
        }
    }
    let stdoutBuffer = "";

    const transport = {
        kind: "windows-native-peer-host",
        get maxConnections() { return slots; },
        get peerIdentity() { return Object.freeze({ mechanism: "os-token-sid", sid: authorizedSid, verified: serving, slots }); },
        get helper() { return readyInfo ? Object.freeze({ pid: readyInfo.pid, slots: readyInfo.slots, dacl: readyInfo.dacl }) : null; },
        on(event, listener) { emitter.on(event, listener); return transport; },
        once(event, listener) { emitter.once(event, listener); return transport; },
        off(event, listener) { emitter.off(event, listener); return transport; },
        removeListener(event, listener) { emitter.off(event, listener); return transport; },

        listen(callback) {
            if (child) throw transportError("TRANSPORT_BIND_FAILED", "the native peer transport is already listening");
            resolved = resolved ?? resolvePeerHostExe({ stateDir });

            child = spawn(resolved.path, [
                "--endpoint", endpoint,
                "--authorized-sid", authorizedSid,
                "--slots", String(slots),
                "--preauth-ms", String(preAuthMs),
                // Opt-in latency trace for diagnostics.  The helper never puts
                // frame contents in it (see the helper header).
                ...(process.env.DAMAR_PEER_TRACE === "1" ? ["--trace"] : [])
            ], { stdio, windowsHide: true, env: helperEnvironment() });

            // Slots address the child's inherited pipes, so they can only be
            // described once the child (and therefore its stdio) exists.
            for (let i = 0; i < slots; i += 1) slotStates.push(describeSlot(i));

            child.on("error", (error) => failClosed("TRANSPORT_PEER_HELPER_FAILED", `could not start the native peer host: ${error.message}`, error));
            child.stdout.on("data", onStdout);
            child.stderr.on("data", (chunk) => {
                const text = chunk.toString("utf8").trim();
                if (text.length > 0) record("helper_stderr", { text: text.slice(0, 400) });
            });
            child.on("exit", (code, signal) => {
                if (closing) return;
                failClosed("TRANSPORT_PEER_HELPER_FAILED",
                    `the native peer host exited unexpectedly (code=${code} signal=${signal})`);
            });
            for (const slot of slotStates) {
                slot.downstream.on("data", slot.decoder);
                slot.downstream.on("error", (error) => failClosed("TRANSPORT_PEER_HELPER_FAILED", `peer host channel failed: ${error.message}`, error));
                slot.upstream.on("error", (error) => failClosed("TRANSPORT_PEER_HELPER_FAILED", `peer host channel failed: ${error.message}`, error));
            }

            const deadline = Date.now() + CONNECT_READY_TIMEOUT_MS;
            const wait = () => {
                if (closing) return;
                if (readyInfo) {
                    serving = true;
                    record("transport_ready", { endpoint, slots });
                    if (typeof callback === "function") callback();
                    return;
                }
                if (!child || child.exitCode !== null) return;
                if (Date.now() >= deadline) {
                    failClosed("TRANSPORT_BIND_FAILED", "the native peer host did not become ready in time");
                    return;
                }
                setTimeout(wait, 20).unref();
            };
            wait();
            return transport;
        },

        close(callback) {
            closing = true;
            serving = false;
            for (const slot of slotStates) {
                try { slot.socket?.destroy(); } catch { /* best effort */ }
                try { slot.downstream.destroy(); } catch { /* best effort */ }
                try { slot.upstream.destroy(); } catch { /* best effort */ }
            }
            const finish = () => { if (typeof callback === "function") callback(); };
            if (!child) { finish(); return transport; }
            const timer = setTimeout(() => { try { child.kill(); } catch { /* best effort */ } finish(); }, HELPER_SHUTDOWN_GRACE_MS);
            child.once("exit", () => { clearTimeout(timer); finish(); });
            try { child.stdin.end(); } catch { /* best effort */ }
            for (const slot of slotStates) {
                try { slot.downstream.destroy(); } catch { /* best effort */ }
                try { slot.upstream.destroy(); } catch { /* best effort */ }
            }
            return transport;
        }
    };

    return transport;
}

/**
 * The helper inherits nothing useful and is told nothing extra: it gets the
 * endpoint, the authorized principal and its own slot count on the command
 * line, and no secret of any kind.
 */
function helperEnvironment() {
    const { SystemRoot, windir, PATH, TEMP, TMP } = process.env;
    return { SystemRoot, windir, PATH, TEMP, TMP };
}

module.exports = {
    createNativePeerTransport,
    resolvePeerHostExe,
    resolveCompiler,
    validatePeerMeta,
    PeerSlotSocket,
    frame,
    K_DATA,
    K_META,
    K_CLOSED,
    U_DATA,
    U_DROP
};
