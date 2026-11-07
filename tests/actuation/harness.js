"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — TEST-ONLY ACTUATION HARNESS (FIRST targeted
 * repair: own private copies of ALL privileged actuation implementations).
 *
 * Production src/action/actuation/*.js now export ONLY inert vocabulary + pure
 * predicates — the privileged constructors live ONLY in the trusted bootstrap's
 * private lexical closure (src/action/bootstrap.js). Tests cannot import them
 * from production; this harness owns its OWN private copies of the same
 * implementation (the test-domain analogue of the trusted bootstrap closure)
 * and is reachable ONLY under tests/ (production src/** never imports it).
 *
 * The test-domain copies use the SAME canonical brand WeakSets exposed to the
 * pure predicates in production `src/action/actuation/index.js`. Wait — NO:
 * the production WeakSets are bootstrap-private and not exported. To let tests
 * exercise the brand predicates against canonical request/result shapes, the
 * test harness instead verifies via the PUBLIC structural predicates in
 * index.js (which recognize frozen plain objects with the exact canonical key
 * set), and the test harness's private formers produce values matching that
 * structural contract.
 *
 * The trusted test harness owns:
 *   - test actuator registry + registrar (test-owned, never reachable from src/action)
 *   - test dispatcher (with the Lane 2 test harness facade for revalidation)
 *   - test request/result formers (private copies)
 *   - test lifecycle tracker (private copy)
 *
 * Downstream (in tests = channel/model code analogues) receives ONLY
 * { execute } — exactly like production. Registration happens through the
 * harness's own registrar surface, mirroring how the trusted runtime layer
 * would wire real actuators in a later lane.
 */

const crypto = require("node:crypto");
const { LIFECYCLE, RESULT_STATE, REASONS, fail } = require("../../src/action/actuation/errors");
const { TRANSITIONS } = require("../../src/action/actuation/lifecycle");
const { READINESS } = require("../../src/action/actuation/actuatorRegistry");
const { DECISION } = require("../../src/action/gate");
const {
    parseActionIntent, canonicalScope, validateTimestamp, isValidIncarnationId
} = require("../../src/action/intent");
const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../../src/authority/evaluate");
const { captureClock } = require("../../src/action/clock");
const { validateAuthorityEvaluation } = require("../../src/action/gate");
const { makeHarness } = require("../action/bootstrapHarness");

// ---------------------------------------------------------------------------
// TEST-ONLY PRIVATE IMPLEMENTATION COPIES
// (mirror the production trusted bootstrap's private closure)
// ---------------------------------------------------------------------------

const MAX_TELEMETRY_CHARS = 128;
const MAX_PARAMETERS_KEYS = 64;
const MAX_NODES = 512;

function isPlainObject(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));
const AUTHORITY_TOKENS = Object.freeze(new Set([
    "authority", "authorized", "authorization", "authorisation",
    "permission", "permissions", "approved", "approval", "approve",
    "ownerapproved", "owner", "admin", "administrator", "root", "superuser",
    "grant", "granted", "trusted", "trust", "privilege", "privileged",
    "role", "roles", "canexecute", "allowed", "allow"
]));

