"use strict";

const crypto = require("crypto");

function computeChecksum(identity) {
    const data = JSON.stringify({
        identityId: identity.identityId,
        generation: identity.generation,
        keyRef: identity.keyRef,
    });
    return crypto.createHash("sha256").update(data).digest("hex");
}

function makeCheckpoint(identity) {
    return {
        identityId: identity.identityId,
        generation: identity.generation,
        checksum: computeChecksum(identity),
        savedAt: Date.now(),
    };
}

function verifyCheckpoint(identity, checkpoint) {
    // RT-W10-16: mismatch → DISPUTED
    if (!checkpoint) return "VERIFIED";
    if (identity.generation !== checkpoint.generation) return "DISPUTED";
    if (computeChecksum(identity) !== checkpoint.checksum) return "DISPUTED";
    return "VERIFIED";
}

module.exports = { makeCheckpoint, verifyCheckpoint };
