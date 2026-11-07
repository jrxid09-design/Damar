"use strict";

/**
 * WAVE 6 MESH — transport abstraction + inbound gate + router (L1).
 *
 * TRANSPORT ID != DAMAR IDENTITY: transports deliver opaque byte frames and
 * report a transportPeer label; that label is EVIDENCE, never identity.
 * The inbound gate re-derives all identity from the envelope itself.
 *
 * MeshRouter wires: envelope gate (structure/expiry/digest) -> replay guard
 * -> trust gate (scope + generation) -> destination check -> handler.
 * One canonical ingress; NO bypass path around it.
 */

const envelopeMod = require("./meshEnvelope");
const ids = require("./ids");
const { meshFailure, MESH_ERRORS } = require("./errors");

const DEFAULTS = Object.freeze({
    maxQueues: 8,
    maxQueueItems: 1024,
    maxQueueBytes: 4 * 1024 * 1024,
    queueExpiryMs: 60_000
});

/** Queue priority classes (§94): revocation must not be silently dropped. */
const QUEUE_PRIORITY = Object.freeze({
    CONTROL: 0,   // revocation/trust updates — never dropped
    RECOVERY: 1,
    STATE: 2,
    EXECUTION: 3,
    TELEMETRY: 4  // may be dropped under pressure
});

const DROPPABLE = Object.freeze(new Set(["TELEMETRY"]));

class MeshRouter {
    constructor({ trust, registry, replayGuard, auditBridge = null, config = {}, nowMs = () => Date.now() } = {}) {
        if (!trust) throw new TypeError("MeshRouter requires trust plane");
        if (!registry) throw new TypeError("MeshRouter requires node registry");
        if (!replayGuard) throw new TypeError("MeshRouter requires replay guard");
        this.trust = trust;
        this.registry = registry;
        this.replayGuard = replayGuard;
        this.auditBridge = auditBridge;
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** messageType -> handler(envelope, context) */
        this._handlers = new Map();
        this._queues = new Map(); // messageType -> { items: [], bytes: 0 }
    }

    /** Register a handler for a canonical message type. */
    on(messageType, handler) {
        if (!envelopeMod.MESSAGE_TYPES[messageType]) throw new TypeError(`unknown message type '${String(messageType).slice(0, 32)}'`);
        if (typeof handler !== "function") throw new TypeError("handler must be a function");
        if (this._handlers.has(messageType)) throw new TypeError(`handler already registered for '${messageType}'`);
        this._handlers.set(messageType, handler);
        return this;
    }

    /**
     * THE canonical inbound gate.
     * `wire` = { frame (raw transport bytes/string), transportPeer (label), receivedAtMs }
     * The transportPeer is evidence only; identity comes from the envelope.
     * Required scope per message type keeps trust enforcement centralized.
     */
    static REQUIRED_SCOPE = Object.freeze({
        PRESENCE_ANNOUNCE: "OBSERVE",
        PRESENCE_QUERY: "OBSERVE",
        DISCOVERY_ADVERTISE: "OBSERVE",
        STATE_REPLICATE: "STATE_REPLICA",
        STATE_RECONCILE: "STATE_REPLICA",
        EXECUTION_REQUEST: "COMPUTE",
        EXECUTION_RESULT: "COMPUTE",
        EXECUTION_ACK: "COMPUTE",
        RECOVERY_PROBE: "RECOVERY_PEER",
        RECOVERY_PAYLOAD: "RECOVERY_PEER",
        AUDIT_APPEND: "OBSERVE",
        GOVERNOR_REPORT: "OBSERVE",
        ECHO: "OBSERVE",
        CONTROL_REVOCATION: "ADMINISTRATIVE_HOST",
        TRUST_UPDATE: "ADMINISTRATIVE_HOST",
        // pairing types are processed by the pairing adapter with its own gate
        PAIRING_OFFER: null,
        PAIRING_CHALLENGE: null,
        PAIRING_CONFIRM: null,
        ERROR: null
    });

