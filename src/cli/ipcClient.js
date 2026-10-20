"use strict";

/**
 * W5-CLI REAL CONNECTED CLI — Phase B/D: THE LOCAL IPC CLIENT.
 *
 * Runs in the CLI's OWN operating-system process.  It holds no Damar
 * authority: it connects, proves possession of the OS-confined channel
 * secret, and forwards the canonical bridge operations.  Every authorization
 * decision still happens in the host process inside the canonical Manager.
 */

const fs = require("node:fs");
const net = require("node:net");

const {
    MAX_FRAME_BYTES,
    PROTOCOL_VERSION,
    assertLocalEndpoint,
    createFrameReader,
    discoveryPath,
    encodeFrame,
    newNonce,
    resolveClientId,
    secretEquals,
    tokenPath,
    verifySecretPath,
    welcomeProof,
    transportError
} = require("./localIpc");

/** Read the ACL-confined discovery record, or explain why there is no host. */
function readDiscovery(stateDir) {
    const file = discoveryPath(stateDir);
    if (!fs.existsSync(file)) {
        throw transportError("TRANSPORT_HOST_ABSENT", `no local Damar CLI host is registered in ${stateDir}`);
    }
    let record;
    try {
        record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        throw transportError("TRANSPORT_HOST_ABSENT", "the local host descriptor is unreadable");
    }
    if (!record || typeof record !== "object" || record.v !== PROTOCOL_VERSION) {
        throw transportError("TRANSPORT_HOST_ABSENT", "the local host descriptor is not a supported version");
    }
    return record;
}

/**
 * Connect and authenticate.  Resolves only after the SERVER has proven it
 * also knows the channel secret, so a process squatting the endpoint cannot
 * impersonate the host.
 */
async function connectCliIpc({ stateDir, clientId = null, connectTimeoutMs = 5_000, requestTimeoutMs = 30_000 } = {}) {
    if (typeof stateDir !== "string" || stateDir.trim() === "") {
        throw transportError("TRANSPORT_CONFIG", "stateDir required");
    }
    const record = readDiscovery(stateDir);
    const endpoint = assertLocalEndpoint(record.endpoint, stateDir);

    // Never use a secret another local principal could read.
    const secretFile = typeof record.tokenFile === "string" ? record.tokenFile : tokenPath(stateDir);
    verifySecretPath(secretFile);
    const token = fs.readFileSync(secretFile, "utf8").trim();

    // Stable client identity: connection handles are bound to it, so a handle
    // minted for this CLI installation is unusable from any other one.
    const clientIdentity = clientId ?? resolveClientId(stateDir);
    if (!/^[0-9a-f]{32}$/.test(clientIdentity)) {
        throw transportError("TRANSPORT_CONFIG", "clientId must be 32 hex characters");
    }

    const clientNonce = newNonce();
    const pending = new Map();
    let fatal = null;
    let closed = false;
    let welcomed = false;
    let welcomeResolve = null;
    const welcome = new Promise((resolve) => { welcomeResolve = resolve; });

    const socket = net.connect(endpoint);
    socket.setNoDelay(true);

    function failAll(error) {
        for (const [id, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
            pending.delete(id);
        }
    }

    const reader = createFrameReader({
        maxFrameBytes: MAX_FRAME_BYTES,
        onMessage: (frame) => {
            if (frame.t === "welcome") {
                const ok = typeof frame.snonce === "string" && typeof frame.proof === "string"
                    && secretEquals(frame.proof, welcomeProof(token, clientNonce, frame.snonce));
                if (!ok) {
                    fatal = transportError("TRANSPORT_PEER_UNVERIFIED", "the endpoint does not hold the channel secret");
                    welcomeResolve();
                    socket.destroy();
                    return;
                }
                welcomed = true;
                welcomeResolve();
                return;
            }
            if (frame.t === "res") {
                if (typeof frame.id === "string" && pending.has(frame.id)) {
                    const entry = pending.get(frame.id);
                    pending.delete(frame.id);
                    clearTimeout(entry.timer);
                    if (frame.ok === true) entry.resolve(frame.result);
                    else entry.reject(transportError(frame.code ?? "EPEER_DENIED", frame.detail ?? ""));
                    return;
                }
                if (frame.ok !== true && pending.size === 1) {
                    // Handshake-stage denial carries no request id.
                    const [id, entry] = [...pending.entries()][0];
                    pending.delete(id);
                    clearTimeout(entry.timer);
                    entry.reject(transportError(frame.code ?? "EPEER_DENIED", frame.detail ?? ""));
                }
            }
        },
        onViolation: (error) => {
            fatal = error;
            welcomeResolve();
            failAll(error);
            socket.destroy();
        }
    });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(transportError("TRANSPORT_TIMEOUT", "connect timed out")), connectTimeoutMs);
        socket.once("connect", () => { clearTimeout(timer); resolve(); });
        socket.once("error", (error) => { clearTimeout(timer); reject(transportError("TRANSPORT_UNAVAILABLE", error?.message ?? "connect failed")); });
    });

    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", (error) => {
        failAll(transportError("TRANSPORT_UNAVAILABLE", error?.message ?? ""));
    });
    socket.on("close", () => {
        closed = true;
        welcomeResolve();
        failAll(transportError("TRANSPORT_CLOSED", "the host closed the connection"));
    });

    socket.write(encodeFrame({ v: PROTOCOL_VERSION, t: "hello", token, cnonce: clientNonce, clientId: clientIdentity }));
    await Promise.race([
        welcome,
        new Promise((resolve) => {
            const timer = setTimeout(resolve, connectTimeoutMs);
            if (typeof timer.unref === "function") timer.unref();
        })
    ]);
    if (fatal !== null) throw fatal;
    if (!welcomed) throw transportError("TRANSPORT_TIMEOUT", "the host did not complete the handshake");

    let counter = 0;

    async function request(op, args = {}, { timeoutMs = requestTimeoutMs } = {}) {
        if (fatal !== null) throw fatal;
        if (closed) throw transportError("TRANSPORT_CLOSED", "the host connection is closed");
        const id = `req-${(++counter).toString(36)}-${newNonce().slice(0, 8)}`;
        const result = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(transportError("EPEER_TIMEOUT", "the host did not answer in time"));
            }, timeoutMs);
            if (typeof timer.unref === "function") timer.unref();
            pending.set(id, { resolve, reject, timer });
        });
        socket.write(encodeFrame({ v: PROTOCOL_VERSION, t: "req", id, op, args }));
        return result;
    }

    function close() {
        if (!closed) {
            closed = true;
            try { socket.destroy(); } catch { /* best effort */ }
        }
    }

    return Object.freeze({ request, close, endpoint, clientId: clientIdentity, get closed() { return closed; } });
}

module.exports = Object.freeze({ connectCliIpc, readDiscovery });
