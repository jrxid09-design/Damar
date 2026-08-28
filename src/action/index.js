"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — public surface (caller-owned auth
 * bootstrap REMOVED; fifth targeted repair, Wave 4).
 *
 * DESCRIPTIVE + EVALUATIVE ONLY. Answers:
 *   1. what action is being proposed (ActionIntent)
 *   2. is that proposed action authorized (AuthorityDecision)
 *
 * NEVER executes, invokes, actuates, compensates, or verifies.
 *
 * TRUST SPLIT (fifth repair):
 *
 *   Trusted Aether bootstrap
 *       ↓
 *   createAuthenticationDomain({ authenticate })   [src/action/authDomain.js]
 *       ↓ owns: authenticate(...), the runtime/session-domain brand, the ONLY
 *               session mint path (authenticate() success), the verifier
 *               capability
 *       ↓
 *   trusted bootstrap creates ActionAuthorityRuntime using authDomain.verifier
 *       ↓
 *   downstream receives ONLY:  admit, evaluate
 *
 * `createActionAuthorityRuntime` REQUIRES a pre-bound `authVerifier`
 * capability (already established by trusted bootstrap's
 * AuthenticationDomain). It does NOT mint users, does NOT authenticate
 * arbitrary principal strings, and exposes NO caller-owned auth bootstrap:
 *   - no onReady / bindAuthentication / mintSession / issuer surface exists
 *     on the runtime, its constructor options, or any module export
 *   - any caller-bootstrap option key passed to the constructor is rejected
 *     at composition (CALLER_BOOTSTRAP_REJECTED)
 *   - authentication failure (null / undefined / false / malformed / throws)
 *     fails closed; there is NO fallback to caller-supplied identity
 *
 * NOT exported from here or any action submodule: createAuthSessionIssuer,
 * createGate, mintAuthSession, mintSession, issueIdentity, isAuthSession,
 * bindAuthentication, onReady, any session brand, any evaluation brand mint,
 * any evaluator/verifier injection hook, any runtime-identity minting.
 *
 * PROCESS-ISOLATION LIMITATION (documented, not hidden): this is a
 * same-process CommonJS trust domain, not OS isolation. A hypothetical
 * untrusted same-process actor with unrestricted require() could still reach
 * and run the trusted bootstrap module itself — that is a process/module
 * isolation limitation. What the Lane 2 surface guarantees is that it exposes
 * no privileged issuer or gate construction, no evaluator/verifier injection,
 * and NO caller-owned auth bootstrap callback.
 */

const { parseActionIntent, canonicalScope, validateTimestamp, INTENT_SCHEMA_VERSION, BOUNDS: INTENT_BOUNDS, isValidIncarnationId } = require("./intent");
const { isCanonicalAuthorityEvaluation, EVAL_REASONS } = require("../authority/evaluate");
const { createActionAuthorityRuntime, DECISION, GATE_REASONS, ALLOW_REASON } = require("./runtime");
const { createAuthenticationDomain } = require("./authDomain");
const { ActionError, REASONS } = require("./errors");

module.exports = {
    // untrusted serialized ingress
    parseActionIntent,
    canonicalScope,
    validateTimestamp,
    INTENT_SCHEMA_VERSION,
    INTENT_BOUNDS,
    isValidIncarnationId,

    // trusted composition roots
    //   createAuthenticationDomain: trusted-bootstrap-only AuthenticationDomain
    //     factory (owns authenticate + session brand + mint + verifier)
    //   createActionAuthorityRuntime: trusted-bootstrap-only evaluation
    //     runtime factory; REQUIRES a pre-bound authVerifier, accepts NO
    //     caller-owned auth bootstrap option
    createAuthenticationDomain,
    createActionAuthorityRuntime,

    // decision / error contract (inert constants)
    DECISION,
    GATE_REASONS,
    ALLOW_REASON,
    ActionError,
    REASONS,

    // read-only canonical evaluation brand verifier (no minting).
    // NOTE: there is deliberately NO public isAuthSession — session brand
    // verification is domain-local by design; a module-global verifier would
    // reintroduce the cross-runtime trust hole.
    isCanonicalAuthorityEvaluation,
    DECISION_REASONS: EVAL_REASONS
};
