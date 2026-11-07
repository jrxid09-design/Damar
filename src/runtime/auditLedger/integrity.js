"use strict";

const crypto = require("node:crypto");

/**
 * Audit Ledger V1 — integrity primitives.
 *
 * BINDING SEMANTICS (same posture as the Recovery capsule digests):
 * A SHA-256 digest here is CORRUPTION / CONSISTENCY DETECTION ONLY.
 * It is NOT authentication, NOT authorization, NOT proof of owner
 * identity, and NOT non-repudiation. Anyone able to rewrite stored
 * records can also recompute the chain. Trust in ledger contents comes
 * from the producing subsystems' own validation, never from the hash.
 *
 * The hash chain still meaningfully improves V1: accidental mutation,
 * partial writes, or buggy tooling that alters any retained record
 * breaks deterministic linkage and is detectable via verifyIntegrity().
 */

const DIGEST_ALGORITHM = "sha256";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function sha256Hex(input) {
    const h = crypto.createHash(DIGEST_ALGORITHM);
    h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
    return h.digest("hex");
}

function isValidDigestFormat(value) {
    return typeof value === "string" && DIGEST_PATTERN.test(value);
}

module.exports = Object.freeze({
    DIGEST_ALGORITHM,
    DIGEST_PATTERN: Object.freeze(DIGEST_PATTERN.source),
    sha256Hex,
    isValidDigestFormat
});
