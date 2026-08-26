"use strict";

/**
 * Vault error taxonomy.
 *
 * LAW: errors NEVER carry secret material. Message context is limited
 * to non-secret identifiers (SecretId, scope, codes) and is length-
 * capped so even hostile context cannot bloat logs or read models.
 */

const VAULT_ERROR_CODES = Object.freeze([
    "VAULT_INVALID_INPUT",
    "VAULT_ID_MALFORMED",
    "VAULT_REF_MALFORMED",
    "VAULT_SCOPE_MISMATCH",
    "VAULT_DUPLICATE",
    "VAULT_NOT_FOUND",
    "VAULT_REVOKED",
    "VAULT_UNAVAILABLE",
    "VAULT_LIMIT_EXCEEDED",
    "VAULT_CONFLICT",
    "VAULT_STORE_FAILURE",
    "VAULT_CIPHER_REQUIRED",
    "VAULT_FORBIDDEN_KEY"
].reduce((m, c) => ((m[c] = c), m), {}));

const MAX_CONTEXT_LENGTH = 128;

function sanitizeContext(context) {
    if (context === undefined || context === null) {
        return undefined;
    }
    let text;
    try {
        text = typeof context === "string" ? context : JSON.stringify(context);
    } catch (_) {
        text = String(context);
    }
    if (typeof text !== "string") {
        return undefined;
    }
    return text.length > MAX_CONTEXT_LENGTH
        ? `${text.slice(0, MAX_CONTEXT_LENGTH)}…[truncated]`
        : text;
}

class VaultError extends Error {
    constructor(code, message, context) {
        if (!Object.prototype.hasOwnProperty.call(VAULT_ERROR_CODES, code)) {
            throw new TypeError(`unknown vault error code: ${String(code)}`);
        }
        super(message);
        this.name = "VaultError";
        this.code = code;
        this.context = sanitizeContext(context);
        Object.freeze(this);
    }
}

function invalidInput(message, context) {
    return new VaultError(VAULT_ERROR_CODES.VAULT_INVALID_INPUT, message, context);
}

function isVaultError(err) {
    return err instanceof VaultError;
}

module.exports = Object.freeze({
    VAULT_ERROR_CODES,
    MAX_CONTEXT_LENGTH,
    VaultError,
    invalidInput,
    isVaultError,
    sanitizeContext
});
