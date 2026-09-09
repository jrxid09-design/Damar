"use strict";

/**
 * WAVE 6 MESH — public surface (L1).
 *
 * This package is INFRASTRUCTURE: it creates membership/trust/transport
 * RECORDS and enforces envelope gates. It NEVER grants Authority, never
 * ratifies actions, never executes tools, and never substitutes for the
 * frozen Manager/Authority plane.
 *
 * LAWS (load-bearing, enforced by the modules):
 *   NODE MEMBERSHIP != AUTHORITY
 *   NODE TRUST != GLOBAL AUTHORITY
 *   NODE DISCOVERY != NODE TRUST
 *   DISCOVERY yields DISCOVERED, never TRUSTED
 *   PAIRING != PERMANENT TRUST
 *   MESH PRESENCE != IDENTITY PROOF
 *   ONLINE != TRUSTED ; OFFLINE != REVOKED
 *   TRANSPORT ID != DAMAR IDENTITY
 *   NODE IDENTITY != DEVICE IDENTITY != SESSION/CHANNEL/MODEL/PROVIDER ID
 *   one-way integrity chain for digests; deterministic canonical encoding
 *   every structure bounded; replay defense bounded; fail-closed on stale
 */

const ids = require("./ids");
const { canonicalize, canonicalJson, canonicalBytes, sha256Hex } = require("./canonical");
const { MESH_ERRORS, MeshError, meshFailure, isMeshFailure } = require("./errors");
const { mintNodeIdentity, adoptNodeIdentity, coerceNodeIdentity } = require("./meshIdentity");
const { NodeRegistry, LIVENESS_STATES } = require("./nodeRegistry");
const { NodeTrust, TRUST_STATES, TRUST_SCOPES, TERMINAL_STATES } = require("./nodeTrust");
const envelope = require("./meshEnvelope");
const { MeshReplayGuard } = require("./meshReplayGuard");
const { MeshRouter, QUEUE_PRIORITY } = require("./meshRouter");
const { MeshPresence } = require("./meshPresence");
const { createLoopbackTransport, validateTransportAdapter, attachTransport } = require("./meshTransport");
const { MeshPairingAdapter } = require("./meshPairing");
const { MeshAuditBridge } = require("./meshAuditBridge");
const { PARTITION_CLASSES, PARTITION_POLICY, partitionClassFor, BOUNDS } = require("./meshPolicy");

module.exports = Object.freeze({
    ids, canonical: { canonicalize, canonicalJson, canonicalBytes, sha256Hex },
    errors: { MESH_ERRORS, MeshError, meshFailure, isMeshFailure },
    meshIdentity: { mintNodeIdentity, adoptNodeIdentity, coerceNodeIdentity },
    NodeRegistry, LIVENESS_STATES,
    NodeTrust, TRUST_STATES, TRUST_SCOPES, TERMINAL_STATES,
    envelope,
    MeshReplayGuard,
    MeshRouter, QUEUE_PRIORITY,
    MeshPresence,
    transport: { createLoopbackTransport, validateTransportAdapter, attachTransport },
    MeshPairingAdapter,
    MeshAuditBridge,
    policy: { PARTITION_CLASSES, PARTITION_POLICY, partitionClassFor, BOUNDS }
});
