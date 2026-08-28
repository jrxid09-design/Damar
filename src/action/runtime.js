"use strict";

/**
 * ACTION AUTHORITY GATE V1 — sealed runtime composition.
 *
 * `createActionAuthorityRuntime` is the SINGLE trusted composition point,
 * created ONCE by trusted Aether bootstrap. It constructs and binds, inside a
 * trusted closure:
 *
 *   - canonical CapabilityRegistry (read-only)
 *   - canonical Authority evaluator (loadAndEvaluateAuthority)
 *   - canonical brand verifier (isCanonicalAuthorityEvaluation)
 *   - trusted capability-bound scope resolvers (captured ONCE, detached)
 *   - sealed gate (closure-bound, no writable internals)
 *
 * and returns ONLY least-privilege surfaces:
 *
 *   admit(serializedProposal, authSession)   — returns a canonical intent
 *   evaluate(intent, authSession)            — returns an AuthorityDecision
 *
 * IDENTITY: `admit`/`evaluate` accept a BRANDED AuthSessionCapability (minted
 * by trusted authentication infrastructure). The runtime DERIVES the runtime
 * identity internally; it never accepts a raw `{ principal }` string, and it
 * does NOT expose `issueIdentity` / `mintSession` / any identity-minting
 * surface. An arbitrary caller cannot mint a "victim" identity, and cannot bind
 * a new runtime to canonical state to gain privileged identity issuance.
 *
 *   VALID SHAPE != TRUSTED ORIGIN
 */

const { parseActionIntent, canonicalScope, validateTimestamp, isValidIncarnationId } = require("./intent");
const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../authority/evaluate");
const { captureClock } = require("./clock");
const { createGate, DECISION, GATE_REASONS, ALLOW_REASON } = require("./gate");
const { fail, REASONS } = require("./errors");

/**
 * @param {object} options
 * @param {object} options.capabilityRuntime  Lane-1 `createCapabilityRuntime()` result
 * @param {object} options.authorityStore     Authority store (read methods)
 * @param {object} options.trustedScopeBindings
 *     closed mapping: { "<capabilityId>": { "<operation>": resolverFn } }
 * @param {object} [options.clock]
 */
function createActionAuthorityRuntime({
    capabilityRuntime,
    authorityStore,
    trustedScopeBindings = {},
    clock = { nowMs: () => Date.now() }
} = {}) {
    if (!capabilityRuntime || !capabilityRuntime.registry || typeof capabilityRuntime.registry.get !== "function") {
        throw new TypeError("runtime requires a capabilityRuntime with .registry.get()");
    }
    if (!authorityStore || typeof authorityStore.getCapability !== "function") {
        throw new TypeError("runtime requires an authorityStore with getCapability()");
    }
    const registry = capabilityRuntime.registry;
    const capturedClock = captureClock(clock);

    // ---- capture scope resolver FUNCTION IDENTITIES exactly once into a
    // detached, closure-owned Map. Caller mutation of trustedScopeBindings
    // afterward has zero effect (we never re-read the caller's object). ----
    const scopeLookup = new Map();   // capabilityId -> Map(operation -> resolverFn)
    if (trustedScopeBindings !== null && trustedScopeBindings !== undefined) {
        if (typeof trustedScopeBindings !== "object" || Array.isArray(trustedScopeBindings)) {
            throw new TypeError("trustedScopeBindings must be a plain object mapping");
        }
        for (const capId of Object.getOwnPropertyNames(trustedScopeBindings)) {
            const opMap = trustedScopeBindings[capId];
            if (opMap === null || typeof opMap !== "object" || Array.isArray(opMap)) {
                throw new TypeError(`trustedScopeBindings['${capId}'] must be an object mapping operations to resolvers`);
            }
            const opResolvers = new Map();
            for (const op of Object.getOwnPropertyNames(opMap)) {
                const resolver = opMap[op];
                if (typeof resolver !== "function") {
                    throw new TypeError(`trustedScopeBindings['${capId}']['${op}'] must be a function`);
                }
                // capture the FUNCTION IDENTITY (bind not needed; resolver is pure)
                opResolvers.set(op, resolver);
            }
            scopeLookup.set(capId, opResolvers);
        }
    }

    function resolveScopeResolver(capabilityId, operation) {
        const opResolvers = scopeLookup.get(capabilityId);
        if (!opResolvers) return null;
        const resolver = opResolvers.get(operation);
        return (typeof resolver === "function") ? resolver : null;
    }

    // ---- trusted intent admission (identity-free; session needed only at eval) ----
    function admit(serialized, { source = "inline" } = {}) {
        const parsed = parseActionIntent(serialized, { source, nowMs: capturedClock.nowMs() });

        const capabilityId = parsed.capabilityId;
        const operation = parsed.operation;

        const descriptor = registry.get(capabilityId);
        if (!descriptor) {
            throw fail(REASONS.CAPABILITY_NOT_FOUND, `no such capability '${capabilityId}'`);
        }
        if (!Array.isArray(descriptor.operations) || !descriptor.operations.includes(operation)) {
            throw fail(REASONS.OPERATION_NOT_DECLARED, `operation '${operation}' not declared by '${capabilityId}'`);
        }

        const incarnationId = descriptor.incarnationId;
        if (!isValidIncarnationId(incarnationId)) {
            throw fail(REASONS.INVALID_INTENT, `capability '${capabilityId}' has no valid incarnation`);
        }

        const resolver = resolveScopeResolver(capabilityId, operation);
        if (!resolver) {
            throw fail(REASONS.INVALID_INTENT, `no trusted scope binding for '${capabilityId}.${operation}'`);
        }
        let rawScope;
        try {
            rawScope = resolver(parsed.arguments);
        } catch {
            throw fail(REASONS.INVALID_INTENT, `scope resolution failed for '${capabilityId}.${operation}'`);
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

    // ---- sealed gate (closure-bound; no writable internals) ----
    const gate = createGate({
        registry,
        authorityEvaluator: (request) => loadAndEvaluateAuthority(authorityStore, request, { nowMs: capturedClock.nowMs() }),
        isCanonicalEvaluation: isCanonicalAuthorityEvaluation,
        clock: capturedClock
    });

    // ---- least-privilege surface (no identity minting) ----
    return Object.freeze({
        admit,
        evaluate: (intent, authSession) => gate.evaluate(intent, authSession)
    });
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

module.exports = {
    createActionAuthorityRuntime,
    DECISION,
    GATE_REASONS,
    ALLOW_REASON
};
