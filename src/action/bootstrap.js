"use strict";

/**
 * ACTION AUTHORITY GATE V1 — CANONICAL TRUSTED BOOTSTRAP (SEVENTH targeted
 * repair, Wave 4 Lane 2: first-binder trust + caller authenticator + seeding
 * on the production facade REMOVED).
 *
 * This is the ONLY place where canonical authority composition happens.
 * It is NOT a public/downstream API and is NOT exported by src/action.
 *
 * CORE LAWS:
 *
 *   caller-selectable verifier != authenticated identity authority
 *   FIRST-BINDER-WINS TRUST IS NOT TRUST
 *   canonical authentication policy is bootstrap-owned, not
 *   runtime-constructor-owned
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW PRIVILEGED CONSTRUCTION IS BOOTSTRAP-PRIVATE (seventh repair)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The privileged composition functions — the action authority runtime factory
 * and the AuthenticationDomain factory — are defined INSIDE THIS MODULE'S
 * private closure (below). They are NOT exports of this module, NOT exports
 * of runtime.js/authDomain.js, and reachable through NO binder, NO token, NO
 * host capability, NO first-call-wins registry. Acquiring them requires
 * ALREADY executing inside this module's own closure — i.e. being the trusted
 * bootstrap itself.
 *
 * runtime.js and authDomain.js are now PURE NON-PRIVILEGED modules (inert
 * vocabularies + pure non-authorizing predicates only). There is NO
 * equivalent surface either: no bindHost / acquireHost / registerHost /
 * installHost / claimComposition / bootstrapBind / hostToken / getFactory /
 * getComposer exists on any action module export.
 *
 * The sixth repair's `bindCompositionHost` / `bindAuthenticationHost` (exported
 * privileged composition APIs with first-binder-wins semantics) are REMOVED.
 * A fresh-process attacker could acquire both privileged constructors before
 * the production bootstrap loaded; the later bootstrap failure was loud but
 * not sufficient. First-binder-wins trust is not trust.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BLOCKER 2 — CANONICAL AUTHENTICATION IS BOOTSTRAP-OWNED
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The production canonical runtime is created by `createCanonicalActionFacade()`
 * which takes NO options. It does NOT accept:
 *
 *   authenticate, authenticator, authenticationProvider, verifyCredentials,
 *   resolvePrincipal, authVerifier, verifier (or any equivalent caller-selected
 *   identity authority)
 *
 * The canonical AuthenticationDomain is bound internally to the FIXED
 * bootstrap-owned authentication adapter (`canonicalAuthAdapter` below): for
 * Lane 2 — where full production owner-auth infrastructure is not yet wired —
 * the adapter FAILS CLOSED unconditionally: no session is ever minted from
 * caller input, no caller-asserted principal is ever trusted. This means the
 * canonical runtime evaluates but every session is INVALID_IDENTITY until a
 * later lane wires the real trusted auth infrastructure INTO THIS MODULE
 * (not through any constructor option). Arbitrary caller input is never
 * silently treated as authenticated.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BLOCKER 3 — PRODUCTION FACADE IS EXACTLY LEAST PRIVILEGE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The production facade is EXACTLY:
 *
 *     Object.freeze({ admit, evaluate, authenticate, session })
 *
 * - admit(serializedProposal) -> canonical identity-free ActionIntent
 * - evaluate(intent, session) -> AuthorityDecision
 * - authenticate(evidence)    -> the FIXED canonical auth path (fail-closed
 *                               adapter); cannot mint a principal the trusted
 *                               infrastructure did not establish
 * - session(...)              -> convenience wrapper over authenticate();
 *                               with the fixed fail-closed adapter this can
 *                               never mint from caller input (it always
 *                               fails closed until real auth infra is wired)
 *
 * The production facade MUST NOT and DOES NOT expose: grantAuthority,
 * revokeAuthority, seedAuthority, registerCapability, unregisterCapability,
 * registry, registrars, AuthorityStore, CapabilityRuntime, capability
 * registrar, evaluator, verifier, AuthenticationDomain, mintSession,
 * issueIdentity, bootstrap hooks. Authority/capability seeding belongs to a
 * SEPARATE privileged bootstrap/provisioning interface — for tests that is
 * the explicitly test-only harness (tests/action/bootstrapHarness.js); for
 * production startup it will be a trusted provisioning capability in a later
 * lane. Downstream NEVER receives it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PROCESS / MODULE ISOLATION LIMITATION (documented honestly)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This is a same-process CommonJS trust domain, NOT OS isolation. Node/CommonJS
 * path hiding is NOT hard sandboxing against code that already has arbitrary
 * same-process filesystem/require execution. What Lane 2 enforces is that the
 * ordinary/downstream Action API exposes NO authority-composition primitive at
 * all: canonical bootstrap owns composition (in its private closure), downstream
 * receives least-privilege facades only. Untrusted executable extensions must
 * eventually require loader allowlisting, sandboxing, workers/process isolation,
 * or equivalent enforcement.
 *
 *   VALID SHAPE != TRUSTED ORIGIN
 *   VALID ORIGIN IN DOMAIN A != TRUSTED IN DOMAIN B
 */

const { createCapabilityRuntime } = require("../capability/registry");
const { createMemoryAuthorityStore } = require("../authority/store");
const { fail, REASONS } = require("./errors");
const { extractAuthenticatedPrincipal } = require("./authDomain");
const { AUTH_TELEMETRY_KEYS } = require("./authSession");
const {
    parseActionIntent, canonicalScope, validateTimestamp, isValidIncarnationId
} = require("./intent");
const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../authority/evaluate");
const { captureClock } = require("./clock");
const { DECISION, GATE_REASONS, ALLOW_REASON, validateAuthorityEvaluation } = require("./gate");

// ---------------------------------------------------------------------------
// PRIVILEGED COMPOSITION — PRIVATE CLOSURE (seventh repair).
// Both factories are defined HERE, inside the trusted bootstrap module's
// closure. They are never exported, never token-gated, never binder-gated.
// ---------------------------------------------------------------------------

const MAX_TELEMETRY_CHARS = 128;
const MAX_SESSIONS_PER_DOMAIN = 4096;

function cleanToken(v, field, maxChars) {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") {
        throw fail(REASONS.INVALID_INTENT, `auth '${field}' must be a string, got ${typeof v}`);
    }
    const s = v.trim();
    if (s.length > maxChars) {
        throw fail(REASONS.BOUND_EXCEEDED, `auth '${field}' exceeds ${maxChars} chars`);
    }
    return s;
}

/** Any caller-bootstrap option key reaching the internal factories is rejected
 *  (defense in depth; the factories' only callers are this closure and the
 *  test-only harness's own private mirror). */
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
 * PRIVILEGED (bootstrap-private) — compose one AuthenticationDomain over a
 * trusted authenticate() hook. The resulting domain's closure owns the
 * session brand, the ONLY mint path, and the verifier capability.
 *
 * @param {function} authenticate
 *     Trusted authentication infrastructure owned by the caller of this
 *     function (production: the fixed fail-closed canonical adapter; tests:
 *     the test-only harness's controlled authenticator).
 * @param {object} clock  hardened clock capture (read-once identity)
 * @returns {object} frozen { authenticate, verifier }
 */
function composeAuthenticationDomain({ authenticate, clock = { nowMs: () => Date.now() } } = {}) {
    if (typeof authenticate !== "function") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "AuthenticationDomain requires trusted authenticate infrastructure");
    }
    if (!clock || typeof clock.nowMs !== "function") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "AuthenticationDomain requires a hardened clock");
    }
    let capturedClock = null;
    try { capturedClock = clock.nowMs(); } catch { capturedClock = null; }
    if (typeof capturedClock !== "number" || !Number.isFinite(capturedClock)) {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "AuthenticationDomain clock must produce a finite number");
    }

    // ---- DOMAIN-LOCAL SESSION BRAND ----------------------------------------
    // The brand WeakSet lives in THIS closure only. It is not module-global,
    // not exported, not reachable from any other domain or caller. The ONLY
    // adder is the authenticated mint path below; the ONLY reader is the
    // verifier capability.
    const sessionBrand = new WeakSet();
    let sessionCount = 0;

    /**
     * THE ONLY MINT PATH. Internal to this closure; reachable ONLY through
     * authenticate() after a positive authentication result. It accepts no
     * caller-invented principal: the principal comes exclusively from
     * `authenticate(...)`'s own trusted return value.
     */
    function mintAuthenticatedSession(authResult, evidence) {
        const principal = extractAuthenticatedPrincipal(authResult);

        // Descriptive telemetry ONLY — never used as Authority identity.
        const claimed = evidence && typeof evidence === "object"
            ? cleanToken(evidence[AUTH_TELEMETRY_KEYS.claimedPrincipal], AUTH_TELEMETRY_KEYS.claimedPrincipal, MAX_TELEMETRY_CHARS)
            : "";
        const channel = evidence && typeof evidence === "object"
            ? cleanToken(evidence.channel, "channel", 64)
            : "";

        if (sessionCount >= MAX_SESSIONS_PER_DOMAIN) {
            throw fail(REASONS.BOUND_EXCEEDED, `session domain bound exceeded (${MAX_SESSIONS_PER_DOMAIN})`);
        }
        const sessionId = cleanToken(
            evidence && typeof evidence === "object" ? evidence.sessionId : null,
            "sessionId", 64
        ) || `sess-${principal}-${capturedClock !== null ? capturedClock : sessionCount}-${sessionCount}`;
        const session = Object.freeze({
            principal,
            sessionId,
            channel,
            claimedPrincipal: claimed
        });
        sessionBrand.add(session);
        sessionCount++;
        return session;
    }

    /**
     * authenticate(evidence) — the domain's single public identity surface.
     * Resolves external evidence through the trusted authenticate()
     * infrastructure bound by bootstrap. On ANY failure (throw, null,
     * undefined, malformed, missing principal) returns null — fail closed,
     * nothing minted, no caller identity fallback. The returned session (if
     * any) is branded to THIS domain and carries the principal that trusted
     * authentication established — nothing else.
     */
    function authenticateEvidence(evidence) {
        let authResult;
        try {
            authResult = authenticate(evidence);
        } catch {
            return null; // fail closed; authentication errors never mint
        }
        if (authResult === null || authResult === undefined) {
            return null; // fail closed
        }
        try {
            return mintAuthenticatedSession(authResult, evidence);
        } catch {
            return null; // malformed authentication result => fail closed
        }
    }

    /**
     * VERIFIER CAPABILITY — the ONLY thing the action authority runtime
     * receives. Brand-first (zero property access before membership check =>
     * zero Proxy traps on rejection). Returns the authenticated principal
     * string for a session branded by THIS domain, or null for anything else.
     */
    function verifySession(sessionObj) {
        if (sessionObj === null || typeof sessionObj !== "object") return null;
        if (!sessionBrand.has(sessionObj)) return null;
        const p = sessionObj.principal;
        return (typeof p === "string" && p.length > 0) ? p : null;
    }

    return Object.freeze({
        authenticate: authenticateEvidence,
        verifier: Object.freeze({
            verify: verifySession
        })
    });
}

/**
 * PRIVILEGED (bootstrap-private) — compose an action authority evaluation
 * runtime over canonical state. Destructures its inputs ONCE into
 * closure-owned state and returns the frozen least-privilege surface
 * { admit, evaluate }.
 *
 * NO issuer, NO mintSession, NO bindAuthentication, NO onReady, NO gate
 * constructor, NO evaluator/verifier hook on the returned surface.
 *
 * NO CALLER PRINCIPAL FALLBACK: identity comes ONLY from the pre-bound
 * verifier's brand-first check.
 *
 * RUNTIME-LOCAL TRUST LAW: domainA session -> accepted only by the runtime
 * composed over domainA; domainB session -> rejected by runtime A (and vice
 * versa); string fields carry zero trust weight.
 */
