"use strict";

/**
 * DAMAR MANAGER — public surface (Lane 5, inert vocabulary ONLY).
 *
 * CORE LAWS:
 *
 *   MANAGER != AUTHORITY
 *   MANAGER != ACTUATOR
 *   MANAGER != VERIFIER
 *   MANAGER != COMPENSATION AUTHORITY
 *   CHANNEL != AUTHORITY
 *   MODEL CLAIM != AUTHORITY
 *   MEMORY != AUTHORITY
 *   PLAN != AUTHORITY
 *   MANAGER RESULT != AUTHORITY
 *
 * The Manager is an orchestrator that routes requests through the certified
 * fabric (Lane 2 authority → Lane 3 actuation → Lane 4 verification, with
 * optional Lane 4 compensation). It never recreates a parallel execution
 * system.
 *
 * WHAT THIS SURFACE EXPORTS (all non-privileged):
 *   - LIFECYCLE / OUTCOME / REASONS / REQUEST_CLASS / CHANNEL_TYPES / BOUNDS /
 *     schema versions — inert vocabularies
 *   - ManagerError — typed error contract
 *   - PURE predicates/projections — isLifecycleState / isOutcome /
 *     isChannelType / isRequestClass / requiresActionFabric /
 *     classifyPlannerOutput / outcomeForVerificationState /
 *     outcomeForExecutionState
 *
 * WHAT THIS SURFACE DOES NOT EXPORT (mirrors Lane 2/3/4 discipline):
 *   - isCanonicalManagerRequest / isCanonicalManagerResult — BRAND-FIRST
 *     predicates reading closure-private per-composition WeakSets owned by
 *     the trusted composition. They live as METHODS on the canonical Manager
 *     facade returned by createDamarManager() (via the trusted internal
 *     composition). A free function here would have to expose the WeakSets
 *     (forbidden) or rely on structural shape (forgeable — rejected).
 *   - createDamarManagerComposition / any composition factory / any registrar
 *   - any request/result former, any brand token, any WeakSet
 *   - any Lane 2/Lane 3/Lane 4 facade, any actuator/verifier registry
 *
 * The production facade is EXACTLY:
 *
 *   Object.freeze({
 *     handle, cancel,
 *     isCanonicalManagerRequest, isCanonicalManagerResult
 *   })
 *
 * reachable ONLY through the trusted bootstrap (src/manager/bootstrap.js).
 */

const {
    LIFECYCLE, OUTCOME, REASONS, fail, ManagerError,
    isLifecycleState, isOutcome,
    outcomeForVerificationState, outcomeForExecutionState
} = require("./errors");
const {
    REQUEST_SCHEMA_VERSION, RESULT_SCHEMA_VERSION, CHANNEL_TYPES, BOUNDS,
    isChannelType
} = require("./schema");
const {
    REQUEST_CLASS, isRequestClass, requiresActionFabric, classifyPlannerOutput
} = require("./channelAdapter");
const { createDamarManager } = require("./bootstrap");

module.exports = {
    // inert vocabularies ONLY
    LIFECYCLE,
    OUTCOME,
    REASONS,
    ManagerError,
    REQUEST_SCHEMA_VERSION,
    RESULT_SCHEMA_VERSION,
    CHANNEL_TYPES,
    BOUNDS,
    isChannelType,
    REQUEST_CLASS,
    isRequestClass,
    requiresActionFabric,
    classifyPlannerOutput,
    isLifecycleState,
    isOutcome,
    outcomeForVerificationState,
    outcomeForExecutionState,
    // Safe canonical production entrypoint; privileged composition remains
    // private to bootstrap and accepts no caller options.
    createDamarManager
};

// NOT exported (privileged construction is composition-private): any
// composition factory, registrar, former, brand token, WeakSet, or the
// canonical application Manager instance.