 ingest(wire) {
 if (!wire || typeof wire !== "object") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "wire input required");
 const receivedAtMs = Number.isFinite(wire.receivedAtMs) ? wire.receivedAtMs : this.nowMs();
 try {
 return this._ingestGated(wire, receivedAtMs);
 } catch (e) {
 // Audit rejections (never blocks, never swallows): rethrow after recording.
 if (this.auditBridge && e && e.name === "MeshError") {
 try { this.auditBridge.ingestRejected(e.code, e.message); } catch { /* audit must not block */ }
 }
 throw e;
 }
 }

 _ingestGated(wire, receivedAtMs) {
 let envelope;
        try {
            // Transports deliver a decoded object; re-coerce structurally here
            // so the gate does not trust the transport's parsing.
            envelope = envelopeMod.coerceInboundEnvelope(
                typeof wire.frame === "string" ? JSON.parse(wire.frame) : wire.frame,
                { nowMs: receivedAtMs }
            );
        } catch (e) {
            if (e.name === "MeshError") throw e;
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `undecodable frame: ${String(e.message).slice(0, 120)}`);
        }
        // Transport spoof check: the envelope's source node must be registered,
        // and if the registry records bound addresses, the transport peer label
        // must match one of them (when the transport supplies one).
        const node = this.registry.lookup(envelope.sourceNodeId);
        if (!node) throw meshFailure(MESH_ERRORS.NODE_UNKNOWN, `source node '${String(envelope.sourceNodeId).slice(0, 24)}' not registered`);
        if (wire.transportPeer !== null && wire.transportPeer !== undefined) {
            const peer = String(wire.transportPeer).slice(0, 256);
            if (node.addresses.length > 0 && !node.addresses.includes(peer)) {
                throw meshFailure(MESH_ERRORS.TRANSPORT_SPOOF, `transport peer '${peer.slice(0, 64)}' not bound to source node`);
            }
        }
        // Replay defense (bounded ledger).
        this.replayGuard.accept(envelope);
        // Trust gate: exact scope + exact current generation, fail-closed.
        const requiredScope = MeshRouter.REQUIRED_SCOPE[envelope.messageType];
        if (requiredScope) {
            this.trust.authorize({
                nodeId: envelope.sourceNodeId,
                scope: requiredScope,
                trustGeneration: envelope.trustGeneration,
                atMs: receivedAtMs
            });
        }
        // Destination check.
        if (envelope.destinationNodeId) {
            // The router can only verify destination sanity; actual ownership
            // of the local node id is enforced by the runtime binding (the
            // local node id is injected via bindLocalNodeId).
            if (this._localNodeId && envelope.destinationNodeId !== this._localNodeId) {
                throw meshFailure(MESH_ERRORS.DESTINATION_MISMATCH, `envelope addressed to '${String(envelope.destinationNodeId).slice(0, 24)}', not this node`);
            }
        }
        // Liveness telemetry (presence != trust).
        try { this.registry.observeLiveness(envelope.sourceNodeId, "ONLINE"); } catch { /* telemetry never blocks ingress */ }

        if (this.auditBridge) {
            try { this.auditBridge.ingestAccepted(envelope, { transportPeer: wire.transportPeer ?? null, receivedAtMs }); } catch { /* audit must not block */ }
        }

        const handler = this._handlers.get(envelope.messageType);
        if (!handler) {
            return Object.freeze({ accepted: true, handled: false, envelope });
        }
        const result = handler(envelope, Object.freeze({ receivedAtMs, transportPeer: wire.transportPeer ?? null, router: this }));
        return Object.freeze({ accepted: true, handled: true, envelope, result: result ?? null });
    }

    bindLocalNodeId(nodeId) {
        this._localNodeId = ids.check.nodeId(nodeId);
        return this;
    }

    /**
     * Outbound dispatch through a bounded per-type queue (§94 backpressure).
     * TELEMETRY may be dropped under pressure; CONTROL never.
     */
    enqueue(envelope) {
        const priorityClass = priorityFor(envelope.messageType);
        let q = this._queues.get(priorityClass);
        if (!q) {
            if (this._queues.size >= this.config.maxQueues) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "queue table full");
            q = { items: [], bytes: 0 };
            this._queues.set(priorityClass, q);
        }
        const size = Buffer.byteLength(envelopeMod.encodeEnvelope(envelope), "utf8");
        const droppable = DROPPABLE.has(priorityClass);
        while (q.items.length >= this.config.maxQueueItems || q.bytes + size > this.config.maxQueueBytes) {
            if (!droppable) {
                // drop oldest TELEMETRY across queues first; if impossible, reject
                const telemetry = this._queues.get("TELEMETRY");
                if (telemetry && telemetry.items.length > 0) {
                    const dropped = telemetry.items.shift();
                    telemetry.bytes -= dropped.size;
                    continue;
                }
                throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `queue '${priorityClass}' full and nothing droppable`);
            }
            const dropped = q.items.shift();
            q.bytes -= dropped.size;
            if (q.items.length === 0) break;
        }
        q.items.push({ envelope, size, enqueuedAtMs: this.nowMs() });
        q.bytes += size;
        return Object.freeze({ queued: true, priority: priorityClass, depth: q.items.length });
    }

    /** Drain up to `max` envelopes (oldest first within priority). */
    drain({ max = 32 } = {}) {
        const out = [];
        const priorities = Object.keys(QUEUE_PRIORITY).sort((a, b) => QUEUE_PRIORITY[a] - QUEUE_PRIORITY[b]);
        for (const p of priorities) {
            const q = this._queues.get(p);
            if (!q) continue;
            while (q.items.length > 0 && out.length < max) {
                const item = q.items.shift();
                if (this.nowMs() - item.enqueuedAtMs > this.config.queueExpiryMs) { q.bytes -= item.size; continue; }
                q.bytes -= item.size;
                out.push(item.envelope);
            }
        }
        return Object.freeze(out);
    }

    queueDepth() {
        const out = {};
        let total = 0;
        for (const [p, q] of this._queues) { out[p] = q.items.length; total += q.items.length; }
        return Object.freeze({ byPriority: Object.freeze(out), total });
    }
}

function priorityFor(messageType) {
    switch (messageType) {
        case "CONTROL_REVOCATION":
        case "TRUST_UPDATE":
            return "CONTROL";
        case "RECOVERY_PROBE":
        case "RECOVERY_PAYLOAD":
            return "RECOVERY";
        case "STATE_REPLICATE":
        case "STATE_RECONCILE":
        case "AUDIT_APPEND":
            return "STATE";
        case "EXECUTION_REQUEST":
        case "EXECUTION_RESULT":
        case "EXECUTION_ACK":
            return "EXECUTION";
        default:
            return "TELEMETRY";
    }
}

module.exports = Object.freeze({ MeshRouter, QUEUE_PRIORITY, DEFAULTS, priorityFor });
