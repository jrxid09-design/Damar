"use strict";

/**
 * DAMAR MANAGER — channel adapter contract + request classification
 * vocabulary (Lane 5, inert contract ONLY — no adapter registry, no
 * privileged transport surface).
 *
 * CHANNEL ADAPTER CONTRACT (narrow):
 *
 *   An adapter NORMALIZES transport-specific inbound messages into
 *   declarative request material and RENDERS outbound projections. It never
 *   receives privileged action-fabric internals and never performs any of:
 *
 *     - authorize actions
 *     - change principal
 *     - mint trusted sessions
 *     - inject capabilities
 *     - choose verifier
 *     - choose actuator
 *     - bypass Manager/fabric
 *
 *   CHANNEL != AUTHORITY.
 *
 *   Adapter surface (conceptual):
 *     normalizeInbound({ channelType, channelId, peer, sessionId, raw, metadata })
 *       -> { channelType, channelId, peer, sessionId, payload, metadata }
 *     renderOutbound(managerResult) -> presentation object
 *
 * Adapter implementations are registered through the TRUSTED composition
 * (per-composition, captured once at bootstrap) — never through a public
 * registry.
 */

const { CHANNEL_TYPES } = require("./schema");

/**
 * REQUEST CLASSIFICATION — the Manager distinguishes non-action cognition
 * from real side effects. Non-action requests complete WITHOUT entering
 * Lane 2/Lane 3 (no authority evaluation, no actuation); any real side
 * effect must enter the canonical action fabric.
 */
const REQUEST_CLASS = Object.freeze({
    INFORMATIONAL: "informational",     // answer from context/memory (no side effect)
    REASONING: "reasoning",             // cognition/planning output (advisory)
    MEMORY_LOOKUP: "memory_lookup",     // read-only recall
    PLANNING: "planning",               // proposed plan (PLAN != AUTHORITY)
    ACTION_PROPOSAL: "action_proposal", // declarative proposal for an action
    ACTION: "action"                    // real side effect -> canonical fabric
});

/** PURE predicate — is `cls` a valid request classification? */
function isRequestClass(cls) {
    return typeof cls === "string" &&
        Object.prototype.hasOwnProperty.call(REQUEST_CLASS, cls);
}

/** PURE predicate — does this classification require the action fabric? */
function requiresActionFabric(cls) {
    return cls === REQUEST_CLASS.ACTION_PROPOSAL || cls === REQUEST_CLASS.ACTION;
}

/**
 * PURE planner-output classification. Planner/model/Pandawa output is
 * UNTRUSTED DECLARATIVE INTENT MATERIAL. This predicate only decides how the
 * Manager should CLASSIFY the material for routing — it never grants
 * authority:
 *
 *   PLAN != AUTHORITY
 *   MODEL CLAIM != AUTHORITY
 *   MEMORY != AUTHORITY
 *   PANDAWA ROLE != AUTHORITY
 */
function classifyPlannerOutput(output) {
    // Any planner/model/memory/Pandawa output is advisory material. If it
    // proposes a capability+operation it is classified as an ACTION_PROPOSAL
    // (which the Manager must still route through the canonical fabric for
    // authority evaluation); otherwise it is advisory cognition.
    if (output === null || typeof output !== "object") {
        return REQUEST_CLASS.REASONING;
    }
    const proposal = output.actionProposal ?? output.proposal ?? null;
    if (proposal !== null && typeof proposal === "object" &&
        typeof proposal.capabilityId === "string" &&
        typeof proposal.operation === "string") {
        return REQUEST_CLASS.ACTION_PROPOSAL;
    }
    if (output.memoryLookup === true) {
        return REQUEST_CLASS.MEMORY_LOOKUP;
    }
    return REQUEST_CLASS.REASONING;
}

module.exports = {
    // inert frozen vocabularies + pure predicates ONLY
    CHANNEL_TYPES,
    REQUEST_CLASS,
    isRequestClass,
    requiresActionFabric,
    classifyPlannerOutput
};

// NOT exported: any adapter registry, any trusted transport surface.
