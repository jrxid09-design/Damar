"use strict";

/**
 * ACTION AUTHORITY GATE V1 — TRUSTED TEST BOOTSTRAP (seventh targeted repair).
 *
 * TEST-ONLY COMPOSITION HARNESS. Lives under tests/ and is explicitly NOT
 * reachable from src/action production exports. It defines its OWN private
 * mirror of the trusted composition (the same composition functions the
 * production trusted bootstrap defines in ITS private closure) so tests can:
 *
 *   - inject controlled test authenticators (per-harness trust domains)
 *   - seed authority (grantAuthority) and register capabilities
 *   - compose isolated trust domains for cross-domain replay proofs
 *
 * PRODUCTION SEPARATION (seventh repair):
 *   production: src/action/bootstrap.js
 *       createCanonicalActionFacade()  — takes NO options; fixed fail-closed
 *                                        bootstrap-owned auth adapter; facade
 *                                        is EXACTLY { admit, evaluate,
 *                                        authenticate, session }
 *   tests:      tests/action/bootstrapHarness.js (THIS file)
 *       makeHarness({ authenticate, scopeBindings }) — per-test trust domain
 *       with controlled auth + seeding helpers
 *
 * The test harness is NOT a public trust factory: it is not exported from
 * src/action, requires an explicit tests/ file path to reach, and grants no
 * access to the canonical runtime's brand, state, or facade.
 */

const { createCapabilityRuntime } = require("../../src/capability/registry");
const { createMemoryAuthorityStore } = require("../../src/authority/store");
const { fail, REASONS } = require("../../src/action/errors");
const { extractAuthenticatedPrincipal } = require("../../src/action/authDomain");
const { AUTH_TELEMETRY_KEYS } = require("../../src/action/authSession");
const {
    parseActionIntent, canonicalScope, validateTimestamp, isValidIncarnationId
} = require("../../src/action/intent");
const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../../src/authority/evaluate");
const { captureClock } = require("../../src/action/clock");
const { DECISION, GATE_REASONS, ALLOW_REASON, validateAuthorityEvaluation } = require("../../src/action/gate");

// ---------------------------------------------------------------------------
// TEST-ONLY PRIVATE COMPOSITION MIRROR
// (same semantics as the production bootstrap's private closure; kept here
// so the test harness never touches production privileged surfaces)
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

