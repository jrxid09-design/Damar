"use strict";

/**
 * ACTION AUTHORITY GATE V1 — ActionAuthorityGate.
 *
 * Consumes a canonical ActionIntent + canonical Capability Registry state +
 * canonical Authority state, and returns a deterministic, immutable
 * AuthorityDecision. It NEVER executes, invokes, actuates, compensates, or
 * verifies anything.
 *
 * Closed decision model:
 *   ALLOW | DENY | OWNER_CONFIRMATION_REQUIRED
 *
 * Semantics:
 *   AVAILABLE != AUTHORIZED ; AUTHORIZED != EXECUTED
 *
 * The gate is OBSERVATIONAL / READ-ONLY over Authority and the Capability
 * Registry. It mutates neither. A rejected/malformed intent produces a typed
 * rejection (no decision, no canonical mutation).
 *
 * ABA SAFETY: an ALLOW decision is bound to the exact capability incarnation
 * and authority generation evaluated. A decision for capability X /
 * incarnation A can never authorize capability X / incarnation B after
 * remove/re-register. Stale authority generation is detected and denied.
 */

const { fail, REASONS } = require("./errors");
const { isValidIncarnationId } = require("./intent");

const DECISION = Object.freeze({
    ALLOW: "ALLOW",
    DENY: "DENY",
    OWNER_CONFIRMATION_REQUIRED: "OWNER_CONFIRMATION_REQUIRED"
});

/**
 * Gate-level reason codes. These are the STABLE final vocabulary of why a
 * decision is DENY / OWNER_CONFIRMATION_REQUIRED. They do not leak raw
 * internal exceptions.
 */
const GATE_REASONS = Object.freeze({
    INVALID_INTENT: "INVALID_INTENT",
    CAPABILITY_NOT_FOUND: "CAPABILITY_NOT_FOUND",
    CAPABILITY_INCARNATION_MISMATCH: "CAPABILITY_INCARNATION_MISMATCH",
    OPERATION_NOT_DECLARED: "OPERATION_NOT_DECLARED",
    CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
    CAPABILITY_DEGRADED: "CAPABILITY_DEGRADED",
    AUTHORITY_INSUFFICIENT: "AUTHORITY_INSUFFICIENT",
    OWNER_CONFIRMATION_REQUIRED: "OWNER_CONFIRMATION_REQUIRED",
    AUTHORITY_STATE_STALE: "AUTHORITY_STATE_STALE"
});

/**
 * Map an authority-context denial reason to a gate reason. Unknown authority
 * reasons fail closed to AUTHORITY_INSUFFICIENT (never ALLOW).
 */
function mapAuthorityReason(reasonCode) {
    if (reasonCode === "CAP_GENERATION_STALE") return GATE_REASONS.AUTHORITY_STATE_STALE;
    if (reasonCode === "CAP_NOT_FOUND") return GATE_REASONS.AUTHORITY_INSUFFICIENT;
    // All other authority denials (action/scope/purpose/identity/budget/
    // inactive/revoked/expired/exhausted/malformed) collapse to insufficient
    // authority for the evaluated action.
    return GATE_REASONS.AUTHORITY_INSUFFICIENT;
}

class ActionAuthorityGate {
    /**
     * @param {object} deps
     * @param {object} deps.capabilityRegistry  Lane-1 CapabilityRegistry (read-only get)
     * @param {object} deps.authorityContext    { evaluate(...) } read-only authority evaluator
     * @param {object} [deps.clock]             { nowMs } trusted clock
     */
    constructor({ capabilityRegistry, authorityContext, clock = { nowMs: () => Date.now() } } = {}) {
        if (!capabilityRegistry || typeof capabilityRegistry.get !== "function") {
            throw new TypeError("gate requires a capability registry with get()");
        }
        if (!authorityContext || typeof authorityContext.evaluate !== "function") {
            throw new TypeError("gate requires an authority context with evaluate()");
        }
        this._registry = capabilityRegistry;
        this._authority = authorityContext;
        this._clock = clock;
    }