function composeActionAuthorityRuntime({
    capabilityRuntime,
    authorityStore,
    authVerifier,
    trustedScopeBindings = {},
    clock = { nowMs: () => Date.now() }
} = {}) {
    if (!capabilityRuntime || !capabilityRuntime.registry || typeof capabilityRuntime.registry.get !== "function") {
        throw new TypeError("runtime requires a capabilityRuntime with .registry.get()");
    }
    if (!authorityStore || typeof authorityStore.getCapability !== "function") {
        throw new TypeError("runtime requires an authorityStore with getCapability()");
    }
    // Trust law: identity comes ONLY from a pre-bound AuthenticationDomain
    // verifier capability. A missing or invalid authVerifier means no session
    // can ever be trusted — reject at composition so a misconfigured runtime
    // fails loudly rather than silently evaluating as if unauthenticated.
    if (!authVerifier || typeof authVerifier !== "object") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "runtime requires a pre-bound authVerifier capability");
    }
    if (typeof authVerifier.verify !== "function") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "authVerifier must expose verify(session)");
    }

    // REJECT every caller-owned auth-bootstrap surface (defense in depth; the
    // only caller of this function is this module's own closure).
    const opts = arguments[0] ?? {};
    for (const key of CALLER_BOOTSTRAP_KEYS) {
        // eslint-disable-next-line no-undefined
        if (Object.prototype.hasOwnProperty.call(opts, key) && opts[key] !== undefined) {
            throw fail(REASONS.CALLER_BOOTSTRAP_REJECTED,
                `caller-owned auth bootstrap option '${key}' is forbidden; authentication is established by trusted bootstrap`);
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
        // zero traps on rejection. There is NO fallback to caller identity.
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

// ---------------------------------------------------------------------------
// FIXED BOOTSTRAP-OWNED CANONICAL AUTHENTICATION ADAPTER (Blocker 2).
// ---------------------------------------------------------------------------

/**
 * Canonical authentication policy is bootstrap-owned, NOT runtime-constructor-
 * owned. For Lane 2 the adapter FAILS CLOSED unconditionally: production
 * owner-auth infrastructure (token-guarded transport etc.) is not wired yet,
 * and rather than silently treating arbitrary caller input as authenticated,
 * the canonical runtime authenticates NOBODY until a later lane wires real
 * trusted auth infrastructure INTO THIS MODULE (never via a constructor
 * option). Every authenticate() => null; every evaluate() on a session is
 * INVALID_IDENTITY fail-closed.
 */
function canonicalAuthAdapter(evidence) {
    void evidence;
    return null;
}

// Any caller-supplied option key in this set is a privileged composition or
// caller-selected-identity primitive and is rejected at bootstrap.
const PRIVILEGED_KEYS = Object.freeze([
    "authenticate",
    "authenticator",
    "authenticationProvider",
    "verifyCredentials",
    "resolvePrincipal",
    "authVerifier",
    "verifier",
    "capabilityRuntime",
    "authorityStore",
    "authDomain",
    "domain",
    "authenticationDomain",
    "sessionBrand",
    "authBrand",
    "brand",
    "evaluator",
    "authorityEvaluator",
    "isCanonicalEvaluation",
    "verifySession",
    "evaluateSession",
    "gate",
    "createGate",
    "registry",
    "capabilityRegistry",
    "store",
    "onReady",
    "bindAuthentication",
    "mintSession",
    "issueIdentity",
    "issueSession",
    "issuer",
    "sessionIssuer",
    "authBinder",
    "bootstrap",
    "bootstrapCapability",
    "trustedBootstrap",
    "createAuthSessionIssuer",
    "authSessionIssuer",
    "clock",
    "trustedScopeBindings",
    "capabilityRuntimeOptions",
    "maxCapabilities",
    "registrars"
]);

// The ONE canonical runtime, created exactly once, lazily, on first use.
let canonical = null;

/**
 * Create the canonical production Action facade. Takes NO options — canonical
 * authentication policy is bootstrap-owned and the fixed fail-closed adapter
 * is bound internally.
 *
 * @returns {object} frozen least-privilege facade, EXACTLY:
 *     { admit, evaluate, authenticate, session }
 */
function createCanonicalActionFacade() {
    if (arguments[0] !== undefined) {
        throw fail(REASONS.CALLER_BOOTSTRAP_REJECTED,
            "canonical runtime creation accepts NO options; canonical state, the AuthenticationDomain, the authentication adapter, and the verifier are bootstrap-owned");
    }

    if (canonical === null) {
        // ---- canonical state is constructed INSIDE this closure. No caller
        //      can substitute a capabilityRuntime, authorityStore, authDomain,
        //      verifier, or authentication adapter. ----
        const capabilityRuntime = createCapabilityRuntime({ registrars: { core: true } });
        const authorityStore = createMemoryAuthorityStore();
        const authDomain = composeAuthenticationDomain({
            authenticate: canonicalAuthAdapter,
            clock: { nowMs: () => Date.now() }
        });

        // ---- INTERNAL composition only. The verifier is captured inside this
        //      closure; it is never handed to a caller. ----
        const rt = composeActionAuthorityRuntime({
            capabilityRuntime,
            authorityStore,
            authVerifier: authDomain.verifier,
            trustedScopeBindings: {},
            clock: { nowMs: () => Date.now() }
        });

        function session() {
            // With the fixed fail-closed canonical auth adapter this can never
            // mint from caller input; it always fails closed.
            const s = authDomain.authenticate({});
            if (!s) throw fail(REASONS.AUTH_FAILED, "canonical authentication failed closed; no session minted");
            return s;
        }

        canonical = Object.freeze({
            // canonical runtime surface (least privilege)
            admit: rt.admit,
            evaluate: rt.evaluate,

            // FIXED canonical authenticated-mint path (fail-closed adapter)
            authenticate: authDomain.authenticate,
            session
        });
    }
    return canonical;
}

// ---------------------------------------------------------------------------
// LANE 3 — CANONICAL ACTUATION COMPOSITION (FIRST targeted repair: ALL
// privileged actuation implementation lives in THIS private lexical closure).
//
// The actuation submodules (actuatorRegistry.js / dispatcher.js /
// executionRequest.js / result.js / lifecycle.js) are now PURE NON-PRIVILEGED
// vocabulary modules. The privileged constructors — buildActuatorRegistry,
// composeDispatcher, formExecutionRequest, createLifecycleTracker,
// buildExecutionResult, buildExecutionEvidence, sanitizeActuatorOutput — are
// defined HERE, inside this module's own lexical scope, exactly like Lane 2's
// composeActionAuthorityRuntime / composeAuthenticationDomain. They are
// reachable through NO binder, NO token, NO host capability, NO first-call-
// wins registry: acquiring them requires ALREADY executing inside this
// closure. A direct import of any actuation submodule yields only inert
// vocabulary + pure predicates.
//
// CANONICAL BRANDS (FIRST targeted repair): the request/result brand WeakSets
// are declared HERE (closure-private). Brand membership is established ONLY
// by the private formers below. No export of ANY module exposes the WeakSets,
// the brand tokens, or any mutation surface. Downstream can ASK (via the pure
// recognition predicates in actuation/index.js); downstream cannot CAUSE.
//
// Downstream NEVER receives the registrar: it receives only the frozen
// { execute } capability. Fresh canonical Lane 2 revalidation happens INSIDE
// execute() — there is no bearer-decision path and no caller-selectable
// actuator.
//
// LANE 2 SEMANTICS UNCHANGED: this extension adds composition only; the
// certified Lane 2 evaluate/admit surface is consumed, never modified.
// ---------------------------------------------------------------------------

const crypto3 = require("node:crypto");
const {
    parseActionIntent: parseIntent3, canonicalScope: canonicalScope3,
    validateTimestamp: validateTimestamp3, isValidIncarnationId: isValidIncarnation3
} = require("./intent");
const { DECISION: DECISION3 } = require("./gate");
const { LIFECYCLE: LIFECYCLE3, RESULT_STATE: RESULT_STATE3, REASONS: REASONS3, fail: fail3 } = require("./actuation/errors");
const { TRANSITIONS: TRANSITIONS3 } = require("./actuation/lifecycle");
const {
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT3, MAX_TIMEOUT_MS: MAX_TIMEOUT3,
    MIN_TIMEOUT_MS: MIN_TIMEOUT3, CALLER_EXECUTOR_KEYS: CALLER_EXECUTOR_KEYS3,
    BEARER_DECISION_KEYS: BEARER_DECISION_KEYS3
} = require("./actuation/dispatcher");
const {
    REQUEST_SCHEMA_VERSION: REQUEST_SCHEMA3, BOUNDS: REQUEST_BOUNDS3
} = require("./actuation/executionRequest");
const { READINESS: READINESS3 } = require("./actuation/actuatorRegistry");

// ---- CANONICAL BRANDS (closure-private; FIRST targeted repair) -------------
const REQUEST_BRAND3 = Symbol("damar.action.actuation.request.brand");
const RESULT_BRAND3 = Symbol("damar.action.actuation.result.brand");
const requestBrandSet3 = new WeakSet();
const resultBrandSet3 = new WeakSet();

function deepFreeze3(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze3(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

const ACTUATION_DANGEROUS_KEYS3 = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));
const ACTUATION_AUTHORITY_TOKENS3 = Object.freeze(new Set([
    "authority", "authorized", "authorization", "authorisation",
    "permission", "permissions", "approved", "approval", "approve",
    "ownerapproved", "owner", "admin", "administrator", "root", "superuser",
    "grant", "granted", "trusted", "trust", "privilege", "privileged",
    "role", "roles", "canexecute", "allowed", "allow"
]));

function actuationIsPlainObject3(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function actuationDetach3(value, state) {
    state.nodes++;
    if (state.nodes > state.maxNodes) {
        throw fail3(REASONS3.BOUND_EXCEEDED, `payload exceeds node budget (${state.maxNodes})`);
    }
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "boolean") return value;
    if (t === "number") {
        if (!Number.isFinite(value)) throw fail3(REASONS3.MALFORMED_PAYLOAD, "numbers must be finite");
        return value;
    }
    if (t === "function") throw fail3(REASONS3.FUNCTION_VALUE, "function values are not permitted");
    if (t === "symbol" || t === "bigint" || t === "undefined") {
        throw fail3(REASONS3.SYMBOL_VALUE, `${t} values are not permitted`);
    }
    if (Array.isArray(value)) {
        if (state.path.has(value)) throw fail3(REASONS3.CYCLIC_INPUT, "cyclic structure is not permitted");
        if (value.length > REQUEST_BOUNDS3.GLOBAL_MAX_ARRAY_LENGTH) {
            throw fail3(REASONS3.BOUND_EXCEEDED, "array length exceeds global bound");
        }
        state.path.add(value);
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = actuationDetach3(value[i], state);
        state.path.delete(value);
        return out;
    }
    if (!actuationIsPlainObject3(value)) {
        throw fail3(REASONS3.NON_PLAIN_OBJECT, "non-plain object is not permitted");
    }
    if (state.path.has(value)) throw fail3(REASONS3.CYCLIC_INPUT, "cyclic structure is not permitted");
    state.path.add(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        if (ACTUATION_DANGEROUS_KEYS3.has(key)) throw fail3(REASONS3.DANGEROUS_KEY, `dangerous key '${key}' in payload`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) {
            throw fail3(REASONS3.ACCESSOR_PROPERTY, `accessor property '${key}' is not permitted`);
        }
        out[key] = actuationDetach3(desc.value, state);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw fail3(REASONS3.SYMBOL_VALUE, "symbol keys are not permitted");
    }
    state.path.delete(value);
    return out;
}

function actuationAssertNoAuthorityKeys3(node) {
    if (node === null || typeof node !== "object") return;
    for (const key of Object.getOwnPropertyNames(node)) {
        if (ACTUATION_AUTHORITY_TOKENS3.has(key.toLowerCase())) {
            throw fail3(REASONS3.MALFORMED_REQUEST, `authority-shaped key '${key}' is forbidden in execution request metadata`);
        }
        const v = node[key];
        if (v !== null && typeof v === "object") actuationAssertNoAuthorityKeys3(v);
    }
}

function actuationRequireString3(value, field, maxChars, { optional = false, allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
        if (optional) return "";
        throw fail3(REASONS3.MALFORMED_REQUEST, `${field} is required`);
    }
    if (typeof value !== "string") {
        throw fail3(REASONS3.MALFORMED_REQUEST, `${field} must be a string, got ${typeof value}`);
    }
    const s = value.trim();
    if (!optional && !allowEmpty && s.length === 0) {
        throw fail3(REASONS3.MALFORMED_REQUEST, `${field} must not be empty`);
    }
    if (s.length > maxChars) {
        throw fail3(REASONS3.BOUND_EXCEEDED, `${field} exceeds ${maxChars} chars`);
    }
    return s;
}

function actuationRequireSafeInteger3(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw fail3(REASONS3.MALFORMED_REQUEST, `${field} must be a nonnegative safe integer`);
    }
    return value;
}

// ---- PRIVILEGED: canonical ExecutionRequest former (closure-private) ------
function formExecutionRequest3(ctx) {
    if (ctx === null || typeof ctx !== "object") {
        throw fail3(REASONS3.MALFORMED_REQUEST, "execution request context must be a plain object");
    }

    const intentId = actuationRequireString3(ctx.intentId, "intentId", REQUEST_BOUNDS3.MAX_INTENT_ID_CHARS);
    const capabilityId = actuationRequireString3(ctx.capabilityId, "capabilityId", REQUEST_BOUNDS3.MAX_CAPABILITY_ID_CHARS);
    const capabilityIncarnationId = actuationRequireString3(ctx.capabilityIncarnationId, "capabilityIncarnationId", REQUEST_BOUNDS3.MAX_INTENT_ID_CHARS);
    if (!isValidIncarnation3(capabilityIncarnationId)) {
        throw fail3(REASONS3.MALFORMED_REQUEST, "capabilityIncarnationId is not a valid canonical incarnation id");
    }
    const operation = actuationRequireString3(ctx.operation, "operation", REQUEST_BOUNDS3.MAX_OPERATION_CHARS);
    const principal = actuationRequireString3(ctx.principal, "principal", REQUEST_BOUNDS3.MAX_PRINCIPAL_CHARS);
    if (!Array.isArray(ctx.scope)) {
        throw fail3(REASONS3.MALFORMED_REQUEST, "scope must be an array of canonical tokens");
    }
    const scope = canonicalScope3(ctx.scope);
    const authorityGeneration = actuationRequireSafeInteger3(ctx.authorityGeneration, "authorityGeneration");
    const admittedAtMs = actuationRequireSafeInteger3(ctx.admittedAtMs, "admittedAtMs");
    const requestedAtMs = actuationRequireSafeInteger3(ctx.requestedAtMs, "requestedAtMs");
    if (requestedAtMs < admittedAtMs) {
        throw fail3(REASONS3.MALFORMED_REQUEST, "requestedAtMs must be >= admittedAtMs");
    }

    const parametersState = { nodes: 0, maxNodes: REQUEST_BOUNDS3.MAX_METADATA_NODES, path: new Set() };
    const parameters = (ctx.parameters === undefined || ctx.parameters === null)
        ? deepFreeze3({})
        : deepFreeze3(actuationDetach3(ctx.parameters, parametersState));
    if (Object.getOwnPropertyNames(parameters).length > REQUEST_BOUNDS3.MAX_PARAMETERS_KEYS) {
        throw fail3(REASONS3.BOUND_EXCEEDED, `parameters exceeds ${REQUEST_BOUNDS3.MAX_PARAMETERS_KEYS} keys`);
    }

    const metadataState = { nodes: 0, maxNodes: REQUEST_BOUNDS3.MAX_METADATA_NODES, path: new Set() };
    const metadata = (ctx.metadata === undefined || ctx.metadata === null)
        ? deepFreeze3({})
        : deepFreeze3(actuationDetach3(ctx.metadata, metadataState));
    actuationAssertNoAuthorityKeys3(metadata);

    const executionId = crypto3.randomUUID();

    const request = deepFreeze3({
        schemaVersion: REQUEST_SCHEMA3,
        executionId,
        intentId,
        capabilityId,
        capabilityIncarnationId,
        operation,
        principal,
        scope,
        authorityGeneration,
        admittedAtMs,
        requestedAtMs,
        parameters,
        metadata
    });
    requestBrandSet3.add(request);
    return request;
}

// ---- PRIVILEGED: lifecycle tracker (closure-private) -----------------------
function createLifecycleTracker3(initialState = LIFECYCLE3.CREATED) {
    if (!TRANSITIONS3.has(initialState)) {
        throw fail3(REASONS3.MALFORMED_REQUEST, `invalid initial lifecycle state '${initialState}'`);
    }
    let state = initialState;
    const entries = [{ state, atMs: null }];
    let frozenTrace = Object.freeze(entries.map((e) => Object.freeze({ ...e })));

    return Object.freeze({
        get state() { return state; },
        get trace() { return frozenTrace; },
        isTerminal() {
            return TRANSITIONS3.get(state).size === 0;
        },
        canCancel() {
            return state === LIFECYCLE3.CREATED || state === LIFECYCLE3.REVALIDATING || state === LIFECYCLE3.READY;
        },
        advance(next, atMs) {
            const allowed = TRANSITIONS3.get(state);
            if (!allowed || !allowed.has(next)) {
                throw fail3(REASONS3.MALFORMED_REQUEST, `illegal lifecycle transition ${state} -> ${next}`);
            }
            if (typeof atMs !== "number" || !Number.isSafeInteger(atMs) || atMs < 0) {
                throw fail3(REASONS3.MALFORMED_REQUEST, "lifecycle timestamp must be a nonnegative safe integer");
            }
            state = next;
            entries.push({ state: next, atMs });
            frozenTrace = Object.freeze(entries.map((e) => Object.freeze({ ...e })));
            return state;
        }
    });
}

// ---- PRIVILEGED: hostile-output sanitizer (closure-private) ----------------
const RESULT_STRING_CHARS3 = 1024;
const RESULT_KEYS3 = 64;
const RESULT_DEPTH3 = 8;
const RESULT_NODES3 = 512;

function sanitizeActuatorOutput3(value) {
    const state = { nodes: 0, path: new Set() };
    function walk(v, depth) {
        state.nodes++;
        if (state.nodes > RESULT_NODES3) throw fail3(REASONS3.ACTUATOR_MALFORMED_RESULT, "actuator output exceeds node budget");
        if (depth > RESULT_DEPTH3) throw fail3(REASONS3.ACTUATOR_MALFORMED_RESULT, "actuator output exceeds depth bound");
        if (v === null) return null;
        const t = typeof v;
        if (t === "string") return v.length > RESULT_STRING_CHARS3 ? v.slice(0, RESULT_STRING_CHARS3) : v;
        if (t === "boolean") return v;
        if (t === "number") return Number.isFinite(v) ? v : null;
        if (t === "bigint" || t === "symbol" || t === "undefined" || t === "function") return null;
        if (v instanceof Error) {
            return { name: String(v.name ?? "Error").slice(0, 64), message: String(v.message ?? "").slice(0, RESULT_STRING_CHARS3) };
        }
        if (!actuationIsPlainObject3(v) && !Array.isArray(v)) return null;
        if (state.path.has(v)) return null;
        state.path.add(v);
        if (Array.isArray(v)) {
            const out = v.slice(0, 256).map((x) => walk(x, depth + 1));
            state.path.delete(v);
            return out;
        }
        const out = {};
        let keys = 0;
        for (const key of Object.getOwnPropertyNames(v)) {
            if (keys >= RESULT_KEYS3) break;
            keys++;
            const desc = Object.getOwnPropertyDescriptor(v, key);
            if (!desc || desc.get || desc.set) continue;
            const kk = key.length > 128 ? key.slice(0, 128) : key;
            out[kk] = walk(desc.value, depth + 1);
        }
        state.path.delete(v);
        return out;
    }
    return walk(value, 0);
}

// ---- PRIVILEGED: result/evidence builders (closure-private) ----------------
function buildExecutionResult3({
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
        throw fail3(REASONS3.MALFORMED_REQUEST, "buildExecutionResult requires a canonical ExecutionRequest");
    }
    if (!RESULT_STATE3[state]) {
        throw fail3(REASONS3.MALFORMED_REQUEST, `invalid result state '${state}'`);
    }
    if (state === RESULT_STATE3.EXECUTED && failureReason) {
        throw fail3(REASONS3.MALFORMED_REQUEST, "EXECUTED result must not carry a failure reason");
    }
    if (state !== RESULT_STATE3.EXECUTED && !failureReason) {
        throw fail3(REASONS3.MALFORMED_REQUEST, `non-EXECUTED result '${state}' must carry a failure reason`);
    }
    actuationRequireSafeInteger3(startedAtMs, "startedAtMs");
    actuationRequireSafeInteger3(completedAtMs, "completedAtMs");
    if (completedAtMs < startedAtMs) {
        throw fail3(REASONS3.MALFORMED_REQUEST, "completedAtMs must be >= startedAtMs");
    }

    const report = actuatorReport === null || actuatorReport === undefined
        ? null
        : deepFreeze3(sanitizeActuatorOutput3(actuatorReport));

    const result = deepFreeze3({
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
        failureDetail: failureDetail ? String(failureDetail).slice(0, RESULT_STRING_CHARS3) : "",
        authorityGeneration: executionRequest.authorityGeneration,
        lifecycleTrace,
        // Explicit non-claims (Lane 3 does not verify; Lane 4 owns that):
        verified: null,
        verificationClaim: null
    });
    resultBrandSet3.add(result);
    return result;
}

function buildExecutionEvidence3({ executionRequest, result, revalidation }) {
    if (!result || typeof result !== "object") {
        throw fail3(REASONS3.MALFORMED_REQUEST, "buildExecutionEvidence requires a structured result");
    }
    return deepFreeze3({
        schemaVersion: 1,
        kind: "action.actuation.execution",
        executionId: result.executionId,
        intentId: result.intentId,
        principal: result.principal,
        capabilityId: result.capabilityId,
        operation: result.operation,
        scope: executionRequest.scope,
        capabilityIncarnationId: result.capabilityIncarnationId,
        actuatorId: result.actuatorId,
        actuatorIncarnationId: result.actuatorIncarnationId,
        authorityGeneration: revalidation.authorityGeneration,
        revalidatedAtMs: revalidation.revalidatedAtMs,
        startedAtMs: result.startedAtMs,
        completedAtMs: result.completedAtMs,
        state: result.state,
        failureReason: result.failureReason,
        lifecycleTrace: result.lifecycleTrace,
        verified: null
    });
}

// ---- PRIVILEGED: actuator registry (closure-private) -----------------------
function buildActuatorRegistry3() {
    const byId = new Map();
    const byCap = new Map();

    function canonicalOp3(op) {
        return String(op ?? "").trim().toLowerCase();
    }

    function register({ capabilityId, operations, capabilityIncarnationId, actuatorId, invoke, readiness = "READY" }) {
        if (typeof capabilityId !== "string" || capabilityId.length === 0) {
            throw fail3(REASONS3.REGISTRATION_REJECTED, "actuator registration requires a non-empty capabilityId");
        }
        if (!Array.isArray(operations) || operations.length === 0) {
            throw fail3(REASONS3.REGISTRATION_REJECTED, "actuator registration requires a non-empty operations array");
        }
        const ops = operations.map(canonicalOp3).filter((s) => s.length > 0);
        if (ops.length === 0) {
            throw fail3(REASONS3.REGISTRATION_REJECTED, "actuator registration requires a non-empty operations array");
        }
        if (typeof capabilityIncarnationId !== "string" || capabilityIncarnationId.length === 0) {
            throw fail3(REASONS3.REGISTRATION_REJECTED, "actuator registration requires a capabilityIncarnationId");
        }
        if (typeof invoke !== "function") {
            throw fail3(REASONS3.REGISTRATION_REJECTED, "actuator registration requires an invoke function");
        }
        if (!READINESS3[readiness]) {
            throw fail3(REASONS3.REGISTRATION_REJECTED, `invalid readiness '${readiness}'`);
        }

        const id = (typeof actuatorId === "string" && actuatorId.length > 0)
            ? actuatorId
            : `act-${crypto3.randomUUID()}`;
        const actuatorIncarnationId = `ainc-${crypto3.randomUUID()}`;

        if (byId.has(id)) {
            throw fail3(REASONS3.REGISTRATION_REJECTED, `actuator '${id}' is already registered; remove it first`);
        }

        const invokeFn = invoke.bind({});
        const binding = Object.freeze({
            capabilityId,
            operations: Object.freeze(ops.slice()),
            capabilityIncarnationId,
            actuatorId: id,
            actuatorIncarnationId,
            readiness,
            invoke: invokeFn
        });

        byId.set(id, binding);
        let opMap = byCap.get(capabilityId);
        if (!opMap) { opMap = new Map(); byCap.set(capabilityId, opMap); }
        for (const op of ops) {
            if (opMap.has(op)) {
                byId.delete(id);
                throw fail3(REASONS3.REGISTRATION_REJECTED, `actuator already registered for '${capabilityId}.${op}'`);
            }
            opMap.set(op, binding);
        }
        return binding;
    }

    function remove(actuatorId) {
        const binding = byId.get(actuatorId);
        if (!binding) return false;
        byId.delete(actuatorId);
        const opMap = byCap.get(binding.capabilityId);
        if (opMap) {
            for (const op of binding.operations) {
                const cur = opMap.get(op);
                if (cur && cur.actuatorId === actuatorId) opMap.delete(op);
            }
            if (opMap.size === 0) byCap.delete(binding.capabilityId);
        }
        return true;
    }

    function resolve(capabilityId, operation) {
        const opMap = byCap.get(capabilityId);
        if (!opMap) return null;
        return opMap.get(canonicalOp3(operation)) ?? null;
    }

    function get(actuatorId) {
        return byId.get(actuatorId) ?? null;
    }

    return Object.freeze({ register, remove, resolve, get });
}

// ---- PRIVILEGED: dispatcher (closure-private) ------------------------------
function composeDispatcher3({
    lane2Facade,
    actuatorRegistry,
    clock = { nowMs: () => Date.now() },
    timeoutMs = DEFAULT_TIMEOUT3
} = {}) {
    if (!lane2Facade || typeof lane2Facade.admit !== "function" || typeof lane2Facade.evaluate !== "function") {
        throw fail3(REASONS3.MALFORMED_REQUEST, "dispatcher requires the Lane 2 facade (admit + evaluate)");
    }
    if (!actuatorRegistry || typeof actuatorRegistry.resolve !== "function") {
        throw fail3(REASONS3.MALFORMED_REQUEST, "dispatcher requires an actuator registry");
    }
    if (!clock || typeof clock.nowMs !== "function") {
        throw fail3(REASONS3.MALFORMED_REQUEST, "dispatcher requires a canonical clock");
    }
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT3 || timeoutMs > MAX_TIMEOUT3) {
        throw fail3(REASONS3.INVALID_TIMEOUT_CONFIG, `timeoutMs must be in [${MIN_TIMEOUT3}, ${MAX_TIMEOUT3}]`);
    }

    const inFlight = new Map();
    const completed = new Map();
    const COMPLETED_MAX = 4096;

    function canonicalClockNow3() {
        const v = clock.nowMs();
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
            throw fail3(REASONS3.MALFORMED_REQUEST, "canonical clock returned an invalid timestamp");
        }
        return v;
    }

    function noteCompleted(key, entry) {
        if (completed.size >= COMPLETED_MAX) {
            const firstKey = completed.keys().next().value;
            if (firstKey !== undefined) completed.delete(firstKey);
        }
        completed.set(key, entry);
    }

    function computeContentKey3(intent, authSession, parameters, metadata) {
        const paramsJson = parameters === undefined || parameters === null ? "{}" : JSON.stringify(parameters);
        const metaJson = metadata === undefined || metadata === null ? "{}" : JSON.stringify(metadata);
        const sessionKey = String(typeof authSession === "object" && authSession !== null ? (authSession.principal ?? "") + ":" + authSession.sessionId : "");
        const scopeJson = JSON.stringify(intent.scope ?? []);
        const key = `${intent.intentId}|${intent.capabilityId}|${intent.capabilityIncarnationId}|${intent.operation}|${sessionKey}|${scopeJson}|${crypto3.createHash("sha256").update(paramsJson).digest("hex").slice(0, 16)}|${crypto3.createHash("sha256").update(metaJson).digest("hex").slice(0, 16)}`;
        return crypto3.createHash("sha256").update(key).digest("hex");
    }

    async function execute(p) {
        if (p === null || typeof p !== "object") {
            throw fail3(REASONS3.MALFORMED_REQUEST, "execute requires a request object");
        }
        for (const key of CALLER_EXECUTOR_KEYS3) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail3(REASONS3.CALLER_EXECUTOR_REJECTED,
                    `caller-executor option '${key}' is forbidden; the actuator is bootstrap-owned, never caller-selectable`);
            }
        }
        for (const key of BEARER_DECISION_KEYS3) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail3(REASONS3.CALLER_EXECUTOR_REJECTED,
                    `authority-decision option '${key}' is forbidden; an AuthorityDecision is historical evidence, not a bearer execution token`);
            }
        }

        const { intent, authSession } = p;
        if (!intent || typeof intent !== "object" ||
            typeof intent.intentId !== "string" ||
            typeof intent.capabilityId !== "string" ||
            typeof intent.operation !== "string" ||
            typeof intent.capabilityIncarnationId !== "string") {
            throw fail3(REASONS3.INVALID_INTENT, "execute requires a canonical ActionIntent");
        }
        if (!isValidIncarnation3(intent.capabilityIncarnationId)) {
            throw fail3(REASONS3.INVALID_INTENT, "intent capabilityIncarnationId is not a valid canonical incarnation");
        }
        if (authSession === null || typeof authSession !== "object") {
            throw fail3(REASONS3.INVALID_SESSION, "execute requires an authenticated session");
        }

        const requestedAtMs = canonicalClockNow3();
        const lifecycle = createLifecycleTracker3(LIFECYCLE3.CREATED);
        const admittedAtMs = intent.createdAtMs;

        let provisionalRequest;
        try {
            provisionalRequest = formExecutionRequest3({
                intentId: intent.intentId,
                capabilityId: intent.capabilityId,
                capabilityIncarnationId: intent.capabilityIncarnationId,
                operation: intent.operation,
                principal: "<pending-revalidation>",
                scope: intent.scope,
                authorityGeneration: 0,
                admittedAtMs,
                requestedAtMs,
                parameters: p.parameters,
                metadata: p.metadata
            });
        } catch (e) {
            lifecycle.advance(LIFECYCLE3.FAILED, requestedAtMs);
            throw e;
        }

        const contentKey = computeContentKey3(intent, authSession, p.parameters, p.metadata);
        if (inFlight.has(contentKey)) {
            return inFlight.get(contentKey).promise;
        }
        if (completed.has(contentKey)) {
            return completed.get(contentKey).result;
        }

        const inFlightEntry = { promise: null, request: provisionalRequest, intentId: provisionalRequest.intentId };
        inFlight.set(contentKey, inFlightEntry);
        const runPromise = (async () => {
            try {
                return await runExecutionBody3(contentKey, intent, authSession, p, provisionalRequest, lifecycle, requestedAtMs, admittedAtMs);
            } finally {
                inFlight.delete(contentKey);
            }
        })();
        inFlightEntry.promise = runPromise;
        return runPromise;
    }

    async function runExecutionBody3(contentKey, intent, authSession, p, provisionalRequest, lifecycle, requestedAtMs, admittedAtMs) {
        // ── PRE-ACTUATION REVALIDATION (the core invariant) ────────────
        lifecycle.advance(LIFECYCLE3.REVALIDATING, canonicalClockNow3());

        let freshDecision;
        try {
            freshDecision = await lane2Facade.evaluate(intent, authSession);
        } catch (e) {
            lifecycle.advance(LIFECYCLE3.FAILED, canonicalClockNow3());
            const result = buildExecutionResult3({
                executionRequest: provisionalRequest,
                state: RESULT_STATE3.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow3(),
                failureReason: REASONS3.AUTHORITY_REVALIDATION_REQUIRED,
                failureDetail: "fresh canonical authority evaluation threw"
            });
            noteCompleted(contentKey, { result, request: provisionalRequest, intentId: provisionalRequest.intentId });
            return result;
        }

        if (!freshDecision || freshDecision.decision !== DECISION3.ALLOW) {
            lifecycle.advance(LIFECYCLE3.FAILED, canonicalClockNow3());
            const reasonCode = freshDecision ? freshDecision.reasonCode : "NO_DECISION";
            const result = buildExecutionResult3({
                executionRequest: provisionalRequest,
                state: RESULT_STATE3.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow3(),
                failureReason: REASONS3.AUTHORITY_DENIED,
                failureDetail: `fresh canonical evaluation denied: ${reasonCode}`
            });
            noteCompleted(contentKey, { result, request: provisionalRequest, intentId: provisionalRequest.intentId });
            return result;
        }

        if (typeof freshDecision.capabilityIncarnationId === "string" &&
            freshDecision.capabilityIncarnationId !== intent.capabilityIncarnationId) {
            lifecycle.advance(LIFECYCLE3.FAILED, canonicalClockNow3());
            const result = buildExecutionResult3({
                executionRequest: provisionalRequest,
                state: RESULT_STATE3.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow3(),
                failureReason: REASONS3.CAPABILITY_INCARNATION_MISMATCH,
                failureDetail: `intent incarnation ${intent.capabilityIncarnationId} != fresh ${freshDecision.capabilityIncarnationId}`
            });
            noteCompleted(contentKey, { result, request: provisionalRequest, intentId: provisionalRequest.intentId });
            return result;
        }

        const principal = freshDecision.principal;
        if (typeof principal !== "string" || principal.length === 0) {
            lifecycle.advance(LIFECYCLE3.FAILED, canonicalClockNow3());
            const result = buildExecutionResult3({
                executionRequest: provisionalRequest,
                state: RESULT_STATE3.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow3(),
                failureReason: REASONS3.INVALID_IDENTITY,
                failureDetail: "fresh canonical evaluation produced no principal"
            });
            noteCompleted(contentKey, { result, request: provisionalRequest, intentId: provisionalRequest.intentId });
            return result;
        }

        const revalidation = {
            principal,
            authorityGeneration: freshDecision.authorityGeneration,
            revalidatedAtMs: canonicalClockNow3()
        };
        let request;
        try {
            request = formExecutionRequest3({
                intentId: intent.intentId,
                capabilityId: intent.capabilityId,
                capabilityIncarnationId: intent.capabilityIncarnationId,
                operation: intent.operation,
                principal,
                scope: intent.scope,
                authorityGeneration: freshDecision.authorityGeneration,
                admittedAtMs,
                requestedAtMs,
                parameters: p.parameters,
                metadata: p.metadata
            });
        } catch (e) {
            lifecycle.advance(LIFECYCLE3.FAILED, canonicalClockNow3());
            throw e;
        }

        const binding = actuatorRegistry.resolve(intent.capabilityId, intent.operation);
        if (!binding) {
            lifecycle.advance(LIFECYCLE3.FAILED, canonicalClockNow3());
            const result = buildExecutionResult3({
                executionRequest: request,
                state: RESULT_STATE3.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow3(),
                failureReason: REASONS3.ACTUATOR_NOT_FOUND,
                failureDetail: `no actuator registered for '${intent.capabilityId}.${intent.operation}'`
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }
        if (binding.capabilityIncarnationId !== intent.capabilityIncarnationId) {
            lifecycle.advance(LIFECYCLE3.FAILED, canonicalClockNow3());
            const result = buildExecutionResult3({
                executionRequest: request,
                state: RESULT_STATE3.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow3(),
                failureReason: REASONS3.ACTUATOR_INCARNATION_MISMATCH,
                failureDetail: `actuator binding capability incarnation ${binding.capabilityIncarnationId} != intent ${intent.capabilityIncarnationId}`
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }
        if (binding.readiness !== READINESS3.READY) {
            lifecycle.advance(LIFECYCLE3.FAILED, canonicalClockNow3());
            const result = buildExecutionResult3({
                executionRequest: request,
                state: RESULT_STATE3.FAILED,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow3(),
                failureReason: REASONS3.ACTUATOR_UNAVAILABLE,
                failureDetail: `actuator readiness is ${binding.readiness}`
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }

        lifecycle.advance(LIFECYCLE3.READY, canonicalClockNow3());

        const signal = p.signal;
        if (signal && typeof signal.addEventListener === "function" && signal.aborted) {
            lifecycle.advance(LIFECYCLE3.CANCELLED, canonicalClockNow3());
            const result = buildExecutionResult3({
                executionRequest: request,
                state: RESULT_STATE3.CANCELLED,
                actuatorId: binding.actuatorId,
                actuatorIncarnationId: binding.actuatorIncarnationId,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: requestedAtMs,
                completedAtMs: canonicalClockNow3(),
                failureReason: REASONS3.CANCELLED_BEFORE_DISPATCH,
                failureDetail: "cancelled before actuator invocation"
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }

        lifecycle.advance(LIFECYCLE3.DISPATCHING, canonicalClockNow3());
        const dispatchStartMs = canonicalClockNow3();
        const effectiveTimeout = (typeof p.timeoutMs === "number" && Number.isSafeInteger(p.timeoutMs) && p.timeoutMs >= MIN_TIMEOUT3 && p.timeoutMs <= MAX_TIMEOUT3)
            ? p.timeoutMs : timeoutMs;

        let cancelledDuringDispatch = false;
        let invocationCount = 0;

        const execPromise = (async () => {
            invocationCount++;
            return await binding.invoke({
                executionId: request.executionId,
                intentId: request.intentId,
                capabilityId: request.capabilityId,
                operation: request.operation,
                principal: request.principal,
                scope: request.scope,
                parameters: request.parameters
            });
        })();

        let timeoutHandle = null;
        let timedOut = false;
        const timeoutPromise = new Promise((resolve) => {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                resolve(null);
            }, effectiveTimeout);
            if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
        });

        let cancelListener = null;
        if (signal && typeof signal.addEventListener === "function") {
            cancelListener = () => {
                if (lifecycle.state === LIFECYCLE3.DISPATCHING && !timedOut) {
                    cancelledDuringDispatch = true;
                }
            };
            signal.addEventListener("abort", cancelListener);
        }

        let actuatorOutput = null;
        let dispatchFailed = null;
        try {
            actuatorOutput = await Promise.race([execPromise, timeoutPromise]);
            if (timedOut) {
                lifecycle.advance(LIFECYCLE3.TIMED_OUT, canonicalClockNow3());
                const result = buildExecutionResult3({
                    executionRequest: request,
                    state: RESULT_STATE3.TIMED_OUT,
                    actuatorId: binding.actuatorId,
                    actuatorIncarnationId: binding.actuatorIncarnationId,
                    lifecycleTrace: lifecycle.trace,
                    startedAtMs: dispatchStartMs,
                    completedAtMs: canonicalClockNow3(),
                    failureReason: REASONS3.TIMEOUT_EXCEEDED,
                    failureDetail: `actuator exceeded ${effectiveTimeout}ms timeout; effect ambiguity preserved`
                });
                noteCompleted(contentKey, { result, request, intentId: request.intentId });
                return result;
            }
        } catch (e) {
            dispatchFailed = e;
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (signal && typeof signal.removeEventListener === "function" && cancelListener) {
                try { signal.removeEventListener("abort", cancelListener); } catch { /* best-effort */ }
            }
        }

        if (dispatchFailed) {
            lifecycle.advance(LIFECYCLE3.FAILED, canonicalClockNow3());
            const sanitized = sanitizeActuatorOutput3(dispatchFailed);
            const result = buildExecutionResult3({
                executionRequest: request,
                state: RESULT_STATE3.FAILED,
                actuatorId: binding.actuatorId,
                actuatorIncarnationId: binding.actuatorIncarnationId,
                lifecycleTrace: lifecycle.trace,
                startedAtMs: dispatchStartMs,
                completedAtMs: canonicalClockNow3(),
                actuatorReport: sanitized,
                failureReason: REASONS3.ACTUATOR_REJECTED_INVOCATION,
                failureDetail: "actuator invocation threw"
            });
            noteCompleted(contentKey, { result, request, intentId: request.intentId });
            return result;
        }

        lifecycle.advance(LIFECYCLE3.EXECUTED, canonicalClockNow3());
        const result = buildExecutionResult3({
            executionRequest: request,
            state: RESULT_STATE3.EXECUTED,
            actuatorId: binding.actuatorId,
            actuatorIncarnationId: binding.actuatorIncarnationId,
            lifecycleTrace: lifecycle.trace,
            startedAtMs: dispatchStartMs,
            completedAtMs: canonicalClockNow3(),
            actuatorReport: actuatorOutput
        });
        noteCompleted(contentKey, { result, request, intentId: request.intentId });
        return result;
    }

    return Object.freeze({
        execute,
        registerActuator: actuatorRegistry.register,
        removeActuator: actuatorRegistry.remove,
        dispatcherState: Object.freeze({
            inFlightCount: () => inFlight.size,
            completedCount: () => completed.size,
            timeoutMs: () => timeoutMs
        })
    });
}

// The ONE canonical actuation facade, created exactly once, lazily, on first use.
let canonicalActuation = null;

/**
 * Create the canonical Lane 3 actuation facade (trusted-bootstrap-private).
 * Takes NO options — the actuator registry, the dispatcher's clock, and the
 * Lane 2 facade it revalidates against are all owned by this closure.
 *
 * @returns {object} frozen { execute }  (least privilege: execution only)
 */
function createCanonicalActuationFacade() {
    if (arguments[0] !== undefined) {
        throw fail(REASONS.CALLER_BOOTSTRAP_REJECTED,
            "canonical actuation creation accepts NO options; the Lane 2 facade, actuator registry, registrar capability, and clock are bootstrap-owned");
    }
    if (canonicalActuation === null) {
        const lane2Facade = createCanonicalActionFacade();
        const actuatorRegistry = buildActuatorRegistry3();
        const dispatcher = composeDispatcher3({
            lane2Facade,
            actuatorRegistry,
            clock: { nowMs: () => Date.now() }
        });
        // Downstream receives ONLY execute + the two PURE brand-recognition
        // predicates. The predicates read THIS closure's brand WeakSets
        // directly (closure-private, never exported as mutable state). The
        // registrar capability (registerActuator/removeActuator) stays in this
        // closure for the trusted runtime layer's own actuator wiring (a later
        // lane wires real actuators; Lane 3 ships the fabric + tests wire test
        // actuators via the test-only harness).
        canonicalActuation = Object.freeze({
            execute: dispatcher.execute,

            // PURE brand-recognition predicates — BRAND-FIRST: closure-only
            // WeakSet membership decides. Downstream can ASK "is this
            // canonical?"; downstream cannot CAUSE "make this canonical" (the
            // brand WeakSets are closure-private; no export exposes them or
            // any mutation capability).
            isCanonicalExecutionRequest(value) {
                if (value === null || typeof value !== "object") return false;
                if (!requestBrandSet3.has(value)) return false;
                return true;
            },
            isCanonicalExecutionResult(value) {
                if (value === null || typeof value !== "object") return false;
                if (!resultBrandSet3.has(value)) return false;
                return true;
            }
        });
    }
    return canonicalActuation;
}

const crypto4 = require("node:crypto");

// ---------------------------------------------------------------------------
// LANE 4 — CANONICAL VERIFICATION + COMPENSATION COMPOSITION.
//
// ALL privileged verification/compensation implementation lives in THIS
// private lexical closure, exactly like Lane 2's
// composeActionAuthorityRuntime / composeAuthenticationDomain and Lane 3's
// actuation formers. The verification submodules (verification/*.js) are PURE
// NON-PRIVILEGED vocabulary modules. The privileged constructors —
// buildVerifierRegistry, composeVerification, formVerificationRequest,
// buildVerificationResult, formCompensationPlan, buildCompensationResult,
// sanitizeEvidence, evaluatePostcondition — are defined HERE, inside this
// module's own lexical scope. They are reachable through NO binder, NO token,
// NO host capability, NO first-call-wins registry: acquiring them requires
// ALREADY executing inside this closure.
//
// CANONICAL BRANDS: the verification-request / verification-result /
// compensation-plan brand WeakSets are declared HERE (closure-private).
// Brand membership is established ONLY by the private formers below. No
// export of ANY module exposes the WeakSets, the brand tokens, or any
// mutation surface. Downstream can ASK (via the pure recognition predicates
// on the facade); downstream cannot CAUSE.
//
// CORE LAWS (Lane 4):
//
//   EXECUTED != VERIFIED            — a Lane 3 EXECUTED result is input to
//                                     verification, never proof of truth.
//   ACTUATOR REPORT != WORLD TRUTH  — verification observes the world via
//                                     bootstrap-owned verifiers only.
//   TIMEOUT != NO SIDE EFFECT       — verification timeout yields TIMED_OUT /
//                                     INCONCLUSIVE, never success/failure.
//   AUDIT != CURRENT TRUTH          — evidence is historical record only.
//   MEMORY != CURRENT TRUTH
//   MODEL CLAIM != VERIFICATION     — no caller/object can mint a claim.
//   PLAN != AUTHORITY               — a CompensationPlan is descriptive.
//   COMPENSATION != ROLLBACK GUARANTEE — restoration is claimed only by a
//                                     fresh verification with VERIFIED_SUCCESS.
//
// COMPENSATION IS A NEW ACTION: compensation NEVER calls a compensator
// function directly from a verification failure. The canonical compensate()
// path (1) requires the source verification state recorded inside THIS
// closure (never a caller-presented result), (2) forms an immutable
// CompensationPlan, (3) admits a fresh canonical ActionIntent for the
// compensation action, (4) routes it through the Lane 3 canonical facade
// execute() — which performs fresh Lane 2 revalidation — and (5) requires a
// separate fresh verification of the compensation's own postcondition before
// any restoration claim. A previous ALLOW for the original action does NOT
// authorize compensation; the Lane 2 gate re-evaluates the compensation
// action against current authority.
//
// IDEMPOTENCE: process-local exact-once scopes for verification
// (verificationId) and compensation (compensationId) are documented as
// PROCESS-LOCAL; a duplicate id returns the SAME canonical record instead of
// re-observing or re-actuating.
// ---------------------------------------------------------------------------

const {
    VERIFICATION_STATE: VSTATE4, COMPENSATION_STATE: CSTATE4,
    LIFECYCLE: VLIFECYCLE4, REASONS: VREASONS4, fail: fail4
} = require("./verification/errors");
const {
    POSTCONDITION_OPS: VOPS4, POSTCONDITION_KIND: VKIND4,
    POSTCONDITION_SCHEMA_VERSION: VPOST_SCHEMA4,
    isValidPostconditionPath: isValidPostPath4
} = require("./verification/postcondition");
const {
    VERIFICATION_REQUEST_SCHEMA_VERSION: VREQ_SCHEMA4,
    VERIFICATION_RESULT_SCHEMA_VERSION: VRES_SCHEMA4,
    COMPENSATION_PLAN_SCHEMA_VERSION: CPLAN_SCHEMA4,
    COMPENSATION_RESULT_SCHEMA_VERSION: CRES_SCHEMA4,
    BOUNDS: VBOUNDS4,
    DEFAULT_VERIFY_TIMEOUT_MS: DEFAULT_VTIMEOUT4,
    MIN_VERIFY_TIMEOUT_MS: MIN_VTIMEOUT4,
    MAX_VERIFY_TIMEOUT_MS: MAX_VTIMEOUT4,
    isValidVerifyTimeoutMs: isValidVTimeout4
} = require("./verification/schema");
const { READINESS: VREADINESS4 } = require("./verification/verifierRegistry");
const { RESULT_STATE: RESULT_STATE3b } = require("./actuation/errors");

const REQUEST_BRAND4 = Symbol("damar.action.verification.request.brand");
const RESULT_BRAND4 = Symbol("damar.action.verification.result.brand");
const PLAN_BRAND4 = Symbol("damar.action.verification.plan.brand");
const vRequestBrandSet4 = new WeakSet();
const vResultBrandSet4 = new WeakSet();
const vPlanBrandSet4 = new WeakSet();

function deepFreeze4(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze4(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

function vIsPlainObject4(v) {
    // ZERO-TRAP REPAIR: vIsPlainObject4 is now called ONLY on values that have
    // already been classified safe by vSafeClassify4 (not a Proxy, not
    // revoked). Object.getPrototypeOf on a genuinely plain object (literal or
    // Object.create(null/proto)) performs no traps. Any caller passing an
    // unclassified value here is a bug, so the prototype read is guarded by
    // the proxy gate in vSafeClassify4, not repeated here.
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

const V_DANGEROUS_KEYS4 = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

// ---------------------------------------------------------------------------
// HOSTILE EVIDENCE ZERO-TRAP CLASSIFICATION (TARGETED REPAIR 1)
//
// ROOT CAUSE (pre-repair): sanitizeEvidence4()/vDetach4() invoked reflection
// — instanceof Error (getPrototypeOf via HasInstance), Object.getPrototypeOf,
// Object.getOwnPropertyNames, Object.getOwnPropertyDescriptor, Array.isArray
// followed by index access — on UNCLASSIFIED verifier observation values. A
// Proxy wrapping the observation could therefore execute attacker-controlled
// getPrototypeOf/ownKeys/getOwnPropertyDescriptor/get traps merely because
// Lane 4 was deciding whether the evidence was safe: the safety check itself
// was an execution gadget.
//
// TRUST ORDERING (post-repair), mirroring the certified Lane 3 brand-first
// lesson — SAFE MEMBERSHIP / TRUSTED ORIGIN FIRST, REFLECTION SECOND:
//
//   1. ONLY primitive inspection is performed on untrusted values:
//        typeof, strict null/undefined comparisons, and
//        util.types.isProxy() — an internal-slot probe that invokes ZERO
//        Proxy traps (verified empirically against every instrumented trap
//        family, including revoked proxies, where it still answers without
//        consulting handler behavior).
//   2. Any Proxy — including revoked proxies and revocable wrappers — is
//        rejected BEFORE any reflection (TRUSTED SHAPE != TRUSTED ORIGIN).
//        Fail closed: if an object cannot be established as safe detached
//        data without interacting with attacker-controlled meta-object
//        behavior, it is rejected, not introspected further.
//   3. Only after a value is classified Proxy-free does reflection proceed:
//        static prototype identity (=== Object.prototype / null), then
//        ownKeys + descriptor inspection, then recursion — where every
//        nested value re-enters this gate BEFORE its own reflection.
//
// There is deliberately NO general "transparent Proxy" acceptance: a Proxy
// carrying plain data is indistinguishable from hostile without traps, and
// inventing shape-based trust for unmarked values would reintroduce the
// gadget. Correct fail-closed rejection is preferred over broader unsafe
// acceptance.
// ---------------------------------------------------------------------------

const { types: vUtilTypes4 } = require("node:util");
const HOSTILE_EVIDENCE_DETAIL4 =
    "hostile observation rejected: proxy-like or non-detached value (zero-trap fail-closed)";

/**
 * ZERO-TRAP classification of an untrusted value. Uses ONLY:
 *   - typeof / === / Array.isArray-on-primitives
 *   - util.types.isProxy (internal slot; zero traps, zero throws — even for
 *     revoked proxies)
 * Returns one of:
 *   "primitive"  — string | boolean | finite number (safe by value)
 *   "null"       — null
 *   "error"      — genuine native Error instance (static prototype chain,
 *                   NO instanceof/HasInstance on untrusted values)
 *   "array"      — plain Array (static prototype chain)
 *   "object"     — plain object (static prototype chain)
 *   "hostile"    — Proxy (incl. revoked), non-plain exotic (class instance,
 *                   Map/Set/Date/RegExp/other realm objects), accessor-target
 *                   (functions are rejected as evidence), or garbage the
 *                   caller must fail closed on
 * "hostile" classification itself MUST NOT be a verdict about the WORLD:
 * callers map it to fail-closed states (ERROR / typed rejection), never to
 * VERIFIED_SUCCESS/VERIFIED_FAILURE.
 */
function vSafeClassify4(value) {
    // (1) primitives + null: zero reflection by construction.
    if (value === null) return "null";
    const t = typeof value;
    if (t === "string" || t === "boolean") return "primitive";
    if (t === "number") return Number.isFinite(value) ? "primitive" : "inert";
    // (2) non-objects: function/symbol/bigint/undefined are INERT values —
    //     they cannot carry traps and are sanitized to null (established
    //     Lane 3/Lane 4 evidence contract), not treated as execution
    //     gadgets. A function VALUE is not a trap gadget; it is dropped.
    if (t === "function" || t === "symbol" || t === "bigint" || t === "undefined") return "inert";
    if (t !== "object") return "hostile";
    // (3) THE GATE — internal-slot proxy probe. Zero traps: the empirical
    //     proof in tests/verification asserts exact-zero counters for get,
    //     has, ownKeys, getOwnPropertyDescriptor, getPrototypeOf, set,
    //     defineProperty, deleteProperty, apply, construct across every
    //     hostile case. Revoked proxies are still reported as proxies, so
    //     a revoked object can never smuggle through as a plain value.
    if (vUtilTypes4.isProxy(value)) return "hostile";
    // (4) The value is now KNOWN not to be a Proxy; reflection is safe.
    //     Array.isArray consults the internal slot (no traps on a
    //     non-proxy), and the static prototype identity check distinguishes
    //     genuine plain values from exotic/class-instance/realm objects.
    if (Array.isArray(value)) {
        return Object.getPrototypeOf(value) === Array.prototype ? "array" : "hostile";
    }
    // A genuine Promise is a trusted native delivery object: classify it so
    // the observation runner can await it WITHOUT probing `.then` on an
    // unclassified value. `util.types.isPromise` is an internal-slot probe
    // (zero traps). A Proxy wrapping a Promise reports false here and is
    // correctly rejected as "hostile" at the gate.
    if (vUtilTypes4.isPromise(value)) return "promise";
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
        // Genuine plain object. (A plain object carrying a fake
        // Symbol.toStringTag cannot fake its way past the next JSON gate in
        // sanitizeEvidence4; the tag is cosmetic only.)
        return "object";
    }
    // Native Error instances are the only exotic family ACCEPTED as
    // evidence (normalized to {name,message}); the check is the STATIC
    // prototype chain — NOT `value instanceof Error`, which routes through
    // Error[Symbol.hasInstance] -> OrdinaryHasInstance -> the object's
    // prototype chain and is exactly the getPrototypeOf gadget the audit
    // flagged. Subclass errors (e.g. TypeError across realms used by this
    // runtime) are matched by walking the static chain with a bound compare.
    let cursor = proto;
    for (let hops = 0; hops < 8 && cursor !== null; hops++) {
        if (cursor === Error.prototype || cursor === globalThis.Error?.prototype) {
            return "error";
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    // Other exotic objects (class instances, Map/Set/Date/RegExp, cross-realm
    // objects): NOT proxies, so own-property reflection is trap-free; the
    // established evidence contract sanitizes them to null ("inert") rather
    // than poisoning. Only actual Proxies (rejected at the internal-slot
    // gate above) poison the observation.
    return "inert";
}

// Hostile-input detachment for DECLARATIVE postcondition values, evidence
// and compensation parameters: functions/symbols/accessors/class instances/
// cycles/prototype-pollution keys are rejected (fail-closed), values are
// bounded and detached from caller mutations.
// TARGETED REPAIR 1: every value passes vSafeClassify4 (zero-trap gate)
// BEFORE any reflection (ownKeys/descriptor/prototype reads). Proxies —
// including trap-bearing and revoked ones — are rejected with a typed error
// at the gate instead of being reflected upon.
function vDetach4(value, state) {
    state.nodes++;
    if (state.nodes > state.maxNodes) {
        throw fail4(VREASONS4.BOUND_EXCEEDED, `payload exceeds node budget (${state.maxNodes})`);
    }
    // ZERO-TRAP GATE: classification uses only typeof/===/internal-slot
    // probes. Nothing below this line runs for a hostile value.
    const cls = vSafeClassify4(value);
    if (cls === "null") return null;
    if (cls === "primitive") {
        if (typeof value === "number") {
            // finite check already done in the classifier
            return value;
        }
        return value;
    }
    if (cls === "inert") {
        // Inert (function/symbol/bigint/undefined/non-finite-number) in
        // postcondition/compensation-parameter payloads is REJECTED (the
        // postcondition contract is declarative; the observation-evidence
        // sanitizer may DROP these to null, but detach must fail closed).
        const t = typeof value;
        if (t === "function") throw fail4(VREASONS4.FUNCTION_VALUE, "function values are not permitted");
        throw fail4(VREASONS4.SYMBOL_VALUE, `${t} values are not permitted`);
    }
    if (cls === "hostile") {
        // Fail closed with a typed error. NEVER reinterpret as a world claim.
        throw fail4(VREASONS4.NON_PLAIN_OBJECT, "proxy-like or non-plain value is not permitted (zero-trap fail-closed)");
    }
    // cls is "array" | "object" — reflection is now safe (value is not a
    // Proxy and its prototype is genuinely Array/Object/null).
    if (Array.isArray(value)) {
        if (state.path.has(value)) throw fail4(VREASONS4.CYCLIC_INPUT, "cyclic structure is not permitted");
        if (value.length > VBOUNDS4.GLOBAL_MAX_ARRAY_LENGTH) {
            throw fail4(VREASONS4.BOUND_EXCEEDED, "array length exceeds global bound");
        }
        state.path.add(value);
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = vDetach4(value[i], state);
        state.path.delete(value);
        return out;
    }
    if (!vIsPlainObject4(value)) {
        throw fail4(VREASONS4.NON_PLAIN_OBJECT, "non-plain object is not permitted");
    }
    if (state.path.has(value)) throw fail4(VREASONS4.CYCLIC_INPUT, "cyclic structure is not permitted");
    state.path.add(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        if (V_DANGEROUS_KEYS4.has(key)) throw fail4(VREASONS4.DANGEROUS_KEY, `dangerous key '${key}' in payload`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) {
            throw fail4(VREASONS4.ACCESSOR_PROPERTY, `accessor property '${key}' is not permitted`);
        }
        out[key] = vDetach4(desc.value, state);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw fail4(VREASONS4.SYMBOL_VALUE, "symbol keys are not permitted");
    }
    state.path.delete(value);
    return out;
}

function vRequireString4(value, field, maxChars, { optional = false, allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
        if (optional) return "";
        throw fail4(VREASONS4.MALFORMED_REQUEST, `${field} is required`);
    }
    if (typeof value !== "string") {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `${field} must be a string, got ${typeof value}`);
    }
    const s = value.trim();
    if (!optional && !allowEmpty && s.length === 0) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `${field} must not be empty`);
    }
    if (s.length > maxChars) {
        throw fail4(VREASONS4.BOUND_EXCEEDED, `${field} exceeds ${maxChars} chars`);
    }
    return s;
}

function vRequireSafeInteger4(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `${field} must be a nonnegative safe integer`);
    }
    return value;
}

// ---- DECLARATIVE POSTCONDITION: canonical former + evaluator (private) ----
function formExpectedPostcondition4(raw) {
    if (raw === undefined || raw === null) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, "expectedPostcondition is required");
    }
    if (typeof raw === "function" || typeof raw === "symbol" || typeof raw === "bigint") {
        throw fail4(VREASONS4.EXECUTABLE_POSTCONDITION_REJECTED,
            "expected postcondition must be declarative; executable values are rejected");
    }
    // ZERO-TRAP REPAIR (TARGETED REPAIR 1): classify FIRST via the
    // internal-slot proxy probe — ANY Proxy (trap-bearing OR transparent) is
    // rejected here with zero trap execution. The pre-repair ownKeys-vs-
    // enumerable divergence probe ran reflection on unclassified values and
    // was itself a trap gadget; it is removed. TRUSTED SHAPE != TRUSTED
    // ORIGIN: no shape-based trust is invented for unmarked values.
    if (vSafeClassify4(raw) !== "object") {
        throw fail4(VREASONS4.NON_PLAIN_OBJECT,
            "proxy-like or non-plain postcondition is not permitted (zero-trap fail-closed)");
    }
    // raw is now a genuinely plain object: reflection is safe.
    if (!vIsPlainObject4(raw)) {
        throw fail4(VREASONS4.NON_PLAIN_OBJECT, "expected postcondition must be a plain declarative object");
    }

    let detached;
    try {
        const state = { nodes: 0, maxNodes: VBOUNDS4.MAX_PARAMETERS_NODES, path: new Set() };
        detached = vDetach4(raw, state);
    } catch (e) {
        if (e && typeof e.reasonCode === "string") throw e;
        // Hostile trap threw mid-detach => typed fail-closed rejection.
        throw fail4(VREASONS4.NON_PLAIN_OBJECT, "hostile postcondition object rejected during detachment");
    }
    return vFinishPostcondition4(detached);
}

function vFinishPostcondition4(detached) {

    if (detached.schemaVersion !== undefined && detached.schemaVersion !== VPOST_SCHEMA4) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `unsupported postcondition schemaVersion ${JSON.stringify(detached.schemaVersion)}`);
    }
    if (detached.kind !== undefined && detached.kind !== VKIND4) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `unsupported postcondition kind ${JSON.stringify(detached.kind)}`);
    }

    const expect = {};
    let expectCount = 0;
    if (detached.expect !== undefined && detached.expect !== null) {
        if (!vIsPlainObject4(detached.expect)) {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "postcondition expect must be a plain object");
        }
        for (const [path, rule] of Object.entries(detached.expect)) {
            expectCount++;
            if (expectCount > VBOUNDS4.MAX_EXPECT_ENTRIES) {
                throw fail4(VREASONS4.BOUND_EXCEEDED, `postcondition expect exceeds ${VBOUNDS4.MAX_EXPECT_ENTRIES} entries`);
            }
            if (!isValidPostPath4(path)) {
                throw fail4(VREASONS4.DANGEROUS_KEY, `invalid postcondition path '${String(path).slice(0, 64)}'`);
            }
            if (!vIsPlainObject4(rule)) {
                throw fail4(VREASONS4.MALFORMED_REQUEST, `postcondition rule for '${path}' must be a declarative object`);
            }
            const op = rule.op;
            if (!VOPS4 || !Object.values(VOPS4).includes(op)) {
                throw fail4(VREASONS4.MALFORMED_REQUEST, `postcondition rule for '${path}' has invalid op`);
            }
            const ruleOut = { op };
            if ("value" in rule) {
                const valueState = { nodes: 0, maxNodes: VBOUNDS4.MAX_VALUE_NODES, path: new Set() };
                ruleOut.value = vDetach4(rule.value, valueState);
            }
            expect[path] = Object.freeze(ruleOut);
        }
    }

    const forbid = {};
    let forbidCount = 0;
    if (detached.forbid !== undefined && detached.forbid !== null) {
        if (!vIsPlainObject4(detached.forbid)) {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "postcondition forbid must be a plain object");
        }
        for (const [path, value] of Object.entries(detached.forbid)) {
            forbidCount++;
            if (forbidCount > VBOUNDS4.MAX_EXPECT_ENTRIES) {
                throw fail4(VREASONS4.BOUND_EXCEEDED, `postcondition forbid exceeds ${VBOUNDS4.MAX_EXPECT_ENTRIES} entries`);
            }
            if (!isValidPostPath4(path)) {
                throw fail4(VREASONS4.DANGEROUS_KEY, `invalid postcondition forbid path '${String(path).slice(0, 64)}'`);
            }
            const valueState = { nodes: 0, maxNodes: VBOUNDS4.MAX_VALUE_NODES, path: new Set() };
            forbid[path] = vDetach4(value, valueState);
        }
    }

    if (expectCount === 0 && forbidCount === 0) {
        // A vacuous postcondition must never be able to mint VERIFIED_SUCCESS.
        throw fail4(VREASONS4.MALFORMED_REQUEST,
            "expected postcondition must contain at least one expect or forbid rule (vacuous postconditions are rejected)");
    }

    return deepFreeze4({ schemaVersion: VPOST_SCHEMA4, kind: VKIND4, expect: deepFreeze4(expect), forbid: deepFreeze4(forbid) });
}

