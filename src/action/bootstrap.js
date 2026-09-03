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
 *
 * Wave 5 Lane 4: the canonical Owner/Admin proof verifier is installed by the
 * SEALED Owner trust composition root through the module-private slot below.
 * The slot is module-private state; the adapter calls it ONLY for canonical
 * proof evidence and fail-closes otherwise.  There is deliberately NO public
 * configuration option on createCanonicalActionFacade and NO enumerable
 * setter on the production facade.  The sealed root installs the verifier at
 * canonical composition time; once installed the slot is first-wins and a
 * later replacement is rejected, so an ordinary importer cannot substitute a
 * verifier of its own after the canonical composition has run.
 */
let ownerAuthVerifier = null;
let ownerAuthVerifierInstalled = false;

/**
 * MODULE-PRIVATE, NON-ENUMERABLE — reachable ONLY by the sealed Owner trust
 * composition root (src/authority/ownerTrustComposition), never by public DI
 * or a caller-controlled callback.  First-wins: a second installation attempt
 * is ignored, so the canonical composition (which runs at startup) cannot be
 * displaced by later code.
 */
function setOwnerAuthVerifierInternal(verifier) {
    if (ownerAuthVerifierInstalled) {
        return false; // first-wins: never displaced
    }
    if (typeof verifier !== "function") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED,
            "Owner auth verifier must be a function");
    }
    ownerAuthVerifier = verifier;
    ownerAuthVerifierInstalled = true;
    return true;
}

function canonicalAuthAdapter(evidence) {
    if (ownerAuthVerifier === null) {
        return null; // fail closed: no owner-auth infrastructure installed
    }
    try {
        return ownerAuthVerifier(evidence);
    } catch {
        return null; // fail closed: verifier fault never mints
    }
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

// ---------------------------------------------------------------------------
// LANE 4 — CANONICAL VERIFICATION + COMPENSATION COMPOSITION (TARGETED
// REPAIR 4: the production implementation now lives in the TRUSTED INTERNAL
// module src/action/internal/verificationBootstrap.js and is extracted
// VERBATIM. This bootstrap simply wires the production composition with NO
// test verifiers; the test-only production harness
// (tests/verification/productionHarness.js) calls the SAME internal
// composition with test-supplied verifier definitions so R3 certification
// proofs exercise the REAL production code path, not a test-domain mirror.
//
// No privileged surface is added: the internal module exports ONLY
// createCanonicalVerificationComposition (a trusted composition factory),
// which is NOT re-exported through src/action/index.js and is NOT reachable
// through the canonical facade. Ordinary downstream still receives exactly
// { verify, compensate, isCanonical* }.
// ---------------------------------------------------------------------------

const { createCanonicalVerificationComposition } = require("./internal/verificationBootstrap");

let canonicalVerification = null;

/**
 * Create the canonical Lane 4 verification/compensation facade
 * (trusted-bootstrap-private). Takes NO options — the verifier registry,
 * observation functions, postcondition evaluator, and the Lane 3 facade it
 * routes compensation through are all owned by the trusted composition.
 * Caller-selected verifiers/compensators are structurally impossible to
 * inject. Production composes with NO trusted test verifiers.
 *
 * @returns {object} frozen least-privilege facade, EXACTLY:
 *     { verify, compensate, isCanonicalVerificationRequest,
 *       isCanonicalVerificationResult, isCanonicalCompensationPlan }
 */
function createCanonicalVerificationFacade() {
    if (arguments[0] !== undefined) {
        const { REASONS: VREASONS_L4 } = require("./verification/errors");
        throw fail(VREASONS_L4.CALLER_EXECUTOR_REJECTED,
            "canonical verification creation accepts NO options; the verifier registry, observation functions, postcondition evaluator, and the Lane 3 facade are bootstrap-owned");
    }
    if (canonicalVerification === null) {
        canonicalVerification = createCanonicalVerificationComposition({
            deps: {
                createLane3Facade: createCanonicalActuationFacade,
                createLane2Facade: createCanonicalActionFacade
            },
            trustedVerifiers: [] // PRODUCTION: no test verifiers, ever
        });
    }
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

// Non-enumerable internal seam for the sealed Owner trust composition root
// (src/authority/ownerTrustComposition).  NOT on the public production facade
// { admit, evaluate, authenticate, session }; NOT reachable by public DI; and
// first-wins so the canonical composition cannot be displaced by later code.
Object.defineProperty(module.exports, "_setOwnerAuthVerifier", {
    value: setOwnerAuthVerifierInternal,
    enumerable: false,
    writable: false,
    configurable: false
});
