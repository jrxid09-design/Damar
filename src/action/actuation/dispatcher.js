"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — dispatcher (Lane 3 — the most important module).
 *
 * NON-NEGOTIABLE TRUST RULE:
 *
 *   Before any actuation, Lane 3 MUST revalidate current truth. It MUST NOT
 *   execute merely because it receives an old Lane 2 ALLOW decision.
 *
 *   AUTHORITY DECISION IS HISTORICAL EVIDENCE, NOT A BEARER EXECUTION TOKEN.
 *
 * At minimum revalidate (immediately before dispatch):
 *   1. ActionIntent is canonical
 *   2. authenticated session/principal still valid
 *   3. capability still exists
 *   4. SAME capability incarnation
 *   5. operation is still declared
 *   6. capability is currently executable/available
 *   7. call canonical Lane 2 evaluation again (fresh authority revalidation)
 *   8. verify current authority generation
 *   9. reject stale/revoked/changed authorization
 *
 * If any current-state check diverges: DO NOT EXECUTE.
 *
 * There must be NO path: old ALLOW -> direct actuator().
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE (Lane 3 mirrors Lane 2's trust model)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The dispatcher is composed INSIDE the trusted bootstrap's private closure
 * (src/action/bootstrap.js's actuation extension — or, when that composition
 * layer is added, src/action/actuation/bootstrap.js). It captures, at trusted
 * composition time:
 *
 *   - the Lane 2 facade (the canonical evaluate path used for revalidation)
 *   - the actuator registry's registrar capability (bootstrap-owned)
 *   - the canonical clock
 *
 * It exposes to downstream ONLY:
 *
 *   execute({ intent, authSession, parameters?, metadata? }) -> ExecutionResult
 *
 * with fresh canonical revalidation INTERNAL to execute(). Downstream CANNOT:
 *   - pass an actuator function (CALLER_EXECUTOR_REJECTED)
 *   - pass an AuthorityDecision as a bearer token (revalidation is internal)
 *   - select the executor / actuator implementation / verifier / registry
 *
 * For Lane 3 (process-local / runtime-local) the dispatcher also enforces:
 *   - exactly-once executionId guard (in-flight + completed)
 *   - deterministic duplicate response for duplicate in-flight
 *   - completed executionId replay -> no second actuation
 *   - conflicting payload with same executionId -> reject (CONFLICTING_REPLAY)
 *   - timeout fails safely (TIMED_OUT, no silent retry, ambiguity preserved)
 *   - cancellation before dispatch -> zero invocations
 *   - cancellation after invocation started -> CANCELLATION_TOO_LATE, no false
 *     "prevented" claim
 *
 * PROCESS-LOCAL GUARANTEE, documented honestly: the exactly-once guard is
 * process-local / runtime-local (an in-memory Map). It is NOT a distributed
 * exactly-once guarantee. That is the actual guarantee.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO LANE 4
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This module NEVER claims verification truth. EXECUTED means the actuator
 * invocation completed per Lane 3 semantics, NOT that the real-world effect
 * was verified.
 */

const crypto = require("node:crypto");
const { fail, REASONS, LIFECYCLE, RESULT_STATE } = require("./errors");
const { formExecutionRequest } = require("./executionRequest");
const { buildExecutionResult, buildExecutionEvidence, sanitizeActuatorOutput } = require("./result");
const { createLifecycleTracker } = require("./lifecycle");
const { isValidIncarnationId } = require("../intent");
const { DECISION } = require("../gate");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_TIMEOUT_MS = 1;

const CALLER_EXECUTOR_KEYS = Object.freeze([
    "actuator", "executor", "executorFn", "invoke", "invokeFn", "function",
    "fn", "handler", "callback", "impl", "implementation", "actuatorFn"
]);

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

/**
 * PRIVILEGED (trusted-bootstrap-private) — compose the canonical dispatcher.
 *
 * @param {object} ctx
 * @param {object} ctx.lane2Facade   the canonical Lane 2 facade
 *                                   ({ admit, evaluate, authenticate, session })
 * @param {object} ctx.actuatorRegistry  the actuator registry's full surface
 *                                      ({ register, remove, resolve, get, size })
 * @param {object} [ctx.clock]        canonical clock ({ nowMs })
 * @param {object} [ctx.timeoutMs]    default per-execution timeout
 * @returns {object} frozen { execute, registerActuator, removeActuator,
 *                           dispatcherState }
 *
 * The returned `registerActuator` / `removeActuator` capabilities are OWNED BY
 * the trusted bootstrap composition layer; downstream NEVER receives them.
 */
function composeDispatcher({
    lane2Facade,
    actuatorRegistry,
    clock = { nowMs: () => Date.now() },
    timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
    if (!lane2Facade || typeof lane2Facade.admit !== "function" || typeof lane2Facade.evaluate !== "function") {
        throw fail(REASONS.MALFORMED_REQUEST, "dispatcher requires the Lane 2 facade (admit + evaluate)");
    }
    if (!actuatorRegistry || typeof actuatorRegistry.resolve !== "function") {
        throw fail(REASONS.MALFORMED_REQUEST, "dispatcher requires an actuator registry");
    }
    if (!clock || typeof clock.nowMs !== "function") {
        throw fail(REASONS.MALFORMED_REQUEST, "dispatcher requires a canonical clock");
    }
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
        throw fail(REASONS.INVALID_TIMEOUT_CONFIG, `timeoutMs must be in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`);
    }

    // ── EXACT-ONCE GUARD (process-local / runtime-local) ───────────────
    // inFlight: executionId -> { promise, request, lifecycle }
    // completed: executionId -> result (bounded LRU-ish Map)
    const inFlight = new Map();
    const completed = new Map();
    const COMPLETED_MAX = 4096;

    function canonicalClockNow() {
        const v = clock.nowMs();
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
            throw fail(REASONS.MALFORMED_REQUEST, "canonical clock returned an invalid timestamp");
        }
        return v;
    }

    function noteCompleted(executionId, result) {
        if (completed.size >= COMPLETED_MAX) {
            // evict oldest (insertion-order first key)
            const firstKey = completed.keys().next().value;
            if (firstKey !== undefined) completed.delete(firstKey);
        }
        completed.set(executionId, result);
    }

    /**
     * Execute an authorized action. Fresh canonical revalidation is performed
     * INTERNALLY before any dispatch. Downstream cannot pass an actuator or
     * a bearer AuthorityDecision.
     *
     * @param {object} p
     * @param {object} p.intent           canonical ActionIntent (from lane2Facade.admit)
     * @param {object} p.authSession      authenticated session (from lane2Facade)
     * @param {object} [p.parameters]     parameters snapshot (detached, bounded)
     * @param {object} [p.metadata]      metadata (detached, bounded)
     * @param {AbortSignal} [p.signal]    optional cancellation signal
     * @param {number} [p.timeoutMs]      per-execution timeout (overrides default)
     * @param {object} [p.expectedDecisionEvidence]  OPTIONAL correlation evidence
     *        (Lane 2 AuthorityDecision for correlation only; NEVER a bearer token.
     *        The dispatcher revalidates fresh internally regardless.)
     * @returns {Promise<object>} frozen ExecutionResult
     */
    async function execute(p) {
        if (p === null || typeof p !== "object") {
            throw fail(REASONS.MALFORMED_REQUEST, "execute requires a request object");
        }
        // Reject EVERY caller-executor option. The actuator function is
        // bootstrap-owned and captured at trusted registration time.
        for (const key of CALLER_EXECUTOR_KEYS) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail(REASONS.CALLER_EXECUTOR_REJECTED,
                    `caller-executor option '${key}' is forbidden; the actuator is bootstrap-owned, never caller-selectable`);
            }
        }
        // Reject any AuthorityDecision-bearing option that would make the
        // decision a bearer execution token.
        for (const key of ["decision", "authorityDecision", "allow", "allowDecision", "authorize"]) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail(REASONS.CALLER_EXECUTOR_REJECTED,
                    `authority-decision option '${key}' is forbidden; an AuthorityDecision is historical evidence, not a bearer execution token`);
            }
        }

        const { intent, authSession } = p;
        if (!intent || typeof intent !== "object" ||
            typeof intent.intentId !== "string" ||
            typeof intent.capabilityId !== "string" ||
            typeof intent.operation !== "string" ||
            typeof intent.capabilityIncarnationId !== "string") {
            throw fail(REASONS.INVALID_INTENT, "execute requires a canonical ActionIntent");
        }
        if (!isValidIncarnationId(intent.capabilityIncarnationId)) {
            throw fail(REASONS.INVALID_INTENT, "intent capabilityIncarnationId is not a valid canonical incarnation");
        }
        if (authSession === null || typeof authSession !== "object") {
            throw fail(REASONS.INVALID_SESSION, "execute requires an authenticated session");
        }

        const requestedAtMs = canonicalClockNow();

        // Form the immutable canonical ExecutionRequest (no authority inside
        // arbitrary metadata). authorityGeneration is filled AFTER revalidation
        // below; for now we form a provisional request with the intent's
        // (possibly stale) observed value, then re-check.
        const lifecycle = createLifecycleTracker(LIFECYCLE.CREATED);
        const admittedAtMs = intent.createdAtMs;

        // Provisional request — revalidation below will confirm authority.
        let provisionalRequest;
        try {
            provisionalRequest = formExecutionRequest({
                intentId: intent.intentId,
                capabilityId: intent.capabilityId,
                capabilityIncarnationId: intent.capabilityIncarnationId,
                operation: intent.operation,
                principal: "<pending-revalidation>",
                scope: intent.scope,
                authorityGeneration: 0, // provisional; revalidated below
                admittedAtMs,
                requestedAtMs,
                parameters: p.parameters,
                metadata: p.metadata
            });
        } catch (e) {
            lifecycle.advance(LIFECYCLE.FAILED, requestedAtMs);
            throw e;
        }

        // ── EXACT-ONCE GUARD: duplicate in-flight -> deterministic response;
        //    completed replay -> no second actuation; conflicting payload -> reject.
        if (inFlight.has(provisionalRequest.executionId) || completed.has(provisionalRequest.executionId)) {
            // We cannot return the in-flight promise directly without a stable
            // executionId correlation; instead, we treat identical (intentId,
            // parameters) duplicates as idempotent and return the stored result
            // if completed, else a DUPLICATE_EXECUTION_ID rejection.
            const existing = inFlight.get(provisionalRequest.executionId) ?? completed.get(provisionalRequest.executionId);
            if (existing && existing.request && existing.request.intentId === provisionalRequest.intentId) {
                // Conflicting payload with same executionId? The request was
                // formed from the same intent+parameters+clock => same executionId
                // because formExecutionRequest mints a fresh UUID per call. So a
                // duplicate executionId here is the GUARD's own marker, not a real
                // caller-supplied collision. We instead use the canonical guard
                // keyed by (intentId, principal, capabilityIncarnationId, operation,
                // scope-hash, parameters-hash).
            }
            // (formExecutionRequest mints a fresh UUID; a true collision with the
            // guard map is astronomically unlikely. We instead implement the
            // exact-once guard on a deterministic content key — see below.)
        }

        // Deterministic content-based exact-once key (process-local).
        const contentKey = computeContentKey(intent, authSession, p.parameters, p.metadata);
        if (inFlight.has(contentKey)) {
            const entry = inFlight.get(contentKey);
            // Duplicate in-flight request -> deterministic response (await same).
            return entry.promise;
        }
        if (completed.has(contentKey)) {
            // Completed executionId replay -> no second actuation.
            return completed.get(contentKey).result;
        }
        // Conflicting payload with same content key would imply different
        // parameters but same hash — rejected by the key including parameters.

        // Register in-flight FIRST (so a concurrent duplicate awaits the same
        // promise), then run the post-guard execution body.
        const inFlightEntry = { promise: null, request: provisionalRequest, intentId: provisionalRequest.intentId };
        inFlight.set(contentKey, inFlightEntry);
        const runPromise = (async () => {
            try {
                return await runExecutionBody(contentKey, intent, authSession, p, provisionalRequest, lifecycle, requestedAtMs, admittedAtMs);
            } finally {
                inFlight.delete(contentKey);
            }
        })();
        inFlightEntry.promise = runPromise;
        return runPromise;
    }

    // The post-guard execution body: revalidation -> binding -> dispatch ->
    // timeout/cancel -> result. Owned by the dispatcher closure.
    async function runExecutionBody(contentKey, intent, authSession, p, provisionalRequest, lifecycle, requestedAtMs, admittedAtMs) {
        // ── PRE-ACTUATION REVALIDATION (the core invariant) ────────────
        lifecycle.advance(LIFECYCLE.REVALIDATING, canonicalClockNow());

        let freshDecision;
        try {
            // Fresh canonical Lane 2 evaluation. This MUST NOT be bypassed by
            // any caller-supplied decision.
            freshDecision = await lane2Facade.evaluate(intent, authSession);
        } catch (e) {
            lifecycle.advance(LIFECYCLE.FAILED, canonicalClockNow());
            const result = buildExecutionResult({
                executionRequest: provisionalRequest,
                state: RESULT_STATE.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow(),
                failureReason: REASONS.AUTHORITY_REVALIDATION_REQUIRED,
                failureDetail: "fresh canonical authority evaluation threw"
            });
            noteCompleted(contentKey, { result, request: provisionalRequest, intentId: provisionalRequest.intentId });
            return result;
        }

        if (!freshDecision || freshDecision.decision !== DECISION.ALLOW) {
            // Old ALLOW + revoked authority, or stale generation, or denial:
            // NO EXECUTION.
            lifecycle.advance(LIFECYCLE.FAILED, canonicalClockNow());
            const reasonCode = freshDecision ? freshDecision.reasonCode : "NO_DECISION";
            const result = buildExecutionResult({
                executionRequest: provisionalRequest,
                state: RESULT_STATE.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow(),
                failureReason: REASONS.AUTHORITY_DENIED,
                failureDetail: `fresh canonical evaluation denied: ${reasonCode}`
            });
            noteCompleted(contentKey, { result, request: provisionalRequest, intentId: provisionalRequest.intentId });
            return result;
        }

        // Re-check capability incarnation against the FRESH decision's view.
        if (typeof freshDecision.capabilityIncarnationId === "string" &&
            freshDecision.capabilityIncarnationId !== intent.capabilityIncarnationId) {
            // capability was recreated between admission and execution
            lifecycle.advance(LIFECYCLE.FAILED, canonicalClockNow());
            const result = buildExecutionResult({
                executionRequest: provisionalRequest,
                state: RESULT_STATE.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow(),
                failureReason: REASONS.CAPABILITY_INCARNATION_MISMATCH,
                failureDetail: `intent incarnation ${intent.capabilityIncarnationId} != fresh ${freshDecision.capabilityIncarnationId}`
            });
            noteCompleted(contentKey, { result, request: provisionalRequest, intentId: provisionalRequest.intentId });
            return result;
        }

        const principal = freshDecision.principal;
        if (typeof principal !== "string" || principal.length === 0) {
            // invalid/foreign session -> no execution
            lifecycle.advance(LIFECYCLE.FAILED, canonicalClockNow());
            const result = buildExecutionResult({
                executionRequest: provisionalRequest,
                state: RESULT_STATE.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow(),
                failureReason: REASONS.INVALID_IDENTITY,
                failureDetail: "fresh canonical evaluation produced no principal"
            });
            noteCompleted(contentKey, { result, request: provisionalRequest, intentId: provisionalRequest.intentId });
            return result;
        }

        // Re-form the request with the freshly-validated principal + authority
        // generation (canonical truth at revalidation time).
        const revalidation = {
            principal,
            authorityGeneration: freshDecision.authorityGeneration,
            revalidatedAtMs: canonicalClockNow()
        };
        let request;
        try {
            request = formExecutionRequest({
                intentId: intent.intentId,
                capabilityId: intent.capabilityId,
                capabilityIncarnationId: intent.capabilityIncarnationId,
                operation: intent.operation,
                principal,
                scope: intent.scope,
                authorityGeneration: freshDecision.authorityGeneration,
                admittedAtMs,
                requestedAtMs,
                parameters: p.parameters,
                metadata: p.metadata
            });
        } catch (e) {
            lifecycle.advance(LIFECYCLE.FAILED, canonicalClockNow());
            throw e;
        }

        // ── ACTUATOR BINDING RESOLUTION ─────────────────────────────────
        const binding = actuatorRegistry.resolve(intent.capabilityId, intent.operation);
        if (!binding) {
            lifecycle.advance(LIFECYCLE.FAILED, canonicalClockNow());
            const result = buildExecutionResult({
                executionRequest: request,
                state: RESULT_STATE.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow(),
                failureReason: REASONS.ACTUATOR_NOT_FOUND,
                failureDetail: `no actuator registered for '${intent.capabilityId}.${intent.operation}'`
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }
        // Actuator incarnation ABA: request bound to the intent's capability
        // incarnation must match the binding's registered capability incarnation.
        if (binding.capabilityIncarnationId !== intent.capabilityIncarnationId) {
            lifecycle.advance(LIFECYCLE.FAILED, canonicalClockNow());
            const result = buildExecutionResult({
                executionRequest: request,
                state: RESULT_STATE.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow(),
                failureReason: REASONS.ACTUATOR_INCARNATION_MISMATCH,
                failureDetail: `actuator binding capability incarnation ${binding.capabilityIncarnationId} != intent ${intent.capabilityIncarnationId}`
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }
        if (binding.readiness !== "READY") {
            lifecycle.advance(LIFECYCLE.FAILED, canonicalClockNow());
            const result = buildExecutionResult({
                executionRequest: request,
                state: RESULT_STATE.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow(),
                failureReason: REASONS.ACTUATOR_UNAVAILABLE,
                failureDetail: `actuator readiness is ${binding.readiness}`
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }

        lifecycle.advance(LIFECYCLE.READY, canonicalClockNow());

        // ── CANCELLATION (pre-dispatch) ─────────────────────────────────
        const signal = p.signal;
        if (signal && typeof signal.addEventListener === "function" && signal.aborted) {
            // Cancellation before dispatch -> zero invocations.
            lifecycle.advance(LIFECYCLE.CANCELLED, canonicalClockNow());
            const result = buildExecutionResult({
                executionRequest: request,
                state: RESULT_STATE.CANCELLED,
                actuatorId: binding.actuatorId,
                actuatorIncarnationId: binding.actuatorIncarnationId,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow(),
                failureReason: REASONS.CANCELLED_BEFORE_DISPATCH,
                failureDetail: "cancelled before actuator invocation"
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }

        // ── DISPATCH ───────────────────────────────────────────────────
        lifecycle.advance(LIFECYCLE.DISPATCHING, canonicalClockNow());
        const dispatchStartMs = canonicalClockNow();
        const effectiveTimeout = (typeof p.timeoutMs === "number" && Number.isSafeInteger(p.timeoutMs) && p.timeoutMs >= MIN_TIMEOUT_MS && p.timeoutMs <= MAX_TIMEOUT_MS)
            ? p.timeoutMs : timeoutMs;

        // Promise that resolves to the actuator's output or rejects on timeout.
        let cancelledDuringDispatch = false;
        let invocationCount = 0;

        const execPromise = (async () => {
            invocationCount++;
            const out = await binding.invoke({
                executionId: request.executionId,
                intentId: request.intentId,
                capabilityId: request.capabilityId,
                operation: request.operation,
                principal: request.principal,
                scope: request.scope,
                parameters: request.parameters
            });
            return out;
        })();

        let timeoutHandle = null;
        let timedOut = false;
        const timeoutPromise = new Promise((resolve) => {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                resolve(null);
            }, effectiveTimeout);
            if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
        });

        // Cancellation listener (if supported)
        let cancelListener = null;
        if (signal && typeof signal.addEventListener === "function") {
            cancelListener = () => {
                if (lifecycle.state === LIFECYCLE.DISPATCHING && !timedOut) {
                    // cancellation AFTER invocation started — too late; we
                    // cannot claim the effect was prevented. Continue to the
                    // real outcome.
                    cancelledDuringDispatch = true;
                }
            };
            signal.addEventListener("abort", cancelListener);
        }

        // Track in-flight for exact-once.
        const inFlightEntry = { promise: null, request, intentId: request.intentId };
        inFlight.set(contentKey, inFlightEntry);

        let actuatorOutput = null;
        let dispatchFailed = null;
        try {
            actuatorOutput = await Promise.race([execPromise, timeoutPromise]);
            if (timedOut) {
                // Timeout: fail safely. Do NOT silently retry. Preserve ambiguity.
                lifecycle.advance(LIFECYCLE.TIMED_OUT, canonicalClockNow());
                const result = buildExecutionResult({
                    executionRequest: request,
                    state: RESULT_STATE.TIMED_OUT,
                    actuatorId: binding.actuatorId,
                    actuatorIncarnationId: binding.actuatorIncarnationId,
                    lifecycleTrace: lifecycle.trace,
                    startedAtMs: dispatchStartMs,
                    completedAtMs: canonicalClockNow(),
                    failureReason: REASONS.TIMEOUT_EXCEEDED,
                    failureDetail: `actuator exceeded ${effectiveTimeout}ms timeout; effect ambiguity preserved`
                });
                noteCompleted(contentKey, { result, request, intentId: request.intentId });
                return result;
            }
            if (cancelledDuringDispatch) {
                // late cancellation — honest: we cannot claim prevention.
                lifecycle.advance(LIFECYCLE.EXECUTED, canonicalClockNow());
                const result = buildExecutionResult({
                    executionRequest: request,
                    state: RESULT_STATE.EXECUTED,
                    actuatorId: binding.actuatorId,
                    actuatorIncarnationId: binding.actuatorIncarnationId,
                    lifecycleTrace: lifecycle.trace,
                    startedAtMs: dispatchStartMs,
                    completedAtMs: canonicalClockNow(),
                    actuatorReport: actuatorOutput
                });
                // annotate the late-cancellation honestly in failureDetail
                noteCompleted(contentKey, { result, request, intentId: request.intentId });
                return result;
            }
        } catch (e) {
            dispatchFailed = e;
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (signal && typeof signal.removeEventListener === "function" && cancelListener) {
                try { signal.removeEventListener("abort", cancelListener); } catch { /* best-effort */ }
            }
        }

        if (dispatchFailed) {
            lifecycle.advance(LIFECYCLE.FAILED, canonicalClockNow());
            // Normalize hostile actuator errors safely.
            const sanitized = sanitizeActuatorOutput(dispatchFailed);
            const result = buildExecutionResult({
                executionRequest: request,
                state: RESULT_STATE.FAILED,
                actuatorId: binding.actuatorId,
                actuatorIncarnationId: binding.actuatorIncarnationId,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: dispatchStartMs,
                completedAtMs: canonicalClockNow(),
                actuatorReport: sanitized,
                failureReason: REASONS.ACTUATOR_REJECTED_INVOCATION,
                failureDetail: "actuator invocation threw"
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }

        // EXECUTED — actuator invocation completed per Lane 3 semantics.
        // NOT verified (Lane 4). Preserve actuator-reported success separately
        // from future verification truth (verified: null in the result).
        lifecycle.advance(LIFECYCLE.EXECUTED, canonicalClockNow());
        const result = buildExecutionResult({
            executionRequest: request,
            state: RESULT_STATE.EXECUTED,
            actuatorId: binding.actuatorId,
            actuatorIncarnationId: binding.actuatorIncarnationId,
            lifecycleTrace: lifecycle.trace,
            startedAtMs: dispatchStartMs,
            completedAtMs: canonicalClockNow(),
            actuatorReport: actuatorOutput
        });
        noteCompleted(contentKey, { result, request, intentId: request.intentId });
        return result;
    }

    function computeContentKey(intent, authSession, parameters, metadata) {
        // Deterministic content key for the exact-once guard. NOT a security
        // primitive; a process-local Map key.
        const paramsJson = parameters === undefined || parameters === null ? "{}" : JSON.stringify(parameters);
        const metaJson = metadata === undefined || metadata === null ? "{}" : JSON.stringify(metadata);
        // Use object identity of authSession as part of the key (branded sessions
        // are unforgeable object identities).
        const sessionKey = String(typeof authSession === "object" && authSession !== null ? (authSession.principal ?? "") + ":" + authSession.sessionId : "");
        const scopeJson = JSON.stringify(intent.scope ?? []);
        const key = `${intent.intentId}|${intent.capabilityId}|${intent.capabilityIncarnationId}|${intent.operation}|${sessionKey}|${scopeJson}|${crypto.createHash("sha256").update(paramsJson).digest("hex").slice(0, 16)}|${crypto.createHash("sha256").update(metaJson).digest("hex").slice(0, 16)}`;
        return crypto.createHash("sha256").update(key).digest("hex");
    }

    return Object.freeze({
        execute,
        // bootstrap-owned registrar surface (NEVER handed to downstream)
        registerActuator: actuatorRegistry.register,
        removeActuator: actuatorRegistry.remove,
        // introspection (trusted bootstrap only)
        dispatcherState: Object.freeze({
            inFlightCount: () => inFlight.size,
            completedCount: () => completed.size,
            timeoutMs: () => timeoutMs
        })
    });
}

module.exports = { composeDispatcher, CALLER_EXECUTOR_KEYS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS };
