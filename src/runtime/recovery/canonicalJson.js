"use strict";

/**
 * Deterministic canonical JSON serialization (R5).
 *
 * Same semantic value => same canonical bytes => same digest.
 *
 * Fail-closed rules:
 *   - object keys are emitted in ascending code-unit order
 *   - NaN / Infinity / -Infinity rejected
 *   - BigInt, undefined, functions, symbols rejected
 *   - circular references rejected
 *   - only plain objects (Object.prototype or null prototype) accepted
 *   - dangerous prototype keys (__proto__, constructor, prototype) rejected
 *   - output is deterministic UTF-8
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class CanonicalizationError extends Error {
    constructor(message) {
        super(message);
        this.name = "CanonicalizationError";
        this.code = "E_CANONICALIZATION";
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== "object") {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function canonicalKey(k) {
    if (FORBIDDEN_KEYS.has(k)) {
        throw new CanonicalizationError(`forbidden object key: "${k}"`);
    }
    return k;
}

function canonicalizeValue(value, ancestors) {
    switch (typeof value) {
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!Number.isFinite(value)) {
                throw new CanonicalizationError(`non-finite number: ${value}`);
            }
            if (Object.is(value, -0)) {
                return "0";
            }
            return JSON.stringify(value);
        case "bigint":
        case "undefined":
        case "function":
        case "symbol":
            throw new CanonicalizationError(`unsupported value type: ${typeof value}`);
        default:
            break;
    }

    if (value === null) {
        return "null";
    }

    if (Array.isArray(value)) {
        if (ancestors.has(value)) {
            throw new CanonicalizationError("circular reference detected");
        }
        ancestors.add(value);
        const parts = value.map((item) => canonicalizeValue(item, ancestors));
        ancestors.delete(value);
        return `[${parts.join(",")}]`;
    }

    if (!isPlainObject(value)) {
        throw new CanonicalizationError(
            `non-plain object of prototype ${String(Object.getPrototypeOf(value)?.constructor?.name ?? "null")}`
        );
    }

    if (ancestors.has(value)) {
        throw new CanonicalizationError("circular reference detected");
    }
    ancestors.add(value);

    const names = Object.getOwnPropertyNames(value);
    const seen = new Set();
    const parts = [];
    for (const name of names.sort()) {
        if (seen.has(name)) {
            throw new CanonicalizationError("duplicate own property name");
        }
        seen.add(name);
        const key = canonicalKey(name);
        const raw = value[name];
        if (raw === undefined) {
            throw new CanonicalizationError(`undefined value for key "${key}"`);
        }
        parts.push(`${JSON.stringify(key)}:${canonicalizeValue(raw, ancestors)}`);
    }

    ancestors.delete(value);
    return `{${parts.join(",")}}`;
}

/** Serialize to a canonical JSON string. */
function canonicalJson(value) {
    return canonicalizeValue(value, new WeakSet());
}

/** Serialize to deterministic UTF-8 bytes. */
function canonicalBytes(value) {
    return Buffer.from(canonicalJson(value), "utf8");
}

module.exports = Object.freeze({
    CanonicalizationError,
    canonicalJson,
    canonicalBytes
});