/** Read a dotted path from a plain object; returns { found, value }. */
function vReadPath4(obj, path) {
    const segments = String(path).split(".");
    let cur = obj;
    for (const seg of segments) {
        if (cur === null || cur === undefined) return { found: false, value: undefined };
        if (typeof cur !== "object") return { found: false, value: undefined };
        if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
        cur = cur[seg];
    }
    return { found: true, value: cur };
}

/**
 * Canonical postcondition evaluator (private). Pure: evaluates the
 * declarative expectation against sanitized evidence.
 *   "matched"    — every expect rule satisfied AND every forbid rule clean
 *   "mismatched" — at least one explicit rule violated
 *   "insufficient" — evidence did not contain a path needed to decide
 * Returns one of those strings, or throws only on internal contract bugs.
 */
function evaluatePostcondition4(postcondition, evidence) {
    if (!postcondition || typeof postcondition !== "object") return "insufficient";
    const ev = (evidence === null || evidence === undefined || typeof evidence !== "object")
        ? {} : evidence;

    let sawAny = false;

    for (const [path, rule] of Object.entries(postcondition.expect ?? {})) {
        sawAny = true;
        const { found, value } = vReadPath4(ev, path);
        const op = rule.op;
        if (op === VOPS4.EXISTS) {
            if (!found) return "insufficient";
            if (value === null || value === undefined) return "mismatched";
            continue;
        }
        if (op === VOPS4.ABSENT) {
            if (found && value !== null && value !== undefined) return "mismatched";
            continue;
        }
        if (op === VOPS4.IN) {
            if (!found) return "insufficient";
            const options = Array.isArray(rule.value) ? rule.value : [];
            if (!options.some((o) => o === value)) return "mismatched";
            continue;
        }
        if (op === VOPS4.TYPE) {
            if (!found) return "insufficient";
            const t = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
            if (t !== rule.value) return "mismatched";
            continue;
        }
        if (!found) return "insufficient";
        if (op === VOPS4.EQ) {
            if (value !== rule.value) return "mismatched";
        } else if (op === VOPS4.NE) {
            if (value === rule.value) return "mismatched";
        } else if (op === VOPS4.GT || op === VOPS4.GTE || op === VOPS4.LT || op === VOPS4.LTE) {
            if (typeof value !== "number" || typeof rule.value !== "number") return "mismatched";
            if (op === VOPS4.GT && !(value > rule.value)) return "mismatched";
            if (op === VOPS4.GTE && !(value >= rule.value)) return "mismatched";
            if (op === VOPS4.LT && !(value < rule.value)) return "mismatched";
            if (op === VOPS4.LTE && !(value <= rule.value)) return "mismatched";
        } else {
            return "insufficient";
        }
    }

    for (const [path, forbiddenValue] of Object.entries(postcondition.forbid ?? {})) {
        sawAny = true;
        const { found, value } = vReadPath4(ev, path);
        // forbid: { path: X } — the path, if present, must not equal X.
        // (To require a path be entirely absent, use
        // expect: { path: { op: "absent" } }.)
        if (found && value === forbiddenValue) return "mismatched";
    }

    if (!sawAny) return "insufficient";
    return "matched";
}

