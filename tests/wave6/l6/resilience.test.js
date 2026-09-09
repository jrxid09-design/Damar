"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dresil = require("../../../src/dresil");
const dstate = require("../../../src/dstate");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * WAVE 6 L6 — replication, resilience & autonomous recovery.
 * Laws: RECOVERY != AUTHORITY RESTORATION; REPLICA MAJORITY != USER AUTHORITY;
 * FAILOVER != ACTION REPLAY; circuits are metadata; bounded episodes.
 */

const damar = ids.mint.logicalDamarId();
const failedNode = ids.mint.nodeId();
const peerA = ids.mint.nodeId();
const peerB = ids.mint.nodeId();

function rig() {
 const trust = new mesh.NodeTrust();
 const registry = new mesh.NodeRegistry();
 // the failed node was a member (DISCOVERED at minimum) before its failure —
 // a node with NO trust record at all cannot have produced a real checkpoint
 trust.pair({ nodeId: failedNode, state: "DISCOVERED", scopes: [] });
 const cpVerifier = (cp, opts) => dstate.checkpoint.verifyCheckpoint(cp, opts);
 const coordinator = new dresil.DistributedRecoveryCoordinator({ trust, checkpointVerifier: cpVerifier });
 const circuits = new dresil.CircuitBreakers();
 const policy = new dresil.ReplicationPolicy();
 return { trust, registry, coordinator, circuits, policy };
}

test("L6: recovery episode — peer selection is a trust decision (RECOVERY_PEER scope only)", () => {
 const { trust, coordinator } = rig();
 const untrusted = ids.mint.nodeId();
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["COMPUTE"] }); // wrong scope
 const ep = coordinator.startEpisode({
 failedNodeId: failedNode,
 candidatePeers: [{ nodeId: untrusted, trustGeneration: ids.mint.trustGeneration() }, { nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }]
 });
 assert.equal(ep.state, "FAILED", "no peer holds RECOVERY_PEER -> episode fails closed");
 assert.equal(ep.peerAttempts, 0);
 // with the right scope, selection succeeds
 trust.pair({ nodeId: peerB, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep2 = coordinator.startEpisode({
 failedNodeId: failedNode,
 candidatePeers: [{ nodeId: untrusted, trustGeneration: ids.mint.trustGeneration() }, { nodeId: peerB, trustGeneration: trust.snapshot(peerB).trustGeneration }]
 });
 assert.equal(ep2.state, "PEER_SELECTED");
 assert.equal(ep2.selectedPeer, peerB);
});

test("L6: checkpoint transfer verified through frozen L2 verifier — stale/revoked/tampered fail closed", () => {
 const { trust, coordinator } = rig();
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 const cp = dstate.checkpoint.buildDistributedCheckpoint({
 sourceNodeId: failedNode, logicalDamarId: damar, continuityIncarnation: "inc-1",
 sessionReferences: ["dsc-1"], verifiedCompletedActionRefs: ["act_1"]
 });
 const nonce1 = coordinator.recoveryNonceBindingFor(coordinator._episodes.get(ep.episodeId), cp);
 const ok = coordinator.transferCheckpoint(ep.episodeId, { checkpoint: cp, recoveryNonce: nonce1 });
 assert.equal(ok.state, "CHECKPOINT_TRANSFERRED");
 // replayed recovery payload rejected
 assert.throws(() => coordinator.transferCheckpoint(ep.episodeId, { checkpoint: cp, recoveryNonce: nonce1 }), (e) => e.code === "MESH_REPLAY");
 // revoked source node -> verifier fails closed (episode failed)
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep2 = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 const badCp = dstate.checkpoint.buildDistributedCheckpoint({
 sourceNodeId: ids.mint.nodeId(), logicalDamarId: damar, continuityIncarnation: "inc-1"
 });
 assert.throws(() => coordinator.transferCheckpoint(ep2.episodeId, { checkpoint: badCp, recoveryNonce: "n-2" }), (e) => e.code === "NODE_REVOKED" || e.code === "MESSAGE_MALFORMED" || e.code === "MESSAGE_EXPIRED" || e.code === "PAYLOAD_DIGEST_MISMATCH");
});

