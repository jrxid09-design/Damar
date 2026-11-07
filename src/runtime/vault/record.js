"use strict";

const { assertSecretId } = require("./ids");
const { coerceSecretScope } = require("./scope");
const { invalidInput } = require("./errors");
const { isValidDigestFormat } = require("./digest");
const crypto = require("node:crypto");

/**
 * Internal secret record — the storage-level truth.
 *
 * INVARIANT: exactly one of
 *   - status "active"   + envelope present
 *   - status "revoked"  + NO envelope (cleartext destroyed)
 *   - status "evidence" + NO envelope (recovery-imported metadata)
 *
 * INCARNATION (R31): every canonical record carries an `incarnationId`
 * identifying ONE creation lifetime of its SecretId.
 *
 *   - SecretId      = stable logical secret identity.
 *   - incarnationId = identity of one creation lifetime of that SecretId.
 *
 * A fresh create MUST produce a fresh incarnationId; delete → recreate
 * with the same SecretId MUST produce a DIFFERENT incarnationId even
 * when timestamps are identical and version restarts at 1. Rotation is
 * a new secret VALUE version, NOT a new record incarnation: rotation,
 * revocation, describe, resolve, and file-store reopen all preserve the
 * incarnationId exactly.
 *
 * incarnationId is 128 bits of cryptographically-strong randomness from
 * node:crypto (randomBytes), rendered as a bounded, validated, log-safe
 * `inc-<32 hex>` string. It is NEVER derived from timestamp, version,
 * scope, secret value, digest, or the clock.
 */

const INCARNATION_PREFIX = "inc-";
const INCARNATION_HEX_LENGTH = 32; // 16 bytes == 128 bits
const INCARNATION_PATTERN = /^inc-[0-9a-f]{32}$/;
const MAX_INCARNATION_INPUT_LENGTH = 96;

/** 128-bit (32-hex-char) incarnation identifier — safe to inspect/log. */
function generateIncarnationId() {
    return `${INCARNATION_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
}

/**
 * Validate an incarnationId. Fails closed with a TYPED VaultError
 * (VAULT_INVALID_INPUT) — never a bare TypeError — so hostile or
 * corrupt input cannot regress the B2 error contract.
 */
function validateIncarnationId(id) {
    if (typeof id !== "string" || id.length > MAX_INCARNATION_INPUT_LENGTH || !INCARNATION_PATTERN.test(id)) {
        throw invalidInput(
            "incarnationId must match inc-<32 lowercase hex>",
            typeof id === "string" ? id.slice(0, 32) : typeof id
        );
    }
    return id;
}

/**
 * Build (validate + freeze) a canonical record.
 *
 * @param {object} input
 * @param {object} [options]
 *   options.generate — when `true` (default), a missing incarnationId is
 *   treated as FRESH CONSTRUCTION and a new one is generated. The
 *   persistence/restore boundary MUST pass `generate: false` so a missing
 *   or malformed persisted incarnationId fails closed instead of being
 *   silently re-rolled (which would change identity across reopen).
 */
function buildSecretRecord(input, options = {}) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw invalidInput("secret record must be an object");
    }
    const generate = options.generate !== false;

    let incarnationId = input.incarnationId;
    if (incarnationId === undefined || incarnationId === null) {
        if (generate) {
            incarnationId = generateIncarnationId();
        } else {
            throw invalidInput("incarnationId required for persisted record");
        }
    }
    validateIncarnationId(incarnationId);

    const rec = {
        secretId: assertSecretId(input.secretId),
        scope: coerceSecretScope(input.scope),
        status: input.status,
        label: typeof input.label === "string" ? input.label : "",
        createdAt: input.createdAt,
        rotatedAt: input.rotatedAt ?? null,
        rotationCount: input.rotationCount ?? 0,
        valueBytes: input.valueBytes ?? 0,
        valueDigest: input.valueDigest ?? null,
        version: input.version ?? 1,
        envelope: input.envelope ?? null,
        incarnationId
    };
    if (!["active", "revoked", "evidence"].includes(rec.status)) {
        throw invalidInput("unknown secret record status", String(rec.status).slice(0, 24));
    }
    if (!Number.isSafeInteger(rec.createdAt) || rec.createdAt < 0) {
        throw invalidInput("createdAt invalid");
    }
    if (!Number.isSafeInteger(rec.rotationCount) || rec.rotationCount < 0) {
        throw invalidInput("rotationCount invalid");
    }
    if (!Number.isSafeInteger(rec.version) || rec.version < 1) {
        throw invalidInput("version invalid");
    }
    if (rec.status === "active") {
        if (rec.envelope === null || typeof rec.envelope !== "object") {
            throw invalidInput("active record requires an envelope");
        }
        if (typeof rec.valueDigest !== "string" || !isValidDigestFormat(rec.valueDigest)) {
            throw invalidInput("active record requires a valid valueDigest");
        }
        if (!Number.isSafeInteger(rec.valueBytes) || rec.valueBytes <= 0) {
            throw invalidInput("active record requires positive valueBytes");
        }
    } else {
        if (rec.envelope !== null) {
            throw invalidInput(`${rec.status} record must not retain an envelope`);
        }
        rec.valueBytes = 0;
        rec.valueDigest = null;
        rec.rotatedAt = rec.rotatedAt;
    }
    return Object.freeze(rec);
}

module.exports = Object.freeze({
    INCARNATION_PREFIX,
    INCARNATION_HEX_LENGTH,
    INCARNATION_PATTERN: Object.freeze(INCARNATION_PATTERN.source),
    MAX_INCARNATION_INPUT_LENGTH,
    generateIncarnationId,
    validateIncarnationId,
    buildSecretRecord
});
