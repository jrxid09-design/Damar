"use strict";

/**
 * ACTION AUTHORITY GATE V1 — RuntimeIdentityContext (trusted identity).
 *
 * Trusted runtime identity MUST come from runtime/session/channel
 * authentication infrastructure, NEVER from untrusted ActionIntent JSON.
 *
 *   principal   — authenticated actor (subject) established by the runtime
 *   sessionId   — authenticated session identity
 *   channel     — transport/channel provenance established by the runtime
 *
 * A RuntimeIdentityContext is built by TRUSTED runtime code only. It is
 * frozen and immutable. The gate uses it (and only it) to supply Authority
 * identity. It carries NO authority decision and grants nothing.
 */

const { fail, REASONS } = require("./errors");

const MAX_PRINCIPAL_CHARS = 128;
const MAX_SESSION_CHARS = 128;
const MAX_CHANNEL_CHARS = 64;

function cleanToken(v, field, maxChars) {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") {
        throw fail(REASONS.INVALID_INTENT, `runtime identity '${field}' must be a string, got ${typeof v}`);
    }
    const s = v.trim();
    if (s.length > maxChars) {
        throw fail(REASONS.BOUND_EXCEEDED, `runtime identity '${field}' exceeds ${maxChars} chars`);
    }
    return s;
}

/**
 * Build a trusted runtime identity context. Throws ActionError on malformed
 * shape. Returns a frozen { principal, sessionId, channel }.
 */
function createRuntimeIdentityContext({ principal, sessionId = null, channel = null } = {}) {
    const p = cleanToken(principal, "principal", MAX_PRINCIPAL_CHARS);
    if (!p) {
        throw fail(REASONS.INVALID_INTENT, "runtime identity context requires a non-empty principal");
    }
    return Object.freeze({
        principal: p,
        sessionId: cleanToken(sessionId, "sessionId", MAX_SESSION_CHARS),
        channel: cleanToken(channel, "channel", MAX_CHANNEL_CHARS)
    });
}

/** True if the value looks like a canonical trusted runtime identity context. */
function isRuntimeIdentityContext(v) {
    return v !== null && typeof v === "object" &&
        typeof v.principal === "string" && v.principal.length > 0 &&
        typeof v.sessionId === "string" && typeof v.channel === "string";
}

module.exports = { createRuntimeIdentityContext, isRuntimeIdentityContext };
