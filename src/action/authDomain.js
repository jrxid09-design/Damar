"use strict";

/**
 * ACTION AUTHORITY GATE V1 — AuthenticationDomain (SIXTH targeted repair,
 * Wave 4 Lane 2: caller-selectable verifier REMOVED).
 *
 * TRUST SPLIT (sixth repair — AuthenticationDomain ownership):
 *
 *   1. AuthenticationDomain (THIS module)
 *        - created ONLY by trusted Aether bootstrap (src/action/bootstrap.js)
 *          INSIDE its own closure, OUTSIDE any public API
 *        - owns authenticate(...): resolves external channel/session evidence
 *          to an authenticated principal record
 *        - owns the ONLY session mint path: authenticate() success is the sole
 *          way a session enters this domain's brand. There is no mintSession
 *          capability that accepts caller-invented principals.
 *        - owns the runtime/session-domain brand (closure-local WeakSet) and
 *          the session verifier capability
 *
 *   2. ActionAuthorityRuntime (src/action/runtime.js)
 *        - receives ONLY the already-established verifier capability
 *          (authVerifier) from trusted bootstrap
 *        - DOES NOT mint users, DOES NOT authenticate arbitrary principal
 *          strings, DOES NOT own any bootstrap callback
 *        - evaluates only sessions proven by this AuthenticationDomain
 *
 * AUTHENTICATION DOMAIN OWNERSHIP LAW (Blocker 3, sixth repair):
 *   `createAuthenticationDomain` is NOT a module export. A downstream caller
 *   can no longer do
 *       createAuthenticationDomain({ authenticate: () => ({principal:"victim"}) })
 *   and use that domain as canonical identity authority. Canonical trust
 *   depends on bootstrap OWNERSHIP (the domain is constructed inside the
 *   trusted bootstrap closure), not on mere possession of the factory. A
 *   caller-forged domain mints sessions valid only in the caller's own
 *   separate trust domain — never in the canonical one.
 *
 * WHAT DOES NOT EXIST ANYMORE:
 *   - the public `createAuthenticationDomain` export (sixth repair)
 *   - onReady, bindAuthentication, mintSession, issueIdentity, issuer —
 *     none of these exist on any action runtime surface, constructor option,
 *     or module export. The historical `onReady({ bindAuthentication })`
 *     hook that handed a mint capability to the caller composing the runtime
 *     is DELETED; authentication/session issuance is established entirely
 *     inside the trusted bootstrap closure.
 *
 * FAIL-CLOSED AUTHENTICATION LAW (no caller-principal fallback, ever):
 *   authenticate(evidence) returns
 *     - a record with a non-empty string principal  -> AUTHENTICATED
 *     - null / undefined / false / "" / 0 / no principal / non-string
 *       principal / malformed / throws              -> AUTH FAILED
 *   On AUTH FAILED nothing is minted, nothing is branded, and no identity
 *   field from the evidence (principal / requestedPrincipal /
 *   claimedPrincipal / any caller string) is ever used as Authority identity.
 *   Caller-asserted name strings are retained only as descriptive telemetry
 *   (claimedPrincipal), never as Authority identity.
 *
 * BRAND-FIRST LAW (unchanged): the verifier checks brand membership BEFORE
 * any property access, so a hostile Proxy executes zero traps on rejection.
 *
 * PROCESS-ISOLATION LIMITATION (documented honestly): same-process CommonJS
 * trust domain, not OS isolation. An untrusted same-process actor with
 * unrestricted require() can reach internal modules — but a domain it forges
 * grants no access to any other domain's brand, mint path, or verifier.
 *
 *   VALID SHAPE != TRUSTED ORIGIN
 *   VALID ORIGIN IN DOMAIN A != TRUSTED IN DOMAIN B
 */

const { fail, REASONS } = require("./errors");
const { sanitizeAuthEvidence, AUTH_TELEMETRY_KEYS } = require("./authSession");

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

/**
 * PURE — fail-closed extraction of the authenticated principal from whatever
 * trusted authenticate() returned. Returns the principal string on success.
 * Throws AUTH_FAILED on EVERYTHING else (null, undefined, false, missing or
 * non-string or empty principal). NEVER falls back to any caller-supplied
 * identity string.
 */
