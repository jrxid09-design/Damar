"use strict";

/**
 * ACTION AUTHORITY GATE V1 — auth evidence sanitization + PURE principal
 * extraction predicate (SEVENTH targeted repair, Wave 4 Lane 2: privileged
 * composition removed entirely from this module).
 *
 * CORE LAWS (preserved across repairs 5–7):
 *
 *   caller-selectable verifier != authenticated identity authority
 *   FIRST-BINDER-WINS TRUST IS NOT TRUST
 *   canonical authentication policy is bootstrap-owned, not
 *   runtime-constructor-owned
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS (seventh repair)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * authDomain.js is now a NON-PRIVILEGED module. It contains ONLY:
 *
 *   - extractAuthenticatedPrincipal — PURE fail-closed predicate: extracts
 *     the authenticated principal from a trusted authentication result,
 *     throwing AUTH_FAILED on anything malformed. It mints nothing, brands
 *     nothing, and is used by the trusted bootstrap's private domain
 *     implementation for exactly that validation step.
 *
 * There is NO factory, NO composition function, NO binder, NO token, NO host
 * capability, NO first-call-wins registry on this module or its exports.
 *
 * Privileged construction (the AuthenticationDomain composition — session
 * brand, mint path, verifier capability) lives ONLY inside the trusted
 * bootstrap layer's private closure (src/action/bootstrap.js), as a private
 * function defined in that module. The explicitly test-only harness
 * (tests/action/bootstrapHarness.js) defines its OWN private mirror for
 * controlled test authentication. A downstream caller has NO importable
 * surface through which an AuthenticationDomain can be created.
 *
 * Equivalent-binder names are likewise absent: no bindHost / acquireHost /
 * registerHost / installHost / claimComposition / bootstrapBind / hostToken /
 * getFactory / getComposer exists on any action module export.
 *
 * FAIL-CLOSED AUTHENTICATION LAW (no caller-principal fallback, ever):
 *   a trusted authentication result is valid ONLY if it is a record with a
 *   non-empty string principal. null / undefined / false / "" / 0 / missing
 *   principal / non-string principal / malformed / throws => AUTH FAILED.
 *   On AUTH FAILED nothing is minted, nothing is branded, and no identity
 *   field from the evidence (principal / requestedPrincipal / claimedPrincipal
 *   / any caller string) is ever used as Authority identity. Caller-asserted
 *   name strings are retained only as descriptive telemetry
 *   (claimedPrincipal), never as Authority identity.
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

const MAX_TELEMETRY_CHARS = 128;

/**
 * PURE — fail-closed extraction of the authenticated principal from whatever
 * trusted authentication infrastructure returned. Returns the principal
 * string on success. Throws AUTH_FAILED on EVERYTHING else (null, undefined,
 * false, missing or non-string or empty principal, oversized). NEVER falls
 * back to any caller-supplied identity string.
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

module.exports = {
    // PURE fail-closed predicate ONLY. No factory, no composition function,
    // no binder, no token, no brand state.
    extractAuthenticatedPrincipal
};
