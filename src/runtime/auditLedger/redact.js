"use strict";

const { LedgerError, CODES } = require("./errors");
const { canonicalJson } = require("./canonicalJson");

/**
 * Audit Ledger V1 — redaction / sanitization boundary.
 *
 * The ledger must never become a secondary secret store. Two layers:
 *
 *   1. KEY layer: metadata keys that LOOK like credential carriers are
 *      redacted unconditionally, regardless of value.
 *   2. VALUE layer: string values shaped like known credential formats
 *      (or long high-entropy blobs) are redacted.
 *
 * This is a best-effort defense-in-depth boundary, NOT a guarantee that
 * callers may launder secrets through metadata. Callers must pass
 * REFERENCES to evidence, never secret material. The structural rule
 * "evidence lives at its origin; the ledger stores only pointers" is
 * the primary protection.
 */

const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN =
    /pass(?:word)?|secret|token|api[-_]?key|apikey|auth(?:oriz)?(?:ation)?|credential|private[-_]?key|bearer|cookie|session[-_]?key|seed[-_]?phrase|mnemonic/i;

const SECRET_VALUE_PATTERNS = Object.freeze([
    // Known provider token shapes (representative prefixes).
    /^(?:sk|rk|pk)[-_][A-Za-z0-9_-]{12,}$/,
    /^gh[pousr]_[A-Za-z0-9]{20,}$/,
    /^github_pat_[A-Za-z0-9_]{20,}$/,
    /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
    /^AKIA[0-9A-Z]{16}$/,
    /^AIza[0-9A-Za-z_-]{30,}$/,
    /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT-shaped
    /^Bearer\s+\S+/i,
    /(?:^|\s)(?:[A-Za-z0-9+/]{40,}={0,2})(?:\s|$)/ // long base64 blob
]);

function looksLikeSecretKey(key) {
    return typeof key === "string" && SECRET_KEY_PATTERN.test(key);
}

function looksLikeSecretValue(value) {
    if (typeof value !== "string" || value.length < 12) return false;
    return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

/** High-entropy heuristic: long mixed-class run with no spaces. */
function looksHighEntropy(value) {
    if (typeof value !== "string" || value.length < 40 || /\s/.test(value)) return false;
    const classes =
        (/[a-z]/.test(value) ? 1 : 0) +
        (/[A-Z]/.test(value) ? 1 : 0) +
        (/[0-9]/.test(value) ? 1 : 0) +
        (/[^A-Za-z0-9]/.test(value) ? 1 : 0);
    return classes >= 3;
}

/**
 * Deep-sanitize a caller-supplied value into a bounded plain structure.
 * Throws (fail closed) on: functions/symbols/bigints/undefined, cyclic
 * structures, forbidden prototype keys, depth/key/array overruns.
 */
function sanitizeValue(
    value,
    bounds,
    ancestors = new WeakSet(),
    depth = 0
) {
    if (depth > bounds.maxMetadataDepth) {
        throw new LedgerError(CODES.BOUNDS_EXCEEDED, `metadata nesting deeper than ${bounds.maxMetadataDepth}`);
    }

    if (value === null) return null;

    switch (typeof value) {
        case "string": {
            if (looksLikeSecretValue(value) || looksHighEntropy(value)) {
                return REDACTED;
            }
            return value.length > bounds.maxMetadataStringLength
                ? value.slice(0, bounds.maxMetadataStringLength)
                : value;
        }
        case "number":
            if (!Number.isFinite(value)) {
                throw new LedgerError(CODES.REDACTION_FAILED, "non-finite number in metadata");
            }
            return value;
        case "boolean":
            return value;
        case "bigint":
        case "symbol":
        case "function":
        case "undefined":
            throw new LedgerError(CODES.REDACTION_FAILED, `unsupported metadata value type: ${typeof value}`);
        default:
            break;
    }

    if (Array.isArray(value)) {
        if (ancestors.has(value)) {
            throw new LedgerError(CODES.REDACTION_FAILED, "cyclic metadata");
        }
        if (value.length > bounds.maxMetadataArrayItems) {
            throw new LedgerError(CODES.BOUNDS_EXCEEDED,
                `metadata array exceeds ${bounds.maxMetadataArrayItems} items`);
        }
        ancestors.add(value);
        const out = value.map((item) => sanitizeValue(item, bounds, ancestors, depth + 1));
        ancestors.delete(value);
        return out;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        throw new LedgerError(CODES.REDACTION_FAILED, "non-plain object in metadata");
    }

    const keys = Object.keys(value);
    if (keys.length > bounds.maxMetadataKeysPerLevel) {
        throw new LedgerError(CODES.BOUNDS_EXCEEDED,
            `metadata object exceeds ${bounds.maxMetadataKeysPerLevel} keys`);
    }

    const out = {};
    for (const key of keys) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
            throw new LedgerError(CODES.REDACTION_FAILED, `forbidden metadata key: ${key}`);
        }
        out[key] = looksLikeSecretKey(key)
            ? REDACTED
            : sanitizeValue(value[key], bounds, ancestors, depth + 1);
    }
    return out;
}

/**
 * Sanitize a metadata object and enforce its canonical byte budget.
 * Returns a fresh frozen plain object, or undefined for empty input.
 */
function sanitizeMetadata(metadata, bounds) {
    if (metadata === undefined || metadata === null) return undefined;
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new LedgerError(CODES.INVALID_EVENT, "metadata must be an object");
    }
    const clean = sanitizeValue(metadata, bounds);
    if (clean === null || typeof clean !== "object" || Array.isArray(clean)) {
        throw new LedgerError(CODES.INVALID_EVENT, "metadata must sanitize to an object");
    }
    const bytes = Buffer.byteLength(canonicalJson(clean), "utf8");
    if (bytes > bounds.maxMetadataBytes) {
        throw new LedgerError(CODES.BOUNDS_EXCEEDED,
            `metadata exceeds ${bounds.maxMetadataBytes} bytes (${bytes})`);
    }
    return Object.freeze(clean);
}

module.exports = Object.freeze({
    REDACTED,
    sanitizeMetadata,
    sanitizeValue,
    looksLikeSecretKey,
    looksLikeSecretValue,
    looksHighEntropy
});
