"use strict";

/**
 * WAVE 6 L2 — DistributedStateEnvelope, revisions, causality (Lane 2).
 *
 * LAWS:
 *   STATE REPLICATION != AUTHORITY REPLICATION
 *   MEMORY REPLICATION != SECRET REPLICATION
 *   STATE CONVERGENCE != TRUTH
 *   CLOCK ORDER != CAUSAL TRUTH
 *
 * Causality: bounded hybrid logical clock + per-object revision lineage.
 * Classification: causal-before / causal-after / CONCURRENT.
 * Every envelope carries a revision + causalContext; timestamps are
 * descriptive only and NEVER the conflict arbiter for authority-sensitive
 * state.
 */

const ids = require("../mesh/ids");
const { meshFailure } = require("../mesh/errors");
const { sha256Hex } = require("../mesh/canonical");

const REPLICATION_CLASSES = Object.freeze([
    "LOCAL_ONLY", "EPHEMERAL", "REPLICATED", "OWNER_BOUND",
    "SECRET_BOUND", "DERIVED", "CACHE", "AUDIT_IMMUTABLE"
].reduce((m, c) => (m[c] = c, m), {}));

const MERGE_POLICIES = Object.freeze([
    "LAST_WRITER_FOR_NONCRITICAL",
    "MONOTONIC_SET",
    "APPEND_ONLY",
    "MAX",
    "MIN",
    "UNION",
    "DOMAIN_MERGE",
    "MANUAL_CONFLICT",
    "AUTHORITY_REVALIDATE"
].reduce((m, p) => (p !== "" && (m[p] = p), m), {}));

/** Which classes may replicate AT ALL (SECRET_BOUND/LOCAL_ONLY/AUDIT_IMMUTABLE never leave the node). */
const REPLICATABLE = Object.freeze(new Set(["REPLICATED", "EPHEMERAL"]));
/** Classes that require authority re-validation on ANY conflict. */
const AUTHORITY_SENSITIVE = Object.freeze(new Set(["OWNER_BOUND"]));

const DEFAULTS = Object.freeze({
    maxLogicalClockBits: 48,          // hlc physical part bounded
    maxCausalParents: 4,              // per-object lineage width (bounded vector)
    maxPayloadBytes: 128 * 1024,
    defaultStateTtlMs: 24 * 3600 * 1000
});

/**
 * Bounded hybrid logical clock tick. Physical ms (48-bit bounded) +
 * logical counter reset on each physical advance. Pure, injectable clock.
 */
function hlcTick(prev, { nowMs = Date.now(), counterBits = 16 } = {}) {
    const maxCounter = 2 ** counterBits - 1;
    const physical = Math.min(Math.floor(nowMs), 2 ** 48 - 1);
    if (!prev) return { physical, logical: 0 };
    if (physical > prev.physical) return { physical, logical: 0 };
    if (prev.logical >= maxCounter) {
        // logical overflow: advance physical (still bounded, monotone enough for tests)
        return { physical: Math.min(prev.physical + 1, 2 ** 48 - 1), logical: 0 };
    }
    return { physical: prev.physical, logical: prev.logical + 1 };
}

function hlcEncode(hlc) { return `${hlc.physical.toString(36).padStart(10, "0")}.${hlc.logical.toString(36).padStart(4, "0")}`; }
function hlcCompare(a, b) {
    if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
    if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
    return 0;
}

/**
 * Causal relation between two revisions with bounded lineage.
 * lineage = array of recent revision ids (parents), ≤ maxCausalParents.
 */
function causalRelation(revA, revB, { maxParents = DEFAULTS.maxCausalParents } = {}) {
    if (revA.stateKey !== revB.stateKey) throw meshFailure("MESSAGE_MALFORMED", "causal relation requires same stateKey");
    if (revA.revisionId === revB.revisionId) return "IDENTICAL";
    // direct lineage knowledge: A knows B as ancestor (B before A)
    const aParents = (revA.causalParents ?? []).slice(0, maxParents);
    const bParents = (revB.causalParents ?? []).slice(0, maxParents);
    if (aParents.includes(revB.revisionId) || revB.revisionId === revA.parentRevisionId) return "AFTER"; // A after B
    if (bParents.includes(revA.revisionId) || revA.revisionId === revB.parentRevisionId) return "BEFORE"; // A before B
    // bounded transitive check via lineage chains
    if (lineageContains(revB, revA.revisionId, maxParents)) return "BEFORE";
    if (lineageContains(revA, revB.revisionId, maxParents)) return "AFTER";
    return "CONCURRENT";
}

function lineageContains(revision, ancestorId, maxDepth) {
    let current = revision;
    for (let depth = 0; depth < maxDepth && current?.causalParents?.length; depth++) {
        if (current.causalParents.includes(ancestorId)) return true;
        // follow stored parent chain if full revisions provided in lineage cache
        current = current.parentRevision || null;
        if (!current) break;
    }
    return false;
}

