"use strict";

/**
 * WAVE 6 L5 — public surface (Portable Core / Edge Runtime).
 */

const edge = require("./edgeRuntime");

module.exports = Object.freeze({
    ...edge,
    laws: Object.freeze({
        EDGE_PROFILE_NOT_AUTHORITY_LEVEL: true,
        USB_PRESENCE_NOT_AUTHORITY: true,
        OFFLINE_NOT_REVOKED: true,
        OFFLINE_CORE_NEVER_INVENTS_APPROVALS: true,
        RECONNECT_RECONCILES_NEVER_OVERWRITES: true,
        MODEL_SWAP_NOT_RUNTIME_REDESIGN: true
    })
});
