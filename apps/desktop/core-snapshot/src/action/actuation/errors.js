"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — Lane 3 error + lifecycle-state contract
 * (FIRST targeted repair: inert vocabulary ONLY — no brand state, no
 * factories, no mutation capability).
 *
 * Every rejection carries a stable `reasonCode` so callers branch on
 * machine-readable causes without parsing messages. All failures are
 * fail-closed: malformed input is rejected, never silently repaired.
 *
 * CORE LAWS (Lane 3):
 *
 *   AVAILABLE != AUTHORIZED
 *   AUTHORIZED != EXECUTED
 *   EXECUTED != SUCCEEDED
 *   SUCCEEDED != VERIFIED
 *
 *   AUTHORITY DECISION IS HISTORICAL EVIDENCE, NOT A BEARER TOKEN.
 *
 * This domain NEVER claims verification truth (that is Lane 4). The
 * vocabulary deliberately contains no VERIFIED state and no
 * "effect-confirmed" reason: execution results record what the actuator
 * REPORTED, not what the real world was proven to contain.
 *
 * FIRST TARGETED REPAIR (Lane 3): canonical brand state is NOT here. Brand
 * membership (request/result WeakSets) is established ONLY inside the
 * trusted bootstrap's private composition closure (src/action/bootstrap.js)
 * and read ONLY by the pure predicates in index.js. No export of this module
 * (or any actuation module) exposes a WeakSet, Set, brand token, minting
 * Symbol, or any add()/mark()/brand()/registerCanonical() mutation surface.
 * Downstream can ASK "is this canonical?"; downstream cannot CAUSE "make
 * this canonical".
 */

const { ActionError } = require("../errors");

/**
 * LIFECYCLE STATES — the execution lifecycle state machine (see lifecycle.js).
 *
 * CREATED       — canonical ExecutionRequest admitted, not yet revalidated
 * REVALIDATING  — fresh canonical authority/capability revalidation in progress
 * READY         — revalidation passed; binding to actuator resolved
 * DISPATCHING   — actuator invocation in flight
 * EXECUTED      — actuator invocation completed (per actuator report; NOT verified)
 * FAILED        — actuator/actuation failed before or during execution
 * TIMED_OUT     — actuator exceeded the timeout boundary (ambiguity preserved)
 * CANCELLED     — cancelled before actuator invocation started
 */
const LIFECYCLE = Object.freeze({
    CREATED: "CREATED",
    REVALIDATING: "REVALIDATING",
    READY: "READY",
    DISPATCHING: "DISPATCHING",
    EXECUTED: "EXECUTED",
    FAILED: "FAILED",
    TIMED_OUT: "TIMED_OUT",
    CANCELLED: "CANCELLED"
});

/**
 * RESULT STATES — distinct from lifecycle because EXECUTED != SUCCEEDED.
 *
 * EXECUTED   — actuator completed and reported success (still not verified)
 * FAILED     — actuator completed and reported failure, or actuation failed
 * TIMED_OUT  — actuator exceeded timeout (effect ambiguity PRESERVED —
 *              timeout != proof of no side effect)
 * CANCELLED  — cancelled before invocation (zero invocations guaranteed)
 */
const RESULT_STATE = Object.freeze({
    EXECUTED: "EXECUTED",
    FAILED: "FAILED",
    TIMED_OUT: "TIMED_OUT",
    CANCELLED: "CANCELLED"
});

const REASONS = Object.freeze({
    // request validation
    MALFORMED_REQUEST: "MALFORMED_REQUEST",
    MALFORMED_PAYLOAD: "MALFORMED_PAYLOAD",
    UNKNOWN_FIELD: "UNKNOWN_FIELD",
    NON_PLAIN_OBJECT: "NON_PLAIN_OBJECT",
    BOUND_EXCEEDED: "BOUND_EXCEEDED",
    UNBOUNDED_STRING: "UNBOUNDED_STRING",
    FUNCTION_VALUE: "FUNCTION_VALUE",
    SYMBOL_VALUE: "SYMBOL_VALUE",
    DANGEROUS_KEY: "DANGEROUS_KEY",
    ACCESSOR_PROPERTY: "ACCESSOR_PROPERTY",
    CYCLIC_INPUT: "CYCLIC_INPUT",

    // intent / session trust boundary
    INVALID_INTENT: "INVALID_INTENT",
    INVALID_SESSION: "INVALID_SESSION",
    INVALID_IDENTITY: "INVALID_IDENTITY",

    // revalidation fail-closed
    STALE_AUTHORITY: "STALE_AUTHORITY",
    AUTHORITY_DENIED: "AUTHORITY_DENIED",
    AUTHORITY_REVALIDATION_REQUIRED: "AUTHORITY_REVALIDATION_REQUIRED",
    CAPABILITY_NOT_FOUND: "CAPABILITY_NOT_FOUND",
    CAPABILITY_INCARNATION_MISMATCH: "CAPABILITY_INCARNATION_MISMATCH",
    OPERATION_NOT_DECLARED: "OPERATION_NOT_DECLARED",
    CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
    CAPABILITY_DEGRADED: "CAPABILITY_DEGRADED",

    // actuator trust boundary
    ACTUATOR_NOT_FOUND: "ACTUATOR_NOT_FOUND",
    ACTUATOR_INCARNATION_MISMATCH: "ACTUATOR_INCARNATION_MISMATCH",
    ACTUATOR_UNAVAILABLE: "ACTUATOR_UNAVAILABLE",
    ACTUATOR_REJECTED_INVOCATION: "ACTUATOR_REJECTED_INVOCATION",
    ACTUATOR_MALFORMED_RESULT: "ACTUATOR_MALFORMED_RESULT",

    // duplicate / exact-once guard
    DUPLICATE_EXECUTION_ID: "DUPLICATE_EXECUTION_ID",
    CONFLICTING_REPLAY: "CONFLICTING_REPLAY",

    // timeout / cancellation
    TIMEOUT_EXCEEDED: "TIMEOUT_EXCEEDED",
    CANCELLED_BEFORE_DISPATCH: "CANCELLED_BEFORE_DISPATCH",
    CANCELLATION_TOO_LATE: "CANCELLATION_TOO_LATE",
    INVALID_TIMEOUT_CONFIG: "INVALID_TIMEOUT_CONFIG",

    // actuator registry trust
    REGISTRATION_REJECTED: "REGISTRATION_REJECTED",
    REGISTRY_READ_FAILURE: "REGISTRY_READ_FAILURE",

    // executor surface protection (mirrors Lane 2's CALLER_BOOTSTRAP_REJECTED
    // discipline: no caller-selectable privileged composition)
    CALLER_EXECUTOR_REJECTED: "CALLER_EXECUTOR_REJECTED"
});

function fail(reasonCode, message, details = null) {
    return new ActionError(reasonCode, message, details);
}

module.exports = { LIFECYCLE, RESULT_STATE, REASONS, fail };
