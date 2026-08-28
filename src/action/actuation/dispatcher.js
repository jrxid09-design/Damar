"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — dispatcher vocabulary (Lane 3, FIRST targeted
 * repair: inert timeout/executor-rejection vocabulary ONLY — no dispatcher
 * factory).
 *
 * NON-NEGOTIABLE TRUST RULE (enforced by the dispatcher implementation that
 * lives ONLY inside the trusted bootstrap's private composition closure):
 *
 *   Before any actuation, Lane 3 MUST revalidate current truth. It MUST NOT
 *   execute merely because it receives an old Lane 2 ALLOW decision.
 *
 *   AUTHORITY DECISION IS HISTORICAL EVIDENCE, NOT A BEARER EXECUTION TOKEN.
 *
 * There must be NO path: old ALLOW -> direct actuator().
 *
 * FIRST TARGETED REPAIR: `composeDispatcher` is NOT exported. The dispatcher
 * implementation lives ONLY inside the trusted bootstrap's private composition
 * closure (src/action/bootstrap.js), exactly like every other privileged Lane
 * 3 constructor. A direct import of THIS module yields no constructor, no
 * registrar, no executor surface — only the inert vocabulary below.
 *
 * The downstream execution surface (composed by the trusted bootstrap) is:
 *
 *   execute({ intent, authSession, parameters?, metadata?, signal?, timeoutMs? })
 *
 * Caller-executor options (below) are rejected with CALLER_EXECUTOR_REJECTED,
 * as are AuthorityDecision-bearer options (decision / authorityDecision /
 * allow / allowDecision / authorize): possession of a decision is NEVER
 * sufficient to execute — fresh canonical Lane 2 revalidation happens
 * internally before every dispatch.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_TIMEOUT_MS = 1;

// Options that must NEVER be accepted from an execution caller: the actuator
// function is bootstrap-owned and captured at trusted registration time.
const CALLER_EXECUTOR_KEYS = Object.freeze([
    "actuator", "executor", "executorFn", "invoke", "invokeFn", "function",
    "fn", "handler", "callback", "impl", "implementation", "actuatorFn"
]);

// Options that would make an AuthorityDecision a bearer execution token.
const BEARER_DECISION_KEYS = Object.freeze([
    "decision", "authorityDecision", "allow", "allowDecision", "authorize"
]);

/** PURE predicate — is the timeout value within the legal dispatch window? */
function isValidTimeoutMs(value) {
    return typeof value === "number" && Number.isSafeInteger(value) &&
        value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS;
}

/** PURE predicate — is this option key a forbidden caller-executor option? */
function isCallerExecutorKey(key) {
    return typeof key === "string" && CALLER_EXECUTOR_KEYS.includes(key);
}

/** PURE predicate — is this option key a forbidden bearer-decision option? */
function isBearerDecisionKey(key) {
    return typeof key === "string" && BEARER_DECISION_KEYS.includes(key);
}

module.exports = {
    // inert frozen vocabulary + pure predicates ONLY
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    CALLER_EXECUTOR_KEYS,
    BEARER_DECISION_KEYS,
    isValidTimeoutMs,
    isCallerExecutorKey,
    isBearerDecisionKey
};
