"use strict";

/**
 * ACTION AUTHORITY GATE V1 — sealed gate.
 *
 * The gate is a CLOSURE-BOUND, frozen `{ evaluate }` surface. It closes over the
 * canonical authority evaluator, the canonical brand verifier, the capability
 * registry, and the hardened clock. There are NO writable internals:
 *
 *   - no `_evaluate` / `_isCanonical` / `_registry` / `_clock` properties
 *   - no mutable callbacks
 *   - no exported raw gate constructor
 *
 * `evaluate(intent, authSession)` accepts a canonical ActionIntent + a BRANDED
 * AuthSessionCapability and returns a deterministic, immutable AuthorityDecision.
 * It NEVER executes, invokes, actuates, compensates, or verifies anything.
 *
 * Closed decision model:
 *   ALLOW | DENY | OWNER_CONFIRMATION_REQUIRED
 */

const { fail, REASONS } = require("./errors");
const { isValidIncarnationId } = require("./intent");
const { isAuthSession } = require("./authSession");
const { captureClock } = require("./clock");

const DECISION = Object.freeze({
    ALLOW: "ALLOW",
    DENY: "DENY",
    OWNER_CONFIRMATION_REQUIRED: "OWNER_CONFIRMATION_REQUIRED"
});

const GATE_REASONS = Object.freeze({
    INVALID_INTENT: "INVALID_INTENT",
    INVALID_IDENTITY: "INVALID_IDENTITY",
    CAPABILITY_NOT_FOUND: "CAPABILITY_NOT_FOUND",
    CAPABILITY_INCARNATION_MISMATCH: "CAPABILITY_INCARNATION_MISMATCH",
    OPERATION_NOT_DECLARED: "OPERATION_NOT_DECLARED",
    CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
    CAPABILITY_DEGRADED: "CAPABILITY_DEGRADED",
    AUTHORITY_INSUFFICIENT: "AUTHORITY_INSUFFICIENT",
    OWNER_CONFIRMATION_REQUIRED: "OWNER_CONFIRMATION_REQUIRED",
    AUTHORITY_STATE_STALE: "AUTHORITY_STATE_STALE",
    MALFORMED_AUTHORITY_EVALUATION: "MALFORMED_AUTHORITY_EVALUATION"
});

function mapAuthorityReason(reasonCode) {
    if (reasonCode === "CAP_GENERATION_STALE") return GATE_REASONS.AUTHORITY_STATE_STALE;
    return GATE_REASONS.AUTHORITY_INSUFFICIENT;
}

const ALLOW_REASON = "AUTHORIZED";

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

/**
 * Build a SEALED gate. Returns a frozen `{ evaluate }` whose behavior is fixed
 * at construction (closure-bound). No internal is reachable or replaceable.
 *
 * @param {object} deps
 * @param {object} deps.registry                Lane-1 CapabilityRegistry (read-only)
 * @param {function} deps.authorityEvaluator    (request) => branded evaluation
 * @param {function} deps.isCanonicalEvaluation (evaluation) => boolean (brand)
 * @param {object} deps.clock                   captured hardened clock
 */
