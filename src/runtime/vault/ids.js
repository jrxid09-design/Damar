"use strict";

const { invalidInput } = require("./errors");

/**
 * Canonical SecretId.
 *
 * IDENTITY ONLY. A SecretId carries no authority semantics and never
 * contains secret material. It is safe for logs, stable across value
 * rotation, closed-format, lowercase, fixed-length, and fails closed
 * on malformed input. Values are never accepted as identity.
 */

const SECRET_ID_PATTERN = /^sec-[0-9a-f]{32}$/;
const MAX_ID_INPUT_LENGTH = 128;

function isNonEmptyString(v) {
    return typeof v === "string" && v.length > 0;
}

/**
 * Normalization applied BEFORE validation so that case/whitespace
 * variants cannot smuggle duplicate identities ("SEC-x" vs "sec-x").
 * Duplicate normalized ids are rejected by the vault at creation time.
 */
function normalizeSecretIdInput(value) {
    if (!isNonEmptyString(value)) {
        throw invalidInput("SecretId must be a non-empty string");
    }
    if (value.length > MAX_ID_INPUT_LENGTH) {
        throw invalidInput("SecretId input exceeds maximum length");
    }
    return value.trim().toLowerCase();
}

function assertSecretId(value) {
    const id = normalizeSecretIdInput(value);
    if (!SECRET_ID_PATTERN.test(id)) {
        throw invalidInput("SecretId malformed", id.slice(0, 16));
    }
    return Object.freeze(id);
}

function newSecretId(randomBytes) {
    const bytes =
        typeof randomBytes === "function"
            ? randomBytes(16)
            : require("node:crypto").randomBytes(16);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
        throw invalidInput("secret id entropy must be 16 bytes");
    }
    return Object.freeze(`sec-${bytes.toString("hex")}`);
}

/** Deterministic derivation for tests / import tooling only. */
function secretIdFromSeed(seed) {
    if (!isNonEmptyString(seed)) {
        throw invalidInput("seed must be a non-empty string");
    }
    const { createHash } = require("node:crypto");
    return Object.freeze(
        `sec-${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32)}`
    );
}

function isValidSecretId(value) {
    try {
        assertSecretId(value);
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = Object.freeze({
    SECRET_ID_PATTERN: Object.freeze(SECRET_ID_PATTERN.source),
    MAX_ID_INPUT_LENGTH,
    assertSecretId,
    normalizeSecretIdInput,
    newSecretId,
    secretIdFromSeed,
    isValidSecretId
});
