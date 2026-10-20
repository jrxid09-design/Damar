"use strict";

/**
 * W5-CLI REAL CONNECTED CLI — Phase B/E: THE LOCAL IPC SERVER.
 *
 * Hosts the certified canonical CLI session bridge (`src/integration/
 * cliSessionBridge.js`) behind a bounded, OS-confined local endpoint.  This
 * file is TRANSPORT + HARDENING ONLY:
 *
 *   - no authority is created here; every operation is forwarded to the
 *     bridge, which forwards consequential work to the canonical Manager;
 *   - the endpoint's OS access control is rewritten to the owning principal /
 *     SYSTEM / Administrators and re-verified by effective access mask BEFORE
 *     the descriptor is published (Phase B); a failed or unverifiable ACL is a
 *     refusal to serve, never a fallback;
 *   - the bridge connection handle issued by `authComplete` is BOUND to the
 *     verified client identity that minted it, so a handle observed by any
 *     other local client can never be replayed (see `connectionOwned`);
 *   - nothing is served before the channel handshake completes — including
 *     `status` (audit P3-1);
 *   - challenge minting is rate limited per channel AND globally (P3-2);
 *   - every request is schema-validated against a closed allow-list before it
 *     reaches the bridge, so caller-supplied authority / owner / privilege /
 *     approval claims are rejected structurally (P3-7, P3-8);
 *   - frames, pending bytes, in-flight requests, channels and idle time are
 *     all bounded (P3-6); disconnect and shutdown revoke and clean up (P3-5).
 */

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const {
    MAX_FRAME_BYTES,
    MAX_MESSAGE_BYTES,
    PROTOCOL_VERSION,
    assertLocalEndpoint,
    createFrameReader,
    discoveryPath,
    encodeFrame,
    hardenNamedPipe,
    currentWindowsUserSid,
    newNonce,
    newSecret,
    randomEndpoint,
    redact,
    secretEquals,
    tokenPath,
    verifyNamedPipeAcl,
    welcomeProof,
    writeSecret,
    verifySecretPath,
    hardenSecretPath,
    transportError
} = require("./localIpc");

const { createNativePeerTransport } = require("./nativePeerTransport");

const OPS = Object.freeze([
    "status", "authBegin", "authComplete", "session",
    "actionChallenge", "capabilities", "submit", "logout"
]);

const MINTING_OPS = Object.freeze(["authBegin", "actionChallenge"]);

/** Closed allow-list.  Unknown keys are a hard rejection, never ignored. */
const ARG_SCHEMA = Object.freeze({
    status: Object.freeze({ connectionId: "string?" }),
    authBegin: Object.freeze({ deviceId: "string", surfaceId: "string" }),
    authComplete: Object.freeze({
        deviceId: "string", surfaceId: "string", nonce: "string",
        signature: "string", bindingSecret: "string", peer: "string?"
    }),
    session: Object.freeze({ connectionId: "string" }),
    actionChallenge: Object.freeze({ connectionId: "string" }),
    capabilities: Object.freeze({ connectionId: "string" }),
    submit: Object.freeze({
        connectionId: "string", capabilityId: "string", operation: "string",
        arguments: "object?", authProof: "object?"
    }),
    logout: Object.freeze({ connectionId: "string" })
});

const DEFAULT_LIMITS = Object.freeze({
    maxFrameBytes: MAX_FRAME_BYTES,
    maxMessageBytes: MAX_MESSAGE_BYTES,
    maxChannels: 64,
    maxInFlightPerChannel: 8,
    maxChannelPendingBytes: 256 * 1024,
    maxPeers: 256,
    maxBoundHandles: 4096,
    idleTimeoutMs: 120_000,
    handshakeTimeoutMs: 10_000,
    requestTimeoutMs: 60_000,
    windowMs: 60_000,
    challengeBurstPerChannel: 30,
    challengeBurstGlobal: 120
});

function nowMs() {
    return Date.now();
}

/** True when `pid` is a live process this host can observe. */
function isProcessAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

