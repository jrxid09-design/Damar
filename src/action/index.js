"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — public surface (post trust-origin repair).
 *
 * DESCRIPTIVE + EVALUATIVE ONLY. Answers:
 *   1. what action is being proposed (ActionIntent)
 *   2. is that proposed action authorized (AuthorityDecision)
 *
 * NEVER executes, invokes, actuates, compensates, or verifies.
 *
 * TRUST BOUNDARY (honest): the ONLY way to obtain trusted runtime surfaces is
 * `createActionAuthorityRuntime`. Raw trust constructors (identity minting,
 * scope resolver injection, generic authorityContext injection, evaluation
 * branding) are NOT exported. `parseActionIntent` is the untrusted STRING-only
 * serialized ingress.
 */

const { parseActionIntent, canonicalScope, validateTimestamp, INTENT_SCHEMA_VERSION, BOUNDS: INTENT_BOUNDS, isValidIncarnationId } = require("./intent");
const { isRuntimeIdentityContext } = require("./runtimeIdentity");
const { isCanonicalAuthorityEvaluation, EVAL_REASONS } = require("../authority/evaluate");
const { createActionAuthorityRuntime, DECISION, GATE_REASONS, ALLOW_REASON } = require("./runtime");
const { ActionAuthorityGate } = require("./gate");
const { ActionError, REASONS } = require("./errors");

module.exports = {
    // untrusted serialized ingress
    parseActionIntent,
    canonicalScope,
    validateTimestamp,
    INTENT_SCHEMA_VERSION,
    INTENT_BOUNDS,
    isValidIncarnationId,

    // trusted composition root (the only trust issuance surface)
    createActionAuthorityRuntime,

    // decision / error contract (inert constants)
    ActionAuthorityGate,
    DECISION,
    GATE_REASONS,
    ALLOW_REASON,
    ActionError,
    REASONS,

    // read-only brand/identity verifiers (no minting)
    isRuntimeIdentityContext,
    isCanonicalAuthorityEvaluation,
    DECISION_REASONS: EVAL_REASONS
};
