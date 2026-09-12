"use strict";

/**
 * R5-04 test helper — compute the SHA-256 of an artifact file so tests pin the
 * REAL validated-artifact digest (digest pinning is mandatory end-to-end: the
 * native sandbox host verifies source + staged digests before launch).
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

function sha256File(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Pin the digest of a real artifact on a federation candidate and enable it.
 * `fed` must already have `discover`+`inspect` called for `candidateId`.
 */
function validateAndEnableTool(fed, candidateId, { toolName, artifactPath }) {
    const digest = sha256File(artifactPath);
    fed.validate(candidateId, { toolDigests: { [toolName]: digest } });
    fed.enableTool(candidateId, { toolName });
    return digest;
}

module.exports = { sha256File, validateAndEnableTool };