function validateArgs(op, args) {
    const schema = ARG_SCHEMA[op];
    if (schema === undefined) return { ok: false, detail: "unknown operation" };
    if (args === undefined || args === null) args = {};
    if (typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, detail: "args must be an object" };
    }
    const proto = Object.getPrototypeOf(args);
    if (proto !== Object.prototype && proto !== null) {
        return { ok: false, detail: "args must be a plain object" };
    }
    for (const key of Object.keys(args)) {
        if (!Object.prototype.hasOwnProperty.call(schema, key)) {
            // Includes any caller-supplied principal / owner / authority /
            // approval / grant claim: rejected, never silently dropped.
            return { ok: false, detail: `unsupported field "${key}"` };
        }
    }
    for (const [key, spec] of Object.entries(schema)) {
        const optional = spec.endsWith("?");
        const kind = optional ? spec.slice(0, -1) : spec;
        const value = args[key];
        if (value === undefined || value === null) {
            if (!optional) return { ok: false, detail: `${key} required` };
            continue;
        }
        if (kind === "string") {
            if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 8192) {
                return { ok: false, detail: `${key} must be a bounded non-empty string` };
            }
        } else if (kind === "object") {
            if (typeof value !== "object" || Array.isArray(value)) {
                return { ok: false, detail: `${key} must be an object` };
            }
        }
    }
    return { ok: true };
}

/** State dirs currently served by a server in THIS process (never share one). */
const ownedStateDirs = new Set();

/**
 * Refuse to share a state directory with a LIVE CLI host, and clear a stale
 * descriptor left by a crashed one.  Exported so the host can run this check
 * BEFORE it composes anything: a second host must fail on the real conflict
 * (the endpoint is taken), not on whatever composition lock it hits first.
 */
function clearStaleDiscovery(stateDir) {
    const key = path.resolve(stateDir);
    if (ownedStateDirs.has(key)) {
        throw transportError("TRANSPORT_ENDPOINT_IN_USE", "a live Damar CLI host already owns this state dir");
    }
    const discovery = discoveryPath(stateDir);
    if (!fs.existsSync(discovery)) return { replaced: false };
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(discovery, "utf8")); } catch { prior = null; }
    const priorPid = prior && Number.isSafeInteger(prior.pid) ? prior.pid : null;
    if (priorPid !== null && isProcessAlive(priorPid)) {
        throw transportError("TRANSPORT_ENDPOINT_IN_USE", "a live Damar CLI host already owns this state dir");
    }
    try { fs.unlinkSync(discovery); } catch { /* already gone */ }
    return { replaced: true };
}

/** Disconnect policies.  `survive` is the certified, shipped behaviour. */
const DISCONNECT_POLICIES = Object.freeze(["survive", "revoke"]);

/**
 * createCliIpcServer({ bridge, stateDir, limits, logger, disconnectPolicy })
 *
 * @param bridge   the canonical CLI session bridge (`{ request, close }`).
 * @param stateDir the canonical Damar state dir (derived from the trusted
 *                 OwnerTrust store path — never caller-choosable per call).
 * @param disconnectPolicy
 *                 `survive` (default) — a disconnect releases the transport
 *                 channel but leaves the canonical session alive.  Required by
 *                 the one-shot CLI, whose every command is a NEW process, and
 *                 safe because every consequential submit still needs a fresh
 *                 one-use Owner proof.
 *                 `revoke` — a disconnect invalidates the session
 *                 authorization context of every handle that channel used, and
 *                 a reconnect must run a fresh ceremony.  This is the stricter
 *                 policy the hardening mission prefers; it is NOT the default
 *                 because it is a breaking product-contract change (a
 *                 one-shot `submit` process would find its session already
 *                 revoked) and flipping it needs explicit Owner approval.
 */
