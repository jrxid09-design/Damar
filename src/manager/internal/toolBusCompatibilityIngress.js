"use strict";

/**
 * W8-IW1 — TOOLBUS COMPATIBILITY INGRESS (Manager-owned).
 *
 * The ONLY place where a ToolBus-format request can reach the canonical
 * governance path. This module is ingress-only: it translates a legacy request
 * shape into a canonical capability execution request and routes it through the
 * existing CanonicalCapabilityExecution bridge. It mints no authority of its own.
 *
 * LAWS (each is a structural property, not just a comment):
 *
 *   TOOLBUS                 != AUTHORITY
 *   LEGACY REQUEST          != ACTION INTENT
 *   COMPATIBILITY INGRESS   != EXECUTION AUTHORITY
 *   CANONICAL EVALUATION       IS REQUIRED — caller must supply it;
 *                              ingress cannot produce it
 *   REGISTRATION            != AUTHORIZATION
 *   DRIVER PRESENT          != PERMISSION
 *
 * Canonical execution path:
 *
 *   legacy ToolBus request + canonical authority evaluation
 *   → ToolBusCompatibilityIngress.execute()
 *   → CanonicalCapabilityExecution.execute()
 *       (TOOLBUS_COMPAT_CAPABILITY_ID, "execute", inert-parameters, evaluation)
 *   → composition-time driver
 *   → VerificationEngine / registered verifier
 *   → AuditAcknowledger
 *   → branded canonical result (EXECUTED_VERIFIED or fail-closed outcome)
 *
 * The driver and verifier are ALWAYS composition-time-only; no caller-supplied
 * handler can ever reach the execution path.
 */

const { isCanonicalAuthorityEvaluation } = require("../../authority/evaluate");
const {
    CanonicalCapabilityExecution,
    OUTCOME,
    REFUSAL,
    isCanonicalCapabilityResult
} = require("./canonicalCapabilityExecution");

/** The one canonical capability id for ToolBus compatibility routing. */
const TOOLBUS_COMPAT_CAPABILITY_ID = "toolbus.compat.execute";

// Closure-private WeakMap — no external access to bridge or construction state.
const STATE = new WeakMap();

class ToolBusCompatibilityIngress {
    /**
     * @param {object}   opts
     * @param {*}        opts.replayStore   replay store (must have
     *                                      rollbackResistance="EXTERNAL" for
     *                                      consequential execution)
     * @param {Function} opts.acknowledger  composition-time audit acknowledger
     * @param {Function} opts.driver        composition-time driver fn,
     *                                      receives ({ parameters, principal,
     *                                        scope, requestId, signal })
     * @param {Function} [opts.verifier]    optional composition-time verifier fn
     */
    constructor({ replayStore, acknowledger, driver, verifier } = {}) {
        if (typeof driver !== "function") {
            throw new TypeError(
                "ToolBusCompatibilityIngress: driver must be a function supplied at composition time");
        }
        if (typeof acknowledger !== "function") {
            throw new TypeError(
                "ToolBusCompatibilityIngress: acknowledger must be a function");
        }

        const bridge = new CanonicalCapabilityExecution({ replayStore });
        bridge.registerCapability({
            capabilityId: TOOLBUS_COMPAT_CAPABILITY_ID,
            operation: "execute",
            consequential: true,
            driver
        });
        if (typeof verifier === "function") {
            bridge.registerVerifier(TOOLBUS_COMPAT_CAPABILITY_ID, verifier);
        }
        bridge.installAuditAcknowledger(acknowledger);

        STATE.set(this, { bridge });
    }

    /**
     * Route a legacy ToolBus request through the canonical governance path.
     *
     * Returns a branded canonical capability result. Only EXECUTED_VERIFIED
     * represents completion; every other outcome fails closed. Replayed requests
     * (same capabilityId + operation + parameters + principal + scope) are refused
     * with outcome=REFUSED, reason=REPLAY and effectInvoked=false.
     *
     * @param {object}      legacyRequest  ToolBus-format ({ name, args, ... })
     * @param {*}           evaluation     must be a canonical authority evaluation
     *                                     produced by loadAndEvaluateAuthority
     * @param {object}      [opts]
     * @param {AbortSignal} [opts.signal]
     * @param {string}      [opts.requestId]
     * @returns {Promise<object>}  branded canonical capability result
     */
    async execute(legacyRequest, evaluation, { signal, requestId } = {}) {
        // Fail closed: no canonical evaluation means no routing — never.
        if (!isCanonicalAuthorityEvaluation(evaluation)) {
            return Object.freeze({
                outcome: OUTCOME.DENIED,
                reason: REFUSAL.AUTHORITY_FORGED,
                effectInvoked: false
            });
        }

        // Read legacy request fields defensively — a hostile container must not
        // escape as anything other than a fail-closed refusal.
        const toolName = (() => {
            try {
                const n = legacyRequest?.name;
                return typeof n === "string" ? n : String(n ?? "");
            } catch { return ""; }
        })();

        const toolArgs = (() => {
            try {
                const a = legacyRequest?.args;
                // Pass through inert shapes; undefined/non-objects become null.
                return (a !== null && a !== undefined && typeof a === "object") ? a : null;
            } catch { return null; }
        })();

        const { bridge } = STATE.get(this);
        return bridge.execute({
            capabilityId: TOOLBUS_COMPAT_CAPABILITY_ID,
            operation: "execute",
            parameters: { tool: toolName, args: toolArgs },
            evaluation,
            signal: signal ?? null,
            requestId: requestId ?? undefined
        });
    }
}

module.exports = Object.freeze({
    ToolBusCompatibilityIngress,
    TOOLBUS_COMPAT_CAPABILITY_ID,
    isCanonicalCapabilityResult
});
