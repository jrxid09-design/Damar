"use strict";

/**
 * ACTION AUTHORITY GATE V1 — RuntimeIdentityContext (trusted identity).
 *
 * A RuntimeIdentityContext carries an UNFORGEABLE runtime-owned brand token
 * held in this module's closure. Callers cannot manufacture a trusted identity
 * by plain object, frozen clone, copied fields, JSON, or Symbol("same-name").
 * The only way to obtain a trusted identity is via the trusted composition
 * root (`createActionAuthorityRuntime`), which mints identities internally.
 *
 *   principal  — authenticated actor (subject) established by runtime auth
 *   sessionId  — authenticated session identity
 *   channel    — transport/channel provenance established by runtime auth
 *
 * The identity is frozen, immutable, and grants nothing.
 */

const { fail, REASONS } = require("./errors");

const IDENTITY_BRAND = Symbol("aether.action.runtimeIdentity.brand");
const identityBrands = new WeakSet();

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
 * INTERNAL — mint a trusted runtime identity. Only the trusted composition root
 * may call this (it is NOT exported from the public index). The brand token is
 * closure-only, so shape-only lookalikes are rejected by isRuntimeIdentityContext.
 */
function mintRuntimeIdentity({ principal, sessionId = null, channel = null } = {}) {
    const p = cleanToken(principal, "principal", MAX_PRINCIPAL_CHARS);
    if (!p) {
        throw fail(REASONS.INVALID_INTENT, "runtime identity context requires a non-empty principal");
    }
    const identity = Object.freeze({
        principal: p,
        sessionId: cleanToken(sessionId, "sessionId", MAX_SESSION_CHARS),
        channel: cleanToken(channel, "channel", MAX_CHANNEL_CHARS)
    });
    identityBrands.add(identity);
    return identity;
}

/** True only if `v` is a genuinely-branded trusted runtime identity context. */
function isRuntimeIdentityContext(v) {
    return v !== null && typeof v === "object" &&
        typeof v.principal === "string" && v.principal.length > 0 &&
        typeof v.sessionId === "string" && typeof v.channel === "string" &&
        identityBrands.has(v);
}

module.exports = { mintRuntimeIdentity, isRuntimeIdentityContext };