    _now() {
        const raw = this._clock.nowMs();
        if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isSafeInteger(raw) || raw < 0) {
            throw fail(REASONS.MALFORMED_INPUT, "gate clock returned an invalid timestamp");
        }
        return raw;
    }

    /**
     * Evaluate a canonical ActionIntent (already parsed, frozen, plain data).
     * Returns a frozen AuthorityDecision. Never mutates anything.
     *
     * @param {object} intent  canonical ActionIntent
     * @returns {object} frozen AuthorityDecision
     */
    async evaluate(intent) {
        // Malformed/non-canonical intent => typed reject (no decision).
        if (!intent || typeof intent !== "object" || typeof intent.intentId !== "string" || typeof intent.capabilityId !== "string" || typeof intent.operation !== "string") {
            throw fail(REASONS.INVALID_INTENT, "gate requires a canonical ActionIntent");
        }

        const capabilityId = intent.capabilityId;
        const operation = intent.operation.trim().toLowerCase();
        const evaluatedAtMs = this._now();

        const deny = (reasonCode, detail = null, extra = {}) => deepFreeze({
            decision: DECISION.DENY,
            reasonCode,
            detail,
            intentId: intent.intentId,
            capabilityId,
            operation,
            evaluatedAtMs,
            ...extra
        });

        // 1. capability exists
        const descriptor = this._registry.get(capabilityId);
        if (!descriptor) {
            return deny(GATE_REASONS.CAPABILITY_NOT_FOUND, `no such capability '${capabilityId}'`);
        }

        // 2. exact incarnation match (ABA safety)
        const currentIncarnation = descriptor.incarnationId;
        const intentIncarnation = intent.capabilityIncarnationId;
        if (intentIncarnation !== null && intentIncarnation !== undefined) {
            if (!isValidIncarnationId(intentIncarnation)) {
                return deny(GATE_REASONS.CAPABILITY_INCARNATION_MISMATCH, `invalid incarnation id in intent`);
            }
            if (intentIncarnation !== currentIncarnation) {
                return deny(GATE_REASONS.CAPABILITY_INCARNATION_MISMATCH,
                    `intent incarnation ${intentIncarnation} != current ${currentIncarnation}`,
                    { intentIncarnation, currentIncarnation });
            }
        } else if (intentIncarnation === null || intentIncarnation === undefined) {
            // No incarnation bound: bind to current incarnation in the decision,
            // but do NOT treat absence as an automatic ALLOW (availability +
            // authority still gate below).
        }

        // 3. operation declared by capability
        const declared = descriptor.operations || [];
        if (!declared.includes(operation)) {
            return deny(GATE_REASONS.OPERATION_NOT_DECLARED, `operation '${operation}' not declared by '${capabilityId}'`);
        }

        // 4. availability semantics (AVAILABLE != AUTHORIZED; explicit states)
        const availability = descriptor.availability;
        if (availability === "UNAVAILABLE") {
            return deny(GATE_REASONS.CAPABILITY_UNAVAILABLE, `capability '${capabilityId}' is UNAVAILABLE`);
        }
        if (availability === "DEGRADED") {
            // Fail-closed: DEGRADED is not ALLOW-eligible without explicit policy.
            return deny(GATE_REASONS.CAPABILITY_DEGRADED, `capability '${capabilityId}' is DEGRADED`);
        }
        if (availability === "UNKNOWN") {
            // UNKNOWN availability is fail-closed (not assumed available).
            return deny(GATE_REASONS.CAPABILITY_UNAVAILABLE, `capability '${capabilityId}' availability is UNKNOWN`);
        }
        // availability === "AVAILABLE" proceeds to authority, but does NOT by
        // itself authorize.

        // 5. authority evaluation (read-only). A throwing/malformed authority
        // context must fail closed to DENY — never crash to ALLOW.
        let authResult;
        try {
            authResult = await this._authority.evaluate({
                capabilityId,
                action: operation,
                scope: intent.scope || [],
                purpose: intent.purpose ?? null,
                identity: {
                    channel: intent.channel,
                    sessionId: intent.session,
                    principal: intent.subject
                },
                nowMs: evaluatedAtMs
            });
        } catch {
            return deny(GATE_REASONS.AUTHORITY_INSUFFICIENT, "authority evaluation failed");
        }

        if (!authResult || typeof authResult !== "object") {
            return deny(GATE_REASONS.AUTHORITY_INSUFFICIENT, "authority context returned no result");
        }

        if (authResult.allowed !== true) {
            // Owner-confirmation semantics: a later owner-auth flow signals
            // this via the authority context; the gate surfaces the decision
            // without manufacturing approval from any untrusted field.
            if (authResult.reasonCode === "OWNER_CONFIRMATION_REQUIRED") {
                return deepFreeze({
                    decision: DECISION.OWNER_CONFIRMATION_REQUIRED,
                    reasonCode: GATE_REASONS.OWNER_CONFIRMATION_REQUIRED,
                    intentId: intent.intentId,
                    capabilityId,
                    capabilityIncarnationId: currentIncarnation,
                    operation,
                    subject: intent.subject,
                    evaluatedAtMs
                });
            }
            const reason = mapAuthorityReason(authResult.reasonCode);
            return deny(reason, `authority denied: ${authResult.reasonCode ?? "unknown"}`, {
                authorityReasonCode: authResult.reasonCode ?? null
            });
        }

        // Authority snapshot binds the decision to the exact generation.
        const authSnapshot = authResult.snapshot || null;
        const authorityGeneration = authSnapshot && typeof authSnapshot.generation === "number"
            ? authSnapshot.generation
            : null;
        const authoritySubject = authSnapshot && typeof authSnapshot.subject === "string"
            ? authSnapshot.subject
            : intent.subject;

        return deepFreeze({
            decision: DECISION.ALLOW,
            reasonCode: ALLOW_REASON,
            intentId: intent.intentId,
            capabilityId,
            capabilityIncarnationId: currentIncarnation,
            operation,
            subject: intent.subject,
            authoritySubject,
            authorityGeneration,
            evaluatedAtMs
        });
    }
}

// ALLOW carries a stable reason "AUTHORIZED" bound to the exact incarnation.
// We expose it as a constant for clarity.
const ALLOW_REASON = "AUTHORIZED";

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

module.exports = { ActionAuthorityGate, DECISION, GATE_REASONS, ALLOW_REASON };