/** TEST-ONLY AuthenticationDomain composition (private to this harness). */
function composeTestAuthenticationDomain({ authenticate, clock = { nowMs: () => Date.now() } } = {}) {
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

    const sessionBrand = new WeakSet();
    let sessionCount = 0;

    function mintAuthenticatedSession(authResult, evidence) {
        const principal = extractAuthenticatedPrincipal(authResult);

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

    function authenticateEvidence(evidence) {
        let authResult;
        try {
            authResult = authenticate(evidence);
        } catch {
            return null; // fail closed
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

/** TEST-ONLY action authority runtime composition (private to this harness). */
function composeTestActionAuthorityRuntime({
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
    if (!authVerifier || typeof authVerifier !== "object") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "runtime requires a pre-bound authVerifier capability");
    }
    if (typeof authVerifier.verify !== "function") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "authVerifier must expose verify(session)");
    }

    const registry = capabilityRuntime.registry;
    const capturedClock = captureClock(clock);
    const verifySession = authVerifier.verify;

    const scopeLookup = new Map();
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

    return Object.freeze({
        admit,
        evaluate: (intent, authSession) => evaluateGate(intent, authSession)
    });
}

// ---------------------------------------------------------------------------
// TEST HARNESS API
// ---------------------------------------------------------------------------

const CLOCK_START = 1_000_000;

function manualClock(startMs = CLOCK_START) {
    let t = startMs;
    return {
        nowMs: () => t,
        nowIso: () => new Date(t).toISOString(),
        advance(ms) { t += ms; return t; },
        get value() { return t; }
    };
}

function defaultScopeResolver(args) {
    const target = args && typeof args.target === "string" ? args.target.trim().toLowerCase() : "";
    return target ? [target] : [];
}

/** Trusted test authenticator: accepts whatever principal bootstrap asserts
 *  (mirrors external trusted auth infra bound during bootstrap). */
function authenticate(evidence) {
    const p = evidence && typeof evidence === "object" ? evidence.claimedPrincipal : null;
    if (typeof p === "string" && p.length > 0) {
        return { principal: p };
    }
    return null;
}

/**
 * Build the canonical trusted test harness.
 *   { registry, registrars, store, clock, authDomain, rt, session,
 *     mintAuthSession, registerCapability, grantAuthority, admit, evaluate,
 *     gate }
 */
async function makeHarness({ clock, scopeBindings, authenticate: authenticateFn = authenticate } = {}) {
    const c = clock ?? manualClock();
    const capabilityRuntime = createCapabilityRuntime({
        registrars: { core: true },
        clock: { nowMs: () => c.nowMs() }
    });
    const store = createMemoryAuthorityStore();

    const bindings = scopeBindings ?? {
        "filesystem.read": { read: defaultScopeResolver, write: defaultScopeResolver },
        "filesystem.write": { write: defaultScopeResolver }
    };

    // ---- trusted test bootstrap: AuthenticationDomain established INSIDE
    // this closure over the controlled test authenticator. ----
    const authDomain = composeTestAuthenticationDomain({
        authenticate: authenticateFn,
        clock: { nowMs: () => c.nowMs() }
    });
    const rt = composeTestActionAuthorityRuntime({
        capabilityRuntime,
        authorityStore: store,
        authVerifier: authDomain.verifier,
        trustedScopeBindings: bindings,
        clock: { nowMs: () => c.nowMs() }
    });

    async function registerCapability(overrides = {}) {
        const descriptor = {
            schemaVersion: 1,
            id: "filesystem.read",
            kind: "system",
            provider: "core",
            operations: ["read"],
            requirements: [],
            effects: [],
            ...overrides
        };
        return capabilityRuntime.registrars.core.register(JSON.stringify(descriptor));
    }

    async function grantAuthority({ capabilityId = "filesystem.read", subject = "alice", actions = ["read"], scope = [], generation = 0, identityBinding = null } = {}) {
        const grant = {
            capabilityId, kind: "root", subject,
            issuer: "owner-ratification:test",
            actions, scope, allowedPurposes: [],
            restrictions: { kind: "unrestricted" }, maxExecutions: null, usedExecutions: 0,
            issuedAt: "2025-01-01T00:00:00Z", notBefore: null, expiresAt: null,
            status: "ACTIVE", generation, delegationDepth: 0, remainingDelegationDepth: 2,
            parentCapabilityId: null, rootCapabilityId: capabilityId, ratificationId: null,
            identityBinding, extra: null
        };
        await store.upsertCapability(capabilityId, "ACTIVE", generation, JSON.stringify(grant));
    }

    function session(principal = "alice", extra = {}) {
        const evidence = { claimedPrincipal: principal, ...extra };
        const s = authDomain.authenticate(evidence);
        if (!s) throw new (require("../../src/action/errors").ActionError)(REASONS.AUTH_FAILED, "test authenticate failed closed; no session minted");
        return s;
    }

    function mintAuthSession(evidence) {
        return authDomain.authenticate(evidence);
    }

    return {
        registry: capabilityRuntime.registry,
        registrars: capabilityRuntime.registrars,
        store, clock: c, authDomain, rt,
        session,
        mintAuthSession,
        admit: rt.admit,
        evaluate: rt.evaluate,
        gate: rt,
        registerCapability, grantAuthority
    };
}

/**
 * Build a SECOND, structurally-identical but brand-distinct trust domain for
 * cross-domain / cross-runtime replay proofs. The returned domain is a
 * SEPARATE trust domain: its session brand is independent, and a session
 * minted here is NEVER valid on the harness runtime (and vice versa), even
 * when composed over the same registry+store.
 */
function composeIsolatedTrustDomain({
    clock = { nowMs: () => 1000 },
    authenticate: authenticateFn = authenticate,
    capabilityRuntime = null,
    authorityStore = null,
    trustedScopeBindings = { "cap.x": { read: (a) => (a && a.target ? [a.target] : []) } }
} = {}) {
    const capRt = capabilityRuntime ?? createCapabilityRuntime({ registrars: { core: true }, clock });
    const store = authorityStore ?? createMemoryAuthorityStore();
    const authDomain = composeTestAuthenticationDomain({ authenticate: authenticateFn, clock });
    const rt = composeTestActionAuthorityRuntime({
        capabilityRuntime: capRt,
        authorityStore: store,
        authVerifier: authDomain.verifier,
        trustedScopeBindings,
        clock
    });
    return { capabilityRuntime: capRt, authorityStore: store, authDomain, rt };
}

/**
 * Trusted-bootstrap test facility: compose an internal runtime over an
 * ARBITRARY authority store (hostile/failing stores for the fail-closed
 * matrix). Test-only; not part of any public/downstream API.
 */
function composeRuntimeOverStore({
    authorityStore,
    capabilityRuntime = null,
    clock = { nowMs: () => 1000 },
    runtimeClock = null,
    authenticate: authenticateFn = authenticate,
    trustedScopeBindings = { "filesystem.read": { read: (a) => (a && a.target ? [a.target] : []) } },
    authDomain = null
} = {}) {
    const capRt = capabilityRuntime ?? createCapabilityRuntime({ registrars: { core: true }, clock });
    const domain = authDomain ?? composeTestAuthenticationDomain({ authenticate: authenticateFn, clock });
    const rt = composeTestActionAuthorityRuntime({
        capabilityRuntime: capRt,
        authorityStore,
        authVerifier: domain.verifier,
        trustedScopeBindings,
        clock: runtimeClock ?? clock
    });
    return { capabilityRuntime: capRt, authorityStore, authDomain: domain, rt };
}

module.exports = {
    manualClock,
    makeHarness,
    composeIsolatedTrustDomain,
    composeRuntimeOverStore,
    defaultScopeResolver,
    authenticate,
    CLOCK_START
};
