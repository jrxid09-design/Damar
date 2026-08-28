"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — public surface.
 *
 * DESCRIPTIVE + EVALUATIVE ONLY. This module answers:
 *   1. what action is being proposed (ActionIntent)
 *   2. is that proposed action currently authorized (AuthorityDecision)
 *
 * It NEVER executes, invokes, actuates, compensates, or verifies anything.
 *
 * Public surface contains NO execution verbs (execute/invoke/run/dispatch/
 * actuate/spawn/shell/callTool/performAction) and NO authority-minting verbs
 * (grant/authorize-as-mutation/approve/ratify/delegate/elevate). The
 * AuthorityDecision is a read-only evaluation result, not a mutation.
 *
 * Trust boundary:
 *   - parseActionIntent is the UNTRUSTED serialized ingress (STRING-ONLY JSON).
 *   - ActionAuthorityGate.evaluate accepts ONLY canonical intents (trusted).
 *   - authorityContext is the read-only adapter over the existing Authority
 *     store (observational).
 */

const { parseActionIntent, INTENT_SCHEMA_VERSION, BOUNDS: INTENT_BOUNDS, isValidIncarnationId } = require("./intent");
const { ActionAuthorityGate, DECISION, GATE_REASONS, ALLOW_REASON } = require("./gate");
const { createReadOnlyAuthorityContext, DECISION_REASONS } = require("./authorityContext");
const { ActionError, REASONS } = require("./errors");

module.exports = {
    // intent
    parseActionIntent,
    INTENT_SCHEMA_VERSION,
    INTENT_BOUNDS,
    isValidIncarnationId,

    // gate / decision
    ActionAuthorityGate,
    DECISION,
    GATE_REASONS,
    ALLOW_REASON,

    // authority read-only context (integration adapter)
    createReadOnlyAuthorityContext,
    DECISION_REASONS,

    // error contract
    ActionError,
    REASONS
};
