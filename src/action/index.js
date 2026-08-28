"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — public surface (caller-selectable
 * verifier REMOVED; SIXTH targeted repair, Wave 4 Lane 2).
 *
 * CORE LAW:
 *
 *   caller-selectable verifier != authenticated identity authority
 *
 * DESCRIPTIVE + EVALUATIVE ONLY. Answers:
 *   1. what action is being proposed (ActionIntent)
 *   2. is that proposed action authorized (AuthorityDecision)
 *
 * NEVER executes, invokes, actuates, compensates, or verifies.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS PUBLIC SURFACE DOES NOT EXPOSE (sixth repair)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * NOT exported from here or any action submodule:
 *   - createActionAuthorityRuntime   (composition is bootstrap-internal only)
 *   - createAuthenticationDomain     (domain ownership is bootstrap-internal)
 *   - createGate / raw auth verifier / auth-session brand / Authority evaluator
 *     injection / canonical evaluation brand / identity/session minting
 *
 * Privileged composition lives in src/action/bootstrap.js, which is the ONE
 * trusted Aether runtime composition layer. It binds the runtime/auth-domain
 * factories one-shot per process and constructs canonical state (CapabilityRuntime,
 * AuthorityStore, AuthenticationDomain, verifier) INSIDE its own closure. The
 * public/downstream Action package exposes no factory through which a caller
 * can construct another authority runtime over ANY state with a caller-selected
 * verifier. A caller possessing canonical CapabilityRuntime + AuthorityStore
 * references has NO API to wrap them in a runtime with its own verifier,
 * because the runtime factory is not importable.
 *
 *   attacker obtains canonical CapabilityRuntime
 *   attacker obtains canonical AuthorityStore
 *   attacker creates new action runtime around them  ← NO such surface exists
 *   attacker selects verifier                       ← NO such surface exists
 *   attacker impersonates victim                     ← impossible
 *
 * Downstream (Console, CLI, Telegram, WhatsApp, Companion, extensions,
 * devices, providers) receives ONLY the bootstrap-issued least-privilege
 * facade { admit, evaluate, authenticate, session } (or a narrower capability).
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
// evaluator/verifier injection hooks, runtime-identity minting. These live
// only in src/action/bootstrap.js and the internal composition modules it
// binds. See src/action/bootstrap.js for the canonical ownership graph.
