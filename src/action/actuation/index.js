"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — Lane 3 public surface (FIRST targeted repair:
 * inert vocabulary ONLY — brand predicates moved onto the trusted-bootstrap-
 * owned actuation facade, not here, because a closure-private brand cannot be
 * recognized by a free function in any non-privileged module).
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
 * WHAT THIS SURFACE EXPORTS (all non-privileged):
 *   - LIFECYCLE / RESULT_STATE / REASONS / TRANSITIONS / ExecutionError —
 *     inert vocabularies and the typed error contract
 *
 * WHAT THIS SURFACE DOES NOT EXPORT (FIRST targeted repair):
 *   - isCanonicalExecutionRequest / isCanonicalExecutionResult — these are
 *     BRAND-FIRST predicates that read closure-private WeakSets owned by the
 *     trusted bootstrap (src/action/bootstrap.js). They live as METHODS on
 *     the canonical actuation facade returned by createCanonicalActuationFacade(),
 *     reachable ONLY through that trusted-bootstrap-owned singleton. A free
 *     function here would have to expose the WeakSets (forbidden) or rely on
 *     structural shape (forgeable — rejected). Methods on the facade read the
 *     closure-private brand directly.
 *   - buildActuatorRegistry / composeDispatcher / formExecutionRequest /
 *     buildExecutionResult / buildExecutionEvidence / createLifecycleTracker /
 *     sanitizeActuatorOutput / any registrar capability / any actuator
 *     invocation function / any brand token, WeakSet, or mutation surface.
 *
 * Downstream receives ONLY the frozen { execute, isCanonicalExecutionRequest,
 * isCanonicalExecutionResult } facade the trusted bootstrap layer hands out.
 */

const { LIFECYCLE, RESULT_STATE, REASONS } = require("./errors");
const { TRANSITIONS } = require("./lifecycle");
const { ActionError } = require("../errors");

const ExecutionError = ActionError;

module.exports = {
    // inert vocabularies ONLY (FIRST targeted repair)
    LIFECYCLE,
    RESULT_STATE,
    REASONS,
    TRANSITIONS,
    ExecutionError
};

// NOT exported (privileged construction is bootstrap-private): every former,
// the registrar capability, the dispatcher, and the brand tokens/WeakSets.
// The brand predicates live as METHODS on the canonical actuation facade
// returned by src/action/bootstrap.js::createCanonicalActuationFacade().
