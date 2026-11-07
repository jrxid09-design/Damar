"use strict";

const { invalidInput } = require("./errors");

/**
 * SecretValue — a value container engineered against ACCIDENTAL leaks.
 *
 * Defensive behavior:
 *  - JSON.stringify(value)        -> "[SecretValue redacted]"
 *  - util.inspect(value)          -> "[SecretValue redacted len=N]"
 *  - String(value) / `${value}`   -> "[SecretValue redacted]"
 *  - structuredClone/spread       -> no enumerable fields carry the raw
 *  - thrown errors                -> never constructed from this object
 *
 * The cleartext is reachable ONLY through reveal(), which is the
 * explicit trusted-API escape hatch (resolution path). There is no
 * global accessor that walks a vault and reveals values.
 */

const REDACTED_MARKER = "[SecretValue redacted]";
const MAX_VALUE_BYTES = 64 * 1024;

const INSPECT = require("node:util").inspect.custom;

function assertValueInput(rawValue) {
    if (typeof rawValue !== "string" && !Buffer.isBuffer(rawValue)) {
        throw invalidInput("secret value must be a string or Buffer");
    }
    const bytes = Buffer.isBuffer(rawValue)
        ? rawValue
        : Buffer.from(rawValue, "utf8");
    if (bytes.length === 0) {
        throw invalidInput("secret value must not be empty");
    }
    if (bytes.length > MAX_VALUE_BYTES) {
        throw invalidInput("secret value exceeds maximum size");
    }
    return bytes;
}

class SecretValue {
    constructor(rawValue) {
        const bytes = assertValueInput(rawValue);
        Object.defineProperties(this, {
            [bytesSymbol]: {
                value: bytes,
                enumerable: false,
                writable: false,
                configurable: false
            },
            sizeBytes: {
                value: bytes.length,
                enumerable: true,
                writable: false,
                configurable: false
            }
        });
        Object.freeze(this);
    }

    /** Explicit trusted disclosure. The ONLY sanctioned read path. */
    reveal() {
        return this[bytesSymbol].toString("utf8");
    }

    revealBytes() {
        return Buffer.from(this[bytesSymbol]);
    }

    toJSON() {
        return REDACTED_MARKER;
    }

    toString() {
        return REDACTED_MARKER;
    }

    get [Symbol.toPrimitive]() {
        return () => REDACTED_MARKER;
    }

    [INSPECT](depth, options, inspect) {
        void depth; void options; void inspect;
        return `${REDACTED_MARKER} len=${this.sizeBytes}`;
    }
}

const bytesSymbol = Symbol("vault.secret.bytes");

/** True when the argument is a SecretValue instance. */
function isSecretValue(v) {
    return v instanceof SecretValue;
}

/**
 * Extracts candidate raw strings for redaction registries. Accepts
 * only genuine SecretValue instances — never arbitrary user objects.
 */
function revealForRedaction(value) {
    if (!isSecretValue(value)) {
        throw invalidInput("revealForRedaction requires a SecretValue");
    }
    return value.reveal();
}

module.exports = Object.freeze({
    REDACTED_MARKER,
    MAX_VALUE_BYTES,
    SecretValue,
    isSecretValue,
    revealForRedaction,
    secretValue(raw) {
        return new SecretValue(raw);
    }
});
