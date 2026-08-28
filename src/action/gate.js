"use strict";

/**
 * ACTION AUTHORITY GATE V1 — ActionAuthorityGate.
 *
 * Consumes a canonical ActionIntent + a BRANDED trusted RuntimeIdentityContext
 * + canonical Capability Registry state + canonical Authority state, and
 * returns a deterministic, immutable AuthorityDecision. It NEVER executes,
 * invokes, actuates, compensates, or verifies anything.
 *
 * Closed decision model:
 *   ALLOW | DENY | OWNER_CONFIRMATION_REQUIRED
 *
 * TRUST ORIGIN: the gate is constructed ONLY by the trusted composition root
 * (`createActionAuthorityRuntime`). It binds directly to the canonical
 * authority evaluator and the identity/evaluation brand verifiers. It does NOT
 * accept an arbitrary `{ evaluate() }` authorityContext, and it accepts ALLOW
 * only from a BRANDED canonical AuthorityEvaluation (provenance that only the
 * canonical evaluator can produce).
 *
 * OBSERVATIONAL: the gate mutates neither Authority nor Capability Registry.
 */

const { fail, REASONS } = require("./errors");
const { isValidIncarnationId } = require("./intent");
const { isRuntimeIdentityContext } = require("./runtimeIdentity");
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

class ActionAuthorityGate {
    /**
     * @param {object} deps
     * @param {object} deps.capabilityRegistry       Lane-1 CapabilityRegistry
     * @param {function} deps.authorityEvaluator     (request) => branded evaluation
     * @param {function} deps.isCanonicalEvaluation  (evaluation) => boolean (brand check)
     * @param {object} [deps.clock]
     */
    constructor({ capabilityRegistry, authorityEvaluator, isCanonicalEvaluation, clock = { nowMs: () => Date.now() } } = {}) {
        if (!capabilityRegistry || typeof capabilityRegistry.get !== "function") {
            throw new TypeError("gate requires a capability registry with get()");
        }
        if (typeof authorityEvaluator !== "function") {
            throw new TypeError("gate requires a canonical authorityEvaluator function");
        }
        if (typeof isCanonicalEvaluation !== "function") {
            throw new TypeError("gate requires an isCanonicalEvaluation brand verifier");
        }
        this._registry = capabilityRegistry;
        this._evaluate = authorityEvaluator;
        this._isCanonical = isCanonicalEvaluation;
        this._clock = captureClock(clock);
    }

