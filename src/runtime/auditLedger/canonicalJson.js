"use strict";

/**
 * Audit Ledger V1 — deterministic canonical JSON serialization.
 *
 * Self-contained copy of the repository-canonical rules (same semantics
 * as the Recovery capsule serializer) so that the ledger has NO import
 * edge into any other subsystem — a structural property the ledger's
 * own audit test enforces.
 *
 * Same semantic value => same canonical bytes => same digest.
 * Fail-closed: sorted keys, NaN/Infinity/BigInt/undefined/function/symbol
 * rejected, cycles rejected, non-plain objects rejected, dangerous
 * prototype keys (__proto__, constructor, prototype) rejected.
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

function canonicalizeValue(value, ancestors, depth, maxDepth) {
    if (depth > maxDepth) {
        throw new CanonicalizationError("maximum nesting depth exceeded");
    }
    switch (typeof value) {
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!Number.isFinite(value)) {
                throw new CanonicalizationError(`non-finite number: ${value}`);
            }
            if (Object.is(value, -0)) return "0";
            return JSON.stringify(value);
        case "bigint":
        case "undefined":
        case "function":
        case "symbol":
            throw new CanonicalizationError(`unsupported value type: ${typeof value}`);
        default:
            break;
    }

    if (value === null) return "null";

    if (Array.isArray(value)) {
        if (ancestors.has(value)) {
            throw new CanonicalizationError("circular reference detected");
        }
        ancestors.add(value);
        const parts = value.map((item) => canonicalizeValue(item, ancestors, depth + 1, maxDepth));
        ancestors.delete(value);
        return `[${parts.join(",")}]`;
    }

    if (!isPlainObject(value)) {
        throw new CanonicalizationError("non-plain object");
    }

    if (ancestors.has(value)) {
        throw new CanonicalizationError("circular reference detected");
    }
    ancestors.add(value);

    const names = Object.getOwnPropertyNames(value).sort();
    const parts = [];
    for (const name of names) {
        if (FORBIDDEN_KEYS.has(name)) {
            throw new CanonicalizationError(`forbidden object key: "${name}"`);
        }
        const raw = value[name];
        if (raw === undefined) {
            throw new CanonicalizationError(`undefined value for key "${name}"`);
        }
        parts.push(`${JSON.stringify(name)}:${canonicalizeValue(raw, ancestors, depth + 1, maxDepth)}`);
    }

    ancestors.delete(value);
    return `{${parts.join(",")}}`;
}

/** Serialize to canonical JSON string. */
function canonicalJson(value, { maxDepth = 16 } = {}) {
    return canonicalizeValue(value, new WeakSet(), 0, maxDepth);
}

module.exports = Object.freeze({ CanonicalizationError, canonicalJson });
