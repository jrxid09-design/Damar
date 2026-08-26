"use strict";

const { assertSecretId } = require("./ids");
const { coerceSecretScope } = require("./scope");
const { invalidInput } = require("./errors");
const { isValidDigestFormat } = require("./digest");

/**
 * Internal secret record — the storage-level truth.
 *
 * INVARIANT: exactly one of
 *   - status "active"   + envelope present
 *   - status "revoked"  + NO envelope (cleartext destroyed)
 *   - status "evidence" + NO envelope (recovery-imported metadata)
 */

function buildSecretRecord(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw invalidInput("secret record must be an object");
    }
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
        envelope: input.envelope ?? null
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
    buildSecretRecord
});
