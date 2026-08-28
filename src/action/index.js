"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — public surface (runtime-local trust
 * domain, sealed).
 *
 * DESCRIPTIVE + EVALUATIVE ONLY. Answers:
 *   1. what action is being proposed (ActionIntent)
 *   2. is that proposed action authorized (AuthorityDecision)
 *
 * NEVER executes, invokes, actuates, compensates, or verifies.
 *
 * TRUST BOUNDARY (honest): the ONLY trust issuance surface is
 * `createActionAuthorityRuntime`, which mints its runtime-local session
 * brand/issuer/verifier and its sealed gate inside its own closure and
 * returns ONLY { admit, evaluate }. Session issuance is bound exactly once
 * through the trusted-bootstrap-only `onReady` / `bindAuthentication` hook
 * during composition; downstream code never receives the issuer.
 *
 * NOT exported from here or any action submodule: createAuthSessionIssuer,
 * createGate, mintAuthSession, any session brand, any evaluation brand mint,
 * any evaluator/verifier injection hook, any runtime-identity minting.
 *
 * PROCESS-ISOLATION LIMITATION (documented, not hidden): this is a
 * same-process CommonJS trust domain, not OS isolation. A hypothetical
 * untrusted same-process actor with unrestricted require() could still reach
 * and run the trusted bootstrap module itself — that is a process/module
 * isolation limitation. What the Lane 2 surface guarantees is that it exposes
 * no privileged issuer or gate construction and no injection hooks.
 */

const { parseActionIntent, canonicalScope, validateTimestamp, INTENT_SCHEMA_VERSION, BOUNDS: INTENT_BOUNDS, isValidIncarnationId } = require("./intent");
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

    // trusted composition root (the only runtime issuance surface)
    createActionAuthorityRuntime,

    // decision / error contract (inert constants)
    DECISION,
    GATE_REASONS,
    ALLOW_REASON,
    ActionError,
    REASONS,

    // read-only canonical evaluation brand verifier (no minting).
    // NOTE: there is deliberately NO public isAuthSession — session brand
    // verification is runtime-local by design; a module-global verifier would
    // reintroduce the cross-runtime trust hole.
    isCanonicalAuthorityEvaluation,
    DECISION_REASONS: EVAL_REASONS
};
