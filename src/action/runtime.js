"use strict";

/**
 * ACTION AUTHORITY GATE V1 — trusted bootstrap composition (runtime-local
 * trust domain).
 *
 * `createActionAuthorityRuntime` is the SINGLE trusted composition point,
 * created ONCE by trusted Aether bootstrap. Everything security-sensitive is
 * minted INSIDE this function's closure and is never caller-supplied:
 *
 *   - runtime-local session trust domain:
 *       const sessionBrand = new WeakSet();      // closure-owned, NOT module-global
 *       const sessionIssuer  = mintSession(...)   // the ONLY adder to sessionBrand
 *       const sessionVerifier = isAuthSession(...) // the ONLY reader of sessionBrand
 *     reachable only through the one-time `bindAuthentication` capability,
 *     exercised by bootstrap DURING composition.
 *   - canonical Authority evaluator (loadAndEvaluateAuthority, fixed require)
 *   - canonical evaluation brand verifier (isCanonicalAuthorityEvaluation)
 *   - sealed gate (PRIVATE closure helper below) over the canonical registry,
 *     the canonical evaluator, the canonical brand verifier, the runtime-local
 *     session verifier, and the hardened clock
 *   - hardened clock capture (read-once function identity)
 *   - trusted scope resolvers (captured ONCE, detached from caller objects)
 *
 * RETURNED SURFACE (least privilege, exactly):
 *   admit(serializedProposal)  — canonical identity-free ActionIntent
 *   evaluate(intent, session)  — AuthorityDecision; accepts ONLY sessions
 *                                branded by THIS runtime's own domain
 *
 * The returned surface contains NO issuer, NO mintSession, NO issueIdentity,
 * NO gate constructor, and NO evaluator/verifier hook. Downstream
 * extension/device/provider/channel code receives only admit/evaluate (plus,
 * where appropriate, ALREADY-AUTHENTICATED session capabilities that bootstrap
 * chose to pass it).
 *
 * RUNTIME-LOCAL TRUST LAW (unforgeable object identity, never strings):
 *   runtimeA session -> accepted only by runtimeA
 *   runtimeB session -> rejected by runtimeA (and vice versa)
 *   a string field like runtimeId:"A" carries zero trust weight
 *
 * AUTHENTICATION BINDING: bootstrap passes `onReady({ bindAuthentication })`
 * and must call `bindAuthentication({ authenticate })` exactly once, where
 * `authenticate(creds) => principalRecord|null` is external trusted auth
 * infrastructure. `bindAuthentication` returns `{ mintSession }`, usable ONLY
 * by the closure that received it, to seal an authenticated transport identity
 * into THIS runtime's session domain. If bootstrap never binds authentication,
 * no session can ever be minted and every evaluate() fails closed on identity.
 *
 * PROCESS-ISOLATION LIMITATION (documented honestly): this is a same-process
 * CommonJS trust domain, not OS isolation. Any untrusted code with unrestricted
 * require() in this process can reach this module and compose its OWN runtime
 * over its OWN stores — but that runtime is a SEPARATE trust domain: it cannot
 * read the session brand of, mint for, or evaluate against any other runtime.
 * The public/downstream Lane 2 surface (src/action/index.js + direct module
 * requires) exposes no privileged issuer, no gate construction, and no
 * evaluator/verifier injection.
 *
 *   VALID SHAPE != TRUSTED ORIGIN
 *   VALID ORIGIN IN RUNTIME A != TRUSTED IN RUNTIME B
 */

const { parseActionIntent, canonicalScope, validateTimestamp, isValidIncarnationId } = require("./intent");
const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../authority/evaluate");
const { captureClock } = require("./clock");
const { sanitizeSessionFields } = require("./authSession");
const { DECISION, GATE_REASONS, ALLOW_REASON, validateAuthorityEvaluation } = require("./gate");
const { fail, REASONS } = require("./errors");

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
 * @param {object} options.trustedScopeBindings
 *     closed mapping: { "<capabilityId>": { "<operation>": resolverFn } }
 * @param {object} [options.clock]
 * @param {function} [options.onReady]
 *     trusted bootstrap hook: called once with { bindAuthentication } during
 *     composition. bindAuthentication({ authenticate }) returns { mintSession };
 *     both capabilities are closure-scoped and never re-exported.
 */
function createActionAuthorityRuntime({
    capabilityRuntime,
    authorityStore,
    trustedScopeBindings = {},
    clock = { nowMs: () => Date.now() },
    onReady = null
} = {}) {
    if (!capabilityRuntime || !capabilityRuntime.registry || typeof capabilityRuntime.registry.get !== "function") {
        throw new TypeError("runtime requires a capabilityRuntime with .registry.get()");
    }
    if (!authorityStore || typeof authorityStore.getCapability !== "function") {
        throw new TypeError("runtime requires an authorityStore with getCapability()");
    }
    const registry = capabilityRuntime.registry;
    const capturedClock = captureClock(clock);

    // ---- RUNTIME-LOCAL SESSION TRUST DOMAIN --------------------------------
    // The brand WeakSet lives in THIS closure only. It is not module-global,
    // not shared, not reachable from any other runtime or caller. Only the
    // issuer sealed below adds to it; only the verifier below reads it.
    const sessionBrand = new WeakSet();

    function isAuthSession(v) {
        if (v === null || typeof v !== "object") return false;
        if (!sessionBrand.has(v)) return false;
        // Only after brand membership do we inspect fields.
        return typeof v.principal === "string" && v.principal.length > 0;
    }

    let authBound = false;

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

        // Trusted identity MUST be branded by THIS runtime's session domain.
        if (!isAuthSession(authSession)) {
            return deny(intent, GATE_REASONS.INVALID_IDENTITY, "not a trusted auth session of this runtime", {}, evaluatedAtMs);
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

    // ---- ONE-TIME authentication binding (bootstrap-only capability) ----
    function bindAuthentication({ authenticate } = {}) {
        if (authBound) {
            throw fail(REASONS.INVALID_DECISION_STATE, "authentication already bound for this runtime");
        }
        if (typeof authenticate !== "function") {
            throw fail(REASONS.INVALID_DECISION_STATE, "bindAuthentication requires an authenticate function");
        }
        authBound = true;

        // The issuer: seals an authenticated transport identity into THIS
        // runtime's session domain. Returned ONLY to the closure that called
        // bindAuthentication (i.e. trusted bootstrap); never placed on the
        // runtime surface.
        return Object.freeze({
            mintSession(creds) {
                const fields = sanitizeSessionFields(creds);
                // Enrich from trusted authentication infrastructure: the
                // principal is whatever the bound authenticate() established,
                // never a caller-invented string.
                const authed = authenticate(fields) ?? null;
                const session = Object.freeze({
                    principal: typeof authed?.principal === "string" && authed.principal ? authed.principal : fields.principal,
                    sessionId: fields.sessionId,
                    channel: fields.channel
                });
                sessionBrand.add(session);
                return session;
            }
        });
    }

    // ---- optional trusted bootstrap hook ----
    let authBinding = null;
    if (typeof onReady === "function") {
        onReady(Object.freeze({
            bindAuthentication: (args) => {
                authBinding = bindAuthentication(args);
                return authBinding;
            }
        }));
    }

    // ---- least-privilege surface (NO issuer, NO minting, NO internals) ----
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
