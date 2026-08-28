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
// LANE 3 — CANONICAL ACTUATION COMPOSITION (private closure, bootstrap-owned).
//
// The Lane 3 dispatcher is composed over the canonical Lane 2 facade, with an
// actuator registry whose registrar capability is owned by THIS closure.
// Downstream NEVER receives the registrar: it receives only the frozen
// { execute } capability. Fresh canonical Lane 2 revalidation happens INSIDE
// execute() — there is no bearer-decision path and no caller-selectable
// actuator.
//
// LANE 2 SEMANTICS UNCHANGED: this extension adds composition only; the
// certified Lane 2 evaluate/admit surface is consumed, never modified.
// ---------------------------------------------------------------------------

const { composeDispatcher } = require("./actuation/dispatcher");
const { buildActuatorRegistry } = require("./actuation/actuatorRegistry");

// The ONE canonical dispatcher, created exactly once, lazily, on first use.
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
        const actuatorRegistry = buildActuatorRegistry();
        const dispatcher = composeDispatcher({
            lane2Facade,
            actuatorRegistry,
            clock: { nowMs: () => Date.now() }
        });
        // Downstream receives ONLY execute. The registrar capability
        // (registerActuator/removeActuator) stays in this closure for the
        // trusted runtime layer's own actuator wiring (a later lane wires real
        // actuators; Lane 3 ships the fabric + tests wire test actuators via
        // the test-only harness).
        canonicalActuation = Object.freeze({
            execute: dispatcher.execute
        });
    }
    return canonicalActuation;
}

module.exports = {
    createCanonicalActionFacade,
    createCanonicalActuationFacade,
    PRIVILEGED_KEYS
};
