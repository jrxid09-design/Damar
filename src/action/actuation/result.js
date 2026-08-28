"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — structured execution result + audit evidence
 * (Lane 3).
 *
 * CORE LAWS (be precise about naming):
 *
 *   EXECUTED != SUCCEEDED      — an actuator invocation completing and
 *                                reporting success is recorded as
 *                                actuator-reported success; it is NOT proof
 *                                the real-world effect occurred as intended.
 *   SUCCEEDED != VERIFIED      — Lane 3 NEVER claims verification truth.
 *                                Verification belongs to Lane 4. There is no
 *                                VERIFIED state anywhere in Lane 3.
 *   TIMED_OUT != NO-EFFECT     — timeout preserves effect ambiguity:
 *                                timeout != proof of no side effect.
 *   CANCELLED only pre-invocation — cancellation after invocation started
 *                                must NOT claim the effect was prevented.
 *
 * Results are immutable (deep-frozen) and normalized: no raw hostile actuator
 * objects/proxies/thrown values escape canonical boundaries.
 */

const crypto = require("node:crypto");
const { fail, REASONS, RESULT_STATE, resultBrandSet } = require("./errors");

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_STRING_CHARS = 1024;
const MAX_KEYS = 64;
const MAX_DEPTH = 8;
const MAX_NODES = 512;

function isPlainObject(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/**
 * PURE — sanitize the actuator's return value / thrown error into a bounded
 * detached payload. Normalizes hostile objects: functions, symbols, accessors,
 * class instances, cycles, prototype pollution are all rejected or flattened;
 * Errors are reduced to { name, message } (stack never retained).
 */
function sanitizeActuatorOutput(value) {
    const state = { nodes: 0, path: new Set() };
    function walk(v, depth) {
        state.nodes++;
        if (state.nodes > MAX_NODES) throw fail(REASONS.ACTUATOR_MALFORMED_RESULT, "actuator output exceeds node budget");
        if (depth > MAX_DEPTH) throw fail(REASONS.ACTUATOR_MALFORMED_RESULT, "actuator output exceeds depth bound");
        if (v === null) return null;
        const t = typeof v;
        if (t === "string") {
            if (v.length > MAX_STRING_CHARS) return v.slice(0, MAX_STRING_CHARS);
            return v;
        }
        if (t === "boolean") return v;
        if (t === "number") return Number.isFinite(v) ? v : null;
        if (t === "bigint" || t === "symbol" || t === "undefined" || t === "function") return null;
        if (v instanceof Error) {
            return { name: String(v.name ?? "Error").slice(0, 64), message: String(v.message ?? "").slice(0, MAX_STRING_CHARS) };
        }
        if (!isPlainObject(v) && !Array.isArray(v)) {
            // class instance / Map / Set / Date / Proxy-with-exotic-target etc.
            return null;
        }
        if (state.path.has(v)) return null; // cycle => flatten to null
        state.path.add(v);
        if (Array.isArray(v)) {
            const out = v.slice(0, 256).map((x) => walk(x, depth + 1));
            state.path.delete(v);
            return out;
        }
        const out = {};
        let keys = 0;
        for (const key of Object.getOwnPropertyNames(v)) {
            if (keys >= MAX_KEYS) break;
            keys++;
            const desc = Object.getOwnPropertyDescriptor(v, key);
            if (!desc || desc.get || desc.set) continue; // accessors skipped
            const kk = key.length > 128 ? key.slice(0, 128) : key;
            out[kk] = walk(desc.value, depth + 1);
        }
        state.path.delete(v);
        return out;
    }
    return walk(value, 0);
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

function requireSafeInteger(v, field) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
        throw fail(REASONS.MALFORMED_REQUEST, `${field} must be a nonnegative safe integer`);
    }
    return v;
}

/**
 * PRIVILEGED (dispatcher-private) — build the immutable structured result.
 *
 * @param {object} p
 * @param {object} p.executionRequest  the canonical ExecutionRequest
 * @param {string} p.state             RESULT_STATE (EXECUTED | FAILED | TIMED_OUT | CANCELLED)
 * @param {string} p.actuatorId        actuator identity ("" if never bound)
 * @param {string} p.actuatorIncarnationId  actuator binding incarnation ("" if never bound)
 * @param {object} p.lifecycleTrace    the frozen lifecycle trace
 * @param {number} p.startedAtMs       dispatch start timestamp
 * @param {number} p.completedAtMs     completion timestamp
 * @param {object} [p.actuatorReport]  sanitized actuator-reported output
 * @param {string} [p.failureReason]   normalized failure reason code ("" if none)
 * @param {string} [p.failureDetail]   bounded failure detail ("" if none)
 * @returns {object} frozen structured result
 */
