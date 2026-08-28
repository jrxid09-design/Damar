"use strict";

/**
 * ACTION AUTHORITY GATE V1 — session field sanitization (PURE ONLY).
 *
 * TRUST-DOMAIN LAW: a session minted by runtime A is trusted ONLY by runtime A.
 * This module deliberately contains NO brand, NO WeakSet, NO issuer, and NO
 * verifier. The session brand + issuer + verifier are created INSIDE the
 * trusted runtime composition closure (`src/action/runtime.js`) as
 * closure-local state, so:
 *
 *   - no module-global session brand can exist (the Wave-3 blocker)
 *   - no public/direct import can mint a session trusted by any canonical
 *     runtime (the Wave-4 blocker)
 *   - only the runtime's own issuer adds sessions to its own brand; only that
 *     runtime's gate checks that brand
 *
 * What remains here is a pure, non-authorizing input sanitizer for session
 * fields. It never confers trust: its output is an ordinary unbranded object.
 */

const { fail, REASONS } = require("./errors");

const MAX_PRINCIPAL_CHARS = 128;
const MAX_SESSION_CHARS = 128;
const MAX_CHANNEL_CHARS = 64;

function cleanToken(v, field, maxChars) {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") {
        throw fail(REASONS.INVALID_INTENT, `auth session '${field}' must be a string, got ${typeof v}`);
    }
    const s = v.trim();
    if (s.length > maxChars) {
        throw fail(REASONS.BOUND_EXCEEDED, `auth session '${field}' exceeds ${maxChars} chars`);
    }
    return s;
}

/**
 * PURE — sanitize authenticated-session fields into a plain record.
 * Returns an UNBRANDED object; branding happens only inside the trusted
 * runtime composition closure. Throws typed ActionError on malformed input.
 */
function sanitizeSessionFields({ principal, sessionId = null, channel = null } = {}) {
    const p = cleanToken(principal, "principal", MAX_PRINCIPAL_CHARS);
    if (!p) {
        throw fail(REASONS.INVALID_INTENT, "auth session requires a non-empty principal");
    }
    return {
        principal: p,
        sessionId: cleanToken(sessionId, "sessionId", MAX_SESSION_CHARS),
        channel: cleanToken(channel, "channel", MAX_CHANNEL_CHARS)
    };
}

module.exports = { sanitizeSessionFields };
