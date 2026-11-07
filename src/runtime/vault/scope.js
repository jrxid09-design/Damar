"use strict";

const { invalidInput } = require("./errors");

/**
 * SecretScope — metadata describing the intended domain of a secret.
 *
 * Scope metadata is NOT authority. It cannot grant, widen, or prove
 * any capability. Its only job is to let callers avoid accidental
 * cross-domain lookups when scoped resolution is used.
 */

const SECRET_SCOPE_KINDS = Object.freeze(
    ["provider", "extension", "transport", "project", "device", "system"].reduce(
        (m, k) => ((m[k] = k), m),
        {}
    )
);

const MAX_SCOPE_KEY_LENGTH = 64;
const SCOPE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function coerceSecretScope(value) {
    if (value === undefined || value === null) {
        return Object.freeze({ kind: "system", key: "" });
    }
    if (typeof value === "string") {
        value = { kind: value.trim().toLowerCase() };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw invalidInput("SecretScope must be an object or string");
    }
    // Explicit key extraction: prototype pollution via spread is impossible.
    const kindRaw = value.kind;
    const keyRaw = Object.prototype.hasOwnProperty.call(value, "key") ? value.key : "";
    if (typeof kindRaw !== "string") {
        throw invalidInput("SecretScope.kind must be a string");
    }
    const kind = kindRaw.trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SECRET_SCOPE_KINDS, kind)) {
        throw invalidInput("SecretScope.kind unknown", kind.slice(0, 24));
    }
    let key = "";
    if (keyRaw !== undefined && keyRaw !== null && keyRaw !== "") {
        if (typeof keyRaw !== "string") {
            throw invalidInput("SecretScope.key must be a string");
        }
        if (keyRaw.length > MAX_SCOPE_KEY_LENGTH) {
            throw invalidInput("SecretScope.key exceeds maximum length");
        }
        if (!SCOPE_KEY_PATTERN.test(keyRaw)) {
            throw invalidInput("SecretScope.key malformed", JSON.stringify(keyRaw.slice(0, 16)));
        }
        key = keyRaw;
    }
    return Object.freeze({ kind, key });
}

/** Canonical printable form: "provider/openrouter" or "system". */
function scopeToString(scope) {
    const s = coerceSecretScope(scope);
    return s.key ? `${s.kind}/${s.key}` : s.kind;
}

function scopeEquals(a, b) {
    const x = coerceSecretScope(a);
    const y = coerceSecretScope(b);
    return x.kind === y.kind && x.key === y.key;
}

module.exports = Object.freeze({
    SECRET_SCOPE_KINDS,
    SCOPE_KEY_PATTERN: Object.freeze(SCOPE_KEY_PATTERN.source),
    MAX_SCOPE_KEY_LENGTH,
    coerceSecretScope,
    scopeToString,
    scopeEquals
});