function createCliIpcServer({ bridge, stateDir, limits = {}, logger = null, disconnectPolicy = "survive" } = {}) {
    if (!bridge || typeof bridge.request !== "function") {
        throw transportError("TRANSPORT_CONFIG", "a canonical CLI session bridge is required");
    }
    if (typeof stateDir !== "string" || stateDir.trim() === "") {
        throw transportError("TRANSPORT_CONFIG", "a state directory is required");
    }
    if (!DISCONNECT_POLICIES.includes(disconnectPolicy)) {
        throw transportError("TRANSPORT_CONFIG", `disconnectPolicy must be one of ${DISCONNECT_POLICIES.join(", ")}`);
    }
    const bound = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    const log = typeof logger === "function" ? logger : () => {};

    const channels = new Map();
    /** connectionId -> the client identity that minted it (survives a disconnect). */
    const boundHandles = new Map();
    /**
     * connectionIds invalidated on disconnect under `disconnectPolicy:
     * "revoke"`.  Kept as a local tombstone so the invalidation is IMMEDIATE —
     * a fast reconnect can never race the canonical logout call.
     */
    const revokedHandles = new Set();
    /** client identity -> recent challenge-mint timestamps (PER PEER, not per socket). */
    const mintBuckets = new Map();
    let server = null;
    let endpoint = null;
    let token = null;
    let aclEvidence = null;
    /**
     * Who this host can prove it is talking to.  On Windows the peer's real OS
     * token SID is verified by the native peer host before a single byte is
     * forwarded; on other platforms there is no OS peer credential check and the
     * field says so instead of implying one.
     */
    let peerIdentity = null;
    let globalMints = [];
    let stopping = false;

    function note(event, detail) {
        log(JSON.stringify({ at: new Date().toISOString(), event, ...redact(detail ?? {}) }));
    }

    // ---- rate limiting (P3-2) --------------------------------------------

    function mintAllowed(channel) {
        const now = nowMs();
        const cutoff = now - bound.windowMs;
        const peer = channel.peerBinding;
        const bucket = (mintBuckets.get(peer) ?? []).filter((at) => at > cutoff);
        globalMints = globalMints.filter((at) => at > cutoff);
        if (bucket.length >= bound.challengeBurstPerChannel) {
            mintBuckets.set(peer, bucket);
            return { ok: false, retryAfterMs: bucket[0] + bound.windowMs - now };
        }
        if (globalMints.length >= bound.challengeBurstGlobal) {
            mintBuckets.set(peer, bucket);
            return { ok: false, retryAfterMs: globalMints[0] + bound.windowMs - now };
        }
        bucket.push(now);
        mintBuckets.set(peer, bucket);
        globalMints.push(now);
        if (mintBuckets.size > bound.maxPeers) {
            for (const [key, value] of mintBuckets) {
                if (value.length === 0) mintBuckets.delete(key);
                if (mintBuckets.size <= bound.maxPeers) break;
            }
        }
        return { ok: true };
    }

    // ---- framing ---------------------------------------------------------

    function send(socket, message) {
        if (socket.destroyed || !socket.writable) return;
        let frame;
        try {
            frame = encodeFrame(message);
        } catch {
            return;
        }
        try {
            socket.write(frame);
        } catch { /* peer gone; cleanup runs from the close handler */ }
    }

    /** Bounded insertion-ordered tombstone set. */
    function revoke(connectionId) {
        revokedHandles.add(connectionId);
        while (revokedHandles.size > bound.maxBoundHandles) {
            const oldest = revokedHandles.values().next().value;
            if (oldest === undefined) break;
            revokedHandles.delete(oldest);
        }
    }

    function destroyChannel(channel, reason) {
        if (channel.closed) return;
        channel.closed = true;
        channels.delete(channel.id);

        if (disconnectPolicy === "revoke" && channel.authed === true) {
            // The channel's session authorization context dies with it.  The
            // tombstone is applied synchronously so no request can slip
            // through; the canonical logout is issued for the durable record.
            for (const connectionId of channel.handles) {
                boundHandles.delete(connectionId);
                revoke(connectionId);
                Promise.resolve()
                    .then(() => bridge.request({ op: "logout", connectionId, channelBinding: channel.peerBinding }))
                    .catch((error) => note("disconnect.revoke.failed", { code: error?.code ?? "UNKNOWN" }));
            }
            if (channel.handles.size > 0) {
                note("disconnect.revoked", { channelId: channel.id, reason, handles: channel.handles.size });
            }
        } else {
            // NOTE (deliberate, certified behaviour): a verified peer that
            // disconnects does NOT have its session revoked.  A one-shot CLI
            // process connects, acts and exits; revoking on disconnect would
            // make the connected CLI unusable.  Every consequential submit
            // still needs a FRESH one-use Owner proof, so an abandoned handle
            // grants nothing.  Sessions end on logout, expiry, canonical device
            // revocation or host shutdown.
        }

        note("channel.closed", { channelId: channel.id, reason });
        try { channel.socket.destroy(); } catch { /* best effort */ }
    }

    function deny(channel, id, code, detail) {
        send(channel.socket, { v: PROTOCOL_VERSION, t: "res", id: id ?? null, ok: false, code, detail: String(detail ?? "").slice(0, 256) });
    }

    function bindChannel(channel, result) {
        if (result && result.ok === true && typeof result.connectionId === "string") {
            // A handle belongs to (caller identity, VERIFIED OS peer SID).  The
            // SID is never taken from the client, so a stolen handle is unusable
            // even by another connection that claims the same identity.
            boundHandles.set(result.connectionId, Object.freeze({
                clientId: channel.peerBinding,
                sid: channel.peerSid
            }));
            if (boundHandles.size > bound.maxBoundHandles) {
                const oldest = boundHandles.keys().next().value;
                if (oldest !== undefined) boundHandles.delete(oldest);
            }
        }
        return result;
    }

    /**
     * A bridge connection handle is usable only by the client identity that
     * minted it.  Two DIFFERENT answers, deliberately:
     *
     *   - the handle IS known here but was minted by another client identity
     *     => refused at the transport (`EPEER_CHANNEL_MISMATCH`), before the
     *      bridge is entered, so a swiped handle never even reaches ingress;
     *   - the handle is NOT known here (never minted, revoked by `logout`, or
     *     minted in another host process) => forwarded to the bridge, which
     *     answers with the canonical `OT_SESSION_UNKNOWN`.  That keeps the
     *     error accurate instead of disguising an unknown handle as a
     *     cross-client attack.
     */
    function checkBinding(channel, connectionId) {
        if (revokedHandles.has(connectionId)) {
            // A handle invalidated by the approved disconnect policy is refused
            // IMMEDIATELY, so no request can ever race the canonical logout.
            // The code is the canonical one; the shape is a transport refusal
            // because the transport reached the verdict, not the bridge.
            return {
                ok: false,
                code: "OT_SESSION_UNKNOWN",
                detail: "the session authorization context ended with its connection"
            };
        }
        const owner = boundHandles.get(connectionId);
        if (owner === undefined) return { ok: true };
        if (owner.clientId === channel.peerBinding && owner.sid === channel.peerSid) return { ok: true };
        return { ok: false, code: "EPEER_CHANNEL_MISMATCH", detail: "connection handle is bound to another peer identity" };
    }

    // ---- request handling ------------------------------------------------

    async function handleAuthedFrame(channel, frame) {
        const id = typeof frame.id === "string" ? frame.id : null;
        const op = frame.op;
        if (id === null) return deny(channel, null, "EPEER_MALFORMED", "request id required");
        if (typeof op !== "string" || !OPS.includes(op)) {
            return deny(channel, id, "EPEER_UNKNOWN_OP", "unsupported operation");
        }
        const check = validateArgs(op, frame.args);
        if (!check.ok) return deny(channel, id, "EPEER_SCHEMA", check.detail);
        const args = frame.args ?? {};

        if (MINTING_OPS.includes(op)) {
            const allowed = mintAllowed(channel);
            if (!allowed.ok) {
                note("ratelimit", { channelId: channel.id, op });
                return deny(channel, id, "EPEER_RATE_LIMITED", `retry in ${allowed.retryAfterMs}ms`);
            }
        }

        if (args.connectionId !== undefined) {
            const binding = checkBinding(channel, args.connectionId);
            if (!binding.ok) {
                return deny(channel, id, binding.code, binding.detail);
            }
            if (typeof args.connectionId === "string") channel.handles.add(args.connectionId);
        }

        if (channel.inFlight >= bound.maxInFlightPerChannel) {
            return deny(channel, id, "EPEER_BACKPRESSURE", "too many in-flight requests");
        }
        if (channel.socket.writableLength > bound.maxChannelPendingBytes) {
            return deny(channel, id, "EPEER_BACKPRESSURE", "write queue saturated");
        }

        channel.inFlight += 1;
        let timer = null;
        try {
            const result = await Promise.race([
                Promise.resolve(bridge.request({
                    op, ...args,
                    channelBinding: channel.peerBinding,
                    // Appended AFTER the caller's fields, and never derived from
                    // them: a client cannot claim, override or omit the peer
                    // identity its socket was verified with.
                    peerIdentity: channel.peerSid === null
                        ? undefined
                        : Object.freeze({ mechanism: "os-token-sid", sid: channel.peerSid })
                })),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(transportError("EPEER_TIMEOUT", "request timed out")), bound.requestTimeoutMs);
                    if (typeof timer.unref === "function") timer.unref();
                })
            ]);

            if (op === "authComplete") {
                bindChannel(channel, result);
                // The session this channel minted belongs to this channel's
                // authorization context: remember it so a disconnect under the
                // `revoke` policy can invalidate it.
                if (result && result.ok === true && typeof result.connectionId === "string") {
                    channel.handles.add(result.connectionId);
                }
            }
            if (op === "logout" && result && result.ok === true) {
                boundHandles.delete(args.connectionId);
            }
            send(channel.socket, { v: PROTOCOL_VERSION, t: "res", id, ok: true, result });
        } catch (error) {
            deny(channel, id, error?.code ?? "EPEER_INTERNAL", error?.message ?? "transport failure");
        } finally {
            if (timer !== null) clearTimeout(timer);
            channel.inFlight -= 1;
        }
    }

    function handleHandshakeFrame(channel, frame) {
        if (frame.t !== "hello" || frame.v !== PROTOCOL_VERSION) {
            // Nothing is disclosed before authentication — not even status.
            deny(channel, null, "EPEER_UNAUTHENTICATED", "handshake required");
            return destroyChannel(channel, "unauthenticated");
        }
        const offered = frame.token;
        if (typeof offered !== "string" || !secretEquals(offered, token)) {
            note("handshake.rejected", { channelId: channel.id });
            deny(channel, null, "EPEER_UNAUTHENTICATED", "handshake required");
            return destroyChannel(channel, "bad-secret");
        }
        const clientNonce = typeof frame.cnonce === "string" && /^[0-9a-f]{16,64}$/.test(frame.cnonce) ? frame.cnonce : null;
        if (clientNonce === null) {
            deny(channel, null, "EPEER_MALFORMED", "handshake nonce required");
            return destroyChannel(channel, "bad-nonce");
        }
        const clientId = typeof frame.clientId === "string" && /^[0-9a-f]{32}$/.test(frame.clientId) ? frame.clientId : null;
        if (clientId === null) {
            deny(channel, null, "EPEER_MALFORMED", "handshake client identity required");
            return destroyChannel(channel, "bad-client-id");
        }
        if (channels.size >= bound.maxChannels) {
            deny(channel, null, "EPEER_BACKPRESSURE", "channel limit reached");
            return destroyChannel(channel, "channel-limit");
        }
        channel.authed = true;
        channel.clientNonce = clientNonce;
        channel.peerBinding = clientId;
        const serverNonce = newNonce();
        channel.serverNonce = serverNonce;
        if (channel.handshakeTimer !== null) {
            clearTimeout(channel.handshakeTimer);
            channel.handshakeTimer = null;
        }
        channel.socket.setTimeout(bound.idleTimeoutMs);
        note("handshake.accepted", { channelId: channel.id });
        send(channel.socket, {
            v: PROTOCOL_VERSION,
            t: "welcome",
            snonce: serverNonce,
            // The verified peer SID the host is bound to, "" when the platform
            // has no OS peer credential check.  It is inside the proof, so the
            // client can detect a substituted or missing value.
            sid: channel.peerSid ?? "",
            proof: welcomeProof(token, clientNonce, serverNonce, channel.peerSid ?? "")
        });
    }

    function onFrame(channel, frame) {
        if (!channel.authed) return handleHandshakeFrame(channel, frame);
        if (frame.t !== "req") {
            return deny(channel, typeof frame.id === "string" ? frame.id : null, "EPEER_MALFORMED", "expected a request frame");
        }
        // Never let a rejection become an unhandled rejection.
        handleAuthedFrame(channel, frame).catch((error) => {
            deny(channel, typeof frame.id === "string" ? frame.id : null, error?.code ?? "EPEER_INTERNAL", error?.message ?? "");
        });
    }

    function onConnection(socket, verifiedPeer = null) {
        const channel = {
            id: `chan-${newNonce()}`,
            socket,
            authed: false,
            peerBinding: null,
            /**
             * The OS-verified SID of whoever is on this socket.  Set only from
             * the transport's verified peer record — never from anything the
             * client sends — and covered by the welcome proof below.
             */
            peerSid: typeof verifiedPeer?.sid === "string" ? verifiedPeer.sid : null,
            /**
             * The native connection instance this channel runs on (slot / conn
             * id / handshake nonce).  It scopes the CHANNEL CONTEXT — it is not
             * the handle binding, because a one-shot CLI uses a fresh connection
             * per command under the default SURVIVE policy.
             */
            verifiedPeer: verifiedPeer === null ? null : Object.freeze({
                sid: typeof verifiedPeer.sid === "string" ? verifiedPeer.sid : null,
                conn: Number.isInteger(verifiedPeer.conn) ? verifiedPeer.conn : null,
                nonce: typeof verifiedPeer.nonce === "string" ? verifiedPeer.nonce : null
            }),
            clientNonce: null,
            serverNonce: null,
            inFlight: 0,
            handshakeTimer: null,
            closed: false,
            /** connectionIds this channel used (for `revoke` on disconnect). */
            handles: new Set()
        };
        channels.set(channel.id, channel);
        socket.setNoDelay(true);
        socket.setTimeout(bound.handshakeTimeoutMs);
        channel.handshakeTimer = null;

        const reader = createFrameReader({
            maxFrameBytes: bound.maxFrameBytes,
            onMessage: (frame) => onFrame(channel, frame),
            onViolation: (error) => {
                note("frame.violation", { channelId: channel.id, code: error.code });
                deny(channel, null, error.code, error.message);
                destroyChannel(channel, error.code);
            }
        });

        socket.on("data", (chunk) => {
            // Bounded read side: never accumulate more than one frame bound.
            if (chunk.length > bound.maxFrameBytes) {
                deny(channel, null, "EPEER_FRAME_TOO_LARGE", "chunk exceeds the frame bound");
                return destroyChannel(channel, "chunk-too-large");
            }
            reader.push(chunk);
        });
        socket.on("timeout", () => destroyChannel(channel, channel.authed ? "idle-timeout" : "handshake-timeout"));
        socket.on("error", () => destroyChannel(channel, "socket-error"));
        socket.on("close", () => destroyChannel(channel, "peer-closed"));
    }

    // ---- lifecycle -------------------------------------------------------

    async function start() {
        if (server !== null) throw transportError("TRANSPORT_STATE", "already started");
        fs.mkdirSync(stateDir, { recursive: true });
        if (!fs.statSync(stateDir).isDirectory()) {
            throw transportError("TRANSPORT_CONFIG", "state dir is not a directory");
        }

        // A live host already owning this state dir must NOT be displaced
        // (endpoint collision / squatted discovery file), and a client must
        // never be pointed at a stale endpoint: fail closed, never take over.
        clearStaleDiscovery(stateDir);
        const discovery = discoveryPath(stateDir);
        try { fs.unlinkSync(tokenPath(stateDir)); } catch { /* no stale secret */ }

        token = newSecret();
        const tokenAcl = writeSecret(tokenPath(stateDir), token);

        endpoint = randomEndpoint();
        assertLocalEndpoint(endpoint, stateDir);

        // Order matters.  The endpoint is BOUND first, then its OS access
        // control is proven readable, and only then is the discovery file
        // published.  A client can therefore never be pointed at an endpoint
        // whose access control has not been verified.
        if (process.platform === "win32") {
            // WINDOWS NATIVE PEER IDENTITY.  The endpoint is owned by the native
            // peer host: it applies a restrictive DACL AT CREATION TIME, refuses
            // remote clients, and verifies each peer's real Windows token before
            // a single byte is forwarded to this process.  The authorized
            // principal is the host's OWN user, resolved from the OS — never from
            // an environment variable or anything a client supplies.  If it
            // cannot be resolved there is no verified-SID transport, so this
            // fails closed rather than falling back to shared-secret only.
            const authorizedSid = currentWindowsUserSid();
            if (typeof authorizedSid !== "string" || !/^S-1-[0-9-]{1,180}$/.test(authorizedSid)) {
                throw transportError("TRANSPORT_PEER_VERIFICATION_UNAVAILABLE",
                    "cannot resolve the authorized peer SID from the operating system");
            }
            peerIdentity = Object.freeze({ mechanism: "os-token-sid", sid: authorizedSid, verified: false, slots: bound.maxChannels });
            server = createNativePeerTransport({
                endpoint,
                authorizedSid,
                stateDir,
                slots: bound.maxChannels,
                // Bounded pre-authentication: a client that connects and says
                // nothing is dropped instead of parking a worker forever.
                preAuthMs: 5000,
                logger: { note: (reason, detail) => note(reason, detail) },
                events: (entry) => note(`peer.${entry.reason}`, entry)
            });
            // The verified peer record is the transport's, not the client's: it
            // is passed to the same connection handler the socket transport uses.
            server.on("connection", (socket, verifiedPeer) => onConnection(socket, verifiedPeer));
            try {
                await new Promise((resolve, reject) => {
                    const onError = (error) => reject(transportError("TRANSPORT_BIND_FAILED", error?.message ?? "bind failed"));
                    server.once("error", onError);
                    server.listen(() => {
                        server.removeListener("error", onError);
                        resolve();
                    });
                });
            } catch (error) {
                try { server.close(); } catch { /* never bound */ }
                server = null;
                peerIdentity = null;
                throw error;
            }
            peerIdentity = Object.freeze({ mechanism: "os-token-sid", sid: authorizedSid, verified: true, slots: bound.maxChannels });
        } else {
            server = net.createServer(onConnection);
            server.maxConnections = bound.maxChannels;
            try {
                await new Promise((resolve, reject) => {
                    const onError = (error) => reject(transportError("TRANSPORT_BIND_FAILED", error?.message ?? "bind failed"));
                    server.once("error", onError);
                    server.listen(endpoint, () => {
                        server.removeListener("error", onError);
                        resolve();
                    });
                });
            } catch (error) {
                try { server.close(); } catch { /* never bound */ }
                server = null;
                throw error;
            }
            // Documented, permanent limit on this platform: there is no OS peer
            // credential check here, only the channel secret.
            peerIdentity = Object.freeze({ mechanism: "none", sid: null, verified: false, slots: bound.maxChannels });
        }

        let pipeAcl = null;
        let discoveryAcl = null;
        try {
            // On Windows the DACL was applied by the process that created the
            // pipe; this call proves it from the serving process, and refuses an
            // endpoint that foreign principals can reach.
            pipeAcl = process.platform === "win32" ? verifyNamedPipeAcl(endpoint) : hardenNamedPipe(endpoint);
            fs.writeFileSync(discovery, `${JSON.stringify({
                v: PROTOCOL_VERSION,
                endpoint,
                tokenFile: tokenPath(stateDir),
                pid: process.pid,
                platform: process.platform,
                startedAtMs: nowMs()
            })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
            hardenSecretPath(discovery);
            discoveryAcl = verifySecretPath(discovery);
        } catch (error) {
            // FAIL CLOSED: never serve on an endpoint whose OS access control
            // was not proven, and never leave a descriptor behind.
            try { fs.unlinkSync(discovery); } catch { /* best effort */ }
            await new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
            server = null;
            try { fs.unlinkSync(tokenPath(stateDir)); } catch { /* best effort */ }
            token = null;
            endpoint = null;
            peerIdentity = null;
            throw error;
        }
        aclEvidence = Object.freeze({ token: tokenAcl, discovery: discoveryAcl, pipe: pipeAcl });

        ownedStateDirs.add(path.resolve(stateDir));
        server.on("error", (error) => note("server.error", { code: error?.code ?? "UNKNOWN" }));
        note("server.listening", { endpoint, pipeAcl: pipeAcl.status, peerMechanism: peerIdentity.mechanism });
        return Object.freeze({ endpoint, stateDir, acl: aclEvidence, peerIdentity });
    }

    async function stop() {
        if (stopping) return;
        stopping = true;
        for (const channel of [...channels.values()]) destroyChannel(channel, "shutdown");
        if (server !== null) {
            await new Promise((resolve) => server.close(() => resolve()));
            server = null;
        }
        ownedStateDirs.delete(path.resolve(stateDir));
        try { fs.unlinkSync(discoveryPath(stateDir)); } catch { /* best effort */ }
        try { fs.unlinkSync(tokenPath(stateDir)); } catch { /* best effort */ }
        boundHandles.clear();
        revokedHandles.clear();
        mintBuckets.clear();
        peerIdentity = null;
        note("server.stopped", {});
    }

    function info() {
        return Object.freeze({
            endpoint,
            channels: channels.size,
            authenticated: [...channels.values()].filter((c) => c.authed).length,
            peers: mintBuckets.size,
            boundHandles: boundHandles.size,
            revokedHandles: revokedHandles.size,
            disconnectPolicy,
            peerIdentity,
            acl: aclEvidence,
            limits: bound
        });
    }

    return Object.freeze({ start, stop, info, ops: OPS, disconnectPolicy });
}

module.exports = Object.freeze({ createCliIpcServer, clearStaleDiscovery, OPS, ARG_SCHEMA, DEFAULT_LIMITS, DISCONNECT_POLICIES, validateArgs });
