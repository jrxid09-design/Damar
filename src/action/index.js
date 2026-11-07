"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — public surface (first-binder trust +
 * caller authenticator + facade seeding REMOVED; SEVENTH targeted repair,
 * Wave 4 Lane 2).
 *
 * CORE LAWS:
 *
 *   caller-selectable verifier != authenticated identity authority
 *   FIRST-BINDER-WINS TRUST IS NOT TRUST
 *   canonical authentication policy is bootstrap-owned, not
 *   runtime-constructor-owned
 *
 * DESCRIPTIVE + EVALUATIVE ONLY. Answers:
 *   1. what action is being proposed (ActionIntent)
 *   2. is that proposed action authorized (AuthorityDecision)
 *
 * NEVER executes, invokes, actuates, compensates, or verifies.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS PUBLIC SURFACE DOES NOT EXPOSE (seventh repair)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * NOT exported from here or any action submodule:
 *   - createActionAuthorityRuntime / createAuthenticationDomain
 *     (privileged construction is bootstrap-private)
 *   - createGate / raw auth verifier / auth-session brand / Authority evaluator
 *     injection / canonical evaluation brand / identity/session minting
 *   - ANY binder / token / host / first-call-wins composition surface:
 *     bindCompositionHost, bindAuthenticationHost, bindHost, acquireHost,
 *     registerHost, installHost, claimComposition, bootstrapBind, hostToken,
 *     getFactory, getComposer — none of these exist anywhere. The sixth
 *     repair's exported binders were themselves privileged composition APIs
 *     (first-import code could acquire both privileged constructors); they
 *     are REMOVED.
 *
 * Privileged construction (both factories) lives ONLY inside the trusted
 * bootstrap layer's private closure (src/action/bootstrap.js). runtime.js and
 * authDomain.js are now PURE NON-PRIVILEGED modules (inert vocabularies +
 * pure non-authorizing predicates). The public/downstream Action package
 * exposes no surface through which a caller can construct an authority
 * runtime over ANY state, first-importer or otherwise.
 *
 *   attacker imports every action module before bootstrap  → nothing acquired
 *   attacker imports after canonical bootstrap load        → nothing acquired
 *   attacker creates new action runtime around canonical state ← NO surface
 *   attacker selects verifier/authenticator                 ← NO surface
 *   attacker impersonates victim                            ← impossible
 *
 * Downstream (Console, CLI, Telegram, WhatsApp, Companion, extensions,
 * devices, providers) receives ONLY the bootstrap-issued least-privilege
 * production facade { admit, evaluate, authenticate, session } (or a narrower
 * capability) from createCanonicalActionFacade(), which takes NO options and
 * binds a FIXED fail-closed bootstrap-owned authentication adapter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PROCESS / MODULE ISOLATION LIMITATION (documented, not hidden)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This is a same-process CommonJS trust domain, NOT OS isolation. Node/CommonJS
 * path hiding is NOT hard sandboxing against code that already has arbitrary
 * same-process filesystem/require execution. What Lane 2 enforces is that the
 * ordinary/downstream Action API exposes NO authority-composition primitive at
 * all: canonical bootstrap owns composition, downstream receives least-
 * privilege facades only. Untrusted executable extensions must eventually
 * require loader allowlisting, sandboxing, workers/process isolation, or
 * equivalent enforcement.
 */

const { parseActionIntent, canonicalScope, validateTimestamp, INTENT_SCHEMA_VERSION, BOUNDS: INTENT_BOUNDS, isValidIncarnationId } = require("./intent");
const { isCanonicalAuthorityEvaluation, EVAL_REASONS } = require("../authority/evaluate");
const { DECISION, GATE_REASONS, ALLOW_REASON } = require("./runtime");
const { ActionError, REASONS } = require("./errors");

module.exports = {
    // untrusted serialized ingress + inert grammar
    parseActionIntent,
    canonicalScope,
    validateTimestamp,
    INTENT_SCHEMA_VERSION,
    INTENT_BOUNDS,
    isValidIncarnationId,

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

// NOT exported: createActionAuthorityRuntime, createAuthenticationDomain,
// createGate, mintAuthSession, mintSession, issueIdentity, isAuthSession,
// bindAuthentication, onReady, any session brand, any evaluation brand,
// evaluator/verifier injection hooks, runtime-identity minting, and any
// binder / token / host / first-call-wins composition surface. Privileged
// composition (both factories) lives ONLY inside the trusted bootstrap
// layer's private closure (src/action/bootstrap.js). See that module for the
// canonical ownership graph.
