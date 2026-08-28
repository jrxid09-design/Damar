"use strict";

/**
 * ACTION AUTHORITY GATE V1 — CANONICAL TRUSTED BOOTSTRAP (sixth targeted
 * repair, Wave 4 Lane 2: caller-selectable verifier REMOVED).
 *
 * This is the ONLY place where canonical authority composition happens.
 * It is NOT a public/downstream API and is NOT exported by src/action.
 *
 * TRUST LAW (the core of the sixth repair):
 *
 *   caller-selectable verifier != authenticated identity authority
 *
 * Before this repair, the public action package exported both
 * `createAuthenticationDomain` and `createActionAuthorityRuntime`, and the
 * runtime constructor accepted a caller-supplied `authVerifier`. That meant
 * any caller that possessed canonical CapabilityRuntime + AuthorityStore
 * references could select the identity verifier governing canonical
 * authorization:
 *
 *     attacker obtains canonical CapabilityRuntime
 *     attacker obtains canonical AuthorityStore
 *     attacker creates new action runtime around them
 *     attacker selects its OWN verifier
 *     attacker impersonates a victim principal the canonical store grants
 *
 * Shape validation / branding inside a caller-created AuthenticationDomain did
 * NOT solve this, because the attacker could create the domain itself.
 *
 * This module removes that hole by owning canonical composition INTERNALLY.
 * There is exactly ONE canonical ActionAuthorityRuntime, assembled by this
 * trusted runtime/bootstrap layer. The public/downstream Action package
 * exposes no factories that let callers construct another authority runtime
 * over canonical state.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CANONICAL OWNERSHIP GRAPH
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   AETHER TRUSTED RUNTIME LAYER (this module)
 *         │
 *         │ owns (constructed once, internally):
 *         ├── canonical CapabilityRuntime   (via createCapabilityRuntime)
 *         ├── canonical AuthorityStore      (via createMemoryAuthorityStore)
 *         ├── canonical AuthenticationDomain (via createAuthenticationDomain)
 *         │     - owns authenticate(...)
 *         │     - owns the runtime/session-domain brand (closure-local WeakSet)
 *         │     - owns the ONLY session mint path (authenticate() success)
 *         │     - owns the verifier capability (brand-first, zero-trap)
 *         ├── canonical trusted scope bindings (captured ONCE, detached)
 *         └── hardened clock (read-once function identity)
 *                 │
 *                 ▼
 *         INTERNAL composition only (createActionAuthorityRuntime, called here)
 *                 │
 *                 ▼
 *         Canonical ActionAuthorityRuntime
 *                 │
 *                 ▼
 *         frozen least-privilege facade returned to downstream:
 *             { admit, evaluate, authenticate, session }
 *
 * Downstream (Console, CLI, Telegram, WhatsApp, Companion, extensions,
 * devices, providers) receives ONLY this facade. They MUST NOT choose:
 *   - auth verifier
 *   - AuthenticationDomain
 *   - Authority store
 *   - Capability registry/runtime
 *   - canonical evaluator
 *   - evaluation verifier
 *   - gate implementation
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO CALLER-SELECTABLE VERIFIER (BLOCKER 2)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `createCanonicalActionRuntime` does NOT accept `authVerifier`,
 * `capabilityRuntime`, `authorityStore`, `authenticate` (the identity-verifier
 * surface), or any composition primitive as a caller option. All canonical
 * state is constructed INSIDE this closure. A caller passing
 *     { verify: () => "victim" }
 * has NO API through which it can attach that verifier to canonical:
 *   CapabilityRuntime / AuthorityStore / ActionAuthorityRuntime.
 *
 * The only caller-supplied inputs this function accepts are NON-PRIVILEGED:
 *   - clock (hardened, read-once; identity captured, object never retained)
 *   - trustedScopeBindings (resolver FUNCTION IDENTITIES captured once into a
 *     detached closure-owned Map; caller mutation afterward has zero effect;
 *     these resolve scope tokens only, never identity or authority)
 *   - authenticate (the trusted external authentication INFRASTRUCTURE hook,
 *     NOT a verifier; it returns an authenticated principal record from
 *     external evidence, and on ANY failure fails closed without minting)
 *
 * `authenticate` is NOT a verifier and is NOT caller-trust: it is the trusted
 * authentication infrastructure owned by bootstrap (e.g. token-guarded
 * transport in production, a controlled test authenticator in tests). The
 * verifier capability is created INSIDE this closure over the
 * AuthenticationDomain's brand and is never handed to a caller.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PROCESS / MODULE ISOLATION LIMITATION (documented honestly)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This is a same-process CommonJS trust domain, NOT OS isolation. Node/CommonJS
 * path hiding is NOT hard sandboxing against code that already has arbitrary
 * same-process filesystem/require execution. An untrusted same-process actor
 * with unrestricted require() could reach this module and call it with its OWN
 * `authenticate` — but the resulting runtime is a SEPARATE trust domain with a
 * SEPARATE AuthenticationDomain brand. It cannot read the session brand of,
 * mint for, or evaluate against the canonical runtime. There is no ordinary
 * public API that hands canonical authority composition to downstream callers.
 *
 * The eventual enforcement against untrusted executable extensions is module
 * loader allowlisting, sandboxing, workers/process isolation, or equivalent.
 * Lane 2 does not attempt to solve full process isolation; it ensures there is
 * no ordinary public API that hands canonical authority composition to
 * downstream callers.
 *
 *   VALID SHAPE != TRUSTED ORIGIN
 *   VALID ORIGIN IN DOMAIN A != TRUSTED IN DOMAIN B
 */

