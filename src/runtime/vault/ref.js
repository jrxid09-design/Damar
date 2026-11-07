"use strict";

const { assertSecretId } = require("./ids");
const { coerceSecretScope, scopeToString } = require("./scope");
const { invalidInput } = require("./errors");

/**
 * SecretRef — a POINTER to a secret. Never the secret itself.
 *
 * A SecretRef is safe to serialize, log, inspect, persist, and send
 * through read models. It contains only: a validated SecretId and the
 * intended scope. Raw values are structurally impossible here because
 * construction goes through strict key extraction.
 */

const REF_VERSION = 1;
const SECRET_REF_PREFIX = "secretref:v1:";

function buildSecretRef(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw invalidInput("SecretRef input must be an object");
    }
    const secretId = assertSecretId(input.secretId);
    const scope = coerceSecretScope(input.scope);
    return Object.freeze({
        v: REF_VERSION,
        secretId,
        scope,
        toString() {
            return `[SecretRef ${scopeToString(scope)}]`;
        },
        toJSON() {
            return { v: REF_VERSION, secretId, scope };
        },
        [require("node:util").inspect.custom]() {
            return `SecretRef(${secretId}, ${scopeToString(scope)})`;
        }
    });
}

/** Canonical wire/log form — reversible, non-secret. */
function secretRefToString(ref) {
    const r = coerceSecretRef(ref);
    return `${SECRET_REF_PREFIX}${r.secretId}:${r.scope.kind}${r.scope.key ? `:${r.scope.key}` : ""}`;
}

function parseSecretRefString(text) {
    if (typeof text !== "string" || !text.startsWith(SECRET_REF_PREFIX)) {
        throw invalidInput("malformed SecretRef string", text);
    }
    const rest = text.slice(SECRET_REF_PREFIX.length);
    const parts = rest.split(":");
    if (parts.length < 2 || parts.length > 3) {
        throw invalidInput("malformed SecretRef string structure");
    }
    const [secretId, kind, key] = parts;
    if (key !== undefined && key.includes("/")) {
        throw invalidInput("malformed SecretRef scope key");
    }
    return buildSecretRef({ secretId, scope: key ? { kind, key } : { kind } });
}

/**
 * Accepts an existing SecretRef, its canonical string form, or a plain
 * persisted shape. Rejects anything that looks like a raw value
 * carrier ("value"/"secret"/"token"/"key" fields) so raw credentials
 * cannot be smuggled where a reference is expected.
 */
const FORBIDDEN_REF_KEYS = Object.freeze(
    ["value", "cleartext", "plaintext", "secret", "token", "apikey", "password"].reduce(
        (m, k) => ((m[k] = k), m),
        {}
    )
);

function coerceSecretRef(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const ownKey of Object.keys(value)) {
            if (Object.prototype.hasOwnProperty.call(FORBIDDEN_REF_KEYS, ownKey.toLowerCase())) {
                throw invalidInput("raw value field forbidden in SecretRef", ownKey.slice(0, 24));
            }
        }
        if (typeof value.toString === "function" && value.v === REF_VERSION) {
            return buildSecretRef({ secretId: value.secretId, scope: value.scope });
        }
        throw invalidInput("object is not a SecretRef");
    }
    if (typeof value === "string") {
        return parseSecretRefString(value);
    }
    throw invalidInput("cannot coerce value into SecretRef", typeof value);
}

module.exports = Object.freeze({
    REF_VERSION,
    SECRET_REF_PREFIX,
    FORBIDDEN_REF_KEYS,
    buildSecretRef,
    coerceSecretRef,
    secretRefToString,
    parseSecretRefString
});
