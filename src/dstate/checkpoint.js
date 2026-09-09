"use strict";

/**
 * WAVE 6 L2 — memory namespace replication classes + DistributedCheckpoint.
 *
 * LAWS:
 *   MEMORY REPLICATION != SECRET REPLICATION
 *   SESSION MIGRATION != AUTHORITY MIGRATION
 *   PERSISTED STATE != LIVE AUTHORITY
 *
 * Checkpoints carry session REFERENCES and continuation markers — never
 * authority objects, raw secrets, or ephemeral handles. A stale checkpoint
 * (expired / old continuity incarnation / revoked source node) fails closed.
 */

const ids = require("../mesh/ids");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const { sha256Hex } = require("../mesh/canonical");

const MEMORY_NAMESPACE_CLASSES = Object.freeze([
    "LOCAL", "SHARED_DAMAR", "NODE_SCOPED", "PANDAWA_SCOPED", "OWNER_SCOPED", "SECRET_REFERENCE_ONLY"
].reduce((m, c) => (m[c] = c, m), {}));

/** Namespaces eligible for selective replication (default policy). */
const REPLICATABLE_NAMESPACES = Object.freeze(new Set(["SHARED_DAMAR"]));
/** Namespaces that may carry secret REFERENCES (never values). */
const SECRET_REFERENCE_NAMESPACES = Object.freeze(new Set(["SECRET_REFERENCE_ONLY", "OWNER_SCOPED"]));

const CHECKPOINT_SCHEMA_VERSION = 1;

/**
 * Build a distributed checkpoint. Inputs are validated against a closed
 * vocabulary; authority-shaped keys are rejected recursively.
 */
function buildDistributedCheckpoint({
    sourceNodeId, logicalDamarId, continuityIncarnation,
    sessionReferences = [], pendingCognitiveWork = [],
    verifiedCompletedActionRefs = [], memoryPointers = [],
    routingMetadata = null, ttlMs = 24 * 3600 * 1000,
    nowMs = Date.now()
} = {}) {
    const src = ids.check.nodeId(sourceNodeId);
    const damar = ids.check.logicalDamarId(logicalDamarId);
    if (typeof continuityIncarnation !== "string" || continuityIncarnation.length === 0 || continuityIncarnation.length > 128) {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "continuityIncarnation required (frozen dsc incarnation)");
    }
 const sessions = boundedArray(sessionReferences, 16, "sessionReferences", 128);
 const pending = boundedArray(pendingCognitiveWork, 32, "pendingCognitiveWork", 256);
 const completed = boundedArray(verifiedCompletedActionRefs, 32, "verifiedCompletedActionRefs", 128);
 const pointers = boundedArray(memoryPointers, 32, "memoryPointers", 256);
 // authority-shaped input rejected on RAW values (before any stringification)
 rejectAuthorityShaped({ sessionReferences, pendingCognitiveWork, verifiedCompletedActionRefs, memoryPointers, routingMetadata });
 const checkpointId = `dckpt-${require("node:crypto").randomBytes(16).toString("hex")}`;
 // explicitly-provided non-positive TTL is a caller bug — fail closed
 if (ttlMs !== undefined && ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "ttlMs must be a positive number");
 }
 const core = {
        checkpointId, schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        sourceNodeId: src, logicalDamarId: damar,
        continuityIncarnation: String(continuityIncarnation).slice(0, 128),
        sessionReferences: sessions,
        pendingCognitiveWork: pending,
        verifiedCompletedActionRefs: completed,
        memoryPointers: pointers,
        routingMetadata: routingMetadata ? boundedSummary(routingMetadata) : null,
        createdAtMs: Math.floor(nowMs),
        expiresAtMs: Math.floor(nowMs) + (Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 24 * 3600 * 1000)
    };
    return Object.freeze({ ...core, integrityDigest: sha256Hex(core) });
}

/**
 * Verify a checkpoint for restore. Fail-closed on: expiry, source-node
 * revocation (caller supplies a trust snapshot fn), incarnation mismatch,
 * digest mismatch, dangerous keys.
 */
