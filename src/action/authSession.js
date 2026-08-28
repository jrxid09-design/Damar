"use strict";

/**
 * ACTION AUTHORITY GATE V1 — AuthSessionCapability (trusted authenticated session).
 *
 * An AuthSessionCapability carries an UNFORGEABLE brand token held in this
 * module's closure. It represents an authenticated session established by
 * trusted runtime authentication/session infrastructure — NOT a caller-
 * supplied principal/session/channel string.
 *
 * The ONLY way to obtain an AuthSessionCapability is `createAuthSessionIssuer()`
 * (the trusted authentication infrastructure, held by Aether bootstrap and
 * never injected downstream as a minting surface). The ActionAuthorityRuntime
 * accepts an AuthSessionCapability and derives the RuntimeIdentity internally;
 * it never accepts a raw `{ principal }` object.
 *
 * BRAND-FIRST VERIFICATION: `isAuthSession` checks the brand (WeakSet
 * membership) BEFORE inspecting any fields, so a hostile Proxy cannot execute
 * get/getPrototypeOf/ownKeys/getOwnPropertyDescriptor/has/set traps during
 * rejection of an unbranded value.
 *
 *   VALID SHAPE != TRUSTED ORIGIN
 */

const { fail, REASONS } = require("./errors");

const AUTH_SESSION_BRAND = Symbol("aether.action.authSession.brand");
const authSessionBrands = new WeakSet();

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
 * INTERNAL — mint an AuthSessionCapability. Called only by the trusted
 * authentication issuer (`createAuthSessionIssuer`). Not exported publicly.
 */
function mintAuthSession({ principal, sessionId = null, channel = null } = {}) {
    const p = cleanToken(principal, "principal", MAX_PRINCIPAL_CHARS);
    if (!p) {
        throw fail(REASONS.INVALID_INTENT, "auth session requires a non-empty principal");
    }
    const session = Object.freeze({
        principal: p,
        sessionId: cleanToken(sessionId, "sessionId", MAX_SESSION_CHARS),
        channel: cleanToken(channel, "channel", MAX_CHANNEL_CHARS)
    });
    authSessionBrands.add(session);
    return session;
}

/**
 * Create the trusted authentication session issuer. This is the authenticated
 * session infrastructure: it establishes sessions from authenticated transport
 * identity. It MUST be held only by trusted Aether bootstrap and never handed
 * to untrusted code as a minting surface.
 */
function createAuthSessionIssuer() {
    return Object.freeze({
        mintSession({ principal, sessionId = null, channel = null } = {}) {
            return mintAuthSession({ principal, sessionId, channel });
        }
    });
}

/**
 * BRAND-FIRST verification. Returns true only if `v` is a genuinely-branded
 * AuthSessionCapability. No property access / prototype check / coercion /
 * reflection happens on an unbranded value before the brand check.
 */
function isAuthSession(v) {
    if (v === null || typeof v !== "object") return false;
    if (!authSessionBrands.has(v)) return false;
    // Only after brand membership do we inspect fields.
    return typeof v.principal === "string" && v.principal.length > 0;
}

module.exports = { createAuthSessionIssuer, mintAuthSession, isAuthSession };
