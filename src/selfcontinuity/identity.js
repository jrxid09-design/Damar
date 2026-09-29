"use strict";

const { IDENTITY_SCHEMA_VERSION } = require("./laws");

function makeIdentityRecord(opts = {}) {
    if (!opts.identityId) throw new Error("identityId required");
    if (!opts.keyRef) throw new Error("keyRef required — identity must be key-bound (W10-L2/RT-W10-11)");
    return {
        schemaVersion: IDENTITY_SCHEMA_VERSION,
        identityId: opts.identityId,
        keyRef: opts.keyRef,
        generation: 1,
        state: "ACTIVE",
        grants: [], // RT-W10-14: restore never restores grants — empty on creation/restore
        createdAt: Date.now(),
    };
}

module.exports = { makeIdentityRecord };
