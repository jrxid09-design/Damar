"use strict";

/**
 * ACTION VERIFICATION + COMPENSATION V1 — Lane 4 error + state contract
 * (inert vocabulary ONLY — no builder, no registry, no factory, no brand).
 *
 * CORE LAWS (Lane 4 — extends the certified Lane 1–3 chain):
 *
 *   EXECUTED != VERIFIED
 *   ACTUATOR REPORT != WORLD TRUTH
 *   TIMEOUT != NO SIDE EFFECT
 *   AUDIT != CURRENT TRUTH
 *   MEMORY != CURRENT TRUTH
 *   MODEL CLAIM != VERIFICATION
 *   PLAN != AUTHORITY
 *   COMPENSATION != ROLLBACK GUARANTEE
 *
 * Every rejection carries a stable `reasonCode` so callers branch on
 * machine-readable causes without parsing messages. All failures are
 * fail-closed: malformed input is rejected, never silently repaired.
 *
 * TRUST ORIGIN (mirrors Lane 2/Lane 3 certified discipline):
 *
 *   - Verifier and compensator registration is BOOTSTRAP-OWNED. The registry
 *     implementation, registrar capability, brand tokens, brand WeakSets and
 *     every privileged former live ONLY inside the trusted bootstrap's private
 *     composition closure (src/action/bootstrap.js). A direct import of THIS
 *     module yields ONLY the inert vocabularies below — no constructor, no
 *     registrar, no factory, no mutation surface.
 *
 *   - The result-provenance predicates (isCanonicalVerificationRequest /
 *     isCanonicalVerificationResult / isCanonicalCompensationPlan) are
 *     BRAND-FIRST: they read closure-private WeakSets owned by the trusted
 *     bootstrap and live as METHODS on the canonical verification facade.
 *     There is no free function here that could recognize them structurally.
 *
 *   - Downstream may supply DECLARATIVE expected postconditions (canonical
 *     declarative spec values) — never executable predicate code, never a
 *     caller-selected verifier/sensor/predicate/compensator.
 *
 * THE PUBLIC/DOWNSTREAM SURFACE IS EXACTLY the frozen
 * { verify, compensate } (+ pure brand-recognition predicates) handed out by
 * createCanonicalVerificationFacade() — see the Lane 4 doc:
 * docs/architecture/ACTION-VERIFICATION-COMPENSATION-V1.md
 */

const { ActionError } = require("../errors");

/**
 * VERIFICATION LIFECYCLE — the verification lifecycle state machine.
 *
 * CREATED      — canonical VerificationRequest formed, not yet observing
 * OBSERVING    — canonical verifier observation in flight
 * COMPLETE     — verification reached a terminal verification state
 * FAILED       — verification infrastructure failed (fail-closed; NOT a
 *                claim about the world)
 * TIMED_OUT    — observation exceeded the verification timeout boundary:
 *                "verification could not establish truth within bound".
 *                NOT "action failed" and NOT "action succeeded".
 */
const LIFECYCLE = Object.freeze({
    CREATED: "CREATED",
    OBSERVING: "OBSERVING",
    COMPLETE: "COMPLETE",
    FAILED: "FAILED",
    TIMED_OUT: "TIMED_OUT"
});

/**
 * VERIFICATION STATES — the precise truth vocabulary. INCONCLUSIVE is a
 * first-class terminal state and is NEVER collapsed into failure or success.
 *
 * PENDING           — verification accepted, truth not yet established
 * OBSERVING         — observation in flight (transient)
 * VERIFIED_SUCCESS  — observed evidence matched the expected postcondition
 * VERIFIED_FAILURE  — observed evidence matched an explicit failure of the
 *                     expected postcondition (actuator/verification did run;
 *                     this is a claim ABOUT THE WORLD, only ever minted by
 *                     the canonical evaluator from canonical evidence)
 * INCONCLUSIVE      — evidence was missing, ambiguous, or contradictory;
 *                     truth was NOT established either way
 * TIMED_OUT         — verification bound exceeded before truth was
 *                     established (ambiguity preserved)
 * ERROR             — verifier infrastructure error (verifier error is NOT
 *                     a VERIFIED_FAILURE; the world was not measured)
 */
const VERIFICATION_STATE = Object.freeze({
    PENDING: "PENDING",
    OBSERVING: "OBSERVING",
    VERIFIED_SUCCESS: "VERIFIED_SUCCESS",
    VERIFIED_FAILURE: "VERIFIED_FAILURE",
    INCONCLUSIVE: "INCONCLUSIVE",
    TIMED_OUT: "TIMED_OUT",
    ERROR: "ERROR"
});

/** Terminal verification states (no further evaluation). */
const TERMINAL_VERIFICATION_STATES = Object.freeze(new Set([
    VERIFICATION_STATE.VERIFIED_SUCCESS,
    VERIFICATION_STATE.VERIFIED_FAILURE,
    VERIFICATION_STATE.INCONCLUSIVE,
    VERIFICATION_STATE.TIMED_OUT,
    VERIFICATION_STATE.ERROR
]));

/**
 * COMPENSATION STATES — tracked separately from verification. There is
 * deliberately NO "ROLLED_BACK" state: compensation executed != original
 * state restored. Restoration is only ever claimed by a fresh Lane 4
 * verification whose result is VERIFIED_SUCCESS on the restoration
 * postcondition.
 */
