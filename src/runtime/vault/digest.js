"use strict";

const crypto = require("node:crypto");

/**
 * Content digests for the Vault.
 *
 * SEMANTICS (binding): a digest here is CORRUPTION / CONSISTENCY
 * DETECTION only. It is NOT authentication, NOT authorization, and
 * NOT tamper resistance. Digests are derived from secret VALUES but
 * are one-way and truncated-domain; they never reveal the value.
 * They must never be treated as proof of correctness of a credential.
 */

const DIGEST_ALGORITHM = "sha256";
const DIGEST_PATTERN_SOURCE = "^[0-9a-f]{64}$";

function sha256Hex(input) {
    const h = crypto.createHash(DIGEST_ALGORITHM);
    h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
    return h.digest("hex");
}

/** Digest over a raw value buffer. Used only inside the vault core. */
function digestOfValue(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        throw new TypeError("value digest requires a Buffer");
    }
    return sha256Hex(buffer);
}

function isValidDigestFormat(value) {
    return typeof value === "string" && new RegExp(DIGEST_PATTERN_SOURCE).test(value);
}

module.exports = Object.freeze({
    DIGEST_ALGORITHM,
    DIGEST_PATTERN_SOURCE,
    sha256Hex,
    digestOfValue,
    isValidDigestFormat
});
