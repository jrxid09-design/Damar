"use strict";

/**
 * WAVE 6 MESH — canonical identifiers (L1).
 *
 * IDs are identity ONLY: opaque, fixed-pattern, fail-closed, no authority
 * semantics, no filesystem/path semantics. Never hostname/IP/MAC/PID.
 * Discipline mirrors frozen recovery ids (rc-/rtg-/repoch-) and the
 * certified Wave 5 tokens (pdlep_, wrtep_).
 */

const crypto = require("node:crypto");

const PATTERNS = Object.freeze({
    nodeId: /^dnode-[0-9a-f]{32}$/,
    logicalDamarId: /^damar-[0-9a-f]{32}$/,
    trustGeneration: /^ntgen-[0-9a-f]{32}$/,
    meshMessageId: /^dmesh-[0-9a-f]{32}$/,
    registryRecordId: /^dnreg-[0-9a-f]{32}$/,
    routeId: /^droute-[0-9a-f]{32}$/,
    pairingTxId: /^dnpair-[0-9a-f]{32}$/
});

function assertPattern(value, pattern, kind) {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${kind} must be a non-empty string`);
    }
    if (value.length > 128) {
        throw new RangeError(`${kind} exceeds maximum length`);
    }
    if (!pattern.test(value)) {
        throw new RangeError(`${kind} malformed: ${JSON.stringify(value.slice(0, 20))}`);
    }
    return Object.freeze(value);
}

const mint = {
    nodeId: () => assertPattern(`dnode-${crypto.randomBytes(16).toString("hex")}`, PATTERNS.nodeId, "nodeId"),
    logicalDamarId: () => assertPattern(`damar-${crypto.randomBytes(16).toString("hex")}`, PATTERNS.logicalDamarId, "logicalDamarId"),
    trustGeneration: () => assertPattern(`ntgen-${crypto.randomBytes(16).toString("hex")}`, PATTERNS.trustGeneration, "trustGeneration"),
    meshMessageId: () => assertPattern(`dmesh-${crypto.randomBytes(16).toString("hex")}`, PATTERNS.meshMessageId, "meshMessageId"),
    registryRecordId: () => assertPattern(`dnreg-${crypto.randomBytes(16).toString("hex")}`, PATTERNS.registryRecordId, "registryRecordId"),
    routeId: () => assertPattern(`droute-${crypto.randomBytes(16).toString("hex")}`, PATTERNS.routeId, "routeId"),
    pairingTxId: () => assertPattern(`dnpair-${crypto.randomBytes(16).toString("hex")}`, PATTERNS.pairingTxId, "pairingTxId")
};

const check = {
    nodeId: v => assertPattern(v, PATTERNS.nodeId, "nodeId"),
    logicalDamarId: v => assertPattern(v, PATTERNS.logicalDamarId, "logicalDamarId"),
    trustGeneration: v => assertPattern(v, PATTERNS.trustGeneration, "trustGeneration"),
    meshMessageId: v => assertPattern(v, PATTERNS.meshMessageId, "meshMessageId"),
    registryRecordId: v => assertPattern(v, PATTERNS.registryRecordId, "registryRecordId"),
    routeId: v => assertPattern(v, PATTERNS.routeId, "routeId"),
    pairingTxId: v => assertPattern(v, PATTERNS.pairingTxId, "pairingTxId")
};

module.exports = Object.freeze({ PATTERNS, mint, check });
