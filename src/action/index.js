"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — public surface.
 *
 * DESCRIPTIVE + EVALUATIVE ONLY. Answers:
 *   1. what action is being proposed (ActionIntent)
 *   2. is that proposed action authorized (AuthorityDecision)
 *
 * NEVER executes, invokes, actuates, compensates, or verifies.
 *
 * Trust boundary:
 *   - parseActionIntent / admitActionIntent is the UNTRUSTED serialized ingress.
 *   - ActionAuthorityGate.evaluate accepts a canonical intent + trusted
 *     RuntimeIdentityContext (identity never comes from the intent).
 *   - authority evaluation delegates to the CANONICAL shared evaluator
 *     (src/authority/evaluate.js), never a Lane-2 re-implementation.
 */

const { parseActionIntent, canonicalScope, validateTimestamp, INTENT_SCHEMA_VERSION, BOUNDS: INTENT_BOUNDS, isValidIncarnationId } = require("./intent");
const { createIntentAdmission } = require("./admission");
const { createRuntimeIdentityContext, isRuntimeIdentityContext } = require("./runtimeIdentity");
const { ActionAuthorityGate, DECISION, GATE_REASONS, ALLOW_REASON } = require("./gate");
const { createReadOnlyAuthorityContext, DECISION_REASONS } = require("./authorityContext");
const { captureClock } = require("./clock");
const { ActionError, REASONS } = require("./errors");

module.exports = {
    // intent
    parseActionIntent,
    createIntentAdmission,
    canonicalScope,
    validateTimestamp,
    INTENT_SCHEMA_VERSION,
    INTENT_BOUNDS,
    isValidIncarnationId,

    // trusted identity
    createRuntimeIdentityContext,
    isRuntimeIdentityContext,

    // gate / decision
    ActionAuthorityGate,
    DECISION,
    GATE_REASONS,
    ALLOW_REASON,

    // authority read-only context (integration adapter over shared evaluator)
    createReadOnlyAuthorityContext,
    DECISION_REASONS,

    // clock
    captureClock,

    // error contract
    ActionError,
    REASONS
};