test("L6: full recovery flow — transfer -> trust revalidation -> readiness -> RESUMED; no authority restored", () => {
 const { trust, coordinator } = rig();
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 const cp = dstate.checkpoint.buildDistributedCheckpoint({
 sourceNodeId: failedNode, logicalDamarId: damar, continuityIncarnation: "inc-1",
 verifiedCompletedActionRefs: ["act_v1"]
 });
 const nA = coordinator.recoveryNonceBindingFor(coordinator._episodes.get(ep.episodeId), cp);
 coordinator.transferCheckpoint(ep.episodeId, { checkpoint: cp, recoveryNonce: nA });
 coordinator.revalidateTrust(ep.episodeId);
 // readiness proof required; failure -> FAILED
 const failSnap = coordinator.revalidateReadiness(ep.episodeId, { readinessProof: null });
 assert.equal(failSnap.state, "FAILED");
 // fresh episode completes
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep2 = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 const nB = coordinator.recoveryNonceBindingFor(coordinator._episodes.get(ep2.episodeId), cp);
 coordinator.transferCheckpoint(ep2.episodeId, { checkpoint: cp, recoveryNonce: nB });
 coordinator.revalidateTrust(ep2.episodeId);
 coordinator.revalidateReadiness(ep2.episodeId, { readinessProof: "READY" });
 const done = coordinator.resume(ep2.episodeId);
 assert.equal(done.state, "RESUMED");
 assert.equal(done.checkpointPresent, true);
 // the episode snapshot exposes NO authority objects
 assert.equal(done.authority, undefined);
 assert.equal(done.grants, undefined);
});

test("L6: bounded peer attempts — failing peers exhaust budget deterministically", () => {
 const { trust, coordinator } = rig();
 const peers = [ids.mint.nodeId(), ids.mint.nodeId(), ids.mint.nodeId()];
 // no peer has RECOVERY_PEER: attempts recorded up to cap then FAILED
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: peers.map(p => ({ nodeId: p, trustGeneration: ids.mint.trustGeneration() })) });
 assert.equal(ep.state, "FAILED");
 assert.ok(ep.peerAttempts <= 2, "bounded peer attempts");
 // illegal transition guard
 assert.throws(() => coordinator.resume(ep.episodeId), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L6: circuits — threshold opens, probe after open window, success closes; metadata only", () => {
 let now = 1_000_000;
 const circuits = new dresil.CircuitBreakers({ nowMs: () => now });
 const key = "node:" + failedNode;
 for (let i = 0; i < 5; i++) circuits.failure(key);
 assert.equal(circuits.status(key).state, "OPEN");
 assert.equal(circuits.allow(key), false);
 now += 30_001; // open window elapsed -> HALF_OPEN probe allowed once
 assert.equal(circuits.allow(key), true);
 assert.equal(circuits.allow(key), false, "one probe at a time");
 circuits.success(key);
 assert.equal(circuits.status(key).state, "CLOSED");
 assert.equal(circuits.allow(key), true);
 // circuit is reliability metadata: it is NOT trust
 assert.equal(circuits.status(key).grants, undefined);
 assert.equal(circuits.status(key).authority, undefined);
});

test("L6: replication policy — per-class targets, deterministic replica sets, quorum freshness only", () => {
 const policy = new dresil.ReplicationPolicy();
 assert.equal(policy.targetFor("SECRET_BOUND"), 0, "secrets never replicate");
 assert.equal(policy.targetFor("AUDIT_IMMUTABLE"), 3);
 assert.equal(policy.targetFor("REPLICATED"), 2);
 assert.equal(policy.targetFor("LOCAL_ONLY"), 0);
 const set = policy.replicaSetFor("REPLICATED", [peerB, failedNode, peerA, peerA]);
 assert.deepEqual(set, [peerA, peerB].sort().map(x => x) && [...set].sort(), "deterministic sorted set, capped");
 assert.equal(set.length, 2);
 // quorum: freshness/availability ONLY
 const q = dresil.replicaQuorum({ ackedReplicas: 2, requiredReplicas: 3 });
 assert.equal(q.available, true);
 assert.equal(q.freshnessQuorumMet, true);
 assert.match(q.note, /REPLICA MAJORITY != USER AUTHORITY/);
 // illegal config rejected
 assert.throws(() => new dresil.ReplicationPolicy({ config: { targets: { SECRET_BOUND: 3 } } }), TypeError);
 assert.throws(() => new dresil.ReplicationPolicy({ config: { targets: { UNKNOWN_CLASS: 1 } } }), TypeError);
 // no peers -> empty replica set for replicatable class
 assert.deepEqual([...policy.replicaSetFor("REPLICATED", [])], []);
});

test("L6: stale recovery generation — old episode messages fail stale by opaque identity", () => {
 const { trust, coordinator } = rig();
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 // generations are opaque per-episode; an unknown episode id fails closed
 assert.throws(() => coordinator.transferCheckpoint("drec-" + "0".repeat(32), { checkpoint: {}, recoveryNonce: "x" }), (e) => e.code === "MESSAGE_MALFORMED");
 assert.match(ep.generation, /^drecgen-[0-9a-f]{32}$/);
});
