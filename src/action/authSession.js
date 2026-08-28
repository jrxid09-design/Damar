"use strict";

/**
 * ACTION AUTHORITY GATE V1 — auth evidence sanitization (PURE ONLY).
 *
 * TRUST-DOMAIN LAW: a session minted by domain A is trusted ONLY by the
 * runtime composed over domain A's verifier. This module deliberately
 * contains NO brand, NO WeakSet, NO issuer, NO verifier, and NO
 * authenticate logic. The session brand + mint path + verifier live INSIDE
 * the trusted AuthenticationDomain closure (`src/action/authDomain.js`):
 *
 *   - no module-global session brand can exist (the Wave-3 blocker)
 *   - no public/direct import can mint a session trusted by any canonical
 *     runtime (the Wave-4 blocker)
 *   - no caller-owned bootstrap callback can hand a mint capability back to
 *     the runtime's own composer (the Wave-4 fifth-repair blocker)
 *
 * What remains here is a pure, non-authorizing input sanitizer for
 * authentication EVIDENCE (external channel/session evidence). It never
 * confers trust: its output is an ordinary unbranded record. The fields it
 * produces are DESCRIPTIVE ONLY — `claimedPrincipal` is retained solely as
 * telemetry and is NEVER an Authority identity (authentication failure never
 * falls back to it; see src/action/authDomain.js).
 */

const { fail, REASONS } = require("./errors");

const MAX_CLAIMED_PRINCIPAL_CHARS = 128;
const MAX_SESSION_CHARS = 128;
const MAX_CHANNEL_CHARS = 64;

/** Telemetry-only field names (never used as Authority identity). */
const AUTH_TELEMETRY_KEYS = Object.freeze({
    claimedPrincipal: "claimedPrincipal"
});

function cleanToken(v, field, maxChars) {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") {
        throw fail(REASONS.INVALID_INTENT, `auth evidence '${field}' must be a string, got ${typeof v}`);
    }
    const s = v.trim();
    if (s.length > maxChars) {
        throw fail(REASONS.BOUND_EXCEEDED, `auth evidence '${field}' exceeds ${maxChars} chars`);
    }
    return s;
}

/**
 * PURE — sanitize external authentication evidence into a plain record.
 * Returns an UNBRANDED object; branding happens only inside the trusted
 * AuthenticationDomain closure, after a positive authentication result.
 *
 * NOTE: a principal string supplied here is a CALLER CLAIM only. It is kept
 * (as `claimedPrincipal`) for descriptive telemetry; it can never become an
 * Authority identity. If the caller passes `principal`, it is mapped to the
 * telemetry field and dropped as an identity candidate.
 *
 * Throws typed ActionError on malformed (non-string/oversized) input.
 */
function sanitizeAuthEvidence({ principal, claimedPrincipal, sessionId = null, channel = null, ...rest } = {}) {
    if (rest && Object.keys(rest).length > 0) {
        // Unknown evidence fields are rejected fail-closed (bounds discipline),
        // with well-known requester-claim aliases mapped to telemetry only.
        const known = new Set(["principal", "requestedPrincipal", "claimedPrincipal", "sessionId", "channel"]);
        for (const k of Object.keys(rest)) {
            if (known.has(k)) continue;
            throw fail(REASONS.UNKNOWN_FIELD, `auth evidence field '${k}' is not accepted`);
        }
    }
    const claim = claimedPrincipal ?? principal ?? null;
    return {
        claimedPrincipal: cleanToken(claim, "claimedPrincipal", MAX_CLAIMED_PRINCIPAL_CHARS),
        sessionId: cleanToken(sessionId, "sessionToken", MAX_SESSION_CHARS),
        channel: cleanToken(channel, "channel", MAX_CHANNEL_CHARS)
    };
}

module.exports = { sanitizeAuthEvidence, AUTH_TELEMETRY_KEYS };