    async evaluate(intent, runtimeIdentity) {
        if (!intent || typeof intent !== "object" ||
            typeof intent.intentId !== "string" ||
            typeof intent.capabilityId !== "string" ||
            typeof intent.operation !== "string") {
            throw fail(REASONS.INVALID_INTENT, "gate requires a canonical ActionIntent");
        }

        const evaluatedAtMs = this._clock.nowMs();

        // Trusted identity MUST be branded (not shape-only).
        if (!isRuntimeIdentityContext(runtimeIdentity)) {
            return this._deny(intent, GATE_REASONS.INVALID_IDENTITY, "not a trusted runtime identity context", {}, evaluatedAtMs);
        }

        const capabilityId = intent.capabilityId;
        const operation = intent.operation.trim().toLowerCase();

        const descriptor = this._registry.get(capabilityId);
        if (!descriptor) {
            return this._deny(intent, GATE_REASONS.CAPABILITY_NOT_FOUND, `no such capability '${capabilityId}'`, {}, evaluatedAtMs);
        }

        const currentIncarnation = descriptor.incarnationId;
        const intentIncarnation = intent.capabilityIncarnationId;
        if (!isValidIncarnationId(intentIncarnation)) {
            return this._deny(intent, GATE_REASONS.CAPABILITY_INCARNATION_MISMATCH, "intent is not bound to a valid capability incarnation", {}, evaluatedAtMs);
        }
        if (intentIncarnation !== currentIncarnation) {
            return this._deny(intent, GATE_REASONS.CAPABILITY_INCARNATION_MISMATCH,
                `intent incarnation ${intentIncarnation} != current ${currentIncarnation}`,
                { intentIncarnation, currentIncarnation }, evaluatedAtMs);
        }

        const declared = descriptor.operations || [];
        if (!declared.includes(operation)) {
            return this._deny(intent, GATE_REASONS.OPERATION_NOT_DECLARED, `operation '${operation}' not declared`, {}, evaluatedAtMs);
        }

        const availability = descriptor.availability;
        if (availability === "UNAVAILABLE" || availability === "UNKNOWN") {
            return this._deny(intent, GATE_REASONS.CAPABILITY_UNAVAILABLE, `capability '${capabilityId}' is ${availability}`, {}, evaluatedAtMs);
        }
        if (availability === "DEGRADED") {
            return this._deny(intent, GATE_REASONS.CAPABILITY_DEGRADED, `capability '${capabilityId}' is DEGRADED`, {}, evaluatedAtMs);
        }

        const scope = Array.isArray(intent.scope) ? intent.scope : [];

        // Canonical authority evaluation (single source of truth).
        let authResult;
        try {
            authResult = await this._evaluate({
                capabilityId,
                action: operation,
                scope,
                purpose: intent.purpose ?? null,
                identity: {
                    channel: runtimeIdentity.channel,
                    sessionId: runtimeIdentity.sessionId,
                    principal: runtimeIdentity.principal
                },
                nowMs: evaluatedAtMs
            });
        } catch {
            return this._deny(intent, GATE_REASONS.AUTHORITY_INSUFFICIENT, "authority evaluation failed", {}, evaluatedAtMs);
        }

        if (!authResult || typeof authResult !== "object") {
            return this._deny(intent, GATE_REASONS.AUTHORITY_INSUFFICIENT, "authority context returned no result", {}, evaluatedAtMs);
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
            return this._deny(intent, reason, `authority denied: ${authResult.reasonCode ?? "unknown"}`, {
                authorityReasonCode: authResult.reasonCode ?? null
            }, evaluatedAtMs);
        }

        // A positive evaluation MUST be a branded canonical AuthorityEvaluation.
        // Shape-valid but un-branded positive results are rejected (fail closed).
        if (!this._isCanonical(authResult)) {
            return this._deny(intent, GATE_REASONS.MALFORMED_AUTHORITY_EVALUATION, "not a canonical authority evaluation", {}, evaluatedAtMs);
        }

        const snapshot = authResult.snapshot;
        const validationError = validateAuthorityEvaluation(authResult, {
            capabilityId, operation, scope,
            principal: runtimeIdentity.principal,
            evaluatedAtMs
        });
        if (validationError) {
            return this._deny(intent, GATE_REASONS.MALFORMED_AUTHORITY_EVALUATION, validationError, {}, evaluatedAtMs);
        }

        return deepFreeze({
            decision: DECISION.ALLOW,
            reasonCode: ALLOW_REASON,
            intentId: intent.intentId,
            capabilityId,
            capabilityIncarnationId: currentIncarnation,
            operation,
            principal: runtimeIdentity.principal,
            authorityGeneration: snapshot.generation,
            evaluatedAtMs
        });
    }

    _deny(intent, reasonCode, detail = null, extra = {}, evaluatedAtMs) {
        return deepFreeze({
            decision: DECISION.DENY,
            reasonCode,
            detail,
            intentId: intent.intentId,
            capabilityId: intent.capabilityId,
            operation: intent.operation,
            evaluatedAtMs: evaluatedAtMs ?? this._clock.nowMs(),
            ...extra
        });
    }
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

const ALLOW_REASON = "AUTHORIZED";

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

module.exports = { ActionAuthorityGate, DECISION, GATE_REASONS, ALLOW_REASON };
