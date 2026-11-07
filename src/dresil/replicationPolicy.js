"use strict";

/**
 * WAVE 6 L6 — replication policy (selective, importance-targeted).
 *
 * REPLICATION != AUTHORITY REPLICATION. Policy assigns bounded replica
 * targets per state class; quorum decides freshness/availability ONLY.
 */

const { REPLICATION_CLASSES } = require("../dstate/stateEnvelope");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");

const DEFAULTS = Object.freeze({
    // per-class replica targets (0 = local only)
    targets: Object.freeze({
        REPLICATED: 2,
        EPHEMERAL: 0,
        OWNER_BOUND: 2,        // revision metadata only (values never replicate)
        SECRET_BOUND: 0,       // NEVER
        LOCAL_ONLY: 0,
        DERIVED: 0,
        CACHE: 1,
        AUDIT_IMMUTABLE: 3     // tamper-evidence via wide distribution
    }),
    maxReplicaSetSize: 3
});

class ReplicationPolicy {
    constructor({ config = {} } = {}) {
        const merged = { ...DEFAULTS.targets, ...(config.targets ?? {}) };
 for (const [cls, n] of Object.entries(merged)) {
 if (!REPLICATION_CLASSES[cls]) throw new TypeError(`unknown replication class '${cls}'`);
 if (!Number.isInteger(n) || n < 0 || n > DEFAULTS.maxReplicaSetSize) {
 throw new TypeError(`replica target for '${cls}' must be 0..${DEFAULTS.maxReplicaSetSize}`);
 }
 if (cls === "SECRET_BOUND" && n > 0) {
 throw new TypeError("SECRET_BOUND replicas are forbidden (MEMORY REPLICATION != SECRET REPLICATION)");
 }
 }
        this.targets = Object.freeze(merged);
    }

    targetFor(replicationClass) {
        if (!REPLICATION_CLASSES[replicationClass]) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown class");
        return this.targets[replicationClass];
    }

    /**
     * Choose replica set from eligible peers (trust already validated by the
     * caller through the L1 trust plane — this function never grants trust).
     * Deterministic: sorted nodeIds, first N.
     */
    replicaSetFor(replicationClass, eligiblePeers = []) {
        const target = this.targetFor(replicationClass);
        const sorted = [...new Set(eligiblePeers)].sort();
        return Object.freeze(sorted.slice(0, Math.min(target, DEFAULTS.maxReplicaSetSize)));
    }
}

/** Quorum: freshness/availability decision ONLY (never user authority). */
function replicaQuorum({ ackedReplicas, requiredReplicas }) {
    if (!Number.isInteger(ackedReplicas) || ackedReplicas < 0) throw new TypeError("ackedReplicas must be >= 0");
    if (!Number.isInteger(requiredReplicas) || requiredReplicas <= 0) throw new TypeError("requiredReplicas must be > 0");
    return Object.freeze({
        freshnessQuorumMet: ackedReplicas >= Math.min(requiredReplicas, Math.max(1, Math.ceil(requiredReplicas / 2) + (requiredReplicas > 1 ? 0 : 0))),
        available: ackedReplicas >= 1,
        note: "REPLICA MAJORITY != USER AUTHORITY — quorum only certifies replica freshness/availability"
    });
}

module.exports = Object.freeze({ ReplicationPolicy, replicaQuorum, DEFAULTS });