function buildExecutionResult({
    executionRequest,
    state,
    actuatorId = "",
    actuatorIncarnationId = "",
    lifecycleTrace,
    startedAtMs,
    completedAtMs,
    actuatorReport = null,
    failureReason = "",
    failureDetail = ""
}) {
    if (!executionRequest || typeof executionRequest !== "object" || typeof executionRequest.executionId !== "string") {
        throw fail(REASONS.MALFORMED_REQUEST, "buildExecutionResult requires a canonical ExecutionRequest");
    }
    if (!RESULT_STATE[state]) {
        throw fail(REASONS.MALFORMED_REQUEST, `invalid result state '${state}'`);
    }
    if (state === RESULT_STATE.EXECUTED && failureReason) {
        throw fail(REASONS.MALFORMED_REQUEST, "EXECUTED result must not carry a failure reason");
    }
    if (state !== RESULT_STATE.EXECUTED && !failureReason) {
        throw fail(REASONS.MALFORMED_REQUEST, `non-EXECUTED result '${state}' must carry a failure reason`);
    }
    requireSafeInteger(startedAtMs, "startedAtMs");
    requireSafeInteger(completedAtMs, "completedAtMs");
    if (completedAtMs < startedAtMs) {
        throw fail(REASONS.MALFORMED_REQUEST, "completedAtMs must be >= startedAtMs");
    }

    // Sanitized actuator report — hostile objects never escape.
    const report = actuatorReport === null || actuatorReport === undefined
        ? null
        : deepFreeze(sanitizeActuatorOutput(actuatorReport));

    const result = deepFreeze({
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
        failureDetail: failureDetail ? String(failureDetail).slice(0, MAX_STRING_CHARS) : "",
        authorityGeneration: executionRequest.authorityGeneration,
        lifecycleTrace,
        // Explicit non-claims (Lane 3 does not verify; Lane 4 owns that):
        verified: null,
        verificationClaim: null
    });
    // Brand as canonical (closure-only WeakSet in errors.js; read by the
    // public PURE predicate isCanonicalExecutionResult). Clone/JSON/forged
    // shapes are never in the brand.
    resultBrandSet.add(result);
    return result;
}

/**
 * PRIVILEGED (dispatcher-private) — build immutable execution evidence
 * suitable for Audit Ledger integration. Evidence records what happened
 * per Lane 3 semantics; the Audit Ledger is NOT the source of current truth.
 *
 * Includes: who / what / which capability incarnation / which actuator
 * incarnation / why execution was authorized (authority generation observed
 * at revalidation) / when / outcome-lifecycle.
 */
function buildExecutionEvidence({ executionRequest, result, actuatorBinding, revalidation }) {
    if (!result || typeof result !== "object") {
        throw fail(REASONS.MALFORMED_REQUEST, "buildExecutionEvidence requires a structured result");
    }
    return deepFreeze({
        schemaVersion: 1,
        kind: "action.actuation.execution",
        executionId: result.executionId,
        intentId: result.intentId,
        // who
        principal: result.principal,
        // what
        capabilityId: result.capabilityId,
        operation: result.operation,
        scope: executionRequest.scope,
        // which lifetimes
        capabilityIncarnationId: result.capabilityIncarnationId,
        actuatorId: result.actuatorId,
        actuatorIncarnationId: result.actuatorIncarnationId,
        // why authorized (historical evidence at revalidation time — NOT a bearer token)
        authorityGeneration: revalidation.authorityGeneration,
        revalidatedAtMs: revalidation.revalidatedAtMs,
        // when
        startedAtMs: result.startedAtMs,
        completedAtMs: result.completedAtMs,
        // outcome / lifecycle
        state: result.state,
        failureReason: result.failureReason,
        lifecycleTrace: result.lifecycleTrace,
        // Lane 3 emits evidence FOR Lane 4; it never claims verification.
        verified: null
    });
}

module.exports = { buildExecutionResult, buildExecutionEvidence, sanitizeActuatorOutput };