// ---- HOSTILE EVIDENCE SANITIZER (private; observation safety) --------------
// TARGETED REPAIR 1: this sanitizer is the untrusted evidence trust boundary.
// It MUST NOT invoke ANY reflection (instanceof / getPrototypeOf /
// ownKeys / getOwnPropertyDescriptor / get / has / set / defineProperty /
// deleteProperty / apply / construct) on an unclassified value.
//
// Post-repair trust ordering (TRUSTED ORIGIN FIRST, REFLECTION SECOND):
//   1. vSafeClassify4() classifies using ONLY typeof / === / internal-slot
//      util.types.isProxy() (zero traps, zero throws — even for revoked
//      proxies).
//   2. Proxies (incl. revoked) and other exotic objects are REJECTED by
//      returning a hostile-rejection sentinel. The caller maps this to the
//      verifier-infrastructure ERROR state (never VERIFIED_SUCCESS/FAILURE).
//   3. Only after a value is classified Proxy-free (plain array/object) does
//      reflection proceed, and EVERY nested value re-enters the gate before
//      its own reflection. The zero-trap invariant holds recursively.
//
// Native Error instances are the only exotic family accepted: they are
// normalized to { name, message } and checked via the STATIC prototype
// chain (not `instanceof Error`, which routes through the getPrototypeOf
// trap and was exactly the gadget flagged by the audit). Error normalization
// runs AFTER the classifier proves the value is not a Proxy, so a Proxy
// wrapping an Error target is rejected at step (2) and never reaches the
// Error branch.
//
// Bounds preserved: nodes (512) / depth (8) / keys (64) / string (1024) /
// array slice (256); cycle handling (null on revisit); dangerous key
// filtering; accessor skipping. These bounds are SECONDARY to the zero-trap
// invariant — no reflection runs merely to enforce them.
const V_EV_STRING_CHARS4 = 1024;
const V_EV_KEYS4 = 64;
const V_EV_DEPTH4 = 8;
const V_EV_NODES4 = 512;
// Sentinel returned for hostile values: the caller translates this into a
// verifier-infrastructure ERROR, never a world claim.
const V_HOSTILE_SENTINEL4 = Symbol("damar.action.verification.evidence.hostile");

