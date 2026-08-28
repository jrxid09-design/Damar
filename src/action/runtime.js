"use strict";

/**
 * ACTION AUTHORITY GATE V1 — trusted composition root.
 *
 * `createActionAuthorityRuntime` is the SINGLE trusted composition point. It
 * constructs and binds, inside a trusted closure:
 *
 *   - trusted RuntimeIdentity issuer (mintRuntimeIdentity, closure-only brand)
 *   - trusted capability-bound scope resolvers (closed mapping, caller cannot
 *     inject a resolver)
 *   - canonical Authority read-only evaluator (loadAndEvaluateAuthority)
 *   - ActionIntent admission
 *   - ActionAuthorityGate
 *
 * and returns ONLY least-privilege surfaces. It does NOT expose raw trust
 * constructors, minting internals, or branding tokens. A caller cannot
 * manufacture authenticated identities, scope resolvers, canonical authority
 * contexts, or positive authority evaluation evidence from shape alone.
 *
 *   VALID SHAPE != TRUSTED ORIGIN
 */

const { parseActionIntent, canonicalScope, validateTimestamp, isValidIncarnationId } = require("./intent");
const { mintRuntimeIdentity, isRuntimeIdentityContext } = require("./runtimeIdentity");
const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../authority/evaluate");
const { captureClock } = require("./clock");
const { ActionAuthorityGate, DECISION, GATE_REASONS, ALLOW_REASON } = require("./gate");
const { fail, REASONS } = require("./errors");

/**
 * @param {object} options
 * @param {object} options.capabilityRuntime  Lane-1 `createCapabilityRuntime()` result
 *                                            (has .registry + .registrars)
 * @param {object} options.authorityStore     Authority store (read methods)
 * @param {object} options.trustedScopeBindings
 *     closed mapping: { "<capabilityId>": { "<operation>": resolverFn } }
 *     where resolverFn(args) -> string[] canonical scope tokens.
 * @param {object} [options.clock]            { nowMs }
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

    // Resolve the trusted, capability+operation-bound scope resolver (closed).
    function resolveScopeResolver(capabilityId, operation) {
        const capBindings = trustedScopeBindings[capabilityId];
        if (capBindings && typeof capBindings === "object") {
            const resolver = capBindings[operation];
            if (typeof resolver === "function") return resolver;
        }
        return null;
    }

    // ----- trusted runtime identity issuance (closure-bound) -----
    function issueIdentity({ principal, sessionId = null, channel = null } = {}) {
        return mintRuntimeIdentity({ principal, sessionId, channel });
    }

    // ----- trusted intent admission -----
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

        // Resolve canonical scope via the trusted bound resolver (fail closed).
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

    // ----- gate bound to the canonical evaluator (no injectable evaluate) -----
    const gate = new ActionAuthorityGate({
        capabilityRegistry: registry,
        authorityEvaluator: (request) => loadAndEvaluateAuthority(authorityStore, request, { nowMs: capturedClock.nowMs() }),
        isCanonicalEvaluation: isCanonicalAuthorityEvaluation,
        clock: capturedClock
    });

    // ----- least-privilege surface -----
    return Object.freeze({
        admit,
        issueIdentity,
        gate,
        verifyIdentity: isRuntimeIdentityContext,
        isCanonicalEvaluation: isCanonicalAuthorityEvaluation
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