/**
 * Build a DistributedStateEnvelope revision.
 * The envelope is the unit of replication: revision identity is opaque,
 * lineage is bounded, digest binds content deterministically.
 */
function buildStateEnvelope({
    stateType, stateKey, logicalOwner, sourceNodeId,
    replicationClass, mergePolicy, payload,
    parentRevision = null, causalParents = [],
    clock = null, ttlMs = null,
    nowMs = Date.now()
} = {}) {
    if (!REPLICATION_CLASSES[replicationClass]) throw meshFailure("MESSAGE_MALFORMED", `unknown replicationClass '${String(replicationClass).slice(0, 32)}'`);
    if (!MERGE_POLICIES[mergePolicy]) throw meshFailure("MESSAGE_MALFORMED", `unknown mergePolicy '${String(mergePolicy).slice(0, 40)}'`);
    if (AUTHORITY_SENSITIVE.has(replicationClass) && mergePolicy === "LAST_WRITER_FOR_NONCRITICAL") {
        // hard law: authority-sensitive state MUST NOT use blind LWW
        throw meshFailure("MESSAGE_MALFORMED", "authority-sensitive state forbids LAST_WRITER_FOR_NONCRITICAL");
    }
    if (replicationClass === "SECRET_BOUND" && !canLeaveNode(replicationClass)) {
        // belt-and-braces: building a replicatable envelope for SECRET_BOUND is impossible
        throw meshFailure("MESSAGE_MALFORMED", "SECRET_BOUND state can never be replicated");
    }
    const checkedSource = require("../mesh/ids").check.nodeId(sourceNodeId);
    if (typeof stateType !== "string" || stateType.length === 0 || stateType.length > 64) throw meshFailure("MESSAGE_MALFORMED", "stateType must be a string <= 64");
    if (typeof stateKey !== "string" || stateKey.length === 0 || stateKey.length > 256) throw meshFailure("MESSAGE_MALFORMED", "stateKey must be a string <= 256");
    if (typeof logicalOwner !== "string" || logicalOwner.length === 0 || logicalOwner.length > 128) throw meshFailure("MESSAGE_MALFORMED", "logicalOwner required");
    const serialized = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(serialized, "utf8") > DEFAULTS.maxPayloadBytes) throw meshFailure("BOUNDS_EXCEEDED", `state payload exceeds ${DEFAULTS.maxPayloadBytes}`);
    const parents = (causalParents ?? []).slice(0, DEFAULTS.maxCausalParents).map(p => String(p).slice(0, 64));
 // MAX/MIN policies require numeric payload.value — validate at build so a
 // malformed payload can never enter the state plane under these policies.
 if (mergePolicy === "MAX" || mergePolicy === "MIN") {
 const v = payload?.value ?? payload;
 if (typeof v !== "number" || !Number.isFinite(v)) {
 throw meshFailure("MESSAGE_MALFORMED", `${mergePolicy} requires numeric payload.value`);
 }
 }
    const tick = hlcTick(clock ?? null, { nowMs });
    const revisionId = `dstate-${require("node:crypto").randomBytes(16).toString("hex")}`;
    const integrityDigest = sha256Hex({ stateType, stateKey, revisionId, payload: payload ?? null });
    const envelope = {
        schemaVersion: 1,
        stateType: String(stateType),
        stateKey: String(stateKey),
        logicalOwner: String(logicalOwner),
        sourceNodeId: checkedSource,
        revisionId,
        revisionSeq: 0, // set by the store on accept
        parentRevisionId: parentRevision?.revisionId ?? null,
        causalParents: parents,
        causalTimestamp: hlcEncode(tick),
        hlc: tick,
        createdAtMs: Math.floor(nowMs),
        updatedAtMs: Math.floor(nowMs),
        expiryMs: Math.floor(nowMs) + (Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULTS.defaultStateTtlMs),
        replicationClass,
        mergePolicy,
        integrityDigest,
        payload: JSON.parse(serialized)
    };
    if (parentRevision) envelope.parentRevision = parentRevision; // in-memory lineage for bounded transitive checks
    return Object.freeze(envelope);
}

/** Replication gate: which classes may leave a node. */
function canLeaveNode(replicationClass) {
    return REPLICATABLE.has(replicationClass);
}

module.exports = Object.freeze({
    REPLICATION_CLASSES, MERGE_POLICIES, REPLICATABLE, AUTHORITY_SENSITIVE, DEFAULTS,
    hlcTick, hlcEncode, hlcCompare, causalRelation, lineageContains,
    buildStateEnvelope, canLeaveNode
});
