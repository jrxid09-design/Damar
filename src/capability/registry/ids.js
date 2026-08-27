"use strict";

/**
 * CAPABILITY REGISTRY V1 — canonical identity.
 *
 * CapabilityId and Provenance are opaque canonical labels. They carry NO
 * authority, trust, or permission semantics: they are descriptive identity
 * only. Identity is derived exclusively from validated, canonicalized
 * strings — never from display names, folder names, or file paths.
 *
 * Grammar (fail-closed, lowercase-only so case tricks cannot collide):
 *   CapabilityId:
 *     segment := [a-z0-9]([a-z0-9._-]*[a-z0-9])?
 *     id      := segment ("." segment)*         total length 3..256
 *
 *   Provenance:
 *     core/runtime | tool:<id> | extension:<id> | device:<id> |
 *     provider:<id> | system:<id>
 *     <id> follows the same segment grammar.
 *
 * Rejected: uppercase, whitespace (incl. NBSP/BOM), path separators,
 * scheme characters, empty/double dots, reserved prototype-ish segments,
 * oversized values.
 *
 * Authority-shaped provenance (authority / owner / root) is rejected at the
 * boundary: a descriptor can never self-assert privilege through its own
 * provenance string.
 */

const { fail, REASONS } = require("./errors");

const CAP_MIN = 3;
const CAP_MAX = 256;
const PROV_MIN = 1;
const PROV_MAX = 256;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

const RESERVED_SEGMENTS = Object.freeze(new Set([
    "__proto__", "constructor", "prototype", "proto"
]));

/** Provenance values that, if a caller asserted them, could be read as
 *  self-granted privilege. They are evidence words only and are rejected
 *  as caller-supplied provenance sources. */
const FORBIDDEN_PROVENANCE = Object.freeze(new Set([
    "authority", "owner", "root"
]));

/** Canonical top-level provenance scopes (allowed as literal values). */
const CORE_RUNTIME_PROVENANCE = "core/runtime";
const SYSTEM_PROVENANCE = "system";

const PROVENANCE_SCHEMES = Object.freeze(new Set([
    "tool", "extension", "device", "provider", "system"
]));

function assertSegments(value, kind) {
    if (typeof value !== "string") {
        throw fail(REASONS.MALFORMED_INPUT, `${kind} must be a string, got ${typeof value}`);
    }
    for (const ch of value) {
        if (/\s/.test(ch) || ch === "\u00a0" || ch === "\ufeff") {
            throw fail(REASONS.INVALID_CAPABILITY_ID,
                `${kind} must not contain whitespace`, { received: truncate(value) });
        }
    }
    if (value.includes("/") || value.includes("\\") || value.includes(":")) {
        throw fail(REASONS.INVALID_CAPABILITY_ID,
            `${kind} must not contain path or scheme characters`, { received: truncate(value) });
    }
    return value;
}

function assertLength(value, min, max, kind, reason) {
    if (value.length < min || value.length > max) {
        throw fail(reason, `${kind} length out of range (${min}..${max})`,
            { length: value.length });
    }
}

function assertNoReservedSegments(value, kind) {
    for (const seg of value.split(".")) {
        if (RESERVED_SEGMENTS.has(seg)) {
            throw fail(REASONS.INVALID_CAPABILITY_ID,
                `${kind} uses reserved segment '${seg}'`, { received: truncate(value) });
        }
    }
}

/**
 * Canonicalize a raw capability id string into its canonical form.
 * Lowercases and trims; rejects malformed dot structure, whitespace,
 * path/scheme characters, reserved segments, and out-of-range lengths.
 */
function canonicalCapabilityId(raw) {
    if (typeof raw !== "string") {
        throw fail(REASONS.INVALID_CAPABILITY_ID,
            `capability id must be string, got ${typeof raw}`);
    }
    const value = raw.trim().toLowerCase();
    assertSegments(value, "capability id");
    assertLength(value, CAP_MIN, CAP_MAX, "capability id", REASONS.INVALID_CAPABILITY_ID);
    if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) {
        throw fail(REASONS.INVALID_CAPABILITY_ID,
            "capability id has malformed dot structure", { received: truncate(raw) });
    }
    if (!ID_PATTERN.test(value)) {
        throw fail(REASONS.INVALID_CAPABILITY_ID,
            "capability id violates grammar", { received: truncate(raw) });
    }
    assertNoReservedSegments(value, "capability id");
    return value;
}

