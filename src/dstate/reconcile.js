"use strict";

/**
 * WAVE 6 L2 — merge policies + reconciliation + conflict model.
 *
 * LAWS:
 *   STATE CONVERGENCE != TRUTH
 *   AUTHORITY-SENSITIVE STATE MUST NOT USE BLIND LWW
 *   conflicts touching authority / verified action completion / owner trust /
 *   device trust / audit / secret metadata are NEVER silently dropped
 */

const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const { AUTHORITY_SENSITIVE } = require("./stateEnvelope");

/**
 * Apply a merge policy to two envelopes of the SAME stateKey.
 * Returns { resolved: envelope|null, conflict: StateConflict|null }.
 * `ctx` = { nodeId, nowMs, authorityRevalidate: async (env) => accepted env or throws }
 */
function merge(left, right, ctx = {}) {
    if (left.stateKey !== right.stateKey) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "merge requires same stateKey");
    const policy = left.mergePolicy;
    switch (policy) {
        case "LAST_WRITER_FOR_NONCRITICAL": {
            if (AUTHORITY_SENSITIVE.has(left.replicationClass)) {
                throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "LWW forbidden for authority-sensitive class");
            }
            const newer = newerOf(left, right);
            return { resolved: newer, conflict: null };
        }
        case "MAX": {
            const l = numericOf(left), r = numericOf(right);
            return { resolved: l >= r ? left : right, conflict: null };
        }
        case "MIN": {
            const l = numericOf(left), r = numericOf(right);
            return { resolved: l <= r ? left : right, conflict: null };
        }
        case "MONOTONIC_SET":
        case "UNION": {
            const l = setOf(left), r = setOf(right);
            const union = [...new Set([...l, ...r])].sort();
            const winner = newerOf(left, right);
            return { resolved: withPayload(winner, { values: union }), conflict: null };
        }
        case "APPEND_ONLY": {
            // appends never conflict: both retained by the store; resolved = right for sequencing
            return { resolved: right, conflict: null, appendBoth: true };
        }
        case "DOMAIN_MERGE": {
            // shallow object merge: right wins per-key only where left lacks the key
            const merged = { ...(left.payload ?? {}), ...(right.payload ?? {}) };
            return { resolved: withPayload(newerOf(left, right), merged), conflict: null };
        }
        case "MANUAL_CONFLICT":
            return { resolved: null, conflict: buildConflict(left, right, "CONCURRENT", "MANUAL_CONFLICT") };
        case "AUTHORITY_REVALIDATE":
            return { resolved: null, conflict: buildConflict(left, right, relationOf(left, right), "AUTHORITY_REVALIDATE") };
        default:
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `unhandled merge policy '${String(policy).slice(0, 40)}'`);
    }
}

/** Reconciliation entry: decide via causal relation first, policy second. */
function reconcile(left, right, ctx = {}) {
 const { causalRelation } = require("./stateEnvelope");
 const relation = causalRelation(left, right);
 if (relation === "IDENTICAL") return { resolved: left, conflict: null };
 // relation(left, right): position of LEFT relative to RIGHT.
 // "AFTER" = left descends from right -> LEFT is newer.
 // "BEFORE" = right descends from left -> RIGHT is newer (accept incoming).
 if (relation === "AFTER") return { resolved: left, conflict: null, relation };
 if (relation === "BEFORE") return { resolved: right, conflict: null, relation };
 // CONCURRENT: apply policy
 const out = merge(left, right, ctx);
 return { ...out, relation };
}

/** Build an explicit StateConflict (never silently dropped for sensitive classes). */
function buildConflict(left, right, causalRelation, policy) {
    const sensitive = AUTHORITY_SENSITIVE.has(left.replicationClass) || AUTHORITY_SENSITIVE.has(right.replicationClass);
    return Object.freeze({
        conflictId: `dconf-${require("node:crypto").randomBytes(16).toString("hex")}`,
        stateType: left.stateType,
        stateKey: left.stateKey,
        replicationClass: left.replicationClass,
        leftRevision: { revisionId: left.revisionId, sourceNodeId: left.sourceNodeId, updatedAtMs: left.updatedAtMs, integrityDigest: left.integrityDigest },
        rightRevision: { revisionId: right.revisionId, sourceNodeId: right.sourceNodeId, updatedAtMs: right.updatedAtMs, integrityDigest: right.integrityDigest },
        causalRelation,
        policy,
        authoritySensitive: sensitive,
        resolutionStatus: sensitive ? "BLOCKING_UNRESOLVED" : "OPEN",
        resolutionEvidence: null,
        detectedAtMs: Date.now()
    });
}

function relationOf(a, b) { return require("./stateEnvelope").causalRelation(a, b); }
function newerOf(a, b) {
    // deterministic tie-break: hlc then revisionId (NEVER wall clock alone)
    const cmp = require("./stateEnvelope").hlcCompare(a.hlc, b.hlc);
    if (cmp !== 0) return cmp > 0 ? a : b;
    return a.revisionId > b.revisionId ? a : b;
}
function numericOf(env) {
    const v = env.payload?.value ?? env.payload;
    if (typeof v !== "number" || !Number.isFinite(v)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `${env.mergePolicy} requires numeric payload.value`);
    return v;
}
function setOf(env) {
    const v = env.payload?.values ?? env.payload;
    if (!Array.isArray(v)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `${env.mergePolicy} requires payload.values array`);
    return v.map(x => String(x).slice(0, 128));
}
function withPayload(env, payloadPatch) {
    const { buildStateEnvelope } = require("./stateEnvelope");
    const rebuilt = buildStateEnvelope({
        stateType: env.stateType, stateKey: env.stateKey, logicalOwner: env.logicalOwner,
        sourceNodeId: env.sourceNodeId, replicationClass: env.replicationClass, mergePolicy: env.mergePolicy,
        payload: payloadPatch, parentRevision: env, causalParents: [env.revisionId],
        clock: env.hlc, ttlMs: env.expiryMs - env.updatedAtMs, nowMs: Date.now()
    });
    return rebuilt;
}

module.exports = Object.freeze({ merge, reconcile, buildConflict });
