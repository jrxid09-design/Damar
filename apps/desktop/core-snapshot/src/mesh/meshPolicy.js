"use strict";

/**
 * WAVE 6 MESH — mesh policy bounds + partition classification (L1).
 *
 * Boundedness is a first-class architectural input: every collection in the
 * mesh declares its cap here. Partition behavior classes are explicit.
 */

const PARTITION_CLASSES = Object.freeze([
    "PARTITION_SAFE",          // local conversation, local cognition
    "PARTITION_LOCAL_ONLY",    // local notes/state, sync on reconnect
    "PARTITION_BLOCKED",       // distributed destructive action
    "PARTITION_VERIFY_FIRST"   // uncertain remote outcome
].reduce((m, c) => (m[c] = c, m), {}));

const BOUNDS = Object.freeze({
    nodeRegistry: { maxNodes: 256, maxAddresses: 8, maxSummaryEntries: 64 },
    trustTable: { maxTrustedNodes: 256, maxScopeHistoryPerNode: 8 },
    replayLedger: { maxEntries: 8192, retentionMs: 10 * 60 * 1000 },
    meshQueues: { maxQueues: 8, maxQueueItems: 1024, maxQueueBytes: 4 * 1024 * 1024, queueExpiryMs: 60_000 },
    presence: { maxTracked: 256 },
    envelope: { maxPayloadBytes: 256 * 1024, defaultTtlMs: 30_000, maxCausalEntries: 16 },
    pairing: { maxPendingPairings: 16 },
    auditBridge: { maxBuffer: 512 }
});

/** Default partition class per mesh message type. */
const PARTITION_POLICY = Object.freeze({
    PRESENCE_ANNOUNCE: "PARTITION_SAFE",
    PRESENCE_QUERY: "PARTITION_SAFE",
    DISCOVERY_ADVERTISE: "PARTITION_SAFE",
    STATE_REPLICATE: "PARTITION_LOCAL_ONLY",
    STATE_RECONCILE: "PARTITION_VERIFY_FIRST",
    EXECUTION_REQUEST: "PARTITION_BLOCKED",
    EXECUTION_RESULT: "PARTITION_VERIFY_FIRST",
    EXECUTION_ACK: "PARTITION_VERIFY_FIRST",
    RECOVERY_PROBE: "PARTITION_LOCAL_ONLY",
    RECOVERY_PAYLOAD: "PARTITION_VERIFY_FIRST",
    AUDIT_APPEND: "PARTITION_LOCAL_ONLY",
    GOVERNOR_REPORT: "PARTITION_SAFE",
    ECHO: "PARTITION_SAFE",
    CONTROL_REVOCATION: "PARTITION_LOCAL_ONLY",
    TRUST_UPDATE: "PARTITION_LOCAL_ONLY",
    PAIRING_OFFER: "PARTITION_LOCAL_ONLY",
    PAIRING_CHALLENGE: "PARTITION_LOCAL_ONLY",
    PAIRING_CONFIRM: "PARTITION_BLOCKED",
    ERROR: "PARTITION_SAFE"
});

function partitionClassFor(messageType) {
    return PARTITION_POLICY[messageType] ?? "PARTITION_VERIFY_FIRST";
}

module.exports = Object.freeze({ PARTITION_CLASSES, PARTITION_POLICY, partitionClassFor, BOUNDS });
