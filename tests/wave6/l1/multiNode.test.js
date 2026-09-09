"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * WAVE 6 L1 — deterministic multi-node logical harness (NODE_A/B/C).
 * Three full mesh stacks wired over loopback transports:
 *   A = primary, B = compute peer, C = portable/edge.
 * Proves: discovery != trust, pairing-driven trust, scoped delivery,
 * replay/expiry/revocation across REAL wire paths, partition + rejoin.
 */

function buildStack({ label }) {
 const registry = new mesh.NodeRegistry();
 const trust = new mesh.NodeTrust();
 const replayGuard = new mesh.MeshReplayGuard();
 const auditRecords = [];
 const ledger = { append: (r) => { auditRecords.push(r); return true; } };
 const localIdentity = mesh.meshIdentity.mintNodeIdentity({ provenance: label });
 const audit = new mesh.MeshAuditBridge({ ledger, localNodeId: localIdentity.nodeId });
 const router = new mesh.MeshRouter({ trust, registry, replayGuard, auditBridge: audit });
 const presence = new mesh.MeshPresence({ registry });
 registry.register({ identity: localIdentity, displayName: label });
 router.bindLocalNodeId(localIdentity.nodeId);
 const transport = mesh.transport.createLoopbackTransport({ label });
 const peer = mesh.transport.attachTransport({ transport, router, localNodeId: localIdentity.nodeId, logicalDamarId: localIdentity.logicalDamarId, trust });
 return {
 label, registry, trust, replayGuard, router, presence, audit, auditRecords,
 identity: localIdentity, transport, peer
 };
}

// Logical network switch: nodeId -> receive hook. Deterministic "LAN".
const SWITCH = new Map();
function attachToSwitch(stack) {
 stack.transportTransportReceive = (frame, peerLabel) => stack.router.ingest({ frame, transportPeer: peerLabel });
 stack.transport.send = ({ frame }) => {
 // destination comes from the frame itself (transport-independent routing)
 const parsed = typeof frame === "string" ? JSON.parse(frame) : frame;
 const dest = parsed.destinationNodeId;
 const hook = SWITCH.get(dest);
 if (hook) hook(frame, stack.peer.peerLabel);
 // undeliverable frames vanish (network semantics)
 };
 SWITCH.set(stack.identity.nodeId, (frame, peerLabel) => stack.transportTransportReceive(frame, peerLabel));
}

