"use strict";

/**
 * EXTENSION KERNEL V1 — canonical identity.
 *
 * ExtensionId / ProjectId are opaque canonical labels. They carry NO
 * capability, authority or trust semantics. Identity is derived only from
 * the manifest field `extensionId` after strict canonicalization — never
 * from display names, folder names, or file paths.
 *
 * Grammar (fail-closed, lowercase-only so case tricks cannot collide):
 *   segment := [a-z0-9]([a-z0-9-]*[a-z0-9])?
 *   id      := segment ("." segment)*            total length 3..128
 *
 * Rejected: uppercase, whitespace anywhere (incl. NBSP/BEM), empty/double
 * dots, path separators, reserved prototype-ish segments, oversized values.
 */

const { fail, REASONS } = require("./errors");

const EXT_BRAND = Symbol("aether.extensions.extensionIdBrand");
const PROJ_BRAND = Symbol("aether.extensions.projectIdBrand");

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const MIN_LENGTH = 3;
const MAX_LENGTH = 128;

const RESERVED_SEGMENTS = Object.freeze(new Set([
    "__proto__", "constructor", "prototype", "proto"
]));

function assertCanonicalIdValue(value, kind) {
    if (typeof value !== "string") {
        throw fail(REASONS.MALFORMED_INPUT, `${kind} must be a string, got: ${typeof value}`);
    }
    for (const ch of value) {
        if (/\s/.test(ch) || ch === "\u00a0" || ch === "\ufeff") {
            throw fail(REASONS.INVALID_EXTENSION_ID, `${kind} must not contain whitespace`, { received: truncate(value) });
        }
    }
    if (value.includes("/") || value.includes("\\") || value.includes(":")) {
        throw fail(REASONS.INVALID_EXTENSION_ID,
            `${kind} must not contain path or scheme characters`, { received: truncate(value) });
    }
    if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) {
        throw fail(REASONS.INVALID_EXTENSION_ID,
            `${kind} length out of range (${MIN_LENGTH}..${MAX_LENGTH})`, { length: value.length });
    }
    if (!ID_PATTERN.test(value)) {
        throw fail(REASONS.INVALID_EXTENSION_ID,
            `${kind} violates canonical grammar`, { received: truncate(value) });
    }
    for (const seg of value.split(".")) {
        if (RESERVED_SEGMENTS.has(seg)) {
            throw fail(REASONS.INVALID_EXTENSION_ID,
                `${kind} uses reserved segment '${seg}'`, { received: truncate(value) });
        }
    }
    return value;
}

function makeBrandedId(BRAND, kind, raw) {
    const value = assertCanonicalIdValue(raw, kind);
    return Object.freeze({
        [BRAND]: true,
        kind,
        value,
        toString() { return value; },
        equals(other) {
            return other !== null && typeof other === "object" &&
                other.kind === kind && other.value === value;
        }
    });
}

/**
 * Canonicalize a raw extension id. Accepts an authentic branded instance
 * (verified, not assumed), an internal frozen {kind,value} view, or a raw
 * string. Anything else fails closed.
 */
function createExtensionId(raw) {
    if (raw !== null && typeof raw === "object") {
        if (raw[EXT_BRAND] === true && raw.kind === "ExtensionId" && typeof raw.value === "string") {
            assertCanonicalIdValue(raw.value, "ExtensionId");
            return raw;
        }
        // internal frozen view produced by manifest parsing
        if (Object.isFrozen(raw) && raw.kind === "ExtensionId" && typeof raw.value === "string") {
            return makeBrandedId(EXT_BRAND, "ExtensionId", raw.value);
        }
        throw fail(REASONS.INVALID_EXTENSION_ID, "unbranded lookalike id objects are not accepted");
    }
    return makeBrandedId(EXT_BRAND, "ExtensionId", raw);
}

/** Accepts branded ProjectId or raw string; fails closed otherwise. */
function createProjectId(raw) {
    if (raw !== null && typeof raw === "object") {
        if (raw[PROJ_BRAND] === true && raw.kind === "ProjectId" && typeof raw.value === "string") {
            assertCanonicalIdValue(raw.value, "ProjectId");
            return raw;
        }
        throw fail(REASONS.INVALID_PROJECT_ID, "unbranded lookalike project id objects are not accepted");
    }
    return makeBrandedId(PROJ_BRAND, "ProjectId", raw);
}

/** Verify an object really is a branded canonical id of the given kind. */
function asExtensionId(candidate) {
    if (candidate === null || typeof candidate !== "object" ||
        candidate[EXT_BRAND] !== true || candidate.kind !== "ExtensionId") {
        return null;
    }
    try {
        assertCanonicalIdValue(candidate.value, "ExtensionId");
    } catch {
        return null;
    }
    return candidate;
}

function asProjectId(candidate) {
    if (candidate === null || typeof candidate !== "object" ||
        candidate[PROJ_BRAND] !== true || candidate.kind !== "ProjectId") {
        return null;
    }
    try {
        assertCanonicalIdValue(candidate.value, "ProjectId");
    } catch {
        return null;
    }
    return candidate;
}

function idToString(id) {
    const verified = asExtensionId(id);
    if (!verified) throw fail(REASONS.INVALID_EXTENSION_ID, "not an authentic canonical ExtensionId");
    return verified.value;
}

function projectToString(id) {
    const verified = asProjectId(id);
    if (!verified) throw fail(REASONS.INVALID_PROJECT_ID, "not an authentic canonical ProjectId");
    return verified.value;
}

/** Capability-id grammar for ADVERTISEMENT ONLY (never authority). */
const CAPABILITY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const CAP_MIN = 3;
const CAP_MAX = 128;

function canonicalCapabilityName(raw) {
    if (typeof raw !== "string") {
        throw fail(REASONS.INVALID_CAPABILITY_ID, `capability name must be string, got ${typeof raw}`);
    }
    const name = raw.trim().toLowerCase();
    if (name.length < CAP_MIN || name.length > CAP_MAX) {
        throw fail(REASONS.INVALID_CAPABILITY_ID, "capability name length out of range",
            { received: truncate(raw) });
    }
    if (name.includes("..") || name.startsWith(".") || name.endsWith(".")) {
        throw fail(REASONS.INVALID_CAPABILITY_ID, "capability name has malformed dot structure",
            { received: truncate(raw) });
    }
    if (!CAPABILITY_PATTERN.test(name)) {
        throw fail(REASONS.INVALID_CAPABILITY_ID, "capability name violates grammar",
            { received: truncate(raw) });
    }
    return name;
}

function truncate(s) {
    return typeof s === "string" ? s.slice(0, 80) : String(s).slice(0, 80);
}

module.exports = {
    createExtensionId,
    createProjectId,
    asExtensionId,
    asProjectId,
    idToString,
    projectToString,
    canonicalCapabilityName,
    ID_PATTERN,
    RESERVED_SEGMENTS
};
