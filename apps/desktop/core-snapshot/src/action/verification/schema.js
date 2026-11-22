"use strict";

/**
 * ACTION VERIFICATION + COMPENSATION V1 — verification request/result and
 * compensation plan SCHEMA vocabulary (Lane 4, inert schemas ONLY — no
 * formers, no brands, no evaluators).
 *
 * CANONICAL VERIFICATION REQUEST SCHEMA (informational, for consumers):
 *
 *   {
 *     schemaVersion: 1,
 *     verificationId,        // uuid minted by the trusted former
 *     executionId,           // bound to the canonical Lane 3 ExecutionResult
 *     intentId, capabilityId, capabilityIncarnationId,
 *     operation, principal, scope[],
 *     actuatorId, actuatorIncarnationId,
 *     authorityGeneration,   // authority generation used by the execution
 *     verifierId, verifierIncarnationId,
 *     expectedPostcondition, // canonical declarative postcondition (frozen)
 *     requestedAtMs, timeoutMs
 *   }
 *
 * A VerificationRequest is formed ONLY from a canonical Lane 3
 * ExecutionResult (brand-checked) plus the bootstrap-owned verifier binding.
 * The trusted former copies binding identity (verifierId/incarnation) from
 * the registry — a caller can never bind a caller-selected verifier.
 *
 * CANONICAL VERIFICATION RESULT SCHEMA (informational):
 *
 *   {
 *     schemaVersion: 1,
 *     verificationId, executionId, intentId,
 *     capabilityId, capabilityIncarnationId, operation, principal,
 *     actuatorId, actuatorIncarnationId, authorityGeneration,
 *     verifierId, verifierIncarnationId,
 *     expectedPostcondition,   // what was expected (immutable copy)
 *     observedEvidence,        // sanitized observed evidence or null
 *     observationMethod,       // how it was observed (verifier binding id)
 *     verificationState,       // VERIFICATION_STATE
 *     observedAtMs, verifiedAtMs,
 *     detail,                  // sanitized human-readable detail or ""
 *   }
 *
 * Evidence records what was expected, observed, how observed, verifier
 * identity/incarnation, timestamps, and source provenance. The Audit Ledger
 * may record evidence but remains HISTORICAL evidence only:
 * AUDIT != CURRENT TRUTH.
 *
 * CANONICAL COMPENSATION PLAN SCHEMA (informational):
 *
 *   {
 *     schemaVersion: 1,
 *     compensationId,          // uuid minted by the trusted former
 *     sourceVerificationId, sourceExecutionId,
 *     principal,               // the principal requesting compensation
 *     capabilityId, capabilityIncarnationId, operation, scope[],
 *     parameters,              // declarative plain values (detached/bounded)
 *     reason,                  // sanitized reason string
 *     createdAtMs
 *   }
 *
 * A CompensationPlan contains NO executable function in its metadata. It is
 * descriptive only; executing it is a NEW ACTION that must traverse the full
 * canonical Lane 2 → Lane 3 chain (fresh intent, fresh authority, fresh
 * actuation, then Lane 4 verification of the compensation itself).
 *
 * CORE LAWS:
 *   COMPENSATION != ROLLBACK GUARANTEE
 *   PLAN != AUTHORITY
 *   AUDIT != CURRENT TRUTH / MEMORY != CURRENT TRUTH / MODEL CLAIM != VERIFICATION
 */

const VERIFICATION_REQUEST_SCHEMA_VERSION = 1;
const VERIFICATION_RESULT_SCHEMA_VERSION = 1;
const COMPENSATION_PLAN_SCHEMA_VERSION = 1;
const COMPENSATION_RESULT_SCHEMA_VERSION = 1;

const BOUNDS = Object.freeze({
    MAX_VERIFICATION_ID_CHARS: 128,
    MAX_EXECUTION_ID_CHARS: 128,
    MAX_INTENT_ID_CHARS: 128,
    MAX_CAPABILITY_ID_CHARS: 256,
    MAX_OPERATION_CHARS: 256,
    MAX_PRINCIPAL_CHARS: 128,
    MAX_VERIFIER_ID_CHARS: 128,
    MAX_ACTUATOR_ID_CHARS: 128,
    MAX_DETAIL_CHARS: 1024,
    MAX_COMPENSATION_REASON_CHARS: 256,
    MAX_COMPENSATION_PARAMETERS_KEYS: 64,
    MAX_PARAMETERS_NODES: 512,
    GLOBAL_MAX_ARRAY_LENGTH: 1024,
    MAX_SCOPE: 32
});

const DEFAULT_VERIFY_TIMEOUT_MS = 10_000;
const MAX_VERIFY_TIMEOUT_MS = 60_000;
const MIN_VERIFY_TIMEOUT_MS = 1;

/** PURE predicate — is `value` within the legal verification timeout window? */
function isValidVerifyTimeoutMs(value) {
    return typeof value === "number" && Number.isSafeInteger(value) &&
        value >= MIN_VERIFY_TIMEOUT_MS && value <= MAX_VERIFY_TIMEOUT_MS;
}

module.exports = {
    // inert frozen vocabulary + pure predicate ONLY
    VERIFICATION_REQUEST_SCHEMA_VERSION,
    VERIFICATION_RESULT_SCHEMA_VERSION,
    COMPENSATION_PLAN_SCHEMA_VERSION,
    COMPENSATION_RESULT_SCHEMA_VERSION,
    BOUNDS,
    DEFAULT_VERIFY_TIMEOUT_MS,
    MAX_VERIFY_TIMEOUT_MS,
    MIN_VERIFY_TIMEOUT_MS,
    isValidVerifyTimeoutMs
};

// NOT exported: formVerificationRequest, buildVerificationResult,
// buildCompensationPlan, any evidence sanitizer, any evaluator.
