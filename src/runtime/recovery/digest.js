"use strict";

const crypto = require("node:crypto");

/**
 * Content digests (R6).
 *
 * SEMANTICS (binding for all callers and future integrations):
 * A SHA-256 digest here is CORRUPTION / CONSISTENCY DETECTION only.
 * It is NOT authentication, NOT authorization, NOT proof of owner
 * identity, and NOT tamper resistance. An attacker who rewrites
 * payload bytes can also rewrite the digest. Semantic trust comes
 * exclusively from schema + provider validation, never from the hash.
 */

const DIGEST_ALGORITHM = "sha256";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function sha256Hex(input) {
    const h = crypto.createHash(DIGEST_ALGORITHM);
    h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
    return h.digest("hex");
}

/** Digest over canonical JSON of a value. */
function digestOfCanonical(value) {
    const { canonicalBytes } = require("./canonicalJson");
    return sha256Hex(canonicalBytes(value));
}

function isValidDigestFormat(value) {
    return typeof value === "string" && DIGEST_PATTERN.test(value);
}

module.exports = Object.freeze({
    DIGEST_ALGORITHM,
    DIGEST_PATTERN: Object.freeze(DIGEST_PATTERN.source),
    sha256Hex,
    digestOfCanonical,
    isValidDigestFormat
});
