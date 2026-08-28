"use strict";

/**
 * ACTION AUTHORITY GATE V1 — runtime composition (fifth targeted repair,
 * Wave 4: caller-owned auth bootstrap REMOVED).
 *
 * `createActionAuthorityRuntime` is the SINGLE trusted composition point for
 * the EVALUATION runtime. It is created ONCE by trusted Aether bootstrap.
 * Everything security-sensitive lives OUTSIDE this constructor's options and
 * is never caller-supplied:
 *
 *   - AuthenticationDomain (src/action/authDomain.js), created SEPARATELY by
 *     trusted bootstrap, owns:
 *         authenticate(evidence)    -> AuthSessionCapability | null
 *         the runtime/session-domain brand (closure-local WeakSet)
 *         the ONLY session mint path (authenticate() success)
 *         verifier capability
 *     trusted bootstrap hands this runtime the ALREADY-BOUND
 *     `authVerifier` only — the runtime never receives any mint, issuer, or
 *     bootstrap callback.
 *   - canonical Authority evaluator (loadAndEvaluateAuthority, fixed require)
 *   - canonical evaluation brand verifier (isCanonicalAuthorityEvaluation)
 *   - sealed gate (PRIVATE closure helper below) over the canonical registry,
 *     the canonical evaluator, the canonical brand verifier, the domain
 *     verifier capability, and the hardened clock
 *   - hardened clock capture (read-once function identity)
 *   - trusted scope resolvers (captured ONCE, detached from caller objects)
 *
 * RETURNED SURFACE (least privilege, exactly):
 *   admit(serializedProposal)  — canonical identity-free ActionIntent
 *   evaluate(intent, session)  — AuthorityDecision; accepts ONLY sessions
 *                                proven by this runtime's AuthenticationDomain
 *
 * The returned surface contains NO issuer, NO mintSession, NO issueIdentity,
 * NO bindAuthentication, NO onReady, NO gate constructor, and NO
 * evaluator/verifier hook. Downstream extension/device/provider/channel code
 * receives only admit/evaluate (plus, where appropriate,
 * already-authenticated session capabilities that bootstrap chose to pass it).
 *
 * NO CALLER-OWNED AUTH BOOTSTRAP:
 *   This constructor used to accept `onReady({ bindAuthentication })` and hand
 *   the composer a session mint capability. That pattern violated the trust
 *   model: the caller that constructed the runtime could mint authenticated
 *   principals. That path is DELETED. The constructor now:
 *     - REQUIRES a pre-bound `authVerifier` from trusted bootstrap
 *     - REJECTS any caller-bootstrap option key (onReady, bindAuthentication,
 *       mintSession, issueIdentity, issuer, sessionIssuer, sessionBrand,
 *       authBrand, bootstrap, etc.) with CALLER_BOOTSTRAP_REJECTED
 *     - exposes no callback of any kind
 *
 * NO CALLER PRINCIPAL FALLBACK (fail-closed authentication):
 *   The identity used for an evaluation is taken ONLY from
 *   `authVerifier.verify(session)` — a brand-first, zero-trap check against
 *   the AuthenticationDomain's closure-local brand. If verification returns
 *   null, identity is INVALID_IDENTITY and evaluation fails closed. The
 *   runtime NEVER consults `session.principal`, `claimedPrincipal`,
 *   `requestedPrincipal`, or any caller-supplied identity string as an
 *   Authority identity. Requester identity claims are descriptive telemetry
 *   only and are never used by the gate for trust.
 *
 * RUNTIME-LOCAL TRUST LAW (unforgeable object identity, never strings):
 *   domainA session -> accepted only by the runtime composed over domainA
 *   domainB session -> rejected by runtime A (and vice versa)
 *   a string field like runtimeId:"A" carries zero trust weight
 *
 * PROCESS-ISOLATION LIMITATION (documented honestly): this is a same-process
 * CommonJS trust domain, not OS isolation. Any untrusted code with
 * unrestricted require() in this process can reach this module and compose
 * its OWN runtime over its OWN stores and its OWN AuthenticationDomain — but
 * that runtime is a SEPARATE trust domain: it cannot read the session brand
 * of, mint for, or evaluate against any other domain. The public/downstream
 * Lane 2 surface exposes no privileged issuer, no gate construction, no
 * evaluator/verifier injection, and NO caller-owned auth bootstrap.
 *
 *   VALID SHAPE != TRUSTED ORIGIN
 *   VALID ORIGIN IN DOMAIN A != TRUSTED IN DOMAIN B
 */

const { parseActionIntent, canonicalScope, validateTimestamp, isValidIncarnationId } = require("./intent");
const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../authority/evaluate");
const { captureClock } = require("./clock");
const { DECISION, GATE_REASONS, ALLOW_REASON, validateAuthorityEvaluation } = require("./gate");
const { fail, REASONS } = require("./errors");

// Any caller-supplied option key in this set is a caller-owned auth-bootstrap
// surface and is rejected at composition. The historical pattern
// (`onReady({ bindAuthentication }) => { mintSession }`) handed a mint
// capability to the very caller constructing the runtime — a trust-model
// violation. There must be NO such callback obtainable by a runtime caller.
const CALLER_BOOTSTRAP_KEYS = Object.freeze([
    "onReady",
    "bindAuthentication",
    "mintSession",
    "issueIdentity",
    "issueSession",
    "issuer",
    "sessionIssuer",
    "sessionBrand",
    "authBrand",
    "authBinder",
    "bootstrap",
    "createAuthSessionIssuer",
    "authSessionIssuer",
    "bootstrapCapability",
    "trustedBootstrap"
]);

