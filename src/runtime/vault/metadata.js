"use strict";

const { assertSecretId } = require("./ids");
const { coerceSecretScope } = require("./scope");
const { invalidInput } = require("./errors");
const { DIGEST_PATTERN_SOURCE } = require("./digest");

/**
 * SecretMetadata — everything the vault knows ABOUT a secret that is
 * safe to expose. Contains NO raw value. Frozen, bounded, canonical.
 *
 * status:
 *   active    — value stored, resolvable
 *   revoked   — value destroyed; ref remains meaningful for audit;
 *               resolution is denied (never empty-string)
 *   evidence  — restored from recovery evidence; metadata only, no
 *               value; resolution denied until a fresh value is set
 */

const SECRET_STATUSES = Object.freeze(
    ["active", "revoked", "evidence"].reduce((m, s) => ((m[s] = s), m), {})
);

const MAX_LABEL_LENGTH = 128;

function checkInt(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw invalidInput(`${name} must be a non-negative safe integer`);
    }
    return value;
}

/**
 * Builds frozen metadata from an internal record. `input` must be an
 * already-internal record shape; hostile callers go through the vault,
 * never here. Keys are extracted explicitly — no spread.
 */
function buildSecretMetadata(record) {
    if (typeof record !== "object" || record === null) {
        throw invalidInput("secret record required");
    }
    const secretId = assertSecretId(record.secretId);
    const scope = coerceSecretScope(record.scope);
    const status = record.status;
    if (!Object.prototype.hasOwnProperty.call(SECRET_STATUSES, status)) {
        throw invalidInput("unknown secret status", String(status).slice(0, 24));
    }
    const createdAt = checkInt(record.createdAt, "createdAt");
    let rotatedAt = null;
    if (record.rotatedAt !== undefined && record.rotatedAt !== null) {
        rotatedAt = checkInt(record.rotatedAt, "rotatedAt");
    }
    const rotationCount = checkInt(record.rotationCount ?? 0, "rotationCount");
    if (!Number.isSafeInteger(rotationCount)) {
        throw invalidInput("rotationCount out of range");
    }
    const valueBytes = checkInt(record.valueBytes ?? 0, "valueBytes");
    let label = "";
    if (record.label !== undefined && record.label !== null) {
        if (typeof record.label !== "string") {
            throw invalidInput("label must be a string");
        }
        if (record.label.length > MAX_LABEL_LENGTH) {
            throw invalidInput("label exceeds maximum length");
        }
        label = record.label;
    }
    let valueDigest = null;
    if (record.valueDigest !== undefined && record.valueDigest !== null) {
        if (typeof record.valueDigest !== "string" ||
            !new RegExp(DIGEST_PATTERN_SOURCE).test(record.valueDigest)) {
            throw invalidInput("valueDigest malformed");
        }
        valueDigest = record.valueDigest;
    } else if (status === "active") {
        throw invalidInput("valueDigest required for valued secrets");
    }

    return Object.freeze({
        v: 1,
        secretId,
        scope,
        status,
        label,
        createdAt,
        rotatedAt,
        rotationCount,
        valueBytes: status === "active" ? valueBytes : 0,
        valueDigest: status === "active" ? valueDigest : null
    });
}

module.exports = Object.freeze({
    SECRET_STATUSES,
    MAX_LABEL_LENGTH,
    buildSecretMetadata
});