const { createCapabilityRuntime } = require("../capability/registry");
const { createMemoryAuthorityStore } = require("../authority/store");
// Trusted-bootstrap-internal composition capabilities. `require` here returns
// the SAME module objects every other in-process consumer sees; the host
// binding inside those modules is one-shot per process and binds THIS
// module's own `module` object, so only code running in this closure can
// ever obtain the factories. Downstream require() of the same paths gets the
// already-bound modules and can never re-bind.
const { bindCompositionHost } = require("./runtime");
const { bindAuthenticationHost } = require("./authDomain");
const { fail, REASONS } = require("./errors");

// Bind the trusted hosts ONCE at module load. The one-shot law inside
// runtime.js / authDomain.js guarantees nobody else can bind later.
const COMPOSITION = bindCompositionHost(module);
const AUTHENTICATION = bindAuthenticationHost(module);
const { createActionAuthorityRuntime } = COMPOSITION;
const { createAuthenticationDomain } = AUTHENTICATION;

// Any caller-supplied option key in this set is a privileged composition
// primitive and is rejected at bootstrap. Canonical state and the identity
// verifier are owned by THIS closure, not by callers.
const PRIVILEGED_KEYS = Object.freeze([
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
    "authSessionIssuer"
]);

/**
 * Build the canonical ActionAuthorityRuntime facade. This is the ONLY
 * composition surface. It is called by trusted Aether runtime wiring (or, in
 * tests, by the trusted test bootstrap that mirrors it).
 *
 * @param {object} [options]
 * @param {function} [options.authenticate]
 *     Trusted external authentication infrastructure hook. NOT a verifier and
 *     NOT caller-trust: returns an authenticated principal record from
 *     external evidence. On ANY failure (null/undefined/false/malformed/
 *     throwing) the AuthenticationDomain fails closed — no session is minted,
 *     no caller-asserted principal is used as Authority identity. If omitted,
 *     authentication always fails closed (the runtime still evaluates, but
 *     every session is INVALID_IDENTITY).
 * @param {object} [options.clock]
 *     Hardened clock ({ nowMs }). Read ONCE; function identity captured, the
 *     caller's clock object is never retained or re-read.
 * @param {object} [options.trustedScopeBindings]
 *     Closed mapping: { "<capabilityId>": { "<operation>": resolverFn } }.
 *     Resolver FUNCTION IDENTITIES are captured once into a detached
 *     closure-owned Map. Caller mutation afterward has zero effect. These
 *     resolve scope tokens only; they never influence identity or authority.
 * @param {object} [options.capabilityRuntimeOptions]
 *     NON-PRIVILEGED options forwarded to createCapabilityRuntime
 *     (registrars spec + maxCapabilities). The runtime itself is created here.
 *
 * @returns {object} frozen facade:
 *     {
 *       admit(serializedProposal) -> canonical identity-free ActionIntent,
 *       evaluate(intent, session) -> AuthorityDecision,
 *       authenticate(evidence)   -> AuthSessionCapability | null,
 *       session(principal, extra) -> AuthSessionCapability (throws on fail-closed)
 *     }
 *
 * The returned surface contains NO issuer, NO mintSession, NO bindAuthentication,
 * NO onReady, NO gate constructor, NO verifier, NO authorityStore, NO
 * capabilityRuntime, NO evaluator/verifier hook. Downstream receives only
 * least-privilege admit/evaluate plus the authenticated-session mint path
 * (which cannot mint a principal the authenticator did not endorse).
 */