function mapAuthorityReason(reasonCode) {
    if (reasonCode === "CAP_GENERATION_STALE") return GATE_REASONS.AUTHORITY_STATE_STALE;
    return GATE_REASONS.AUTHORITY_INSUFFICIENT;
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

/**
 * @param {object} options
 * @param {object} options.capabilityRuntime  Lane-1 `createCapabilityRuntime()` result
 * @param {object} options.authorityStore     Authority store (read methods)
 * @param {object} options.authVerifier
 *     ALREADY-BOUND verifier capability from trusted bootstrap's
 *     AuthenticationDomain. Must expose `verify(session) -> principalString|null`
 *     using a closure-local brand check (brand-first, zero-trap). The runtime
 *     never mints, never authenticates, and never receives any mint callback.
 * @param {object} options.trustedScopeBindings
 *     closed mapping: { "<capabilityId>": { "<operation>": resolverFn } }
 * @param {object} [options.clock]
 *     hardened clock (read-once function identity). Defaults to Date.now.
 *
 * @throws TypeError / ActionError(AUTH_VERIFIER_REQUIRED) if authVerifier is
 *     not a pre-bound verifier capability.
 * @throws ActionError(CALLER_BOOTSTRAP_REJECTED) if any caller-bootstrap
 *     option key (onReady, bindAuthentication, mintSession, issuer, ...) is
 *     present — there is NO caller-owned auth bootstrap path.
 */
function createActionAuthorityRuntime(options = {}) {
    const {
        capabilityRuntime,
        authorityStore,
        authVerifier,
        trustedScopeBindings = {},
        clock = { nowMs: () => Date.now() }
    } = options;

    if (!capabilityRuntime || !capabilityRuntime.registry || typeof capabilityRuntime.registry.get !== "function") {
        throw new TypeError("runtime requires a capabilityRuntime with .registry.get()");
    }
    if (!authorityStore || typeof authorityStore.getCapability !== "function") {
        throw new TypeError("runtime requires an authorityStore with getCapability()");
    }
    // Trust law: identity comes ONLY from a pre-bound AuthenticationDomain
    // verifier capability. The runtime itself must NOT mint, authenticate, or
    // receive any bootstrap callback. A missing or invalid authVerifier means
    // no session can ever be trusted and every evaluate() fails closed on
    // identity — but we also reject at composition so a misconfigured runtime
    // fails loudly rather than silently evaluating as if unauthenticated.
    if (!authVerifier || typeof authVerifier !== "object") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "runtime requires a pre-bound authVerifier capability");
    }
    if (typeof authVerifier.verify !== "function") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "authVerifier must expose verify(session)");
    }

    // REJECT every caller-owned auth-bootstrap surface. There must be NO
    // callback obtainable by a runtime caller that can mint authenticated
    // principals. Passing any of these keys is a trust-model violation.
    for (const key of CALLER_BOOTSTRAP_KEYS) {
        // eslint-disable-next-line no-undefined
        if (Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined) {
            throw fail(REASONS.CALLER_BOOTSTRAP_REJECTED,
                `caller-owned auth bootstrap option '${key}' is forbidden; authentication is established by trusted bootstrap outside the runtime constructor`);
        }
    }

    const registry = capabilityRuntime.registry;
    const capturedClock = captureClock(clock);
    // Capture the verifier FUNCTION IDENTITY exactly once (detached from the
    // caller object). The runtime consults only this captured function.
    const verifySession = authVerifier.verify;

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

    // ---- PRIVATE SEALED GATE (closure helper; NOT an importable constructor).
    // Built exactly once here, over closure-owned dependencies only. ----
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

    async function evaluateGate(intent, authSession) {
        if (!intent || typeof intent !== "object" ||
            typeof intent.intentId !== "string" ||
            typeof intent.capabilityId !== "string" ||
            typeof intent.operation !== "string") {
            throw fail(REASONS.INVALID_INTENT, "gate requires a canonical ActionIntent");
        }

        const evaluatedAtMs = capturedClock.nowMs();

        // Trusted identity MUST be proven by this runtime's AuthenticationDomain
        // via the pre-bound verifier. BRAND-FIRST: verify() checks brand
        // membership before any property access, so a hostile Proxy executes
        // zero traps on rejection. There is NO fallback to caller identity:
        // verify() returning null/undefined/false/malformed => INVALID_IDENTITY,
        // regardless of any principal string the session object may carry.
        const principal = verifySession(authSession);
        if (typeof principal !== "string" || principal.length === 0) {
            return deny(intent, GATE_REASONS.INVALID_IDENTITY, "not a trusted auth session of this runtime's AuthenticationDomain", {}, evaluatedAtMs);
        }

        const capabilityId = intent.capabilityId;
        const operation = intent.operation.trim().toLowerCase();
        const channel = (authSession && typeof authSession === "object" && typeof authSession.channel === "string")
            ? authSession.channel
            : "";
        const sessionId = (authSession && typeof authSession === "object" && typeof authSession.sessionId === "string")
            ? authSession.sessionId
            : "";

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
            authResult = await loadAndEvaluateAuthority(authorityStore, {
                capabilityId,
                action: operation,
                scope,
                purpose: intent.purpose ?? null,
                identity: { channel, sessionId, principal },
                nowMs: evaluatedAtMs
            }, { nowMs: evaluatedAtMs });
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

        if (!isCanonicalAuthorityEvaluation(authResult)) {
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

    // ---- least-privilege surface (NO issuer, NO minting, NO bootstrap
    // callback, NO internals) ----
    return Object.freeze({
        admit,
        evaluate: (intent, authSession) => evaluateGate(intent, authSession)
    });
}

module.exports = {
    createActionAuthorityRuntime,
    DECISION,
    GATE_REASONS,
    ALLOW_REASON
};