function sanitizeEvidence4(value) {
    const state = { nodes: 0, path: new Set() };

    function normalizeErrorName(v) {
        // v is KNOWN non-proxy + static Error prototype chain. .name/.message
        // reads on a genuine native Error are not attacker-controlled (no
        // exotic meta-object behavior can interpose).
        let n = v.name;
        if (typeof n !== "string") n = "Error";
        n = n.slice(0, 64);
        let m = v.message;
        if (typeof m !== "string") m = "";
        m = m.slice(0, V_EV_STRING_CHARS4);
        return { name: n, message: m };
    }

    function walk(v, depth) {
        state.nodes++;
        if (state.nodes > V_EV_NODES4 || depth > V_EV_DEPTH4) return null;

        // (1) ZERO-TRAP GATE. No reflection below this line until the value
        //     is classified Proxy-free.
        const cls = vSafeClassify4(v);
        if (cls === "null" || cls === "inert") {
            // null, non-finite numbers, functions, symbols, bigints,
            // undefined: inert values — sanitized to null (no traps possible;
            // established evidence contract), never treated as gadgets.
            return null;
        }
        if (cls === "primitive") {
            const t = typeof v;
            if (t === "string") return v.length > V_EV_STRING_CHARS4 ? v.slice(0, V_EV_STRING_CHARS4) : v;
            if (t === "boolean") return v;
            // number — finite already established by the classifier
            return v;
        }
        if (cls === "error") {
            // Native Error normalization (the classifier proved not a Proxy
            // and a static Error.prototype chain). No HasInstance gadget.
            return normalizeErrorName(v);
        }
        if (cls === "hostile") {
            // Hostile: reject. ANY hostile value — top-level OR nested inside
            // otherwise normal-looking evidence — poisons the whole
            // observation: the caller maps the sentinel to the verifier-
            // infrastructure ERROR state (never VERIFIED_SUCCESS/FAILURE).
            return V_HOSTILE_SENTINEL4;
        }

        // cls is "array" | "object" — reflection is now safe (value is not a
        // Proxy and its prototype is genuinely Array/Object/null).
        if (state.path.has(v)) return null;
        state.path.add(v);
        if (Array.isArray(v)) {
            const out = v.slice(0, 256).map((x) => walk(x, depth + 1));
            state.path.delete(v);
            // Propagate poisoning: any hostile nested value poisons the
            // entire observation.
            if (out.some((x) => x === V_HOSTILE_SENTINEL4)) return V_HOSTILE_SENTINEL4;
            return out;
        }
        const out = {};
        let keys = 0;
        let poisoned = false;
        for (const key of Object.getOwnPropertyNames(v)) {
            if (keys >= V_EV_KEYS4) break;
            keys++;
            if (V_DANGEROUS_KEYS4.has(key)) continue;
            const desc = Object.getOwnPropertyDescriptor(v, key);
            if (!desc || desc.get || desc.set) continue;
            const kk = key.length > 128 ? key.slice(0, 128) : key;
            const child = walk(desc.value, depth + 1);
            if (child === V_HOSTILE_SENTINEL4) {
                poisoned = true;
                break;
            }
            out[kk] = child;
        }
        state.path.delete(v);
        // Propagate poisoning: any hostile nested value poisons the entire
        // observation (fail closed at the top level as ERROR).
        if (poisoned) return V_HOSTILE_SENTINEL4;
        return out;
    }

    const result = walk(value, 0);
    if (result === V_HOSTILE_SENTINEL4) return V_HOSTILE_SENTINEL4;
    return result;
}

