"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — Lane 3 public surface (non-privileged only).
 *
 * CORE LAWS:
 *
 *   AVAILABLE != AUTHORIZED
 *   AUTHORIZED != EXECUTED
 *   EXECUTED != SUCCEEDED
 *   SUCCEEDED != VERIFIED
 *
 *   AUTHORITY DECISION IS HISTORICAL EVIDENCE, NOT A BEARER EXECUTION TOKEN.
 *
 * Lane 3 answers: how is an authorized action dispatched to the correct
 * actuator, and how do we preserve execution provenance and fail safely?
 * Lane 3 MUST NOT decide authority independently — fresh canonical Lane 2
 * revalidation is INTERNAL to execute().
 *
 * WHAT THIS SURFACE EXPORTS (all non-privileged):
 *   - LIFECYCLE / RESULT_STATE / REASONS / TRANSITIONS / ExecutionError —
 *     inert vocabularies and the typed error contract
 *   - isCanonicalExecutionRequest — PURE predicate: verifies an object was
 *     genuinely produced by the canonical request former (closure-only brand
 *     membership check; no token, no mutation surface)
 *   - isCanonicalExecutionResult — PURE predicate: verifies an object was
 *     genuinely produced by the canonical result builder
 *
 * NOT exported (privileged construction is bootstrap-private):
 *   - composeDispatcher / buildActuatorRegistry / formExecutionRequest /
 *     buildExecutionResult / buildExecutionEvidence / createLifecycleTracker /
 *     sanitizeActuatorOutput / any registrar capability / any actuator
 *     invocation function / the brand tokens and WeakSets
 *   - NO factory, NO binder, NO token, NO first-call-wins surface. There is
 *     no path from downstream code to a privileged actuator/executor
 *     constructor over canonical state.
 *
 * The canonical dispatcher is composed by the trusted bootstrap layer
 * (src/action/bootstrap.js actuation composition) and downstream receives
 * ONLY the frozen { execute } capability the trusted layer chooses to hand
 * out. The brand predicates exist so callers can RECOGNIZE canonical
 * values, never to mint them.
 */

const { LIFECYCLE, RESULT_STATE, REASONS, requestBrandSet, resultBrandSet } = require("./errors");
const { TRANSITIONS } = require("./lifecycle");
const { ActionError } = require("../errors");

const ExecutionError = ActionError;

/**
 * PURE predicate — BRAND-FIRST: closure-only WeakSet membership decides; a
 * plain object, a clone, a JSON round-trip, or a forged Symbol lookalike is
 * never in the brand.
 */
function isCanonicalExecutionRequest(value) {
    if (value === null || typeof value !== "object") return false;
    if (value.schemaVersion !== 1) return false;
    if (typeof value.executionId !== "string" || value.executionId.length === 0) return false;
    return requestBrandSet.has(value);
}

/**
 * PURE predicate — BRAND-FIRST (same discipline as above).
 */
function isCanonicalExecutionResult(value) {
    if (value === null || typeof value !== "object") return false;
    if (value.schemaVersion !== 1) return false;
    if (typeof value.executionId !== "string" || value.executionId.length === 0) return false;
    return resultBrandSet.has(value);
}

module.exports = {
    // inert vocabularies + pure predicates only
    LIFECYCLE,
    RESULT_STATE,
    REASONS,
    TRANSITIONS,
    ExecutionError,
    isCanonicalExecutionRequest,
    isCanonicalExecutionResult
};

// NOT exported: composeDispatcher, buildActuatorRegistry, formExecutionRequest,
// buildExecutionResult, buildExecutionEvidence, createLifecycleTracker,
// sanitizeActuatorOutput, any registrar capability, any actuator invocation
// function, and the REQUEST_BRAND / RESULT_BRAND tokens + WeakSets. Privileged
// actuation composition lives ONLY inside the trusted bootstrap layer's
// private closure (src/action/bootstrap.js), exactly like Lane 2's
// runtime/auth-domain composition.