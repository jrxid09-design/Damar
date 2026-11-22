"use strict";

const crypto = require("node:crypto");

/**
 * Audit Ledger V1 — canonical identifiers and reference shapes.
 *
 * IDs are identity ONLY. An ID in the ledger is an observation of the
 * past, never a capability, never a permission, and never live state.
 * All formats are closed, lowercase where applicable, fixed-shape, and
 * fail closed on malformed input.
 */

const AUDIT_EVENT_ID_PATTERN = /^ae-[0-9a-f]{32}$/;

/**
 * Generation refs are opaque. Both existing generation id styles in the
 * codebase are accepted (InteractionBus `gen_...`, Recovery `rtg-...`)
 * WITHOUT importing either subsystem: the pattern is structural only
 * and carries no semantics. A recorded generation is historical.
 */
const GENERATION_REF_PATTERN = /^(?:gen|rtg)[_-][a-z0-9][a-z0-9_-]{4,62}$/;

/**
 * Source ids name the emitting subsystem ("authority", "runtime.recovery").
 * Same shape as transport ids elsewhere: lowercase dotted path.
 */
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){0,7}$/;

/**
 * Correlation keys are a CLOSED set. Values are opaque bounded strings;
 * specific prefixes of sibling lanes are NOT enforced so this module
 * stays independent of sibling branches.
 */
const CORRELATION_KEYS = Object.freeze([
    "interactionId",
    "sessionId",
    "correlationId",
    "turnId",
    "projectId",
    "deviceId"
]);

const REF_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function isRefValue(v) {
    return typeof v === "string" && v.length > 0 && v.length <= 128 && REF_VALUE_PATTERN.test(v);
}

function newAuditEventId() {
    return `ae-${crypto.randomBytes(16).toString("hex")}`;
}

function coerceAuditEventId(value) {
    if (typeof value !== "string") {
        throw new TypeError("AuditEventId must be a string");
    }
    if (value.length > 64) {
        throw new RangeError("AuditEventId exceeds maximum length");
    }
    if (!AUDIT_EVENT_ID_PATTERN.test(value)) {
        throw new RangeError(`AuditEventId malformed: ${JSON.stringify(value.slice(0, 16))}`);
    }
    return value;
}

function coerceSourceId(value) {
    if (typeof value !== "string") {
        throw new TypeError("source must be a string");
    }
    if (value.length > 64 || !SOURCE_ID_PATTERN.test(value)) {
        throw new RangeError(`source malformed: ${JSON.stringify(String(value).slice(0, 24))}`);
    }
    return value;
}

function coerceGenerationRef(value) {
    if (typeof value !== "string" || value.length > 128 || !GENERATION_REF_PATTERN.test(value)) {
        throw new RangeError("generation ref malformed");
    }
    return value;
}

function coerceCorrelation(input) {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== "object" || Array.isArray(input)) {
        throw new RangeError("correlation must be an object");
    }
    const keys = Object.keys(input);
    const out = {};
    for (const key of keys) {
        if (!CORRELATION_KEYS.includes(key)) {
            throw new RangeError(`unknown correlation key: ${key}`);
        }
        const value = input[key];
        if (value === undefined || value === null) continue;
        if (!isRefValue(value)) {
            throw new RangeError(`correlation value malformed for ${key}`);
        }
        out[key] = value;
    }
    return Object.keys(out).length > 0 ? Object.freeze(out) : undefined;
}

module.exports = Object.freeze({
    AUDIT_EVENT_ID_PATTERN: Object.freeze(AUDIT_EVENT_ID_PATTERN.source),
    GENERATION_REF_PATTERN: Object.freeze(GENERATION_REF_PATTERN.source),
    SOURCE_ID_PATTERN: Object.freeze(SOURCE_ID_PATTERN.source),
    CORRELATION_KEYS,
    newAuditEventId,
    coerceAuditEventId,
    coerceSourceId,
    coerceGenerationRef,
    coerceCorrelation,
    isRefValue
});