// ---- PRIVILEGED: verifier registry (closure-private) -----------------------
function buildVerifierRegistry4() {
    const byId = new Map();
    const byCap = new Map();

    function canonicalOp(op) {
        return String(op ?? "").trim().toLowerCase();
    }

    function register({ capabilityId, operations, capabilityIncarnationId, verifierId, observe, readiness = "READY" }) {
        if (typeof capabilityId !== "string" || capabilityId.length === 0) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, "verifier registration requires a non-empty capabilityId");
        }
        if (!Array.isArray(operations) || operations.length === 0 ||
            operations.map(canonicalOp).filter((s) => s.length > 0).length === 0) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, "verifier registration requires a non-empty operations array");
        }
        if (typeof capabilityIncarnationId !== "string" || capabilityIncarnationId.length === 0) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, "verifier registration requires a capabilityIncarnationId");
        }
        if (typeof observe !== "function") {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, "verifier registration requires an observe function");
        }
        if (!VREADINESS4[readiness]) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, `invalid readiness '${readiness}'`);
        }

        const id = (typeof verifierId === "string" && verifierId.length > 0)
            ? verifierId
            : `ver-${crypto4.randomUUID()}`;
        const verifierIncarnationId = `vinc-${crypto4.randomUUID()}`;

        if (byId.has(id)) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, `verifier '${id}' is already registered; remove it first`);
        }

        // Function identity captured ONCE (bind to a stable detached receiver).
        const observeFn = observe.bind({});
        const ops = operations.map(canonicalOp).filter((s) => s.length > 0);
        const binding = Object.freeze({
            capabilityId,
            operations: Object.freeze(ops.slice()),
            capabilityIncarnationId,
            verifierId: id,
            verifierIncarnationId,
            readiness,
            observe: observeFn
        });

        byId.set(id, binding);
        let opMap = byCap.get(capabilityId);
        if (!opMap) { opMap = new Map(); byCap.set(capabilityId, opMap); }
        for (const op of ops) {
            if (opMap.has(op)) {
                byId.delete(id);
                throw fail4(VREASONS4.REGISTRATION_REJECTED, `verifier already registered for '${capabilityId}.${op}'`);
            }
            opMap.set(op, binding);
        }
        return binding;
    }

    function remove(verifierId) {
        const binding = byId.get(verifierId);
        if (!binding) return false;
        byId.delete(verifierId);
        const opMap = byCap.get(binding.capabilityId);
        if (opMap) {
            for (const op of binding.operations) {
                const cur = opMap.get(op);
                if (cur && cur.verifierId === verifierId) opMap.delete(op);
            }
            if (opMap.size === 0) byCap.delete(binding.capabilityId);
        }
        return true;
    }

    function resolve(capabilityId, operation) {
        const opMap = byCap.get(capabilityId);
        if (!opMap) return null;
        return opMap.get(canonicalOp(operation)) ?? null;
    }

    function get(verifierId) {
        return byId.get(verifierId) ?? null;
    }

    return Object.freeze({ register, remove, resolve, get });
}

// ---- LANE 4 — CANONICAL VERIFICATION + COMPENSATION COMPOSITION ------------

let canonicalVerification = null;

/**
 * Create the canonical Lane 4 verification/compensation facade
 * (trusted-bootstrap-private). Takes NO options — the verifier registry,
 * registrar capability, observation functions, postcondition evaluator, and
 * the Lane 3 facade it routes compensation through are all owned by this
 * closure. Caller-selected verifiers/compensators are structurally
 * impossible to inject.
 *
 * @returns {object} frozen least-privilege facade, EXACTLY:
 *     { verify, compensate, isCanonicalVerificationRequest,
 *       isCanonicalVerificationResult, isCanonicalCompensationPlan }
 */
