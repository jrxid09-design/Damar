"use strict";

/**
 * WAVE 6 MESH — NodeIdentity (L1).
 *
 * LAWS:
 *   NODE IDENTITY != DEVICE IDENTITY != SESSION IDENTITY != CHANNEL IDENTITY
 *   != MODEL IDENTITY != PROVIDER IDENTITY != DAMAR LOGICAL IDENTITY
 *   TRANSPORT ID != DAMAR IDENTITY
 *
 * A NodeIdentity is opaque (`dnode-<32hex>`). Hostname, IP, MAC, PID are
 * ATTRIBUTES (mutable metadata), never identity. A NodeIdentity binds to
 * exactly one logical Damar identity (`damar-<32hex>`) at creation; that
 * binding is IMMUTABLE for the life of the node record.
 *
 * Node identities are minted by this module only; a caller-supplied nodeId
 * must pass strict format validation, and a forged identity is rejected at
 * registry/trust/routing layers.
 */

const ids = require("./ids");
const { meshFailure, MESH_ERRORS } = require("./errors");
const { sha256Hex } = require("./canonical");

const ATTRIBUTES = Object.freeze({
    MAX_COUNT: 24,
    MAX_KEY_CHARS: 64,
    MAX_VALUE_CHARS: 256
});

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

/**
 * Mint a fresh NodeIdentity for a logical Damar instance.
 * @returns {object} frozen { nodeId, logicalDamarId, createdAtMs, identityProvenance }
 */
function mintNodeIdentity({ logicalDamarId = null, provenance = "generated", attributes = {}, atMs = Date.now() } = {}) {
    const damarId = logicalDamarId ? ids.check.logicalDamarId(logicalDamarId) : ids.mint.logicalDamarId();
    const nodeId = ids.mint.nodeId();
    return Object.freeze({
        nodeId,
        logicalDamarId: damarId,
        createdAtMs: Number.isFinite(atMs) ? Math.floor(atMs) : Date.now(),
        identityProvenance: Object.freeze(String(provenance ?? "generated").slice(0, 64)),
        attributes: freezeAttributes(attributes),
        identityDigest: sha256Hex({ nodeId, logicalDamarId: damarId })
    });
}

/**
 * Adopt an EXISTING opaque node id (e.g. restored from persistence).
 * Rejects malformed/forged identifiers.
 */
function adoptNodeIdentity({ nodeId, logicalDamarId, provenance = "restored", attributes = {}, atMs = Date.now() } = {}) {
    const checked = ids.check.nodeId(nodeId);
    const damarId = ids.check.logicalDamarId(logicalDamarId);
    return Object.freeze({
        nodeId: checked,
        logicalDamarId: damarId,
        createdAtMs: Number.isFinite(atMs) ? Math.floor(atMs) : Date.now(),
        identityProvenance: Object.freeze(String(provenance ?? "restored").slice(0, 64)),
        attributes: freezeAttributes(attributes),
        identityDigest: sha256Hex({ nodeId: checked, logicalDamarId: damarId })
    });
}

/** Strict validation of an externally supplied identity object. */
function coerceNodeIdentity(value) {
    if (!value || typeof value !== "object") {
        throw meshFailure(MESH_ERRORS.NODE_IDENTITY_MALFORMED, "node identity must be an object");
    }
    try {
        return adoptNodeIdentity(value);
    } catch (e) {
        if (e.name === "RangeError" || e.name === "TypeError") {
            throw meshFailure(MESH_ERRORS.NODE_IDENTITY_MALFORMED, `malformed node identity: ${String(e.message).slice(0, 120)}`);
        }
        throw e;
    }
}

function freezeAttributes(attributes = {}) {
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
        throw meshFailure(MESH_ERRORS.NODE_IDENTITY_MALFORMED, "attributes must be an object");
    }
    const keys = Object.keys(attributes);
    if (keys.length > ATTRIBUTES.MAX_COUNT) {
        throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `attributes exceed ${ATTRIBUTES.MAX_COUNT} entries`);
    }
    const out = {};
    for (const k of keys) {
        if (DANGEROUS_KEYS.has(k)) throw meshFailure(MESH_ERRORS.NODE_IDENTITY_MALFORMED, "dangerous attribute key");
        if (typeof k !== "string" || k.length === 0 || k.length > ATTRIBUTES.MAX_KEY_CHARS) {
            throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "attribute key length");
        }
        const v = attributes[k];
        if (typeof v !== "string" || v.length > ATTRIBUTES.MAX_VALUE_CHARS) {
            throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `attribute '${k.slice(0, 16)}' must be a string <= ${ATTRIBUTES.MAX_VALUE_CHARS} chars`);
        }
        out[k] = v;
    }
    return Object.freeze(out);
}

module.exports = Object.freeze({
    mintNodeIdentity, adoptNodeIdentity, coerceNodeIdentity,
    ATTRIBUTES, DANGEROUS_KEYS
});