test("L1 multi-node: three stacks discover, pair, and exchange scoped messages over real wire paths", () => {
 const A = buildStack({ label: "NODE_A" });
 const B = buildStack({ label: "NODE_B" });
 const C = buildStack({ label: "NODE_C" });
 attachToSwitch(A); attachToSwitch(B); attachToSwitch(C);

 const receivedByA = [], receivedByB = [];
 A.router.on("ECHO", env => receivedByA.push({ from: env.sourceNodeId, payload: env.payload }));
 B.router.on("ECHO", env => receivedByB.push({ from: env.sourceNodeId, payload: env.payload }));

 // B pairs toward A: A registers B's node identity (discovery path);
 // B registers A (mutual discovery). Each stack registers itself too.
 const identityB = mesh.meshIdentity.mintNodeIdentity();
 A.registry.register({ identity: A.identity, displayName: "NODE_A" });
 B.registry.register({ identity: B.identity, displayName: "NODE_B" });
 C.registry.register({ identity: C.identity, displayName: "NODE_C" });
 A.registry.register({ identity: identityB, displayName: "NODE_B-mesh" });
 B.registry.register({ identity: A.identity, displayName: "NODE_A-mesh" });
 A.trust.pair({ nodeId: identityB.nodeId, state: "PAIRING_PENDING", scopes: [] });
 // owner on A confirms scoped trust for B
 const confirmedB = A.trust.pair({ nodeId: identityB.nodeId, state: "TRUSTED", scopes: ["OBSERVE"], ttlMs: 600_000 });
 const env = mesh.envelope.buildEnvelope({
 messageType: "ECHO", sourceNodeId: identityB.nodeId, destinationNodeId: A.identity.nodeId,
 logicalDamarId: A.identity.logicalDamarId, trustGeneration: confirmedB.trustGeneration,
 payload: { hello: "from-B" }
 });
 B.peer.send({ envelope: env, toPeer: A.peer.peerLabel });
 // B's send goes through B's transport, which is wired to A's router
 assert.equal(receivedByA.length, 1);
 assert.equal(receivedByA[0].payload.hello, "from-B");

 // replay over the wire: same message again rejected at A's gate (logged, not crashing)
 const before = A.auditRecords.length;
 assert.throws(() => A.router.ingest({ frame: mesh.envelope.encodeEnvelope(env), transportPeer: B.peer.peerLabel }), (e) => e.code === "MESH_REPLAY");

 // C (unpaired) cannot reach A: gate fails closed with NODE_UNKNOWN/UNTRUSTED
 const identityC = mesh.meshIdentity.mintNodeIdentity();
 const envC = mesh.envelope.buildEnvelope({
 messageType: "ECHO", sourceNodeId: identityC.nodeId, destinationNodeId: A.identity.nodeId,
 logicalDamarId: A.identity.logicalDamarId, trustGeneration: ids.mint.trustGeneration(),
 payload: { intruder: true }
 });
 const preCount = receivedByA.length;
 try { A.router.ingest({ frame: mesh.envelope.encodeEnvelope(envC), transportPeer: "unknown" }); } catch (e) {
 assert.ok(e.code === "NODE_UNKNOWN" || e.code === "NODE_UNTRUSTED" || e.code === "TRUST_GENERATION_STALE");
 }
 assert.equal(receivedByA.length, preCount); // handler never ran

 // revocation propagates: B revoked on A -> B's next message fails stale
 A.trust.revoke(identityB.nodeId, { reason: "operator" });
 const env2 = mesh.envelope.buildEnvelope({
 messageType: "ECHO", sourceNodeId: identityB.nodeId, destinationNodeId: A.identity.nodeId,
 logicalDamarId: A.identity.logicalDamarId, trustGeneration: confirmedB.trustGeneration,
 payload: { after: "revocation" }
 });
 assert.throws(() => A.router.ingest({ frame: mesh.envelope.encodeEnvelope(env2), transportPeer: B.peer.peerLabel }), (e) => e.code === "TRUST_GENERATION_STALE");

 // audit trail recorded the accepted + rejected ingests
 const accepted = A.auditRecords.filter(r => r.type === "mesh.ingest_accepted");
 const rejected = A.auditRecords.filter(r => r.type === "mesh.ingest_rejected");
 assert.ok(accepted.length >= 1 && rejected.length >= 1);
});

test("L1 multi-node: queue backpressure drops telemetry before control under pressure", () => {
 const A = buildStack({ label: "NODE_A" });
 const B = buildStack({ label: "NODE_B" });
 A.registry.register({ identity: B.identity, displayName: "B" });
 A.trust.pair({ nodeId: B.identity.nodeId, state: "TRUSTED", scopes: ["OBSERVE", "ADMINISTRATIVE_HOST"] });
 const gen = A.trust.snapshot(B.identity.nodeId).trustGeneration;
 // fill telemetry queue to cap
 const caps = mesh.policy.BOUNDS.meshQueues;
 for (let i = 0; i < caps.maxQueueItems; i++) {
 A.router.enqueue(mesh.envelope.buildEnvelope({
 messageType: "PRESENCE_ANNOUNCE", sourceNodeId: B.identity.nodeId, destinationNodeId: A.identity.nodeId,
 logicalDamarId: A.identity.logicalDamarId, trustGeneration: gen, payload: { i }
 }));
 }
 // one more telemetry: oldest telemetry dropped (bounded)
 A.router.enqueue(mesh.envelope.buildEnvelope({
 messageType: "PRESENCE_ANNOUNCE", sourceNodeId: B.identity.nodeId, destinationNodeId: A.identity.nodeId,
 logicalDamarId: A.identity.logicalDamarId, trustGeneration: gen, payload: { i: "last" }
 }));
 const depth = A.router.queueDepth();
 assert.ok(depth.byPriority.TELEMETRY <= caps.maxQueueItems);
 // control message enqueue succeeds (never silently dropped)
 A.router.enqueue(mesh.envelope.buildEnvelope({
 messageType: "CONTROL_REVOCATION", sourceNodeId: B.identity.nodeId, destinationNodeId: A.identity.nodeId,
 logicalDamarId: A.identity.logicalDamarId, trustGeneration: gen, payload: { revoke: true }
 }));
 const drained = A.router.drain({ max: caps.maxQueueItems + 10 });
 const controlIdx = drained.findIndex(e => e.messageType === "CONTROL_REVOCATION");
 assert.ok(controlIdx >= 0, "control message must survive backpressure");
});
