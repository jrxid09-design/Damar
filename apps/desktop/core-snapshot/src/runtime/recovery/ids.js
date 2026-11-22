"use strict";

const crypto = require("node:crypto");

/**
 * Canonical identifiers for the Recovery Capsule subsystem.
 *
 * IDs are identity ONLY. They carry no authority semantics, no
 * filesystem path semantics, and cannot smuggle traversal segments.
 * All formats are closed, lowercase, fixed-length, and fail closed
 * on any malformed input.
 */

const CAPSULE_ID_PATTERN = /^rc-[0-9a-f]{32}$/;
const GENERATION_ID_PATTERN = /^rtg-[0-9a-f]{32}$/;
const EPOCH_ID_PATTERN = /^repoch-[0-9]{20}$/;
const SECTION_ID_PATTERN = /^[a-z]$|^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,30}[a-z0-9]$/;
const EPOCH_MAX = 10n ** 20n - 1n;

function isNonEmptyString(v) {
    return typeof v === "string" && v.length > 0;
}

function assertPattern(value, pattern, kind) {
    if (!isNonEmptyString(value)) {
        throw new TypeError(`${kind} must be a non-empty string`);
    }
    if (value.length > 128) {
        throw new RangeError(`${kind} exceeds maximum length`);
    }
    if (!pattern.test(value)) {
        throw new RangeError(`${kind} malformed: ${JSON.stringify(value.slice(0, 16))}`);
    }
    return Object.freeze(value);
}

function newRecoveryCapsuleId() {
    return `rc-${crypto.randomBytes(16).toString("hex")}`;
}

function coerceRecoveryCapsuleId(value) {
    return assertPattern(value, CAPSULE_ID_PATTERN, "RecoveryCapsuleId");
}

function newRuntimeGenerationId() {
    return `rtg-${crypto.randomBytes(16).toString("hex")}`;
}

function coerceRuntimeGenerationId(value) {
    return assertPattern(value, GENERATION_ID_PATTERN, "RuntimeGenerationId");
}

/**
 * Epoch ids are zero-padded 20-digit decimal counters so that
 * lexicographic order equals numeric order (deterministic sorting).
 */
function newRecoveryEpochId(n) {
    if (!Number.isSafeInteger(n) || n < 1 || BigInt(n) > EPOCH_MAX) {
        throw new RangeError("RecoveryEpochId counter out of range");
    }
    return `repoch-${String(n).padStart(20, "0")}`;
}

function coerceRecoveryEpochId(value) {
    const id = assertPattern(value, EPOCH_ID_PATTERN, "RecoveryEpochId");
    const n = BigInt(id.slice("repoch-".length));
    if (n < 1n) {
        throw new RangeError("RecoveryEpochId counter out of range");
    }
    return id;
}

function epochRank(epochId) {
    const id = coerceRecoveryEpochId(epochId);
    return Number(BigInt(id.slice("repoch-".length)));
}

function coerceSectionId(value) {
    return assertPattern(value, SECTION_ID_PATTERN, "RecoverySectionId");
}

module.exports = Object.freeze({
    CAPSULE_ID_PATTERN: Object.freeze(CAPSULE_ID_PATTERN.source),
    GENERATION_ID_PATTERN: Object.freeze(GENERATION_ID_PATTERN.source),
    EPOCH_ID_PATTERN: Object.freeze(EPOCH_ID_PATTERN.source),
    SECTION_ID_PATTERN: Object.freeze(SECTION_ID_PATTERN.source),
    newRecoveryCapsuleId,
    coerceRecoveryCapsuleId,
    newRuntimeGenerationId,
    coerceRuntimeGenerationId,
    newRecoveryEpochId,
    coerceRecoveryEpochId,
    epochRank,
    coerceSectionId
});
