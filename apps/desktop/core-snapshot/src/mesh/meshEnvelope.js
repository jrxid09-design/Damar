"use strict";

/**
 * WAVE 6 MESH — DamarMeshEnvelope (L1).
 *
 * Transport-independent logical envelope. LAWS:
 *   TRANSPORT ID != DAMAR IDENTITY   (transport adapters never mint identity)
 *   MESH PRESENCE != IDENTITY PROOF
 *   CHANNEL != AUTHORITY
 *
 * Envelope integrity: payloadDigest = SHA256 over the DETERMINISTIC
 * canonical encoding of the payload — never over pretty-printed/ambiguous
 * JSON. schemaVersion is mandatory; unknown critical versions reject.
 */

const ids = require("./ids");
const { meshFailure, MESH_ERRORS } = require("./errors");
const { canonicalJson, sha256Hex } = require("./canonical");

const SCHEMA_VERSION = 1;
const SUPPORTED_VERSIONS = Object.freeze(new Set([SCHEMA_VERSION]));

const MESSAGE_TYPES = Object.freeze([
    "PRESENCE_ANNOUNCE",
    "PRESENCE_QUERY",
    "DISCOVERY_ADVERTISE",
    "PAIRING_OFFER",
    "PAIRING_CHALLENGE",
    "PAIRING_CONFIRM",
    "TRUST_UPDATE",
    "STATE_REPLICATE",
    "STATE_RECONCILE",
    "EXECUTION_REQUEST",
    "EXECUTION_RESULT",
    "EXECUTION_ACK",
    "RECOVERY_PROBE",
    "RECOVERY_PAYLOAD",
    "AUDIT_APPEND",
    "GOVERNOR_REPORT",
    "ECHO",
    "CONTROL_REVOCATION",
    "ERROR"
].reduce((m, t) => (m[t] = t, m), {}));

const DEFAULTS = Object.freeze({
    defaultTtlMs: 30_000,
    maxPayloadBytes: 256 * 1024,
    maxCausalEntries: 16,
    maxSessionRefChars: 128,
    maxTraceChars: 128
});

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

/**
 * Build an envelope. All inputs validated; all identity fields
 * format-checked; output frozen. `payload` MUST be a plain JSON object.
 */
function buildEnvelope({
    messageType, sourceNodeId, destinationNodeId = null, // null + multicastScope => multicast
    multicastScope = null,
    logicalDamarId, trustGeneration,
    payload, ttlMs = null,
    sessionReference = null, causalMetadata = null,
    traceId = null, schemaVersion = SCHEMA_VERSION,
    nowMs = Date.now()
} = {}) {
    if (!SUPPORTED_VERSIONS.has(schemaVersion)) {
        throw meshFailure(MESH_ERRORS.SCHEMA_VERSION_UNSUPPORTED, `unsupported schemaVersion '${String(schemaVersion).slice(0, 16)}'`);
    }
    if (!MESSAGE_TYPES[messageType]) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `unknown messageType '${String(messageType).slice(0, 32)}'`);
    const src = ids.check.nodeId(sourceNodeId);
    if (!destinationNodeId && !multicastScope) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "destinationNodeId or multicastScope required");
    if (destinationNodeId && multicastScope) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "destinationNodeId and multicastScope are mutually exclusive");
    const dst = destinationNodeId ? ids.check.nodeId(destinationNodeId) : null;
    if (dst && dst === src) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "self-addressed envelope rejected");
    const damar = ids.check.logicalDamarId(logicalDamarId);
    const gen = ids.check.trustGeneration(trustGeneration);
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULTS.defaultTtlMs;
    const canonicalPayload = canonicalJson(payload ?? {});
    if (Buffer.byteLength(canonicalPayload, "utf8") > DEFAULTS.maxPayloadBytes) {
        throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `payload exceeds ${DEFAULTS.maxPayloadBytes} bytes`);
    }
    const payloadDigest = sha256Hex(payload ?? {});
    const messageId = ids.mint.meshMessageId();
    const createdAtMs = Math.floor(nowMs);
    return Object.freeze({
        schemaVersion,
        messageId,
        logicalDamarId: damar,
        sourceNodeId: src,
        destinationNodeId: dst,
        multicastScope: multicastScope ? String(multicastScope).slice(0, 64) : null,
        messageType,
        createdAtMs,
        expiryMs: createdAtMs + ttl,
        trustGeneration: gen,
        sessionReference: sessionReference ? String(sessionReference).slice(0, DEFAULTS.maxSessionRefChars) : null,
        causalMetadata: boundCausal(causalMetadata),
        payloadDigest,
        payload: deepFreezePayload(payload ?? {}),
        authenticity: null, // filled by transport authenticity layer (proof slot, never identity)
        traceId: traceId ? String(traceId).slice(0, DEFAULTS.maxTraceChars) : null
    });
}