function detach(value, state) {
    state.nodes++;
    if (state.nodes > state.maxNodes) throw fail(REASONS.BOUND_EXCEEDED, `payload exceeds node budget (${state.maxNodes})`);
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "boolean") return value;
    if (t === "number") {
        if (!Number.isFinite(value)) throw fail(REASONS.MALFORMED_PAYLOAD, "numbers must be finite");
        return value;
    }
    if (t === "function") throw fail(REASONS.FUNCTION_VALUE, "function values are not permitted");
    if (t === "symbol" || t === "bigint" || t === "undefined") throw fail(REASONS.SYMBOL_VALUE, `${t} values are not permitted`);
    if (Array.isArray(value)) {
        if (state.path.has(value)) throw fail(REASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
        if (value.length > 1024) throw fail(REASONS.BOUND_EXCEEDED, "array length exceeds global bound");
        state.path.add(value);
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = detach(value[i], state);
        state.path.delete(value);
        return out;
    }
    if (!isPlainObject(value)) throw fail(REASONS.NON_PLAIN_OBJECT, "non-plain object is not permitted");
    if (state.path.has(value)) throw fail(REASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
    state.path.add(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        if (DANGEROUS_KEYS.has(key)) throw fail(REASONS.DANGEROUS_KEY, `dangerous key '${key}' in payload`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) throw fail(REASONS.ACCESSOR_PROPERTY, `accessor property '${key}' is not permitted`);
        out[key] = detach(desc.value, state);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw fail(REASONS.SYMBOL_VALUE, "symbol keys are not permitted");
    state.path.delete(value);
    return out;
}

function assertNoAuthorityKeys(node) {
    if (node === null || typeof node !== "object") return;
    for (const key of Object.getOwnPropertyNames(node)) {
        if (AUTHORITY_TOKENS.has(key.toLowerCase())) {
            throw fail(REASONS.MALFORMED_REQUEST, `authority-shaped key '${key}' is forbidden in execution request metadata`);
        }
        const v = node[key];
        if (v !== null && typeof v === "object") assertNoAuthorityKeys(v);
    }
}

function requireString(value, field, maxChars, { optional = false, allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
        if (optional) return "";
        throw fail(REASONS.MALFORMED_REQUEST, `${field} is required`);
    }
    if (typeof value !== "string") throw fail(REASONS.MALFORMED_REQUEST, `${field} must be a string, got ${typeof value}`);
    const s = value.trim();
    if (!optional && !allowEmpty && s.length === 0) throw fail(REASONS.MALFORMED_REQUEST, `${field} must not be empty`);
    if (s.length > maxChars) throw fail(REASONS.BOUND_EXCEEDED, `${field} exceeds ${maxChars} chars`);
    return s;
}

function requireSafeInteger(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw fail(REASONS.MALFORMED_REQUEST, `${field} must be a nonnegative safe integer`);
    }
    return value;
}

// ---- TEST-ONLY request former ---------------------------------------------
function formExecutionRequest(ctx) {
    if (ctx === null || typeof ctx !== "object") {
        throw fail(REASONS.MALFORMED_REQUEST, "execution request context must be a plain object");
    }
    const intentId = requireString(ctx.intentId, "intentId", 128);
    const capabilityId = requireString(ctx.capabilityId, "capabilityId", 256);
    const capabilityIncarnationId = requireString(ctx.capabilityIncarnationId, "capabilityIncarnationId", 128);
    if (!isValidIncarnationId(capabilityIncarnationId)) {
        throw fail(REASONS.MALFORMED_REQUEST, "capabilityIncarnationId is not a valid canonical incarnation id");
    }
    const operation = requireString(ctx.operation, "operation", 256);
    const principal = requireString(ctx.principal, "principal", MAX_TELEMETRY_CHARS);
    if (!Array.isArray(ctx.scope)) throw fail(REASONS.MALFORMED_REQUEST, "scope must be an array of canonical tokens");
    const scope = canonicalScope(ctx.scope);
    const authorityGeneration = requireSafeInteger(ctx.authorityGeneration, "authorityGeneration");
    const admittedAtMs = requireSafeInteger(ctx.admittedAtMs, "admittedAtMs");
    const requestedAtMs = requireSafeInteger(ctx.requestedAtMs, "requestedAtMs");
    if (requestedAtMs < admittedAtMs) throw fail(REASONS.MALFORMED_REQUEST, "requestedAtMs must be >= admittedAtMs");

    const parametersState = { nodes: 0, maxNodes: MAX_NODES, path: new Set() };
    const parameters = (ctx.parameters === undefined || ctx.parameters === null)
        ? deepFreeze({}) : deepFreeze(detach(ctx.parameters, parametersState));
    if (Object.getOwnPropertyNames(parameters).length > MAX_PARAMETERS_KEYS) {
        throw fail(REASONS.BOUND_EXCEEDED, `parameters exceeds ${MAX_PARAMETERS_KEYS} keys`);
    }
    const metadataState = { nodes: 0, maxNodes: MAX_NODES, path: new Set() };
    const metadata = (ctx.metadata === undefined || ctx.metadata === null)
        ? deepFreeze({}) : deepFreeze(detach(ctx.metadata, metadataState));
    assertNoAuthorityKeys(metadata);

    const executionId = crypto.randomUUID();
    return deepFreeze({
        schemaVersion: 1,
        executionId, intentId, capabilityId, capabilityIncarnationId,
        operation, principal, scope, authorityGeneration,
        admittedAtMs, requestedAtMs, parameters, metadata
    });
}

// ---- TEST-ONLY lifecycle tracker -------------------------------------------
function createLifecycleTracker(initialState = LIFECYCLE.CREATED) {
    if (!TRANSITIONS.has(initialState)) throw fail(REASONS.MALFORMED_REQUEST, `invalid initial lifecycle state '${initialState}'`);
    let state = initialState;
    const entries = [{ state, atMs: null }];
    let frozenTrace = Object.freeze(entries.map((e) => Object.freeze({ ...e })));
    return Object.freeze({
        get state() { return state; },
        get trace() { return frozenTrace; },
        isTerminal() { return TRANSITIONS.get(state).size === 0; },
        canCancel() { return state === LIFECYCLE.CREATED || state === LIFECYCLE.REVALIDATING || state === LIFECYCLE.READY; },
        advance(next, atMs) {
            const allowed = TRANSITIONS.get(state);
            if (!allowed || !allowed.has(next)) throw fail(REASONS.MALFORMED_REQUEST, `illegal lifecycle transition ${state} -> ${next}`);
            if (typeof atMs !== "number" || !Number.isSafeInteger(atMs) || atMs < 0) throw fail(REASONS.MALFORMED_REQUEST, "lifecycle timestamp must be a nonnegative safe integer");
            state = next;
            entries.push({ state: next, atMs });
            frozenTrace = Object.freeze(entries.map((e) => Object.freeze({ ...e })));
            return state;
        }
    });
}

// ---- TEST-ONLY hostile-output sanitizer -----------------------------------
function sanitizeActuatorOutput(value) {
    const state = { nodes: 0, path: new Set() };
    function walk(v, depth) {
        state.nodes++;
        if (state.nodes > MAX_NODES) throw fail(REASONS.ACTUATOR_MALFORMED_RESULT, "actuator output exceeds node budget");
        if (depth > 8) throw fail(REASONS.ACTUATOR_MALFORMED_RESULT, "actuator output exceeds depth bound");
        if (v === null) return null;
        const t = typeof v;
        if (t === "string") return v.length > 1024 ? v.slice(0, 1024) : v;
        if (t === "boolean") return v;
        if (t === "number") return Number.isFinite(v) ? v : null;
        if (t === "bigint" || t === "symbol" || t === "undefined" || t === "function") return null;
        if (v instanceof Error) return { name: String(v.name ?? "Error").slice(0, 64), message: String(v.message ?? "").slice(0, 1024) };
        if (!isPlainObject(v) && !Array.isArray(v)) return null;
        if (state.path.has(v)) return null;
        state.path.add(v);
        if (Array.isArray(v)) {
            const out = v.slice(0, 256).map((x) => walk(x, depth + 1));
            state.path.delete(v);
            return out;
        }
        const out = {};
        let keys = 0;
        for (const key of Object.getOwnPropertyNames(v)) {
            if (keys >= 64) break;
            keys++;
            const desc = Object.getOwnPropertyDescriptor(v, key);
            if (!desc || desc.get || desc.set) continue;
            const kk = key.length > 128 ? key.slice(0, 128) : key;
            out[kk] = walk(desc.value, depth + 1);
        }
        state.path.delete(v);
        return out;
    }
    return walk(value, 0);
}

// ---- TEST-ONLY result/evidence builder ------------------------------------
function buildExecutionResult({
    executionRequest, state, actuatorId = "", actuatorIncarnationId = "",
    lifecycleTrace, startedAtMs, completedAtMs, actuatorReport = null,
    failureReason = "", failureDetail = ""
}) {
    if (!executionRequest || typeof executionRequest !== "object" || typeof executionRequest.executionId !== "string") {
        throw fail(REASONS.MALFORMED_REQUEST, "buildExecutionResult requires a canonical ExecutionRequest");
    }
    if (!RESULT_STATE[state]) throw fail(REASONS.MALFORMED_REQUEST, `invalid result state '${state}'`);
    if (state === RESULT_STATE.EXECUTED && failureReason) throw fail(REASONS.MALFORMED_REQUEST, "EXECUTED result must not carry a failure reason");
    if (state !== RESULT_STATE.EXECUTED && !failureReason) throw fail(REASONS.MALFORMED_REQUEST, `non-EXECUTED result '${state}' must carry a failure reason`);
    requireSafeInteger(startedAtMs, "startedAtMs");
    requireSafeInteger(completedAtMs, "completedAtMs");
    if (completedAtMs < startedAtMs) throw fail(REASONS.MALFORMED_REQUEST, "completedAtMs must be >= startedAtMs");

    const report = actuatorReport === null || actuatorReport === undefined
        ? null : deepFreeze(sanitizeActuatorOutput(actuatorReport));

    return deepFreeze({
        schemaVersion: 1,
        executionId: executionRequest.executionId,
        intentId: executionRequest.intentId,
        capabilityId: executionRequest.capabilityId,
        capabilityIncarnationId: executionRequest.capabilityIncarnationId,
        operation: executionRequest.operation,
        principal: executionRequest.principal,
        actuatorId,
        actuatorIncarnationId,
        state,
        startedAtMs,
        completedAtMs,
        actuatorReport: report,
        failureReason: failureReason || "",
        failureDetail: failureDetail ? String(failureDetail).slice(0, 1024) : "",
        authorityGeneration: executionRequest.authorityGeneration,
        lifecycleTrace,
        verified: null,
        verificationClaim: null
    });
}

// ---- TEST-ONLY actuator registry ------------------------------------------
function buildActuatorRegistry() {
    const byId = new Map();
    const byCap = new Map();
    function canonicalOp(op) { return String(op ?? "").trim().toLowerCase(); }
    function register({ capabilityId, operations, capabilityIncarnationId, actuatorId, invoke, readiness = "READY" }) {
        if (typeof capabilityId !== "string" || capabilityId.length === 0) throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires a non-empty capabilityId");
        if (!Array.isArray(operations) || operations.length === 0) throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires a non-empty operations array");
        const ops = operations.map(canonicalOp).filter((s) => s.length > 0);
        if (ops.length === 0) throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires a non-empty operations array");
        if (typeof capabilityIncarnationId !== "string" || capabilityIncarnationId.length === 0) throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires a capabilityIncarnationId");
        if (typeof invoke !== "function") throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires an invoke function");
        if (!READINESS[readiness]) throw fail(REASONS.REGISTRATION_REJECTED, `invalid readiness '${readiness}'`);
        const id = (typeof actuatorId === "string" && actuatorId.length > 0) ? actuatorId : `act-${crypto.randomUUID()}`;
        const actuatorIncarnationId = `ainc-${crypto.randomUUID()}`;
        if (byId.has(id)) throw fail(REASONS.REGISTRATION_REJECTED, `actuator '${id}' is already registered; remove it first`);
        const invokeFn = invoke.bind({});
        const binding = Object.freeze({
            capabilityId, operations: Object.freeze(ops.slice()),
            capabilityIncarnationId, actuatorId: id, actuatorIncarnationId,
            readiness, invoke: invokeFn
        });
        byId.set(id, binding);
        let opMap = byCap.get(capabilityId);
        if (!opMap) { opMap = new Map(); byCap.set(capabilityId, opMap); }
        for (const op of ops) {
            if (opMap.has(op)) {
                byId.delete(id);
                throw fail(REASONS.REGISTRATION_REJECTED, `actuator already registered for '${capabilityId}.${op}'`);
            }
            opMap.set(op, binding);
        }
        return binding;
    }
    function remove(actuatorId) {
        const binding = byId.get(actuatorId);
        if (!binding) return false;
        byId.delete(actuatorId);
        const opMap = byCap.get(binding.capabilityId);
        if (opMap) {
            for (const op of binding.operations) {
                const cur = opMap.get(op);
                if (cur && cur.actuatorId === actuatorId) opMap.delete(op);
            }
            if (opMap.size === 0) byCap.delete(binding.capabilityId);
        }
        return true;
    }
    function resolve(capabilityId, operation) {
        const opMap = byCap.get(capabilityId);
        if (!opMap) return null;
        return opMap.get(canonicalOp(operation)) ?? null;
    }
    function get(actuatorId) { return byId.get(actuatorId) ?? null; }
    return Object.freeze({ register, remove, resolve, get });
}

// ---- TEST-ONLY dispatcher -------------------------------------------------
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_TIMEOUT_MS = 1;
const CALLER_EXECUTOR_KEYS = Object.freeze([
    "actuator", "executor", "executorFn", "invoke", "invokeFn", "function",
    "fn", "handler", "callback", "impl", "implementation", "actuatorFn"
]);
const BEARER_DECISION_KEYS = Object.freeze([
    "decision", "authorityDecision", "allow", "allowDecision", "authorize"
]);

function composeDispatcher({ lane2Facade, actuatorRegistry, clock = { nowMs: () => Date.now() }, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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

    function noteCompleted(key, entry) {
        if (completed.size >= COMPLETED_MAX) {
            const firstKey = completed.keys().next().value;
            if (firstKey !== undefined) completed.delete(firstKey);
        }
        completed.set(key, entry);
    }

    function computeContentKey(intent, authSession, parameters, metadata) {
        const paramsJson = parameters === undefined || parameters === null ? "{}" : JSON.stringify(parameters);
        const metaJson = metadata === undefined || metadata === null ? "{}" : JSON.stringify(metadata);
        const sessionKey = String(typeof authSession === "object" && authSession !== null ? (authSession.principal ?? "") + ":" + authSession.sessionId : "");
        const scopeJson = JSON.stringify(intent.scope ?? []);
        const key = `${intent.intentId}|${intent.capabilityId}|${intent.capabilityIncarnationId}|${intent.operation}|${sessionKey}|${scopeJson}|${crypto.createHash("sha256").update(paramsJson).digest("hex").slice(0, 16)}|${crypto.createHash("sha256").update(metaJson).digest("hex").slice(0, 16)}`;
        return crypto.createHash("sha256").update(key).digest("hex");
    }

    async function execute(p) {
        if (p === null || typeof p !== "object") throw fail(REASONS.MALFORMED_REQUEST, "execute requires a request object");
        for (const key of CALLER_EXECUTOR_KEYS) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail(REASONS.CALLER_EXECUTOR_REJECTED, `caller-executor option '${key}' is forbidden; the actuator is bootstrap-owned, never caller-selectable`);
            }
        }
        for (const key of BEARER_DECISION_KEYS) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail(REASONS.CALLER_EXECUTOR_REJECTED, `authority-decision option '${key}' is forbidden; an AuthorityDecision is historical evidence, not a bearer execution token`);
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
        const lifecycle = createLifecycleTracker(LIFECYCLE.CREATED);
        const admittedAtMs = intent.createdAtMs;

        let provisionalRequest;
        try {
            provisionalRequest = formExecutionRequest({
                intentId: intent.intentId,
                capabilityId: intent.capabilityId,
                capabilityIncarnationId: intent.capabilityIncarnationId,
                operation: intent.operation,
                principal: "<pending-revalidation>",
                scope: intent.scope,
                authorityGeneration: 0,
                admittedAtMs,
                requestedAtMs,
                parameters: p.parameters,
                metadata: p.metadata
            });
        } catch (e) {
            lifecycle.advance(LIFECYCLE.FAILED, requestedAtMs);
            throw e;
        }

        const contentKey = computeContentKey(intent, authSession, p.parameters, p.metadata);
        if (inFlight.has(contentKey)) return inFlight.get(contentKey).promise;
        if (completed.has(contentKey)) return completed.get(contentKey).result;

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

    async function runExecutionBody(contentKey, intent, authSession, p, provisionalRequest, lifecycle, requestedAtMs, admittedAtMs) {
        lifecycle.advance(LIFECYCLE.REVALIDATING, canonicalClockNow());

        let freshDecision;
        try {
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

        if (typeof freshDecision.capabilityIncarnationId === "string" &&
            freshDecision.capabilityIncarnationId !== intent.capabilityIncarnationId) {
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

        const revalidation = { principal, authorityGeneration: freshDecision.authorityGeneration, revalidatedAtMs: canonicalClockNow() };
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
        if (binding.readiness !== READINESS.READY) {
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

        const signal = p.signal;
        if (signal && typeof signal.addEventListener === "function" && signal.aborted) {
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

        lifecycle.advance(LIFECYCLE.DISPATCHING, canonicalClockNow());
        const dispatchStartMs = canonicalClockNow();
        const effectiveTimeout = (typeof p.timeoutMs === "number" && Number.isSafeInteger(p.timeoutMs) && p.timeoutMs >= MIN_TIMEOUT_MS && p.timeoutMs <= MAX_TIMEOUT_MS)
            ? p.timeoutMs : timeoutMs;

        let cancelledDuringDispatch = false;
        let invocationCount = 0;
        const execPromise = (async () => {
            invocationCount++;
            return await binding.invoke({
                executionId: request.executionId,
                intentId: request.intentId,
                capabilityId: request.capabilityId,
                operation: request.operation,
                principal: request.principal,
                scope: request.scope,
                parameters: request.parameters
            });
        })();

        let timeoutHandle = null;
        let timedOut = false;
        const timeoutPromise = new Promise((resolve) => {
            timeoutHandle = setTimeout(() => { timedOut = true; resolve(null); }, effectiveTimeout);
            if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
        });

        let cancelListener = null;
        if (signal && typeof signal.addEventListener === "function") {
            cancelListener = () => {
                if (lifecycle.state === LIFECYCLE.DISPATCHING && !timedOut) cancelledDuringDispatch = true;
            };
            signal.addEventListener("abort", cancelListener);
        }

        let actuatorOutput = null;
        let dispatchFailed = null;
        try {
            actuatorOutput = await Promise.race([execPromise, timeoutPromise]);
            if (timedOut) {
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

    return Object.freeze({
        execute,
        registerActuator: actuatorRegistry.register,
        removeActuator: actuatorRegistry.remove,
        dispatcherState: Object.freeze({
            inFlightCount: () => inFlight.size,
            completedCount: () => completed.size,
            timeoutMs: () => timeoutMs
        })
    });
}

// ---- TEST-ONLY brand WeakSets + predicates (test-domain analogue) -------------
const testRequestBrandSet = new WeakSet();
const testResultBrandSet = new WeakSet();

// Patch the test-domain formers to brand their outputs against these WeakSets.
// (Production bootstrap brands against ITS closure-private WeakSets; tests
// mirror this with their own WeakSet, and the test facade exposes brand
// predicates analogous to the production facade.)
const _origFormExecutionRequest = formExecutionRequest;
// eslint-disable-next-line no-func-assign
formExecutionRequest = function formBrandedExecutionRequest(ctx) {
    const r = _origFormExecutionRequest(ctx);
    testRequestBrandSet.add(r);
    return r;
};
const _origBuildExecutionResult = buildExecutionResult;
// eslint-disable-next-line no-func-assign
buildExecutionResult = function buildBrandedExecutionResult(p) {
    const r = _origBuildExecutionResult(p);
    testResultBrandSet.add(r);
    return r;
};

// ---------------------------------------------------------------------------
// TEST HARNESS API
// ---------------------------------------------------------------------------

/**
 * Build a Lane 3 test harness:
 *   {
 *     lane2,                 // Lane 2 test harness (registry, store, session, admit, evaluate, ...)
 *     execute,               // the ONLY downstream-received capability (plus brand predicates)
 *     isCanonicalExecutionRequest,
 *     isCanonicalExecutionResult,
 *     registerActuator,      // test-registrar capability (mirrors trusted wiring)
 *     removeActuator,
 *     dispatcherState
 *   }
 */
async function makeActuationHarness({ clock, scopeBindings, authenticate } = {}) {
    const lane2 = await makeHarness({ clock, scopeBindings, authenticate });
    const actuatorRegistry = buildActuatorRegistry();
    const dispatcher = composeDispatcher({
        lane2Facade: {
            admit: lane2.admit,
            evaluate: lane2.evaluate,
            authenticate: lane2.authDomain.authenticate,
            session: lane2.session
        },
        actuatorRegistry,
        clock: { nowMs: () => lane2.clock.nowMs() }
    });
    // Per-harness brand set: a separate trust domain per makeActuationHarness
    // call. Two harness instances have INDEPENDENT result brands, so a
    // result from harness A is NOT canonical in harness B — exactly mirroring
    // the production closure-private brand model.
    const localRequestBrandSet = new WeakSet();
    const localResultBrandSet = new WeakSet();
    // Patch the test-domain formers to brand against THIS harness's local
    // sets instead of the shared module-level sets.
    const _origForm = formExecutionRequest;
    const _localForm = function formBrandedExecutionRequest(ctx) {
        const r = _origForm(ctx);
        localRequestBrandSet.add(r);
        return r;
    };
    const _origBuild = buildExecutionResult;
    const _localBuild = function buildBrandedExecutionResult(p) {
        const r = _origBuild(p);
        localResultBrandSet.add(r);
        return r;
    };
    // Override the dispatcher's local formers by re-implementing just the
    // request/result production in-place. Since formExecutionRequest and
    // buildExecutionResult are referenced by name inside composeDispatcher
    // (which captured the MODULE-level functions), we cannot easily swap
    // them after the fact. Instead, wrap the public execute() to brand the
    // returned result into the local set.
    const rawExecute = dispatcher.execute;
    async function brandedExecute(p) {
        const r = await rawExecute(p);
        if (r && typeof r === "object") localResultBrandSet.add(r);
        return r;
    }
    return {
        lane2,
        execute: brandedExecute,
        isCanonicalExecutionRequest(value) {
            if (value === null || typeof value !== "object") return false;
            if (value.schemaVersion !== 1) return false;
            if (typeof value.executionId !== "string" || value.executionId.length === 0) return false;
            return localRequestBrandSet.has(value) || testRequestBrandSet.has(value);
        },
        isCanonicalExecutionResult(value) {
            if (value === null || typeof value !== "object") return false;
            if (value.schemaVersion !== 1) return false;
            if (typeof value.executionId !== "string" || value.executionId.length === 0) return false;
            return localResultBrandSet.has(value);
        },
        registerActuator: actuatorRegistry.register,
        removeActuator: actuatorRegistry.remove,
        dispatcherState: dispatcher.dispatcherState,
        // Local brand set accessor (for the verification harness to compose
        // canonical verification over THIS harness's branded results).
        _localResultBrandSet: localResultBrandSet
    };
}

function testDomainIsCanonicalExecutionResult(value) {
    if (value === null || typeof value !== "object") return false;
    if (value.schemaVersion !== 1) return false;
    if (typeof value.executionId !== "string" || value.executionId.length === 0) return false;
    return testResultBrandSet.has(value);
}

module.exports = { makeActuationHarness, testDomainIsCanonicalExecutionResult };