function createCanonicalVerificationFacade() {
    if (arguments[0] !== undefined) {
        throw fail(VREASONS4.CALLER_EXECUTOR_REJECTED,
            "canonical verification creation accepts NO options; the verifier registry, observation functions, postcondition evaluator, and the Lane 3 facade are bootstrap-owned");
    }
    if (canonicalVerification !== null) return canonicalVerification;

    const lane3Facade = createCanonicalActuationFacade();
    const verifierRegistry = buildVerifierRegistry4();

    // Process-local exact-once scopes (documented as PROCESS-LOCAL).
    const verificationsById = new Map();  // verificationId -> { result, request }
    const compensationById = new Map();   // compensationId -> record
    const VERIFICATION_MAX = 4096;
    const COMPENSATION_MAX = 4096;

    function noteVerification(id, rec) {
        if (verificationsById.size >= VERIFICATION_MAX) {
            const first = verificationsById.keys().next().value;
            if (first !== undefined) verificationsById.delete(first);
        }
        verificationsById.set(id, rec);
    }

    function canonicalClockNow4() {
        const v = Date.now();
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "canonical clock returned an invalid timestamp");
        }
        return v;
    }

    /**
     * ZERO-ASSIMILATION observation runner (TARGETED REPAIR 2).
     *
     * Boxes the observation outcome into a PLAIN frozen wrapper {kind, value?}
     * resolved through promises that NEVER contain an unclassified value:
     *   - "value"       : classified-safe evidence delivered synchronously or
     *                     through the trusted sink
     *   - "hostile"     : hostile evidence (Proxy / revoked / non-detached)
     *   - "throw"       : observe threw / rejected (sanitized plain
     *                     {name,message} only)
     *   - "timeout"     : observation exceeded the bound
     *   - "unsupported" : verifier used an UNSUPPORTED async transport (a
     *                     Promise return), which would require native
     *                     thenable assimilation of untrusted evidence
     *
     * NATIVE PROMISE ASSIMILATION IS NEVER USED ON UNTRUSTED EVIDENCE:
     * the pre-R2 path called `promise.then(...)` on a genuine Promise
     * returned by an async observer; V8 assimilates the promise's RESOLVED
     * value by probing `.then` on it (PromiseResolveThenableJob), which
     * executes a hostile Proxy's `get` trap BEFORE vSafeClassify4 ever sees
     * the value. R2 removes every `then` call on values that can originate
     * from the verifier:
     *
     *   SYNC OBSERVERS   observe(ctx) -> raw evidence: the raw return is
     *                    classified immediately (zero-trap classifier) and
     *                    boxed; it is NEVER passed through Promise.resolve /
     *                    await / .then.
     *   ASYNC OBSERVERS  observe(ctx, sink): the observer drives a
     *                    bootstrap-owned trusted sink. The sink classifies
     *                    the evidence SYNCHRONOUSLY at receipt — before any
     *                    promise machinery can assimilate it — and stores
     *                    only the classified box. The sink is frozen,
     *                    closure-private, exactly-once, and cannot be
     *                    replaced by the verifier. A Promise RETURN from the
     *                    observer is UNSUPPORTED (fail closed to ERROR with
     *                    UNSUPPORTED_ASYNC_RAW_RETURN semantics — never
     *                    VERIFIED_SUCCESS / VERIFIED_FAILURE, never a
     *                    compensation trigger).
     *
     * LATE / DUPLICATE COMPLETION: only the FIRST valid completion (before
     * the timeout) finalizes the observation. Late or duplicate completions
     * are ignored and can never mutate the canonical result or trigger
     * compensation.
     */
    function vRunObservation4(binding, request, executionResult, timeoutMs) {
        return new Promise((resolve) => {
            let finalized = false;
            const finalize = (box) => {
                if (finalized) return; // exactly-once; late/duplicate ignored
                finalized = true;
                clearTimeout(timeoutHandle);
                resolve(box);
            };

            const timeoutHandle = setTimeout(() => {
                finalize(Object.freeze({ kind: "timeout" }));
            }, timeoutMs);
            if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();

            // Trusted sink: bootstrap-owned, frozen, closure-private. Raw
            // evidence is classified SYNCHRONOUSLY at receipt (before any
            // promise machinery), and only the classified box is stored.
            const observationCtx = Object.freeze({
                verificationId: request.verificationId,
                executionId: request.executionId,
                intentId: request.intentId,
                capabilityId: request.capabilityId,
                operation: request.operation,
                principal: request.principal,
                scope: request.scope,
                parameters: executionResult.parameters ?? null,
                expectedPostcondition: request.expectedPostcondition
            });

            const sink = Object.freeze({
                resolveEvidence(rawEvidence) {
                    if (finalized) return; // duplicate/late completion ignored
                    // Classify BEFORE storing: zero-trap gate only.
                    const cls = vSafeClassify4(rawEvidence);
                    if (cls === "hostile") {
                        finalize(Object.freeze({ kind: "hostile" }));
                        return;
                    }
                    if (cls === "inert" || cls === "error" || cls === "promise") {
                        // Inert (fn/symbol/bigint/class instance) evidence and
                        // Error objects delivered through the sink are not
                        // observation values: map to throw/hostile per the
                        // transport contract (a sink may not deliver Errors
                        // as evidence — use rejectObservation).
                        finalize(Object.freeze({ kind: "throw", name: "Error", message: "invalid observation value delivered to sink" }));
                        return;
                    }
                    finalize(Object.freeze({ kind: "value", value: rawEvidence }));
                },
                rejectObservation(err) {
                    if (finalized) return; // duplicate/late completion ignored
                    // Sanitized plain error metadata only; the err object
                    // itself is NEVER stored (its properties may be hostile).
                    const e = (err !== null && typeof err === "object") ? err : null;
                    const name = (e !== null && typeof e.name === "string") ? e.name.slice(0, 64) : "Error";
                    const message = (e !== null && typeof e.message === "string") ? e.message.slice(0, V_EV_STRING_CHARS4) : "verifier rejected the observation";
                    finalize(Object.freeze({ kind: "throw", name, message }));
                }
            });

            // (1) Synchronous observe call — capture the raw RETURN.
            //     NEVER `Promise.resolve(observe())` / `await observe()`:
            //     both assimilate the returned value's `.then`.
            let rawReturn;
            try {
                rawReturn = binding.observe(observationCtx, sink);
            } catch (e) {
                // observe threw synchronously: sanitized plain metadata only.
                const name = ((e && typeof e.name === "string") ? e.name.slice(0, 64) : "Error");
                const message = ((e && typeof e.message === "string") ? e.message.slice(0, V_EV_STRING_CHARS4) : "");
                finalize(Object.freeze({ kind: "throw", name, message }));
                return;
            }

            // (2) ZERO-TRAP classify the raw return. The ONLY operations on
            //     rawReturn here are typeof / === / internal-slot probes —
            //     NO `.then` read, NO `.then` call, NO assimilation.
            //     A Promise return is UNSUPPORTED: awaiting it would require
            //     native thenable assimilation of its eventual resolution,
            //     which executes attacker-controlled `then` behavior before
            //     Lane 4 can classify. Fail closed.
            const cls = vSafeClassify4(rawReturn);
            if (cls === "promise") {
                // Unsupported async transport (raw Promise return). The
                // observer must use the trusted sink for async completion.
                // The Promise object itself is NEVER assimilated by Lane 4:
                // no .then call, no await, no Promise.resolve. (If the
                // verifier's own code already assimilated a hostile value
                // internally, that execution belongs to the trusted
                // verifier's process — Lane 4's transport stays clean.)
                finalize(Object.freeze({ kind: "unsupported" }));
                return;
            }
            if (cls === "hostile") {
                // Hostile raw return (Proxy / revoked proxy / Proxy-wrapped
                // thenable): rejected at the internal-slot gate with zero
                // trap execution; never assimilated, never retained.
                finalize(Object.freeze({ kind: "hostile" }));
                return;
            }
            if (rawReturn === undefined) {
                // The observer returned undefined: this is the canonical
                // "async via sink" signal. Do NOT finalize from the return
                // value — the sink path owns completion (or the timeout
                // fires). Fall through silently.
            } else if (cls === "inert" || cls === "error") {
                // observe returning a non-undefined inert value (function,
                // symbol, bigint, non-finite number) or an Error object
                // directly: an observer must not deliver these as a return
                // value (use rejectObservation for errors). Classify-first
                // means we never introspect these. Map to throw with
                // sanitized metadata derived ONLY from zero-trap checks.
                const name = ((rawReturn !== null && typeof rawReturn.name === "string") ? rawReturn.name.slice(0, 64) : "Error");
                const message = ((rawReturn !== null && typeof rawReturn.message === "string") ? rawReturn.message.slice(0, V_EV_STRING_CHARS4) : "observer returned an unsupported value; async observers must use the trusted sink");
                finalize(Object.freeze({ kind: "throw", name, message }));
                return;
            }
            if (cls === "null") {
                // observe returned null with no sink completion: treated as
                // no observation (the sink path or a non-null return is
                // required). If the sink already finalized, this is a no-op.
                if (!finalized) {
                    finalize(Object.freeze({ kind: "throw", name: "Error", message: "observer returned null without completing the trusted sink" }));
                }
                return;
            }

            // (3) cls is "primitive" | "object" | "array": synchronous raw
            //     evidence. Box the value directly — the wrapper has no
            //     `then` property, so resolving the OUTER promise with the
            //     wrapper performs NO `.then` probe on the contained value.
            //     (Duplicate: if the sink already finalized first, ignore;
            //     for the undefined sink-async signal, the sink/timeout owns
            //     completion.)
            if (!finalized && rawReturn !== undefined) {
                finalize(Object.freeze({ kind: "value", value: rawReturn }));
            }
        });
    }

    // ---- verify(): the ONLY downstream verification capability -------------
    async function verify(p) {
        if (p === null || typeof p !== "object") {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "verify requires a request object");
        }
        // Caller-selected verifier/compensator/executor keys are forbidden.
        for (const key of CALLER_VERIFIER_KEYS4) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail4(VREASONS4.CALLER_VERIFIER_REJECTED,
                    `caller-verifier option '${key}' is forbidden; the verifier is bootstrap-owned, never caller-selectable`);
            }
        }
        for (const key of CALLER_COMPENSATOR_KEYS4) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail4(VREASONS4.CALLER_EXECUTOR_REJECTED,
                    `caller-compensator option '${key}' is forbidden; compensation is a canonical action routed through Lane 3`);
            }
        }

        const executionResult = p.executionResult;
        // BRAND-FIRST: only canonical Lane 3 ExecutionResults are verifiable.
        if (!isCanonicalExecutionResult4(executionResult)) {
            throw fail4(VREASONS4.NOT_CANONICAL_EXECUTION_RESULT,
                "verification requires a canonical Lane 3 ExecutionResult; arbitrary result-shaped objects, JSON clones, and foreign-domain results are not verifiable");
        }

        // Foreign-domain guard: the result must carry the canonical Lane 3
        // result shape AND state vocabulary (a cloned brand check already
        // fails above; this belt-and-braces check keeps the contract explicit).
        if (typeof executionResult.executionId !== "string" ||
            !executionResult.executionId ||
            (executionResult.state !== undefined &&
             !Object.values(RESULT_STATE3b).includes(executionResult.state))) {
            throw fail4(VREASONS4.FOREIGN_DOMAIN_RESULT,
                "execution result carries a foreign/non-canonical shape");
        }

        const expectedPostcondition = formExpectedPostcondition4(p.expectedPostcondition);
        const timeoutMs = (p.timeoutMs === undefined) ? DEFAULT_VTIMEOUT4
            : (isValidVTimeout4(p.timeoutMs) ? p.timeoutMs
                : (() => { throw fail4(VREASONS4.INVALID_TIMEOUT_CONFIG, `verify timeoutMs must be in [${MIN_VTIMEOUT4}, ${MAX_VTIMEOUT4}]`); })());

        // Resolve the bootstrap-owned verifier binding for this capability.op.
        const binding = verifierRegistry.resolve(executionResult.capabilityId, executionResult.operation);
        if (!binding) {
            throw fail4(VREASONS4.VERIFIER_NOT_FOUND,
                `no verifier registered for '${executionResult.capabilityId}.${executionResult.operation}'`);
        }
        // Incarnation discipline: verifier binding must match the capability
        // incarnation the execution ran under (ABA-safe).
        if (binding.capabilityIncarnationId !== executionResult.capabilityIncarnationId) {
            throw fail4(VREASONS4.VERIFIER_INCARNATION_MISMATCH,
                `verifier binding capability incarnation ${binding.capabilityIncarnationId} != result ${executionResult.capabilityIncarnationId}`);
        }
        if (binding.readiness !== VREADINESS4.READY) {
            throw fail4(VREASONS4.VERIFIER_UNAVAILABLE, `verifier readiness is ${binding.readiness}`);
        }

        const verificationId = crypto4.randomUUID();
        if (verificationsById.has(verificationId)) {
            throw fail4(VREASONS4.DUPLICATE_VERIFICATION_ID, "duplicate verificationId");
        }

        const requestedAtMs = canonicalClockNow4();
        const request = deepFreeze4({
            schemaVersion: VREQ_SCHEMA4,
            verificationId,
            executionId: executionResult.executionId,
            intentId: executionResult.intentId,
            capabilityId: executionResult.capabilityId,
            capabilityIncarnationId: executionResult.capabilityIncarnationId,
            operation: executionResult.operation,
            principal: executionResult.principal,
            scope: deepFreeze4(Array.isArray(executionResult.scope) ? executionResult.scope.slice() : []),
            actuatorId: executionResult.actuatorId,
            actuatorIncarnationId: executionResult.actuatorIncarnationId,
            authorityGeneration: executionResult.authorityGeneration,
            verifierId: binding.verifierId,
            verifierIncarnationId: binding.verifierIncarnationId,
            expectedPostcondition,
            requestedAtMs,
            timeoutMs
        });
        vRequestBrandSet4.add(request);

        // Duplicate suppression by executionId+postcondition content: a
        // concurrent verify of the same execution with the same expectation
        // must not produce duplicate observer effects where the observer has
        // side effects.
        const dupKey = crypto4.createHash("sha256").update(JSON.stringify({
            e: request.executionId,
            v: request.verifierIncarnationId,
            p: request.expectedPostcondition
        })).digest("hex");
        const existing = verificationsById.get(dupKey);
        if (existing) return existing.result;

        const rec = { request, result: null };
        verificationsById.set(dupKey, rec);
        verificationsById.set(verificationId, rec);

        // ---- OBSERVING (ZERO-TRAP DELIVERY) ----
        // TARGETED REPAIR 1: the observation value is UNTRUSTED at the moment
        // of receipt. Two language-level gadgets previously executed
        // attacker-controlled traps during delivery:
        //   (a) `await observe(...)` probes the RETURN value's `.then`
        //       (a `get` trap) to decide thenable-ness;
        //   (b) resolving a Promise with a hostile Proxy enqueues a
        //       PromiseResolveThenableJob that probes `.then` again.
        // The wrapper below NEVER reads `.then` off an unclassified value and
        // NEVER resolves a promise with an unclassified value:
        //   1. call observe() synchronously and take its raw return;
        //   2. classify the raw return with the zero-trap classifier
        //      (typeof / === / internal-slot isProxy only);
        //   3. hostile returns are delivered as a PLAIN sentinel object
        //      (boxing never probes the contained value);
        //   4. non-hostile thenables (genuine Promises from async observers)
        //      are awaited through the promise's OWN .then, and their
        //      resolved value is classified the same way before any use.
        // A hostile Proxy returned by an async observer still gets its
        // `.then` probed by the OBSERVER'S OWN async-function machinery at
        // return time — that probe belongs to the verifier's process, not to
        // Lane 4's classification; Lane 4 still classifies and rejects the
        // value with zero further traps.
        const observedAtMs = canonicalClockNow4();
        let observation = null;
        let verifierErrored = null;
        try {
            observation = await vRunObservation4(binding, request, executionResult, timeoutMs);
        } catch (e) {
            verifierErrored = e;
        }

        let verificationState;
        let observedEvidence = null;
        let detail = "";

        if (verifierErrored !== null) {
            // VERIFIER ERROR != VERIFIED FAILURE — infrastructure error is
            // classified separately; the world was not measured.
            verificationState = VSTATE4.ERROR;
            observedEvidence = sanitizeEvidence4(verifierErrored);
            if (observedEvidence === V_HOSTILE_SENTINEL4) observedEvidence = null;
            detail = "verifier infrastructure error";
        } else if (observation.kind === "timeout") {
            // VERIFICATION TIMEOUT: truth could not be established within the
            // bound. NOT success, NOT failure, NOT "no side effect".
            verificationState = VSTATE4.TIMED_OUT;
            detail = `verification exceeded ${timeoutMs}ms; ambiguity preserved`;
        } else if (observation.kind === "throw") {
            // Observe threw (sync or rejected promise): verifier
            // infrastructure error — sanitized plain {name,message} only.
            verificationState = VSTATE4.ERROR;
            observedEvidence = deepFreeze4({ name: observation.name, message: observation.message });
            detail = "verifier infrastructure error";
        } else if (observation.kind === "hostile") {
            // Hostile observation output (Proxy / revoked proxy / other
            // non-detached value, at the raw return OR nested inside
            // otherwise normal-looking evidence): rejected at the zero-trap
            // gate WITHOUT any attacker-controlled reflection. Fail closed:
            // verifier-infrastructure ERROR — never VERIFIED_SUCCESS, never
            // VERIFIED_FAILURE, and NOT INCONCLUSIVE "evidence".
            verificationState = VSTATE4.ERROR;
            observedEvidence = null;
            detail = HOSTILE_EVIDENCE_DETAIL4;
        } else if (observation.kind === "unsupported") {
            // TARGETED REPAIR 2: the observer used an UNSUPPORTED async
            // transport (a raw Promise return). Awaiting it would require
            // native thenable assimilation of its eventual resolution,
            // which executes attacker-controlled `then` behavior before
            // Lane 4 can classify the evidence. Fail closed: typed
            // observation-transport ERROR — never VERIFIED_SUCCESS, never
            // VERIFIED_FAILURE, never INCONCLUSIVE, and NEVER a
            // compensation trigger. The returned Promise object itself was
            // never assimilated by Lane 4 (no .then call, no await, no
            // Promise.resolve).
            verificationState = VSTATE4.ERROR;
            observedEvidence = null;
            detail = `unsupported async observation transport (${VREASONS4.UNSUPPORTED_ASYNC_RAW_RETURN}); async observers must complete through the trusted sink`;
        } else {
            // observation.kind === "value"
            const evidence = sanitizeEvidence4(observation.value);
            if (evidence === V_HOSTILE_SENTINEL4) {
                // Nested hostile value inside an otherwise plain-shaped
                // observation: same zero-trap fail-closed classification.
                verificationState = VSTATE4.ERROR;
                observedEvidence = null;
                detail = HOSTILE_EVIDENCE_DETAIL4;
            } else if (evidence === null && observation.value !== null && observation.value !== undefined) {
                // Unusable-but-benign observation output: not evidence.
                verificationState = VSTATE4.INCONCLUSIVE;
                detail = "observation could not be normalized into evidence";
            } else {
                observedEvidence = evidence;
                const verdict = evaluatePostcondition4(request.expectedPostcondition, evidence);
                if (verdict === "matched") {
                    verificationState = VSTATE4.VERIFIED_SUCCESS;
                } else if (verdict === "mismatched") {
                    verificationState = VSTATE4.VERIFIED_FAILURE;
                } else {
                    // Missing/ambiguous evidence stays INCONCLUSIVE — never
                    // collapsed into success or failure.
                    verificationState = VSTATE4.INCONCLUSIVE;
                    detail = "evidence missing or ambiguous for expected postcondition";
                }
            }
        }

        const result = deepFreeze4({
            schemaVersion: VRES_SCHEMA4,
            verificationId: request.verificationId,
            executionId: request.executionId,
            intentId: request.intentId,
            capabilityId: request.capabilityId,
            capabilityIncarnationId: request.capabilityIncarnationId,
            operation: request.operation,
            principal: request.principal,
            actuatorId: request.actuatorId,
            actuatorIncarnationId: request.actuatorIncarnationId,
            authorityGeneration: request.authorityGeneration,
            verifierId: request.verifierId,
            verifierIncarnationId: request.verifierIncarnationId,
            expectedPostcondition: request.expectedPostcondition,
            observedEvidence: deepFreeze4(observedEvidence),
            observationMethod: request.verifierId,
            verificationState,
            observedAtMs,
            verifiedAtMs: canonicalClockNow4(),
            detail
        });
        vResultBrandSet4.add(result);
        rec.result = result;
        return result;
    }

    // ---- compensate(): a NEW canonical action; never a direct call --------
    async function compensate(p) {
        if (p === null || typeof p !== "object") {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "compensate requires a request object");
        }
        for (const key of CALLER_VERIFIER_KEYS4) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail4(VREASONS4.CALLER_VERIFIER_REJECTED,
                    `caller-verifier option '${key}' is forbidden`);
            }
        }
        for (const key of CALLER_COMPENSATOR_KEYS4) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail4(VREASONS4.CALLER_EXECUTOR_REJECTED,
                    `caller-compensator option '${key}' is forbidden; compensation routes through the canonical Lane 3 facade`);
            }
        }

        // The compensation trigger must be a canonical verification result
        // produced by THIS closure (never a caller-forged lookalike).
        const source = p.verification;
        if (!vResultBrandSet4.has(source) || source === null || typeof source !== "object") {
            throw fail4(VREASONS4.NOT_CANONICAL_EXECUTION_RESULT,
                "compensation requires a canonical VerificationResult produced by this runtime");
        }
        // The verified state must itself indicate compensation is warranted.
        // Verifier timeout, INCONCLUSIVE, and ERROR states do NOT trigger
        // compensation (ambiguity is preserved, not resolved by re-actuation).
        if (source.verificationState !== VSTATE4.VERIFIED_FAILURE) {
            throw fail4(VREASONS4.COMPENSATION_NOT_INDICATED,
                `verification state '${source.verificationState}' does not indicate compensation; only VERIFIED_FAILURE does`);
        }

        // Plan inputs must be declarative plain values.
        const planCapabilityId = vRequireString4(p.capabilityId, "capabilityId", VBOUNDS4.MAX_CAPABILITY_ID_CHARS);
        const planOperation = vRequireString4(p.operation, "operation", VBOUNDS4.MAX_OPERATION_CHARS);
        const planPrincipal = vRequireString4(p.principal, "principal", VBOUNDS4.MAX_PRINCIPAL_CHARS);
        const planScope = canonicalScope3(Array.isArray(p.scope) ? p.scope : []);
        const paramsState = { nodes: 0, maxNodes: VBOUNDS4.MAX_PARAMETERS_NODES, path: new Set() };
        const planParameters = (p.parameters === undefined || p.parameters === null)
            ? deepFreeze4({}) : deepFreeze4(vDetach4(p.parameters, paramsState));
        if (Object.getOwnPropertyNames(planParameters).length > VBOUNDS4.MAX_COMPENSATION_PARAMETERS_KEYS) {
            throw fail4(VREASONS4.BOUND_EXCEEDED, `compensation parameters exceed ${VBOUNDS4.MAX_COMPENSATION_PARAMETERS_KEYS} keys`);
        }
        const reason = vRequireString4(p.reason, "reason", VBOUNDS4.MAX_COMPENSATION_REASON_CHARS);

        // IDEMPOTENCE: a caller may pin compensationId for exact-once retries.
        const compensationId = (p.compensationId === undefined || p.compensationId === null)
            ? crypto4.randomUUID()
            : vRequireString4(p.compensationId, "compensationId", VBOUNDS4.MAX_VERIFICATION_ID_CHARS);
        const existingRecord = compensationById.get(compensationId);
        if (existingRecord) {
            // Same id => SAME record; never a duplicate actuation.
            return existingRecord.result;
        }

        const createdAtMs = canonicalClockNow4();
        const plan = deepFreeze4({
            schemaVersion: CPLAN_SCHEMA4,
            compensationId,
            sourceVerificationId: source.verificationId,
            sourceExecutionId: source.executionId,
            principal: planPrincipal,
            capabilityId: planCapabilityId,
            capabilityIncarnationId: null,
            operation: planOperation,
            scope: planScope,
            parameters: planParameters,
            reason,
            createdAtMs
        });
        vPlanBrandSet4.add(plan);

        const record = { plan, result: null };
        compensationById.set(compensationId, record);

        // ---- COMPENSATION IS A NEW ACTION -------------------------------
        // (1) admit a fresh canonical ActionIntent for the compensation,
        // (2) route through the Lane 3 facade execute() — which performs
        //     fresh Lane 2 revalidation against CURRENT authority,
        // (3) report execution state; restoration is NEVER claimed here.
        let intent;
        try {
            intent = lane3FacadeAdmit4({
                capabilityId: planCapabilityId,
                operation: planOperation,
                arguments: planParameters
            });
        } catch (e) {
            const result = deepFreeze4({
                schemaVersion: CRES_SCHEMA4,
                compensationId,
                sourceVerificationId: plan.sourceVerificationId,
                sourceExecutionId: plan.sourceExecutionId,
                state: CSTATE4.FAILED,
                executionResult: null,
                detail: `compensation intent rejected at admission: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                restored: null
            });
            record.result = result;
            return result;
        }

        const session = planPrincipal ? lane3Session4(planPrincipal) : null;
        let executionResult = null;
        if (!session) {
            const result = deepFreeze4({
                schemaVersion: CRES_SCHEMA4,
                compensationId,
                sourceVerificationId: plan.sourceVerificationId,
                sourceExecutionId: plan.sourceExecutionId,
                state: CSTATE4.FAILED,
                executionResult: null,
                detail: "compensation session could not be established (fail-closed)",
                restored: null
            });
            record.result = result;
            return result;
        }

        try {
            executionResult = await lane3Facade.execute({
                intent,
                authSession: session,
                parameters: planParameters
            });
        } catch (e) {
            const result = deepFreeze4({
                schemaVersion: CRES_SCHEMA4,
                compensationId,
                sourceVerificationId: plan.sourceVerificationId,
                sourceExecutionId: plan.sourceExecutionId,
                state: CSTATE4.FAILED,
                executionResult: null,
                detail: `compensation dispatch failed: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                restored: null
            });
            record.result = result;
            return result;
        }

        const executedOk = executionResult && executionResult.state === "EXECUTED";
        const result = deepFreeze4({
            schemaVersion: CRES_SCHEMA4,
            compensationId,
            sourceVerificationId: plan.sourceVerificationId,
            sourceExecutionId: plan.sourceExecutionId,
            state: executedOk ? CSTATE4.EXECUTED : CSTATE4.FAILED,
            executionResult,
            detail: executedOk
                ? "compensation action executed through canonical Lane 3; restoration NOT claimed until a fresh verification succeeds"
                : "compensation action did not execute",
            // COMPENSATION != ROLLBACK GUARANTEE: restored is null here. Only
            // a SEPARATE fresh verification of the compensation's own
            // postcondition returning VERIFIED_SUCCESS may ever claim
            // restoration — and even then it is verified per-postcondition,
            // never a blanket rollback.
            restored: null
        });
        record.result = result;
        return result;
    }

    // ---- Lane 2/Lane 3 canonical routing helpers (closure-private) --------
    // admit a compensation intent + mint a session through the canonical
    // Lane 2 facade. The canonical action facade fails closed on
    // authentication, so compensation through THIS production closure fails
    // closed at the session step unless a trusted lane wires real auth —
    // exactly like every other canonical action path.
    function lane3FacadeAdmit4({ capabilityId, operation, arguments: args }) {
        const lane2 = createCanonicalActionFacade();
        const serialized = JSON.stringify({
            schemaVersion: 1,
            capabilityId,
            operation,
            arguments: args
        });
        return lane2.admit(serialized, { source: "lane4-compensation" });
    }

    function lane3Session4(principal) {
        // The canonical authentication path is bootstrap-owned and
        // FAILS CLOSED (canonicalAuthAdapter returns null). Compensation
        // therefore cannot mint a session from caller input — mirroring the
        // production trust model until real auth infrastructure is wired INTO
        // the bootstrap by a later lane. Tests exercise the full authorized
        // path through the test-only harness (tests/verification/harness.js).
        try {
            const lane2 = createCanonicalActionFacade();
            return lane2.session({ claimedPrincipal: principal });
        } catch {
            return null;
        }
    }

    canonicalVerification = Object.freeze({
        // least-privilege downstream surface
        verify,
        compensate,

        // PURE brand-recognition predicates — BRAND-FIRST: closure-only
        // WeakSet membership decides before any property read.
        isCanonicalVerificationRequest(value) {
            if (value === null || typeof value !== "object") return false;
            if (!vRequestBrandSet4.has(value)) return false;
            return true;
        },
        isCanonicalVerificationResult(value) {
            if (value === null || typeof value !== "object") return false;
            if (!vResultBrandSet4.has(value)) return false;
            return true;
        },
        isCanonicalCompensationPlan(value) {
            if (value === null || typeof value !== "object") return false;
            if (!vPlanBrandSet4.has(value)) return false;
            return true;
        }
    });
    return canonicalVerification;
}

// Options that must NEVER be accepted from a verify/compensate caller: the
// verifier/compensator functions are bootstrap-owned and captured at trusted
// registration time.
const CALLER_VERIFIER_KEYS4 = Object.freeze([
    "verifier", "verifierFn", "observe", "observeFn", "sensor", "sensorFn",
    "predicate", "predicateFn", "evaluator", "evaluatorFn", "checker",
    "checkFn", "postconditionFn", "verifyFn"
]);
const CALLER_COMPENSATOR_KEYS4 = Object.freeze([
    "compensator", "compensatorFn", "rollback", "rollbackFn", "repair",
    "repairFn", "undo", "undoFn", "restore", "restoreFn", "compensateFn"
]);
const TIMEOUT_SENTINEL4 = Symbol("damar.action.verification.timeout");

// The ONE canonical verification facade, created exactly once, lazily.
function isCanonicalExecutionResult4(value) {
    // Reuse the Lane 3 brand check through the canonical actuation facade —
    // the ONLY trusted path to brand membership.
    return createCanonicalActuationFacade().isCanonicalExecutionResult(value);
}

module.exports = {
    createCanonicalActionFacade,
    createCanonicalActuationFacade,
    createCanonicalVerificationFacade,
    PRIVILEGED_KEYS
};
