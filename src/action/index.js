"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — public surface (sealed runtime composition).
 *
 * DESCRIPTIVE + EVALUATIVE ONLY. Answers:
 *   1. what action is being proposed (ActionIntent)
 *   2. is that proposed action authorized (AuthorityDecision)
 *
 * NEVER executes, invokes, actuates, compensates, or verifies.
 *
 * TRUST BOUNDARY (honest): the ONLY trust issuance surface is
 * `createActionAuthorityRuntime` (created once by trusted bootstrap). Identity
 * comes from a BRANDED AuthSessionCapability minted by trusted authentication
 * infrastructure (`createAuthSessionIssuer`, held by bootstrap, never injected
 * downstream). Raw trust constructors (identity minting, scope resolver
 * injection, generic authorityContext injection, evaluation branding, raw gate
 * constructor) are NOT exported. `parseActionIntent` is the untrusted
 * STRING-only serialized ingress.
 */

const { parseActionIntent, canonicalScope, validateTimestamp, INTENT_SCHEMA_VERSION, BOUNDS: INTENT_BOUNDS, isValidIncarnationId } = require("./intent");
const { createAuthSessionIssuer, isAuthSession } = require("./authSession");
const { isCanonicalAuthorityEvaluation, EVAL_REASONS } = require("../authority/evaluate");
const { createActionAuthorityRuntime, DECISION, GATE_REASONS, ALLOW_REASON } = require("./runtime");
const { ActionError, REASONS } = require("./errors");

module.exports = {
    // untrusted serialized ingress
    parseActionIntent,
    canonicalScope,
    validateTimestamp,
    INTENT_SCHEMA_VERSION,
    INTENT_BOUNDS,
    isValidIncarnationId,

    // trusted authentication infrastructure (bootstrap-only)
    createAuthSessionIssuer,

    // trusted composition root (the only runtime issuance surface)
    createActionAuthorityRuntime,

    // decision / error contract (inert constants)
    DECISION,
    GATE_REASONS,
    ALLOW_REASON,
    ActionError,
    REASONS,

    // read-only brand verifiers (no minting)
    isAuthSession,
    isCanonicalAuthorityEvaluation,
    DECISION_REASONS: EVAL_REASONS
};
