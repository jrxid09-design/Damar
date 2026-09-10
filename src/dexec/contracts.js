"use strict";

/**
 * WAVE 6 L3 — distributed execution contracts.
 *
 * LAWS:
 *   REMOTE EXECUTION != AUTHORITY TRANSFER
 *   WORKLOAD ROUTING != AUTHORITY ROUTING
 *   FAILOVER != PRIVILEGE ESCALATION
 *   ACTION INTENT -> AUTHORITY GATE -> LEASE -> TRANSPORT -> VERIFICATION
 *   (never model -> node directly)
 *
 * An ExecutionLease is permission to execute ONE specific authorized work
 * unit on ONE target node. It is NOT a general authority token: it binds
 * actionIntentId + actionDigest + capability + tool + target node +
 * requesting node + trust generation + expiry + a one-use nonce. Every
 * field is format-checked; the lease is frozen at mint; verification is
 * exact identity (no numeric epochs).
 */

const crypto = require("node:crypto");
const ids = require("../mesh/ids");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const { sha256Hex } = require("../mesh/canonical");

const EXECUTION_STATES = Object.freeze([
    "PLANNED", "AUTHORIZED", "LEASED", "DISPATCHED", "ACKNOWLEDGED",
    "EXECUTING", "SUCCEEDED", "FAILED", "UNKNOWN", "VERIFIED",
    "COMPENSATED", "CANCELLED", "EXPIRED"
].reduce((m, s) => (m[s] = s, m), {}));

/** Terminal states. UNKNOWN is special: exit requires verification/compensation. */
const TERMINAL_STATES = Object.freeze(new Set(["SUCCEEDED", "FAILED", "VERIFIED", "COMPENSATED", "CANCELLED", "EXPIRED"]));

/** Legal transitions (fail-closed; anything unlisted is rejected). */
const TRANSITIONS = Object.freeze({
    PLANNED: ["AUTHORIZED", "CANCELLED"],
    AUTHORIZED: ["LEASED", "CANCELLED", "EXPIRED"],
    LEASED: ["DISPATCHED", "EXPIRED", "CANCELLED"],
    DISPATCHED: ["ACKNOWLEDGED", "EXECUTING", "UNKNOWN", "EXPIRED", "FAILED"],
    ACKNOWLEDGED: ["EXECUTING", "UNKNOWN", "EXPIRED"],
    EXECUTING: ["SUCCEEDED", "FAILED", "UNKNOWN", "EXPIRED"],
    UNKNOWN: ["VERIFIED", "COMPENSATED", "EXPIRED"],
    SUCCEEDED: ["VERIFIED"],
    FAILED: ["COMPENSATED"],
    VERIFIED: [],
    COMPENSATED: [],
    CANCELLED: [],
    EXPIRED: []
});

const LEASE_DEFAULTS = Object.freeze({
 defaultTtlMs: 60_000,
 maxLeases: 1024
});

/**
 * Mint an ExecutionLease. ALL binding inputs are mandatory and validated:
 * an unbounded or generic lease cannot exist by construction.
 * `authorityDecisionDigest` binds the lease to a canonical Authority
 * DECISION ARTIFACT (W6-02: minted by the authority adapter from a BRANDED
 * canonical evaluation — never a caller-supplied string). The lease NEVER
 * carries or replaces authority itself.
 * `authorityBinding` (optional) embeds the artifact core for target-side
 * re-verification.
 */
function mintExecutionLease({
 actionIntentId, actionIntentCanonical, capabilityId, capabilityIncarnationId,
 toolId, targetNodeId, requestingNodeId, trustGeneration,
 ttlMs = null, authorityDecisionDigest, authorityBinding = null,
 nowMs = Date.now()
} = {}) {
 if (typeof actionIntentId !== "string" || actionIntentId.length === 0 || actionIntentId.length > 128) {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "actionIntentId required (<=128)");
 }
 if (typeof actionIntentCanonical !== "string" || actionIntentCanonical.length === 0 || actionIntentCanonical.length > 4096) {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "actionIntentCanonical (deterministic encoding) required");
 }
 for (const [v, name] of [[capabilityId, "capabilityId"], [toolId, "toolId"]]) {
 if (typeof v !== "string" || v.length === 0 || v.length > 256) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `${name} required (<=256)`);
 }
 const target = ids.check.nodeId(targetNodeId);
 const requester = ids.check.nodeId(requestingNodeId);
 if (target === requester) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "self-lease rejected (target == requesting node)");
 const gen = ids.check.trustGeneration(trustGeneration);
 if (typeof authorityDecisionDigest !== "string" || !/^[0-9a-f]{64}$/.test(authorityDecisionDigest)) {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "authorityDecisionDigest must be the digest of a canonical Authority decision artifact (lease != authority; it references the canonical decision)");
 }
 const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : LEASE_DEFAULTS.defaultTtlMs;
 const actionDigest = sha256Hex(actionIntentCanonical);
 const executionNonce = crypto.randomBytes(16).toString("hex");
 const leaseId = `dlease-${crypto.randomBytes(16).toString("hex")}`;
 return Object.freeze({
 leaseId,
 schemaVersion: 1,
 actionIntentId: String(actionIntentId).slice(0, 128),
 actionDigest, // binds the EXACT intent — any change invalidates the lease
 capabilityId: String(capabilityId).slice(0, 256),
 capabilityIncarnationId: capabilityIncarnationId ? String(capabilityIncarnationId).slice(0, 64) : null,
 toolId: String(toolId).slice(0, 256),
 targetNodeId: target,
 requestingNodeId: requester,
 trustGeneration: gen,
 authorityDecisionDigest,
 authorityBinding: authorityBinding && typeof authorityBinding === "object" ? Object.freeze({ ...authorityBinding }) : null,
 executionNonce,
 oneUse: true,
 issuedAtMs: Math.floor(nowMs),
 expiresAtMs: Math.floor(nowMs) + ttl
 });
}

