"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — execution lifecycle state machine (Lane 3).
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
 *     prevented. Late cancellation is reported as CANCELLATION_TOO_LATE
 *     and the execution continues to its real outcome.
 *   - TIMED_OUT preserves effect ambiguity: timeout != proof of no side
 *     effect. No silent retry.
 */

const { fail, REASONS, LIFECYCLE } = require("./errors");

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

/**
 * Create a fresh lifecycle tracker for one execution. The tracker records the
 * ordered (state, atMs) trace used in results/evidence. It is owned by the
 * dispatcher and never handed to downstream callers.
 */
function createLifecycleTracker(initialState = LIFECYCLE.CREATED) {
    if (!TRANSITIONS.has(initialState)) {
        throw fail(REASONS.MALFORMED_REQUEST, `invalid initial lifecycle state '${initialState}'`);
    }
    let state = initialState;
    const trace = Object.freeze([{ state, atMs: null }].slice(0, 0)); // replaced below
    const entries = [{ state, atMs: null }];
    let frozenTrace = Object.freeze(entries.map((e) => Object.freeze({ ...e })));

    return Object.freeze({
        get state() { return state; },
        get trace() { return frozenTrace; },
        isTerminal() {
            return TRANSITIONS.get(state).size === 0;
        },
        /** Whether cancellation is still honest (pre-invocation). */
        canCancel() {
            return state === LIFECYCLE.CREATED || state === LIFECYCLE.REVALIDATING || state === LIFECYCLE.READY;
        },
        /**
         * Advance to `next` at timestamp `atMs`. Throws on an illegal
         * transition (state machine violations are fail-closed).
         */
        advance(next, atMs) {
            const allowed = TRANSITIONS.get(state);
            if (!allowed || !allowed.has(next)) {
                throw fail(REASONS.MALFORMED_REQUEST, `illegal lifecycle transition ${state} -> ${next}`);
            }
            if (typeof atMs !== "number" || !Number.isSafeInteger(atMs) || atMs < 0) {
                throw fail(REASONS.MALFORMED_REQUEST, "lifecycle timestamp must be a nonnegative safe integer");
            }
            state = next;
            entries.push({ state: next, atMs });
            frozenTrace = Object.freeze(entries.map((e) => Object.freeze({ ...e })));
            return state;
        }
    });
}

module.exports = { createLifecycleTracker, TRANSITIONS, LIFECYCLE };