const COMPENSATION_STATE = Object.freeze({
    PROPOSED: "COMPENSATION_PROPOSED",
    AUTHORIZED: "COMPENSATION_AUTHORIZED",
    EXECUTED: "COMPENSATION_EXECUTED",
    VERIFIED: "COMPENSATION_VERIFIED",
    FAILED: "COMPENSATION_FAILED",
    INCONCLUSIVE: "COMPENSATION_INCONCLUSIVE"
});

const REASONS = Object.freeze({
    // request validation (mirrors Lane 3 vocabulary)
    MALFORMED_REQUEST: "MALFORMED_REQUEST",
    MALFORMED_PAYLOAD: "MALFORMED_PAYLOAD",
    NON_PLAIN_OBJECT: "NON_PLAIN_OBJECT",
    BOUND_EXCEEDED: "BOUND_EXCEEDED",
    FUNCTION_VALUE: "FUNCTION_VALUE",
    SYMBOL_VALUE: "SYMBOL_VALUE",
    DANGEROUS_KEY: "DANGEROUS_KEY",
    ACCESSOR_PROPERTY: "ACCESSOR_PROPERTY",
    CYCLIC_INPUT: "CYCLIC_INPUT",

    // provenance trust boundary (Lane 3 canonical ExecutionResult required)
    NOT_CANONICAL_EXECUTION_RESULT: "NOT_CANONICAL_EXECUTION_RESULT",
    FOREIGN_DOMAIN_RESULT: "FOREIGN_DOMAIN_RESULT",

    // verifier registry trust boundary
    VERIFIER_NOT_FOUND: "VERIFIER_NOT_FOUND",
    VERIFIER_INCARNATION_MISMATCH: "VERIFIER_INCARNATION_MISMATCH",
    VERIFIER_UNAVAILABLE: "VERIFIER_UNAVAILABLE",
    VERIFIER_REJECTED_OBSERVATION: "VERIFIER_REJECTED_OBSERVATION",
    VERIFIER_MALFORMED_OBSERVATION: "VERIFIER_MALFORMED_OBSERVATION",
    REGISTRATION_REJECTED: "REGISTRATION_REJECTED",

    // postcondition trust boundary (declarative only)
    CALLER_VERIFIER_REJECTED: "CALLER_VERIFIER_REJECTED",
    EXECUTABLE_POSTCONDITION_REJECTED: "EXECUTABLE_POSTCONDITION_REJECTED",

    // compensation trust boundary
    COMPENSATION_NOT_AUTHORIZED: "COMPENSATION_NOT_AUTHORIZED",
    COMPENSATION_PLAN_MALFORMED: "COMPENSATION_PLAN_MALFORMED",
    COMPENSATION_VERIFICATION_REQUIRED: "COMPENSATION_VERIFICATION_REQUIRED",
    COMPENSATION_NOT_INDICATED: "COMPENSATION_NOT_INDICATED",
    COMPENSATOR_NOT_FOUND: "COMPENSATOR_NOT_FOUND",
    COMPENSATOR_INCARNATION_MISMATCH: "COMPENSATOR_INCARNATION_MISMATCH",
    COMPENSATOR_UNAVAILABLE: "COMPENSATOR_UNAVAILABLE",
    DUPLICATE_COMPENSATION_ID: "DUPLICATE_COMPENSATION_ID",

    // duplicates
    DUPLICATE_VERIFICATION_ID: "DUPLICATE_VERIFICATION_ID",

    // timeout
    TIMEOUT_EXCEEDED: "TIMEOUT_EXCEEDED",
    INVALID_TIMEOUT_CONFIG: "INVALID_TIMEOUT_CONFIG",

    // executor surface protection (mirrors Lane 2/Lane 3 discipline)
    CALLER_EXECUTOR_REJECTED: "CALLER_EXECUTOR_REJECTED"
});

function fail(reasonCode, message, details = null) {
    return new ActionError(reasonCode, message, details);
}

/** PURE predicate — is `state` a valid verification state? */
function isVerificationState(state) {
    return typeof state === "string" &&
        Object.prototype.hasOwnProperty.call(VERIFICATION_STATE, state);
}

/** PURE predicate — is `state` terminal for verification? */
function isTerminalVerificationState(state) {
    return TERMINAL_VERIFICATION_STATES.has(state);
}

/** PURE predicate — is `state` a valid compensation state? */
function isCompensationState(state) {
    return typeof state === "string" &&
        Object.prototype.hasOwnProperty.call(COMPENSATION_STATE, state);
}

/** Typed error contract re-export (mirrors Lane 3's ExecutionError alias). */
const ExecutionError = ActionError;

module.exports = {
    // inert frozen vocabularies + pure predicates ONLY
    LIFECYCLE,
    VERIFICATION_STATE,
    TERMINAL_VERIFICATION_STATES,
    COMPENSATION_STATE,
    REASONS,
    fail,
    ExecutionError,
    isVerificationState,
    isTerminalVerificationState,
    isCompensationState
};

// NOT exported (privileged construction is bootstrap-private): any verifier
// registry, registrar, former, sanitizer, evaluator, compensator, plan
// builder, brand token, WeakSet, or mutation surface.