/**
 * W6-R2-03 REPAIR: DIAGNOSTIC-ONLY structural validation.
 *
 * STRUCTURAL VALIDITY != EXECUTION AUTHORIZATION.
 * This helper performs pure field-shape validation and returns
 * { structurallyValid: true } — NEVER `verified: true`. The result cannot
 * be consumed by the execution path (execution authorization flows
 * EXCLUSIVELY through LeaseConsumptionLedger.verifyAndConsume on the
 * target node). No replay state exists here; no default Set/Map.
 */
function inspectExecutionLeaseStructure(lease, {
 localNodeId, currentTrustGeneration, actionIntentCanonical,
 capabilityId, toolId, nowMs = Date.now()
} = {}) {
 const problems = [];
 if (!lease || typeof lease !== "object") problems.push("lease missing");
 else {
 if (lease.schemaVersion !== 1) problems.push("unsupported lease schemaVersion");
 const recomputed = sha256Hex(actionIntentCanonical ?? "");
 if (recomputed !== lease.actionDigest) problems.push("action digest mismatch — intent changed after authorization");
 if (lease.targetNodeId !== ids.check.nodeId(localNodeId)) problems.push("lease bound to a different node");
 if (lease.trustGeneration !== ids.check.trustGeneration(currentTrustGeneration)) problems.push("lease trust generation stale");
 if (lease.capabilityId !== String(capabilityId ?? "").slice(0, 256)) problems.push("capability mismatch");
 if (lease.toolId !== String(toolId ?? "").slice(0, 256)) problems.push("tool mismatch");
 const now = Math.floor(nowMs);
 if (!Number.isFinite(lease.expiresAtMs) || lease.expiresAtMs <= now) problems.push("lease expired");
 }
 return Object.freeze({
 structurallyValid: problems.length === 0,
 problems: Object.freeze(problems),
 // explicit marker that this is NOT an execution authorization
 diagnosticOnly: true,
 note: "STRUCTURAL VALIDITY != EXECUTION AUTHORIZATION — execution requires LeaseConsumptionLedger.verifyAndConsume"
 });
}

/**
 * Build a DistributedExecutionRequest envelope payload (carried inside a
 * mesh EXECUTION_REQUEST envelope). Includes verification requirements.
 */
function buildExecutionRequest({ lease, input, deadlineMs = null, verificationRequirements = {} } = {}) {
    if (!lease) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "lease required");
    const inputDigest = sha256Hex(input ?? {});
    return Object.freeze({
        schemaVersion: 1,
        executionId: `dexec-${lease.executionNonce}`,
        lease,
        actionDigest: lease.actionDigest,
        inputDigest,
        input: input ?? {},
        expectedCapability: lease.capabilityId,
        toolIdentity: lease.toolId,
        deadlineMs: Number.isFinite(deadlineMs) ? Math.floor(deadlineMs) : lease.expiresAtMs,
        verificationRequirements: verificationRequirements && typeof verificationRequirements === "object" ? Object.freeze({ ...verificationRequirements }) : Object.freeze({}),
        state: "DISPATCHED"
    });
}

/**
 * Verify a DistributedExecutionResult returned by a remote node.
 * The result carries the executionId + inputDigest + resultDigest; a forged
 * result fails digest binding. Result state must be a legal outcome state.
 */
function verifyExecutionResult(request, result, { nowMs = Date.now() } = {}) {
    if (!result || typeof result !== "object") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "result required");
    if (result.executionId !== request.executionId) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "executionId mismatch");
    if (result.inputDigest !== request.inputDigest) throw meshFailure(MESH_ERRORS.PAYLOAD_DIGEST_MISMATCH, "inputDigest mismatch (result for different input)");
    const resultDigest = sha256Hex(result.output ?? null);
    if (result.resultDigest !== resultDigest) throw meshFailure(MESH_ERRORS.PAYLOAD_DIGEST_MISMATCH, "resultDigest mismatch (forged result)");
    if (!["SUCCEEDED", "FAILED"].includes(result.state)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `illegal result state '${String(result.state).slice(0, 24)}'`);
    if (!Number.isFinite(result.completedAtMs) || result.completedAtMs > nowMs + 5000) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "completedAtMs in the future");
    return Object.freeze({ verified: true, state: result.state, output: result.output ?? null, resultDigest });
}

/** Build a well-formed remote result (sender side). */
function buildExecutionResult(request, { state, output = null, completedAtMs = Date.now() } = {}) {
    if (!["SUCCEEDED", "FAILED"].includes(state)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `illegal result state '${String(state).slice(0, 24)}'`);
    return Object.freeze({
        schemaVersion: 1,
        executionId: request.executionId,
        inputDigest: request.inputDigest,
        state,
        output,
        resultDigest: sha256Hex(output),
        completedAtMs: Math.floor(completedAtMs)
    });
}

module.exports = Object.freeze({
    EXECUTION_STATES, TRANSITIONS, TERMINAL_STATES, LEASE_DEFAULTS,
    mintExecutionLease, inspectExecutionLeaseStructure,
    buildExecutionRequest, buildExecutionResult, verifyExecutionResult
});
