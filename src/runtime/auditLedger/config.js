"use strict";

const { LedgerError, CODES } = require("./errors");

/**
 * Audit Ledger V1 — bounds.
 *
 * The ledger is observational infrastructure: it must never become an
 * unbounded memory sink. All limits are enforced fail-closed. In-memory
 * retention is a BOUNDED WINDOW over the logical sequence; eviction of
 * old records is expected and does not invalidate ordering or IDs.
 */

const DEFAULT_BOUNDS = Object.freeze({
    /** Max events retained in memory (ring window; oldest evicted). */
    maxInMemoryEvents: 5000,
    /** Hard cap for any single query result. */
    maxQueryLimit: 1000,
    /** Default query result size when caller omits limit. */
    defaultQueryLimit: 200,
    /** Max canonical-JSON byte size of one event's metadata object. */
    maxMetadataBytes: 2048,
    /** Max length of any single metadata string after sanitization. */
    maxMetadataStringLength: 512,
    /** Max nesting depth accepted inside metadata. */
    maxMetadataDepth: 6,
    /** Max keys per metadata object level. */
    maxMetadataKeysPerLevel: 64,
    /** Max items per metadata array. */
    maxMetadataArrayItems: 32,
    /** Max evidence references per event. */
    maxEvidenceRefs: 16,
    /** Max eventType length. */
    maxEventTypeLength: 96,
    /** Max length of any identifier-shaped ref string. */
    maxRefLength: 128
});

function isPlainObject(value) {
    if (value === null || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Validate + clamp a bounds override. Unknown keys rejected; every value
 * must be a positive safe integer within sane hard ceilings.
 */
function resolveBounds(override) {
    if (override === undefined || override === null) {
        return { ...DEFAULT_BOUNDS };
    }
    if (!isPlainObject(override)) {
        throw new LedgerError(CODES.INVALID_BOUNDS, "bounds override must be a plain object");
    }
    const HARD_CEILINGS = Object.freeze({
        maxInMemoryEvents: 1_000_000,
        maxQueryLimit: 10_000,
        defaultQueryLimit: 10_000,
        maxMetadataBytes: 65_536,
        maxMetadataStringLength: 8192,
        maxMetadataDepth: 16,
        maxMetadataKeysPerLevel: 256,
        maxMetadataArrayItems: 256,
        maxEvidenceRefs: 128,
        maxEventTypeLength: 256,
        maxRefLength: 512
    });
    const out = { ...DEFAULT_BOUNDS };
    for (const key of Object.keys(override)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_BOUNDS, key)) {
            throw new LedgerError(CODES.INVALID_BOUNDS, `unknown bound: ${key}`);
        }
        const v = override[key];
        if (!Number.isSafeInteger(v) || v < 1 || v > HARD_CEILINGS[key]) {
            throw new LedgerError(CODES.INVALID_BOUNDS, `bound out of range: ${key}`);
        }
        out[key] = v;
    }
    if (out.defaultQueryLimit > out.maxQueryLimit) {
        out.defaultQueryLimit = out.maxQueryLimit;
    }
    return Object.freeze(out);
}

module.exports = Object.freeze({ DEFAULT_BOUNDS, resolveBounds });
