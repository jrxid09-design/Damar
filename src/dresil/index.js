"use strict";

/**
 * WAVE 6 L6 — public surface (Lane 6: Replication, Resilience & Autonomous Recovery).
 */

const { createDistributedRecoveryCoordinator, EPISODE_STATES, EPISODE_TRANSITIONS } = require("./recoveryCoordinator");
const { CircuitBreakers, CIRCUIT_STATES } = require("./circuits");
const { ReplicationPolicy, replicaQuorum } = require("./replicationPolicy");

module.exports = Object.freeze({
    createDistributedRecoveryCoordinator, EPISODE_STATES, EPISODE_TRANSITIONS,
    CircuitBreakers, CIRCUIT_STATES,
    ReplicationPolicy, replicaQuorum,
    laws: Object.freeze({
        RECOVERY_NOT_AUTHORITY_RESTORATION: true,
        LEADER_ELECTION_NOT_ROOT_AUTHORITY: true,
        REPLICA_MAJORITY_NOT_USER_AUTHORITY: true,
        FAILOVER_NOT_ACTION_REPLAY: true,
        FAILOVER_NOT_PRIVILEGE_ESCALATION: true,
        CIRCUITS_NOT_TRUST: true
    })
});
