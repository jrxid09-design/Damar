"use strict";

/**
 * WAVE 6 MESH — transport abstraction (L1).
 *
 * LAWS:
 *   TRANSPORT ID != DAMAR IDENTITY
 *   NODE DISCOVERY != NODE TRUST
 *
 * A transport adapter DELIVERS opaque frames between peers and reports a
 * transportPeer label (EVIDENCE, not identity). The canonical envelope gate
 * (MeshRouter.ingest) re-derives all identity/trust from the envelope.
 * This module provides the adapter contract and a deterministic loopback
 * transport for logical multi-node tests. Real transports (LAN/Tailscale/
 * USB/…) implement the same two methods later — nothing in the architecture
 * binds to a specific technology.
 */

const { meshFailure, MESH_ERRORS } = require("./errors");

/**
 * Adapter contract:
 *   id: string (adapter label, diagnostics only)
 *   send({ frame, toPeer })            -> void (fire; delivery not guaranteed)
 *   onReceive(handler({ frame, transportPeer, receivedAtMs }))
 *   boundPeers() -> string[]           // transport-level peer labels (evidence)
 *
 * A transport NEVER: mints node ids, signs as identity, mutates trust,
 * or bypasses MeshRouter.ingest.
 */
function validateTransportAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") throw new TypeError("transport adapter must be an object");
    if (typeof adapter.id !== "string" || adapter.id.length === 0 || adapter.id.length > 64) {
        throw new TypeError("transport adapter requires an id string");
    }
    if (typeof adapter.send !== "function") throw new TypeError("transport adapter requires send()");
    if (typeof adapter.onReceive !== "function") throw new TypeError("transport adapter requires onReceive()");
    return true;
}

/** Deterministic in-process loopback transport (logical multi-node tests). */
function createLoopbackTransport({ label = "loopback" } = {}) {
    const listeners = new Set();
    let boundPeer = null;
    return {
        id: label,
        transport: true,
        bind(peerLabel) {
            boundPeer = String(peerLabel).slice(0, 256);
            return boundPeer;
        },
        boundPeer() { return boundPeer; },
        send({ frame, toPeer }) {
            if (typeof frame !== "string" && typeof frame !== "object") {
                throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "frame must be string or object");
            }
            // deliver synchronously to all listeners of the target peer label
            for (const l of listeners) {
                if (l.peerLabel === null || l.peerLabel === toPeer || toPeer === undefined) {
                    l.handler({ frame, transportPeer: boundPeer, receivedAtMs: Date.now() });
                }
            }
        },
        onReceive(handler, { peerLabel = null } = {}) {
            if (typeof handler !== "function") throw new TypeError("handler must be a function");
            const entry = { handler, peerLabel };
            listeners.add(entry);
            return () => listeners.delete(entry);
        },
        listenerCount() { return listeners.size; }
    };
}

/**
 * Wire a transport into a MeshRouter: transport.receive -> router.ingest,
 * with an outbound sender bound to the local node's trust generation.
 * Returns a bound MeshPeer handle used by higher layers (L2/L3) to send.
 */
function attachTransport({ transport, router, localNodeId, logicalDamarId, trust, encode = (e) => e, nowMs = () => Date.now() } = {}) {
    const { validateTransportAdapter } = module.exports;
    validateTransportAdapter(transport);
    const peerLabel = transport.bind ? transport.bind(`node:${localNodeId}`) : null;
    const off = transport.onReceive(wire => {
        // Single canonical ingress — no transport bypass.
        try { router.ingest(wire); } catch { /* gate failures are audited by router callers; ingest never throws across transport boundary */ }
    }, { peerLabel });
    return Object.freeze({
        transportId: transport.id,
        peerLabel,
        close: () => { try { off(); } catch { /* idempotent */ } },
        send({ envelope, toPeer = null }) {
            // Stamp the CURRENT trust generation at send time (stale-send guard).
            const current = trust.snapshot(localNodeId);
            const gen = current ? current.trustGeneration : envelope.trustGeneration;
            const stamped = gen === envelope.trustGeneration ? envelope : { ...envelope, trustGeneration: gen };
            transport.send({ frame: encode(stamped), toPeer: toPeer ?? envelope.destinationNodeId });
            return Object.freeze({ sent: true, messageId: envelope.messageId, transportId: transport.id });
        },
        nowMs
    });
}

module.exports = Object.freeze({ validateTransportAdapter, createLoopbackTransport, attachTransport });