function extractAuthenticatedPrincipal(authResult) {
    if (authResult === null || authResult === undefined || typeof authResult !== "object" || Array.isArray(authResult)) {
        throw fail(REASONS.AUTH_FAILED, "authentication did not return an identity record");
    }
    const p = authResult.principal;
    if (typeof p !== "string" || p.length === 0) {
        throw fail(REASONS.AUTH_FAILED, "authentication returned no valid principal");
    }
    const s = p.trim();
    if (s.length === 0 || s.length > MAX_TELEMETRY_CHARS) {
        throw fail(REASONS.AUTH_FAILED, "authentication returned an invalid principal");
    }
    return s;
}

/**
 * TRUSTED BOOTSTRAP ONLY — create one AuthenticationDomain.
 *
 * @param {object} options
 * @param {function} options.authenticate
 *     Trusted external authentication infrastructure:
 *     `authenticate(evidence) => { principal, ... } | null | undefined`.
 *     Must return a record with a non-empty string principal on success.
 *     Anything else (null/undefined/false/malformed/throwing) fails closed:
 *     no session is minted and no caller-asserted principal is used.
 * @param {object} [options.clock]  hardened clock capture (read-once identity)
 * @returns {object} AuthenticationDomain with EXACTLY:
 *     authenticate(evidence) -> AuthSessionCapability | null  (null = fail closed)
 *     verifier               -> already-bound verifier capability for runtime
 *                               composition; verifies ONLY this domain's sessions
 *     (NO mintSession, NO issuer, NO brand accessor, NO bindAuthentication)
 */
function createAuthenticationDomain({ authenticate, clock = { nowMs: () => Date.now() } } = {}) {
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
     * VERIFIER CAPABILITY — the ONLY thing ActionAuthorityRuntime receives.
     * Brand-first (zero property access before membership check => zero
     * Proxy traps on rejection). Returns the authenticated principal string
     * for a session branded by THIS domain, or null for anything else.
     */
    function verifySession(session) {
        if (session === null || typeof session !== "object") return null;
        if (!sessionBrand.has(session)) return null;
        // Brand membership holds; read the established principal. The only
        // sessions in the brand were minted with a validated non-empty
        // string principal, so this can only be the authenticated identity.
        const p = session.principal;
        return (typeof p === "string" && p.length > 0) ? p : null;
    }

    return Object.freeze({
        authenticate: authenticateEvidence,
        verifier: Object.freeze({
            verify: verifySession
        })
    });
}

// ---------------------------------------------------------------------------
// HOST-BOUND COMPOSITION CAPABILITY (sixth repair).
//
// `createAuthenticationDomain` is NOT a module export. It is reachable only
// through the capability minted by `bindAuthenticationHost(hostModule)`,
// where hostModule is the module object of the trusted bootstrap layer.
// Binding is one-shot per process: a second bind attempt from ANY module
// throws HOST_ALREADY_BOUND. Downstream code therefore has no importable
// surface through which it can create an AuthenticationDomain and present it
// as canonical identity authority.
//
// `extractAuthenticatedPrincipal` is a PURE fail-closed predicate retained as
// a normal export (it mints nothing and brands nothing).
// ---------------------------------------------------------------------------
const BOUND = { host: null };

function bindAuthenticationHost(hostModule) {
    if (hostModule === null || typeof hostModule !== "object") {
        throw fail(REASONS.CALLER_BOOTSTRAP_REJECTED, "bindAuthenticationHost requires a module object");
    }
    if (BOUND.host !== null) {
        throw fail(REASONS.CALLER_BOOTSTRAP_REJECTED,
            `authentication host already bound${BOUND.host === hostModule ? " (same host)" : ""}; there is exactly ONE trusted authentication bootstrap`);
    }
    BOUND.host = hostModule;
    return Object.freeze({
        createAuthenticationDomain
    });
}

/** Trusted-bootstrap-only introspection: is the authentication host bound? */
function isAuthenticationHostBound() {
    return BOUND.host !== null;
}

module.exports = {
    // NOTE (sixth repair): `createAuthenticationDomain` is deliberately NOT
    // exported. It is reachable only via bindAuthenticationHost(), which only
    // the trusted bootstrap layer (src/action/bootstrap.js) calls, one-shot
    // per process.
    extractAuthenticatedPrincipal,
    bindAuthenticationHost,
    isAuthenticationHostBound
};