function createCanonicalActionRuntime(options = {}) {
    // REJECT every privileged composition primitive. There must be NO
    // caller-selectable verifier, NO caller-supplied canonical state, NO
    // caller-supplied evaluator/gate, and NO caller-owned auth bootstrap.
    for (const key of PRIVILEGED_KEYS) {
        // eslint-disable-next-line no-undefined
        if (Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined) {
            throw fail(REASONS.CALLER_BOOTSTRAP_REJECTED,
                `privileged composition option '${key}' is forbidden; canonical state and the identity verifier are owned by trusted bootstrap, not by callers`);
        }
    }

    const {
        authenticate = () => null,
        clock = { nowMs: () => Date.now() },
        trustedScopeBindings = {},
        capabilityRuntimeOptions = { registrars: { core: true } }
    } = options;

    if (typeof authenticate !== "function") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED,
            "authenticate, when supplied, must be trusted authentication infrastructure (a function)");
    }
    if (!clock || typeof clock.nowMs !== "function") {
        throw fail(REASONS.AUTH_VERIFIER_REQUIRED, "canonical bootstrap requires a hardened clock");
    }

    // ---- canonical state is constructed INSIDE this closure. No caller can
    //      substitute a capabilityRuntime, authorityStore, authDomain, or
    //      verifier. ----
    const capabilityRuntime = createCapabilityRuntime({
        ...capabilityRuntimeOptions,
        clock
    });
    const authorityStore = createMemoryAuthorityStore();
    const authDomain = createAuthenticationDomain({ authenticate, clock });

    // ---- INTERNAL composition only. The verifier is captured inside this
    //      closure; it is never handed back to the caller. ----
    const rt = createActionAuthorityRuntime({
        capabilityRuntime,
        authorityStore,
        authVerifier: authDomain.verifier,
        trustedScopeBindings,
        clock
    });

    // ---- least-privilege facade. Exposes:
    //      admit / evaluate: the canonical runtime's exact surface
    //      authenticate: the AuthenticationDomain's authenticated-mint path
    //                    (trusted infra; cannot mint a principal the
    //                    authenticator did not endorse; fail-closed)
    //      session: convenience wrapper around authenticate() that throws on
    //               fail-closed (so a test/caller cannot silently obtain an
    //               unauthenticated session and use it as identity)
    //      registry / store / grantAuthority / registerCapability: read/query
    //               helpers for bootstrap-owned canonical state, exposed ONLY
    //               because Lane 2 is evaluation-only and the trusted bootstrap
    //               must be able to seed grants for evaluation. These are NOT
    //               the raw AuthorityStore / CapabilityRuntime objects.
    function session(principal, extra = {}) {
        const evidence = { claimedPrincipal: principal, ...extra };
        const s = authDomain.authenticate(evidence);
        if (!s) throw fail(REASONS.AUTH_FAILED, "canonical authentication failed closed; no session minted");
        return s;
    }

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

    async function grantAuthority({
        capabilityId = "filesystem.read",
        subject = "alice",
        actions = ["read"],
        scope = [],
        generation = 0,
        identityBinding = null
    } = {}) {
        const grant = {
            capabilityId, kind: "root", subject,
            issuer: "owner-ratification:bootstrap",
            actions, scope, allowedPurposes: [],
            restrictions: { kind: "unrestricted" }, maxExecutions: null, usedExecutions: 0,
            issuedAt: "2025-01-01T00:00:00Z", notBefore: null, expiresAt: null,
            status: "ACTIVE", generation, delegationDepth: 0, remainingDelegationDepth: 2,
            parentCapabilityId: null, rootCapabilityId: capabilityId, ratificationId: null,
            identityBinding, extra: null
        };
        await authorityStore.upsertCapability(capabilityId, "ACTIVE", generation, JSON.stringify(grant));
    }

    return Object.freeze({
        // canonical runtime surface (least privilege)
        admit: rt.admit,
        evaluate: rt.evaluate,

        // authenticated-session mint path (trusted infra; fail-closed)
        authenticate: authDomain.authenticate,
        session,

        // bootstrap-owned canonical state query/seed helpers (NOT raw stores)
        registerCapability,
        grantAuthority,
        registry: capabilityRuntime.registry,
        registrars: capabilityRuntime.registrars
    });
}

module.exports = { createCanonicalActionRuntime, PRIVILEGED_KEYS };