function verifyCheckpoint(checkpoint, { nowMs = Date.now(), continuityIncarnation = null, isNodeTrusted = null } = {}) {
    if (!checkpoint || typeof checkpoint !== "object") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "checkpoint required");
    if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) throw meshFailure(MESH_ERRORS.SCHEMA_VERSION_UNSUPPORTED, "unsupported checkpoint schemaVersion");
    const recomputed = sha256Hex({ ...checkpoint, integrityDigest: undefined });
    if (recomputed !== checkpoint.integrityDigest) throw meshFailure(MESH_ERRORS.PAYLOAD_DIGEST_MISMATCH, "checkpoint digest mismatch (corrupted or tampered)");
    if (Number.isFinite(checkpoint.expiresAtMs) && checkpoint.expiresAtMs <= nowMs) {
        throw meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, "checkpoint expired (stale restore rejected)");
    }
    if (continuityIncarnation !== null && checkpoint.continuityIncarnation !== continuityIncarnation) {
        throw meshFailure(MESH_ERRORS.TRUST_GENERATION_STALE, "checkpoint from a stale continuity incarnation");
    }
    if (typeof isNodeTrusted === "function" && !isNodeTrusted(checkpoint.sourceNodeId)) {
        throw meshFailure(MESH_ERRORS.NODE_REVOKED, "checkpoint source node is not trusted");
    }
    return true;
}

/** Restore view: inert continuation data only — NEVER live authority. */
function restoreView(checkpoint) {
    verifyCheckpoint(checkpoint, { nowMs: Date.now() });
    return Object.freeze({
        checkpointId: checkpoint.checkpointId,
        sessionReferences: Object.freeze([...checkpoint.sessionReferences]),
        pendingCognitiveWork: Object.freeze([...checkpoint.pendingCognitiveWork]),
        verifiedCompletedActionRefs: Object.freeze([...checkpoint.verifiedCompletedActionRefs]),
        memoryPointers: Object.freeze([...checkpoint.memoryPointers]),
        routingMetadata: checkpoint.routingMetadata ? Object.freeze({ ...checkpoint.routingMetadata }) : null,
        note: "SESSION MIGRATION != AUTHORITY MIGRATION: no authority objects are restored; completed actions stay completed (MODEL RECOVERY != ACTION REPLAY)"
    });
}

const AUTHORITY_TOKENS = Object.freeze(new Set(["authority", "authorized", "grant", "granted", "permission", "privilege", "capabilitygrant", "ownertrust", "secretvalue", "vaultvalue"]));

function rejectAuthorityShaped(obj) {
    const seen = new WeakSet();
    const walk = (v, path) => {
        if (v === null || typeof v !== "object") return;
        if (seen.has(v)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "circular checkpoint input");
        seen.add(v);
        for (const [k, val] of Object.entries(v)) {
            if (AUTHORITY_TOKENS.has(String(k).toLowerCase())) {
                throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `authority-shaped field '${k.slice(0, 32)}' forbidden in checkpoint (path ${path})`);
            }
            walk(val, `${path}.${k}`);
        }
    };
    walk(obj, "$");
}

function boundedArray(arr, max, name, maxItem) {
    if (!Array.isArray(arr)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `${name} must be an array`);
    if (arr.length > max) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `${name} exceeds ${max}`);
    return Object.freeze(arr.map(x => String(x).slice(0, maxItem)));
}

function boundedSummary(obj) {
    const out = {};
    const entries = Object.entries(obj ?? {});
    if (entries.length > 16) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "routingMetadata exceeds 16 entries");
    for (const [k, v] of entries) {
        if (AUTHORITY_TOKENS.has(String(k).toLowerCase())) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `authority-shaped routing key '${k.slice(0, 32)}'`);
        out[String(k).slice(0, 64)] = String(v ?? "").slice(0, 128);
    }
    return out;
}

module.exports = Object.freeze({
    MEMORY_NAMESPACE_CLASSES, REPLICATABLE_NAMESPACES, SECRET_REFERENCE_NAMESPACES,
    CHECKPOINT_SCHEMA_VERSION, buildDistributedCheckpoint, verifyCheckpoint, restoreView
});
