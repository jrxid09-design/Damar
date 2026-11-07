"use strict";

/**
 * ACTION VERIFICATION + COMPENSATION FABRIC V1 — Lane 4 public surface
 * (inert vocabulary ONLY).
 *
 * CORE LAWS (Lane 4 extends the certified Lane 1–3 chain):
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
 * WHAT THIS SURFACE EXPORTS (all non-privileged):
 *   - LIFECYCLE / VERIFICATION_STATE / COMPENSATION_STATE / REASONS /
 *     TERMINAL_VERIFICATION_STATES / ExecutionError — inert vocabularies and
 *     the typed error contract
 *   - VERIFICATION_REQUEST_SCHEMA_VERSION / VERIFICATION_RESULT_SCHEMA_VERSION /
 *     COMPENSATION_PLAN_SCHEMA_VERSION / COMPENSATION_RESULT_SCHEMA_VERSION /
 *     BOUNDS / DEFAULT_VERIFY_TIMEOUT_MS / MAX_VERIFY_TIMEOUT_MS /
 *     MIN_VERIFY_TIMEOUT_MS — inert schema vocabulary
 *   - POSTCONDITION_SCHEMA_VERSION / POSTCONDITION_KIND / POSTCONDITION_OPS /
 *     POSTCONDITION_TYPES — declarative postcondition vocabulary
 *   - READINESS — verifier readiness vocabulary
 *   - PURE predicates — isVerificationState / isTerminalVerificationState /
 *     isCompensationState / isPostconditionOp / isPostconditionType /
 *     isValidPostconditionPath / isReadiness / isValidVerifyTimeoutMs
 *
 * WHAT THIS SURFACE DOES NOT EXPORT (mirrors Lane 3 discipline):
 *   - isCanonicalVerificationRequest / isCanonicalVerificationResult /
 *     isCanonicalCompensationPlan — these are BRAND-FIRST predicates that read
 *     closure-private WeakSets owned by the trusted bootstrap
 *     (src/action/bootstrap.js). They live as METHODS on the canonical
 *     verification facade returned by createCanonicalVerificationFacade(),
 *     reachable ONLY through that trusted-bootstrap-owned singleton. A free
 *     function here would have to expose the WeakSets (forbidden) or rely on
 *     structural shape (forgeable — rejected).
 *   - buildVerifierRegistry / registerVerifier / composeVerification /
 *     formVerificationRequest / buildVerificationResult / formCompensationPlan /
 *     buildCompensationResult / sanitizeEvidence / evaluatePostcondition /
 *     any compensator registry / any rollback executor.
 *
 * Downstream receives ONLY the frozen { verify, compensate } facade the
 * trusted bootstrap layer hands out (plus the pure brand-recognition
 * predicates for checking externally-provided values).
 */

const {
    LIFECYCLE, VERIFICATION_STATE, COMPENSATION_STATE, REASONS,
    TERMINAL_VERIFICATION_STATES, ExecutionError, isVerificationState,
    isTerminalVerificationState, isCompensationState
} = require("./errors");
const {
    VERIFICATION_REQUEST_SCHEMA_VERSION, VERIFICATION_RESULT_SCHEMA_VERSION,
    COMPENSATION_PLAN_SCHEMA_VERSION, COMPENSATION_RESULT_SCHEMA_VERSION,
    BOUNDS, DEFAULT_VERIFY_TIMEOUT_MS, MAX_VERIFY_TIMEOUT_MS,
    MIN_VERIFY_TIMEOUT_MS, isValidVerifyTimeoutMs
} = require("./schema");
const {
    POSTCONDITION_SCHEMA_VERSION, POSTCONDITION_KIND, POSTCONDITION_OPS,
    POSTCONDITION_TYPES, isPostconditionOp, isPostconditionType,
    isValidPostconditionPath
} = require("./postcondition");
const { READINESS, isReadiness: isVerifierReadiness } = require("./verifierRegistry");

module.exports = {
    // inert vocabularies ONLY
    LIFECYCLE,
    VERIFICATION_STATE,
    TERMINAL_VERIFICATION_STATES,
    COMPENSATION_STATE,
    REASONS,
    ExecutionError,

    VERIFICATION_REQUEST_SCHEMA_VERSION,
    VERIFICATION_RESULT_SCHEMA_VERSION,
    COMPENSATION_PLAN_SCHEMA_VERSION,
    COMPENSATION_RESULT_SCHEMA_VERSION,
    BOUNDS,
    DEFAULT_VERIFY_TIMEOUT_MS,
    MAX_VERIFY_TIMEOUT_MS,
    MIN_VERIFY_TIMEOUT_MS,
    isValidVerifyTimeoutMs,

    POSTCONDITION_SCHEMA_VERSION,
    POSTCONDITION_KIND,
    POSTCONDITION_OPS,
    POSTCONDITION_TYPES,
    isPostconditionOp,
    isPostconditionType,
    isValidPostconditionPath,

    READINESS,
    isVerifierReadiness,

    isVerificationState,
    isTerminalVerificationState,
    isCompensationState
};

// NOT exported (privileged construction is bootstrap-private): every former,
// the verifier/compensator registrar capability, the dispatcher, and the
// brand tokens/WeakSets. The brand predicates live as METHODS on the
// canonical verification facade returned by
// src/action/bootstrap.js::createCanonicalVerificationFacade().
