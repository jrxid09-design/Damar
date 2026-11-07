"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — result/evidence vocabulary (Lane 3, FIRST
 * targeted repair: inert schema vocabulary ONLY — no result/evidence
 * builder, no hostile-output sanitizer).
 *
 * CORE LAWS (be precise about naming):
 *
 *   EXECUTED != SUCCEEDED      — an actuator invocation completing and
 *                                reporting success is recorded as
 *                                actuator-reported success; it is NOT proof
 *                                the real-world effect occurred as intended.
 *   SUCCEEDED != VERIFIED      — Lane 3 NEVER claims verification truth.
 *                                Verification belongs to Lane 4. There is no
 *                                VERIFIED state anywhere in Lane 3.
 *   TIMED_OUT != NO-EFFECT     — timeout preserves effect ambiguity:
 *                                timeout != proof of no side effect.
 *   CANCELLED only pre-invocation — cancellation after invocation started
 *                                must NOT claim the effect was prevented.
 *
 * FIRST TARGETED REPAIR: `buildExecutionResult` / `buildExecutionEvidence` /
 * `sanitizeActuatorOutput` are NOT exported. The result/evidence builders and
 * the hostile-output sanitizer implementation live ONLY inside the trusted
 * bootstrap's private composition closure (src/action/bootstrap.js), exactly
 * like every other privileged Lane 3 constructor. This module exports ONLY
 * the inert schema version (for downstream recognition).
 *
 * The canonical result SCHEMA (informational, for consumers):
 *
 *   {
 *     schemaVersion: 1,
 *     executionId, intentId, capabilityId, capabilityIncarnationId,
 *     operation, principal, actuatorId, actuatorIncarnationId,
 *     state (RESULT_STATE), startedAtMs, completedAtMs,
 *     actuatorReport (sanitized or null), failureReason, failureDetail,
 *     authorityGeneration, lifecycleTrace,
 *     verified: null, verificationClaim: null   (explicit non-claims)
 *   }
 *
 * The canonical evidence SCHEMA (informational):
 *
 *   {
 *     schemaVersion: 1, kind: "action.actuation.execution",
 *     executionId, intentId, principal, capabilityId, operation, scope,
 *     capabilityIncarnationId, actuatorId, actuatorIncarnationId,
 *     authorityGeneration, revalidatedAtMs,
 *     startedAtMs, completedAtMs, state, failureReason, lifecycleTrace,
 *     verified: null
 *   }
 *
 * Evidence records what happened per Lane 3 semantics; the Audit Ledger is
 * NOT the source of current truth.
 */

const RESULT_SCHEMA_VERSION = 1;
const EVIDENCE_SCHEMA_VERSION = 1;

module.exports = {
    // inert frozen vocabulary ONLY
    RESULT_SCHEMA_VERSION,
    EVIDENCE_SCHEMA_VERSION
};
