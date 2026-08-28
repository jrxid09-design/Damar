"use strict";

/**
 * ACTION INTENT V1 — admission (trusted minting).
 *
 * The trusted composition that turns an UNTRUSTED serialized proposal into a
 * canonical evaluable ActionIntent bound to the exact capability incarnation
 * and canonical scope.
 *
 * Flow:
 *   serialized raw proposal
 *       -> resolve capability from certified registry (fail closed if absent)
 *       -> validate operation declared (fail closed if undeclared)
 *       -> resolve canonical scope via trusted scopeResolver (fail closed if
 *          unresolved)
 *       -> mint intentId + createdAtMs (validated clock)
 *       -> immutable ActionIntent
 */

const { fail, REASONS } = require("./errors");
const { parseActionIntent, canonicalScope, validateTimestamp, isValidIncarnationId } = require("./intent");
const { captureClock } = require("./clock");

/**
 * Create an admission function bound to a capability registry + scope resolver.
 *
 * @param {object} deps
 * @param {object} deps.registry        Lane-1 CapabilityRegistry (read-only get)
 * @param {function} deps.scopeResolver  trusted (capabilityId, operation, args)
 *                                       -> string[] canonical scope tokens
 * @param {object} [deps.clock]
 */
function createIntentAdmission({ registry, scopeResolver, clock = { nowMs: () => Date.now() } } = {}) {
    if (!registry || typeof registry.get !== "function") {
        throw new TypeError("admission requires a capability registry with get()");
    }
    if (typeof scopeResolver !== "function") {
        throw new TypeError("admission requires a trusted scopeResolver");
    }
    const capturedClock = captureClock(clock);

    /**
     * Admit an untrusted serialized proposal into a canonical ActionIntent.
     * Throws ActionError on any rejection. Never mutates anything.
     */
    function admit(serialized, { source = "inline" } = {}) {
        // parse untrusted proposal (STRING-ONLY boundary)
        const parsed = parseActionIntent(serialized, { source, nowMs: capturedClock.nowMs() });

        const capabilityId = parsed.capabilityId;

        // resolve capability: must exist (fail closed at admission)
        const descriptor = registry.get(capabilityId);
        if (!descriptor) {
            throw fail(REASONS.CAPABILITY_NOT_FOUND, `no such capability '${capabilityId}'`);
        }

        // validate operation declared (fail closed before evaluable intent)
        const operation = parsed.operation;
        if (!Array.isArray(descriptor.operations) || !descriptor.operations.includes(operation)) {
            throw fail(REASONS.OPERATION_NOT_DECLARED, `operation '${operation}' not declared by '${capabilityId}'`);
        }

        // bind exact capability incarnation (never opportunistically at gate)
        const incarnationId = descriptor.incarnationId;
        if (!isValidIncarnationId(incarnationId)) {
            throw fail(REASONS.INVALID_INTENT, `capability '${capabilityId}' has no valid incarnation`);
        }

        // resolve canonical scope via trusted resolver (fail closed if unresolved)
        let rawScope;
        try {
            rawScope = scopeResolver(capabilityId, operation, parsed.arguments);
        } catch {
            throw fail(REASONS.INVALID_INTENT, `scope resolution failed for '${capabilityId}'`);
        }
        const scope = canonicalScope(rawScope);

        const createdAtMs = validateTimestamp(parsed.createdAtMs, "createdAtMs");

        return deepFreeze({
            ...parsed,
            capabilityIncarnationId: incarnationId,
            scope,
            createdAtMs
        });
    }

    return Object.freeze({ admit });
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

module.exports = { createIntentAdmission };
