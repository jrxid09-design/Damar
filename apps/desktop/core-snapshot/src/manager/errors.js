"use strict";

/**
 * DAMAR MANAGER — Lane 5 error + lifecycle contract (inert vocabulary ONLY —
 * no builder, no brand, no composition, no registrar).
 *
 * CORE LAWS (Lane 5 — the Manager coordinates, it never authorizes):
 *
 *   MANAGER != AUTHORITY
 *   MANAGER != ACTUATOR
 *   MANAGER != VERIFIER
 *   MANAGER != COMPENSATION AUTHORITY
 *   CHANNEL != AUTHORITY
 *   MODEL CLAIM != AUTHORITY
 *   MEMORY != AUTHORITY
 *   PLAN != AUTHORITY
 *
 * The Manager routes requests through the certified fabric:
 *   Channel → Manager → Lane 2 (authority) → Lane 3 (actuation)
 *   → Lane 4 (verification) → [optional Lane 4 compensation]
 *   → unified result projection.
 *
 * The Manager never recreates a parallel execution system, never returns
 * ALLOW itself, never constructs bearer AuthorityDecisions, never invokes
 * actuators/verifiers directly, and never treats planner output, memory,
 * channel metadata, or Pandawa output as authority.
 */

const { ActionError } = require("../action/errors");

/**
 * MANAGER LIFECYCLE STATES — the Manager's request lifecycle. Lower-layer
 * states are mapped but NEVER collapsed incorrectly:
 *
 *   Lane 3 TIMED_OUT  !=  Manager FAILED with "no side effect"
 *   Lane 4 INCONCLUSIVE  !=  Manager SUCCESS
 *   VERIFIED_SUCCESS is the only strong successful postcondition truth state.
 *   CANCELLED != NO SIDE EFFECT (dispatch may already have happened).
 */
const LIFECYCLE = Object.freeze({
    RECEIVED: "RECEIVED",
    NORMALIZED: "NORMALIZED",
    PLANNED: "PLANNED",
    INTENT_FORMED: "INTENT_FORMED",
    AUTHORITY_EVALUATED: "AUTHORITY_EVALUATED",
    DISPATCHED: "DISPATCHED",
    EXECUTED: "EXECUTED",
    VERIFYING: "VERIFYING",
    VERIFIED: "VERIFIED",
    COMPENSATING: "COMPENSATING",
    COMPLETED: "COMPLETED",
    INCONCLUSIVE: "INCONCLUSIVE",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED"
});

/**
 * USER-FACING OUTCOME CATEGORIES — the semantic classification projected to
 * ALL channels uniformly. Channels may vary presentation only, never the
 * classification (no channel-specific timeout reinterpretation).
 */
const OUTCOME = Object.freeze({
    COMPLETED: "COMPLETED",                 // VERIFIED_SUCCESS (strong truth)
    EXECUTED_UNVERIFIED: "EXECUTED_UNVERIFIED", // actuator reported done, not verified
    INCONCLUSIVE: "INCONCLUSIVE",           // ambiguity preserved, never fabricated
    FAILED: "FAILED",
    AUTHORITY_DENIED: "AUTHORITY_DENIED",
    CANCELLED: "CANCELLED",
    INVALID_REQUEST: "INVALID_REQUEST",
    AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED"
});