function createGate({ registry, authorityEvaluator, isCanonicalEvaluation, clock } = {}) {
    if (!registry || typeof registry.get !== "function") {
        throw new TypeError("gate requires a capability registry with get()");
    }
    if (typeof authorityEvaluator !== "function") {
        throw new TypeError("gate requires a canonical authorityEvaluator function");
    }
    if (typeof isCanonicalEvaluation !== "function") {
        throw new TypeError("gate requires an isCanonicalEvaluation brand verifier");
    }
    const capturedClock = captureClock(clock);

    const deny = (intent, reasonCode, detail = null, extra = {}, evaluatedAtMs) => deepFreeze({
        decision: DECISION.DENY,
        reasonCode,
        detail,
        intentId: intent.intentId,
        capabilityId: intent.capabilityId,
        operation: intent.operation,
        evaluatedAtMs,
        ...extra
    });

    async function evaluate(intent, authSession) {
        if (!intent || typeof intent !== "object" ||
            typeof intent.intentId !== "string" ||
            typeof intent.capabilityId !== "string" ||
            typeof intent.operation !== "string") {
            throw fail(REASONS.INVALID_INTENT, "gate requires a canonical ActionIntent");
        }

        const evaluatedAtMs = capturedClock.nowMs();

        // Trusted identity MUST be a branded AuthSessionCapability.
        if (!isAuthSession(authSession)) {
            return deny(intent, GATE_REASONS.INVALID_IDENTITY, "not a trusted auth session", {}, evaluatedAtMs);
        }

        const capabilityId = intent.capabilityId;
        const operation = intent.operation.trim().toLowerCase();
        const principal = authSession.principal;
        const channel = authSession.channel;
        const sessionId = authSession.sessionId;

        const descriptor = registry.get(capabilityId);
        if (!descriptor) {
            return deny(intent, GATE_REASONS.CAPABILITY_NOT_FOUND, `no such capability '${capabilityId}'`, {}, evaluatedAtMs);
        }

        const currentIncarnation = descriptor.incarnationId;
        const intentIncarnation = intent.capabilityIncarnationId;
        if (!isValidIncarnationId(intentIncarnation)) {
            return deny(intent, GATE_REASONS.CAPABILITY_INCARNATION_MISMATCH, "intent is not bound to a valid capability incarnation", {}, evaluatedAtMs);
        }
        if (intentIncarnation !== currentIncarnation) {
            return deny(intent, GATE_REASONS.CAPABILITY_INCARNATION_MISMATCH,
                `intent incarnation ${intentIncarnation} != current ${currentIncarnation}`,
                { intentIncarnation, currentIncarnation }, evaluatedAtMs);
        }

        const declared = descriptor.operations || [];
        if (!declared.includes(operation)) {
            return deny(intent, GATE_REASONS.OPERATION_NOT_DECLARED, `operation '${operation}' not declared`, {}, evaluatedAtMs);
        }

        const availability = descriptor.availability;
        if (availability === "UNAVAILABLE" || availability === "UNKNOWN") {
            return deny(intent, GATE_REASONS.CAPABILITY_UNAVAILABLE, `capability '${capabilityId}' is ${availability}`, {}, evaluatedAtMs);
        }
        if (availability === "DEGRADED") {
            return deny(intent, GATE_REASONS.CAPABILITY_DEGRADED, `capability '${capabilityId}' is DEGRADED`, {}, evaluatedAtMs);
        }

        const scope = Array.isArray(intent.scope) ? intent.scope : [];

        let authResult;
        try {
            authResult = await authorityEvaluator({
                capabilityId,
                action: operation,
                scope,
                purpose: intent.purpose ?? null,
                identity: { channel, sessionId, principal },
                nowMs: evaluatedAtMs
            });
        } catch {
            return deny(intent, GATE_REASONS.AUTHORITY_INSUFFICIENT, "authority evaluation failed", {}, evaluatedAtMs);
        }

        if (!authResult || typeof authResult !== "object") {
            return deny(intent, GATE_REASONS.AUTHORITY_INSUFFICIENT, "authority context returned no result", {}, evaluatedAtMs);
        }

        if (authResult.allowed !== true) {
            if (authResult.reasonCode === "OWNER_CONFIRMATION_REQUIRED") {
                return deepFreeze({
                    decision: DECISION.OWNER_CONFIRMATION_REQUIRED,
                    reasonCode: GATE_REASONS.OWNER_CONFIRMATION_REQUIRED,
                    intentId: intent.intentId,
                    capabilityId,
                    capabilityIncarnationId: currentIncarnation,
                    operation,
                    evaluatedAtMs
                });
            }
            const reason = mapAuthorityReason(authResult.reasonCode);
            return deny(intent, reason, `authority denied: ${authResult.reasonCode ?? "unknown"}`, {
                authorityReasonCode: authResult.reasonCode ?? null
            }, evaluatedAtMs);
        }

        if (!isCanonicalEvaluation(authResult)) {
            return deny(intent, GATE_REASONS.MALFORMED_AUTHORITY_EVALUATION, "not a canonical authority evaluation", {}, evaluatedAtMs);
        }

        const snapshot = authResult.snapshot;
        const validationError = validateAuthorityEvaluation(authResult, {
            capabilityId, operation, scope, principal, evaluatedAtMs
        });
        if (validationError) {
            return deny(intent, GATE_REASONS.MALFORMED_AUTHORITY_EVALUATION, validationError, {}, evaluatedAtMs);
        }

        return deepFreeze({
            decision: DECISION.ALLOW,
            reasonCode: ALLOW_REASON,
            intentId: intent.intentId,
            capabilityId,
            capabilityIncarnationId: currentIncarnation,
            operation,
            principal,
            authorityGeneration: snapshot.generation,
            evaluatedAtMs
        });
    }

    return Object.freeze({ evaluate });
}

/**
 * Validate that a positive AuthorityEvaluation exactly matches the request the
 * gate sent. Any missing/mismatched/malformed field => fail closed.
 */
function validateAuthorityEvaluation(authResult, req) {
    if (authResult.allowed !== true) return "allowed !== true";
    const s = authResult.snapshot;
    if (!s || typeof s !== "object" || Array.isArray(s)) return "missing snapshot";

    if (typeof s.generation !== "number" || !Number.isSafeInteger(s.generation) || s.generation < 0) {
        return "missing/invalid generation";
    }
    if (typeof s.capabilityId !== "string" || s.capabilityId !== req.capabilityId) {
        return "capabilityId mismatch";
    }
    if (typeof s.subject !== "string" || s.subject.length === 0) return "missing subject";

    if (typeof s.principal !== "string" || s.principal !== req.principal) {
        return "principal mismatch";
    }

    const actions = Array.isArray(s.actions) ? s.actions.map((a) => String(a).trim().toLowerCase()) : [];
    if (!actions.includes(req.operation)) return "action mismatch";

    const reqScope = req.scope.map((t) => String(t).trim().toLowerCase()).sort();
    const snapScope = Array.isArray(s.scope) ? s.scope.map((t) => String(t).trim().toLowerCase()).sort() : [];
    if (JSON.stringify(snapScope) !== JSON.stringify(reqScope)) return "scope mismatch";

    if (typeof authResult.reasonCode !== "string" || authResult.reasonCode.length === 0) {
        return "missing reasonCode";
    }

    return null;
}

module.exports = { createGate, DECISION, GATE_REASONS, ALLOW_REASON };
