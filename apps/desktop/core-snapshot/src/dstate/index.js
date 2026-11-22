"use strict";

/**
 * WAVE 6 L2 — public surface (Lane 2: Distributed State Continuity & Reconciliation).
 *
 * EXTENDS frozen owners (sessionContinuity, vault, audit, memory); never
 * replaces them. The state plane carries only REPLICATABLE classes; secrets
 * and authority never replicate; conflicts on authority-sensitive state are
 * blocking and resolved only by explicit authority re-validation.
 */

const stateEnvelope = require("./stateEnvelope");
const { reconcile, merge, buildConflict } = require("./reconcile");
const { DistributedStateStore } = require("./stateStore");
const checkpoint = require("./checkpoint");

module.exports = Object.freeze({
    stateEnvelope,
    reconcile, merge, buildConflict,
    DistributedStateStore,
    checkpoint,
    laws: Object.freeze({
        STATE_REPLICATION_NOT_AUTHORITY_REPLICATION: true,
        MEMORY_REPLICATION_NOT_SECRET_REPLICATION: true,
        STATE_CONVERGENCE_NOT_TRUTH: true,
        CLOCK_ORDER_NOT_CAUSAL_TRUTH: true,
        SESSION_MIGRATION_NOT_AUTHORITY_MIGRATION: true
    })
});