const REASONS = Object.freeze({
    // request validation (fail-closed)
    INVALID_MANAGER_REQUEST: "INVALID_MANAGER_REQUEST",
    FOREIGN_MANAGER_REQUEST: "FOREIGN_MANAGER_REQUEST",
    MALFORMED_PAYLOAD: "MALFORMED_PAYLOAD",
    NON_PLAIN_OBJECT: "NON_PLAIN_OBJECT",
    BOUND_EXCEEDED: "BOUND_EXCEEDED",
    CYCLIC_INPUT: "CYCLIC_INPUT",
    FUNCTION_VALUE: "FUNCTION_VALUE",
    SYMBOL_VALUE: "SYMBOL_VALUE",
    DANGEROUS_KEY: "DANGEROUS_KEY",
    ACCESSOR_PROPERTY: "ACCESSOR_PROPERTY",
    DUPLICATE_REQUEST: "DUPLICATE_REQUEST",
    REQUEST_CANCELLED: "REQUEST_CANCELLED",

    // identity / session provenance (canonical authentication first)
    AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
    INVALID_IDENTITY: "INVALID_IDENTITY",

    // routing classification
    CHANNEL_ADAPTER_ERROR: "CHANNEL_ADAPTER_ERROR",
    PLANNER_UNAVAILABLE: "PLANNER_UNAVAILABLE",

    // action routing (canonical fabric only)
    INTENT_REJECTED: "INTENT_REJECTED",
    AUTHORITY_DENIED: "AUTHORITY_DENIED",
    ACTUATION_REJECTED: "ACTUATION_REJECTED",
    VERIFICATION_INCONCLUSIVE: "VERIFICATION_INCONCLUSIVE",
    VERIFICATION_ERROR: "VERIFICATION_ERROR",
    VERIFICATION_TIMED_OUT: "VERIFICATION_TIMED_OUT",
    COMPENSATION_NOT_INDICATED: "COMPENSATION_NOT_INDICATED",
    COMPENSATION_FAILED: "COMPENSATION_FAILED",

    // surface discipline (mirrors Lane 2/3/4)
    CALLER_EXECUTOR_REJECTED: "CALLER_EXECUTOR_REJECTED",
    REGISTRATION_REJECTED: "REGISTRATION_REJECTED"
});

function fail(reasonCode, message, details = null) {
    return new ActionError(reasonCode, message, details);
}

/** PURE predicate — is `state` a valid Manager lifecycle state? */
function isLifecycleState(state) {
    return typeof state === "string" &&
        Object.prototype.hasOwnProperty.call(LIFECYCLE, state);
}

/** PURE predicate — is `outcome` a valid user-facing outcome category? */
function isOutcome(outcome) {
    return typeof outcome === "string" &&
        Object.prototype.hasOwnProperty.call(OUTCOME, outcome);
}

/**
 * PURE projection: map a Lane 4 verification state to the unified Manager
 * outcome category. The mapping is CANONICAL — all channels receive the
 * same semantic classification. INCONCLUSIVE / TIMED_OUT / ERROR are NEVER
 * fabricated into success or failure for UX convenience.
 */
function outcomeForVerificationState(state, OUTCOME_REF) {
    switch (state) {
        case "VERIFIED_SUCCESS": return OUTCOME_REF.COMPLETED;
        case "VERIFIED_FAILURE": return OUTCOME_REF.FAILED;
        case "INCONCLUSIVE": return OUTCOME_REF.INCONCLUSIVE;
        case "TIMED_OUT": return OUTCOME_REF.INCONCLUSIVE;
        case "ERROR": return OUTCOME_REF.FAILED;
        default: return OUTCOME_REF.INCONCLUSIVE;
    }
}

/**
 * PURE projection: map a Lane 3 result state to the unified Manager outcome
 * category (used when verification is not applicable / not requested).
 * Lane 3 TIMED_OUT maps to INCONCLUSIVE — NOT to FAILED "no side effect".
 */
function outcomeForExecutionState(state, OUTCOME_REF) {
    switch (state) {
        case "EXECUTED": return OUTCOME_REF.EXECUTED_UNVERIFIED;
        case "FAILED": return OUTCOME_REF.FAILED;
        case "TIMED_OUT": return OUTCOME_REF.INCONCLUSIVE;
        case "CANCELLED": return OUTCOME_REF.CANCELLED;
        default: return OUTCOME_REF.INCONCLUSIVE;
    }
}

module.exports = {
    // inert frozen vocabularies + pure predicates ONLY
    LIFECYCLE,
    OUTCOME,
    REASONS,
    fail,
    ManagerError: ActionError,
    isLifecycleState,
    isOutcome,
    outcomeForVerificationState,
    outcomeForExecutionState
};

// NOT exported: any brand state, any composition, any registrar, any
// canonical former.