/**
 * Validate an INBOUND envelope (from a transport). Verifies structure,
 * identity formats, version, expiry window, and payloadDigest binding.
 */
function coerceInboundEnvelope(value, { nowMs = Date.now() } = {}) {
    if (!value || typeof value !== "object") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "envelope must be an object");
    if (!SUPPORTED_VERSIONS.has(value.schemaVersion)) throw meshFailure(MESH_ERRORS.SCHEMA_VERSION_UNSUPPORTED, `unsupported schemaVersion '${String(value.schemaVersion).slice(0, 16)}'`);
    try {
        ids.check.meshMessageId(value.messageId);
        ids.check.logicalDamarId(value.logicalDamarId);
        ids.check.nodeId(value.sourceNodeId);
        ids.check.trustGeneration(value.trustGeneration);
        if (value.destinationNodeId) ids.check.nodeId(value.destinationNodeId);
    } catch (e) {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `malformed envelope identity: ${String(e.message).slice(0, 100)}`);
    }
    if (!MESSAGE_TYPES[value.messageType]) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown messageType");
    if (typeof value.payloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.payloadDigest)) {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "payloadDigest must be 64 hex chars");
    }
    const recomputed = sha256Hex(value.payload);
    if (recomputed !== value.payloadDigest) {
        throw meshFailure(MESH_ERRORS.PAYLOAD_DIGEST_MISMATCH, "payload does not match payloadDigest (tampered or non-canonical)");
    }
const now = Math.floor(nowMs);
 if (!Number.isFinite(value.expiryMs) || value.expiryMs <= now) {
 throw meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, `expired at ${String(value.expiryMs).slice(0, 20)}`);
 }
 // Detach (deep-copy) BEFORE freezing: an inbound payload may already be
 // frozen by a previous gate; cloning makes re-coercion idempotent and
 // guarantees this gate owns its own frozen copy.
 const detached = JSON.parse(JSON.stringify(value.payload ?? {}));
 deepFreezePayload(detached);
 return Object.freeze({ ...value, payload: detached });
}

/** Deterministic wire encoding (for transport adapters + log evidence). */
function encodeEnvelope(envelope) {
    return canonicalJson({
        schemaVersion: envelope.schemaVersion,
        messageId: envelope.messageId,
        logicalDamarId: envelope.logicalDamarId,
        sourceNodeId: envelope.sourceNodeId,
        destinationNodeId: envelope.destinationNodeId,
        multicastScope: envelope.multicastScope,
        messageType: envelope.messageType,
        createdAtMs: envelope.createdAtMs,
        expiryMs: envelope.expiryMs,
        trustGeneration: envelope.trustGeneration,
        sessionReference: envelope.sessionReference,
        causalMetadata: envelope.causalMetadata,
        payloadDigest: envelope.payloadDigest,
        payload: envelope.payload,
        traceId: envelope.traceId
    });
}

function boundCausal(causalMetadata) {
    if (causalMetadata === null || causalMetadata === undefined) return null;
    if (typeof causalMetadata !== "object") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "causalMetadata must be an object");
    const entries = Object.entries(causalMetadata);
    if (entries.length > DEFAULTS.maxCausalEntries) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `causalMetadata exceeds ${DEFAULTS.maxCausalEntries} entries`);
    const out = {};
    for (const [k, v] of entries) {
        if (DANGEROUS_KEYS.has(k)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "dangerous causal key");
        if (typeof k !== "string" || k.length > 64) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "causal key length");
        out[k] = typeof v === "number" ? (Object.is(v, -0) ? 0 : Math.floor(v)) : String(v).slice(0, 64);
    }
    return Object.freeze(out);
}

function deepFreezePayload(payload) {
    if (!payload || typeof payload !== "object") return Object.freeze(payload ?? {});
    const seen = new WeakSet();
    const freeze = (v) => {
        if (v === null || typeof v !== "object") return v;
        if (seen.has(v)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "circular payload");
        seen.add(v);
        try {
            const proto = Object.getPrototypeOf(v);
            if (proto !== Object.prototype && proto !== Array.prototype) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "non-plain payload object");
            for (const k of Object.keys(v)) {
                if (DANGEROUS_KEYS.has(k)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "dangerous payload key");
                v[k] = freeze(v[k]);
            }
            return Array.isArray(v) ? Object.freeze(v) : Object.freeze(v);
        } finally { seen.delete(v); }
    };
    return freeze(payload);
}

module.exports = Object.freeze({
    SCHEMA_VERSION, SUPPORTED_VERSIONS, MESSAGE_TYPES, DEFAULTS,
    buildEnvelope, coerceInboundEnvelope, encodeEnvelope
});