function isValidCapabilityId(raw) {
    try { canonicalCapabilityId(raw); return true; } catch { return false; }
}

/**
 * Canonicalize a provenance string. Accepts only the bounded canonical
 * grammar and rejects authority/owner/root self-assertion at the boundary.
 * Returns the normalized string.
 */
function canonicalProvenance(raw) {
    if (typeof raw !== "string") {
        throw fail(REASONS.INVALID_PROVENANCE,
            `provenance must be string, got ${typeof raw}`);
    }
    const value = raw.trim().toLowerCase();
    assertLength(value, PROV_MIN, PROV_MAX, "provenance", REASONS.INVALID_PROVENANCE);

    // exact canonical core/runtime and system literals
    if (value === CORE_RUNTIME_PROVENANCE || value === SYSTEM_PROVENANCE) {
        return value;
    }

    // forbidden self-asserted privilege words
    if (FORBIDDEN_PROVENANCE.has(value)) {
        throw fail(REASONS.INVALID_PROVENANCE_SCOPE,
            `provenance '${value}' is a self-asserted privilege scope and is rejected`,
            { received: truncate(value) });
    }

    // scheme-scoped: scheme:<id>
    const colon = value.indexOf(":");
    if (colon === -1) {
        // bare provenance that is not a recognized scope word
        if (FORBIDDEN_PROVENANCE.has(value)) {
            throw fail(REASONS.INVALID_PROVENANCE_SCOPE,
                `provenance '${value}' is a self-asserted privilege scope and is rejected`);
        }
        // allow bare non-forbidden strings only if they look like a scoped id
        // (single segment); strictly, provenance must be core/runtime, system,
        // or scheme:<id>.
        throw fail(REASONS.INVALID_PROVENANCE,
            `provenance '${value}' must be core/runtime, system, or scheme:<id>`,
            { received: truncate(value) });
    }
    const scheme = value.slice(0, colon);
    const rest = value.slice(colon + 1);
    if (!PROVENANCE_SCHEMES.has(scheme)) {
        throw fail(REASONS.INVALID_PROVENANCE,
            `provenance scheme '${scheme}' is not recognized`,
            { received: truncate(scheme) });
    }
    // forbid forbidden words appearing as scheme or id
    if (FORBIDDEN_PROVENANCE.has(scheme)) {
        throw fail(REASONS.INVALID_PROVENANCE_SCOPE,
            `provenance scheme '${scheme}' is a self-asserted privilege scope and is rejected`);
    }
    if (!rest || rest.length > CAP_MAX) {
        throw fail(REASONS.INVALID_PROVENANCE,
            `provenance id part is empty or too long`, { received: truncate(rest) });
    }
    assertSegments(rest, "provenance id");
    if (!ID_PATTERN.test(rest)) {
        throw fail(REASONS.INVALID_PROVENANCE,
            "provenance id part violates grammar", { received: truncate(rest) });
    }
    assertNoReservedSegments(rest, "provenance id");
    return value;
}

function isValidProvenance(raw) {
    try { canonicalProvenance(raw); return true; } catch { return false; }
}

function truncate(s) {
    return typeof s === "string" ? s.slice(0, 80) : String(s).slice(0, 80);
}

module.exports = {
    canonicalCapabilityId,
    isValidCapabilityId,
    canonicalProvenance,
    isValidProvenance,
    ID_PATTERN,
    RESERVED_SEGMENTS,
    FORBIDDEN_PROVENANCE,
    PROVENANCE_SCHEMES,
    CORE_RUNTIME_PROVENANCE,
    SYSTEM_PROVENANCE,
    CAP_MAX,
    CAP_MIN
};
