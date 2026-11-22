"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — lifecycle state-machine vocabulary (Lane 3,
 * FIRST targeted repair: inert transition table ONLY — no tracker factory).
 *
 * States:
 *
 *   CREATED      — ExecutionRequest admitted, not yet revalidated
 *   REVALIDATING — fresh canonical authority/capability revalidation running
 *   READY        — revalidation passed; actuator binding resolved
 *   DISPATCHING  — actuator invocation in flight
 *   EXECUTED     — actuator invocation completed (per actuator report; NOT verified)
 *   FAILED       — actuation failed before or during execution
 *   TIMED_OUT    — actuator exceeded the timeout boundary (ambiguity preserved)
 *   CANCELLED    — cancelled before actuator invocation started
 *
 * There is deliberately NO VERIFIED state (Lane 4 owns verification).
 *
 * HONEST TERMINAL SEMANTICS:
 *   - CANCELLED is only valid from pre-DISPATCHING states: once invocation
 *     has started, cancellation must not claim the real-world effect was
 *     prevented.
 *   - TIMED_OUT preserves effect ambiguity: timeout != proof of no side
 *     effect. No silent retry.
 *
 * FIRST TARGETED REPAIR: `createLifecycleTracker` is NOT exported. The
 * lifecycle tracker implementation lives ONLY inside the trusted bootstrap's
 * private composition closure (src/action/bootstrap.js), exactly like every
 * other privileged Lane 3 constructor. This module exports ONLY the frozen
 * transition table + state vocabulary for downstream recognition (asking),
 * never construction.
 */

const { LIFECYCLE } = require("./errors");

// Allowed transitions (deterministic; no skips except fail-closed paths).
const TRANSITIONS = Object.freeze(new Map([
    [LIFECYCLE.CREATED, new Set([LIFECYCLE.REVALIDATING, LIFECYCLE.CANCELLED, LIFECYCLE.FAILED])],
    [LIFECYCLE.REVALIDATING, new Set([LIFECYCLE.READY, LIFECYCLE.FAILED, LIFECYCLE.CANCELLED])],
    [LIFECYCLE.READY, new Set([LIFECYCLE.DISPATCHING, LIFECYCLE.CANCELLED, LIFECYCLE.FAILED])],
    [LIFECYCLE.DISPATCHING, new Set([LIFECYCLE.EXECUTED, LIFECYCLE.FAILED, LIFECYCLE.TIMED_OUT])],
    // terminal states have no outgoing transitions
    [LIFECYCLE.EXECUTED, new Set()],
    [LIFECYCLE.FAILED, new Set()],
    [LIFECYCLE.TIMED_OUT, new Set()],
    [LIFECYCLE.CANCELLED, new Set()]
]));

/** PURE predicate — is `state` a valid lifecycle state? */
function isLifecycleState(state) {
    return typeof state === "string" && Object.prototype.hasOwnProperty.call(LIFECYCLE, state);
}

/** PURE predicate — is the transition from -> to legal? */
function isLegalTransition(from, to) {
    const allowed = TRANSITIONS.get(from);
    return allowed !== undefined && allowed.has(to);
}

/** PURE predicate — does the state admit honest pre-dispatch cancellation? */
function isCancellable(state) {
    return state === LIFECYCLE.CREATED || state === LIFECYCLE.REVALIDATING || state === LIFECYCLE.READY;
}

/** PURE predicate — is the state terminal? */
function isTerminal(state) {
    const allowed = TRANSITIONS.get(state);
    return allowed !== undefined && allowed.size === 0;
}

module.exports = {
    // inert frozen vocabulary + pure predicates ONLY
    LIFECYCLE,
    TRANSITIONS,
    isLifecycleState,
    isLegalTransition,
    isCancellable,
    isTerminal
};
