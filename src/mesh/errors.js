"use strict";

/**
 * WAVE 6 MESH — typed failure envelopes (L1).
 *
 * Prefer typed failures over thrown strings. No fake successful content.
 * CALLER-SELECTED `cause`/detail strings are bounded and never include
 * stack traces.
 */

const MESH_ERRORS = Object.freeze([
    // identity / trust
    "NODE_IDENTITY_MALFORMED",
    "NODE_UNTRUSTED",
    "NODE_REVOKED",
    "NODE_QUARANTINED",
    "TRUST_GENERATION_STALE",
    "TRUST_SCOPE_MISSING",
    "TRUST_EXPIRED",
    "PAIRING_INVALID",
    "PAIRING_EXPIRED",
    "PAIRING_PENDING_OWNER_CONFIRMATION",
    "IDENTITY_IMMUTABLE",
    // envelope / transport
    "MESH_REPLAY",
    "MESSAGE_EXPIRED",
    "MESSAGE_MALFORMED",
    "SCHEMA_VERSION_UNSUPPORTED",
    "DESTINATION_MISMATCH",
    "PAYLOAD_DIGEST_MISMATCH",
    "AUTHENTICITY_INVALID",
    "TRANSPORT_SPOOF",
    // registry / presence
    "NODE_UNKNOWN",
    "NODE_REGISTRY_FULL",
    "REGISTRY_UPDATE_REJECTED",
    "ROUTE_UNAVAILABLE",
    // bounds
    "BOUNDS_EXCEEDED"
].reduce((m, e) => (m[e] = e, m), {}));

class MeshError extends Error {
    /**
     * @param {string} code one of MESH_ERRORS
     * @param {string} message bounded human context (no stack, no secrets)
     * @param {object} [details] bounded structured context
     */
    constructor(code, message, details = null) {
        if (!MESH_ERRORS[code]) throw new TypeError(`unknown mesh error code: ${code}`);
        const msg = String(message ?? code).slice(0, 300);
        super(msg);
        this.name = "MeshError";
        this.code = code;
        this.details = details && typeof details === "object" ? details : null;
    }
    toJSON() {
        return { error: "MeshError", code: this.code, message: this.message, details: this.details };
    }
}

function meshFailure(code, message, details = null) {
    const e = new MeshError(code, message, details);
    e.failure = Object.freeze({ kind: "MESH_FAILURE", code, message: e.message, details: e.details });
    return e;
}

function isMeshFailure(value, code = null) {
    if (!value || value.name !== "MeshError") return false;
    return code ? value.code === code : Boolean(MESH_ERRORS[value.code]);
}

module.exports = Object.freeze({ MESH_ERRORS, MeshError, meshFailure, isMeshFailure });
