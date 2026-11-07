"use strict";

/**
 * ACTION AUTHORITY GATE V1 — inert decision vocabulary + pure fail-closed
 * predicate. This module exports NO gate constructor of any kind.
 *
 * The gate itself is a PRIVATE CLOSURE HELPER inside the trusted runtime
 * composition (`src/action/runtime.js`): it is constructed exactly once, inside
 * the same closure that owns the runtime-local session brand/verifier, the
 * canonical authority evaluator, the canonical evaluation brand verifier, the
 * canonical capability registry, and the hardened clock. There is no module in
 * this codebase from which `createGate` (or any equivalent gate mint) can be
 * imported, so no caller can build a canonical-equivalent gate over an
 * injected evaluator.
 *
 * What lives here:
 *   - DECISION / GATE_REASONS / ALLOW_REASON — inert frozen value vocabularies
 *   - validateAuthorityEvaluation — PURE predicate: verifies a positive
 *     AuthorityEvaluation exactly matches the request the gate sent. It never
 *     authorizes, brands, or mints anything.
 */

const DECISION = Object.freeze({
    ALLOW: "ALLOW",
    DENY: "DENY",
    OWNER_CONFIRMATION_REQUIRED: "OWNER_CONFIRMATION_REQUIRED"
});

const GATE_REASONS = Object.freeze({
    INVALID_INTENT: "INVALID_INTENT",
    INVALID_IDENTITY: "INVALID_IDENTITY",
    CAPABILITY_NOT_FOUND: "CAPABILITY_NOT_FOUND",
    CAPABILITY_INCARNATION_MISMATCH: "CAPABILITY_INCARNATION_MISMATCH",
    OPERATION_NOT_DECLARED: "OPERATION_NOT_DECLARED",
    CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
    CAPABILITY_DEGRADED: "CAPABILITY_DEGRADED",
    AUTHORITY_INSUFFICIENT: "AUTHORITY_INSUFFICIENT",
    OWNER_CONFIRMATION_REQUIRED: "OWNER_CONFIRMATION_REQUIRED",
    AUTHORITY_STATE_STALE: "AUTHORITY_STATE_STALE",
    MALFORMED_AUTHORITY_EVALUATION: "MALFORMED_AUTHORITY_EVALUATION"
});

const ALLOW_REASON = "AUTHORIZED";

/**
 * PURE predicate. Validate that a positive AuthorityEvaluation exactly matches
 * the request the gate sent. Any missing/mismatched/malformed field => fail
 * closed (returns an error string; null means the shape is exact).
 */
function validateAuthorityEvaluation(authResult, req) {
    if (authResult.allowed !== true) return "allowed !== true";
    const s = authResult.snapshot;
    if (!s || typeof s !== "object" || Array.isArray(s)) return "missing snapshot";

    if (typeof s.generation !== "number" || !Number.isSafeInteger(s.generation) || s.generation < 0) {
        return "missing/invalid generation";
    }
    if (typeof s.capabilityId !== "string" || s.capabilityId !== req.capabilityId) {
        return "capabilityId mismatch";
    }
    if (typeof s.subject !== "string" || s.subject.length === 0) return "missing subject";

    if (typeof s.principal !== "string" || s.principal !== req.principal) {
        return "principal mismatch";
    }

    const actions = Array.isArray(s.actions) ? s.actions.map((a) => String(a).trim().toLowerCase()) : [];
    if (!actions.includes(req.operation)) return "action mismatch";

    const reqScope = req.scope.map((t) => String(t).trim().toLowerCase()).sort();
    const snapScope = Array.isArray(s.scope) ? s.scope.map((t) => String(t).trim().toLowerCase()).sort() : [];
    if (JSON.stringify(snapScope) !== JSON.stringify(reqScope)) return "scope mismatch";

    if (typeof authResult.reasonCode !== "string" || authResult.reasonCode.length === 0) {
        return "missing reasonCode";
    }

    return null;
}

// NO gate constructor. NO privileged composition hook. Nothing mintable.
module.exports = { DECISION, GATE_REASONS, ALLOW_REASON, validateAuthorityEvaluation };
