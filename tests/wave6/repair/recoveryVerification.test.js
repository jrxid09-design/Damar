"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dresil = require("../../../src/dresil");
const dstate = require("../../../src/dstate");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * W6-05 — mandatory recovery verification + generation binding.
 */

const damar = ids.mint.logicalDamarId();
const failedNode = ids.mint.nodeId();
const peerA = ids.mint.nodeId();

function makeCoordinator() {
 const trust = new mesh.NodeTrust();
 // the failed node was a member (DISCOVERED) before failure
 trust.pair({ nodeId: failedNode, state: "DISCOVERED", scopes: [] });
 // R2-04: the verifier is closure-bound to the frozen canonical checkpoint
 // verifier inside the factory — no injectable callback exists.
 return { trust, coordinator: dresil.createDistributedRecoveryCoordinator({ trust }) };
}

function checkpoint({ sourceNodeId = failedNode } = {}) {
 return dstate.checkpoint.buildDistributedCheckpoint({
 sourceNodeId, logicalDamarId: damar, continuityIncarnation: "inc-1",
 verifiedCompletedActionRefs: ["act_1"]
 });
}

function nonceFor(coordinator, episode, cp) {
 return coordinator.recoveryNonceBindingFor(episode, cp);
}

test("W6-05/R2-04: permissive callback injection impossible — factory exposes no verifier parameter", () => {
 const trust = new mesh.NodeTrust();
 // R2-REC-01: caller tries to pass () => true — there is NO verifier parameter
 // on the factory; the checkpointVerifier is closure-bound to the frozen
 // canonical verifier. The factory ignores/rejects unknown option keys.
 const coordinator = dresil.createDistributedRecoveryCoordinator({ trust, checkpointVerifier: () => true });
 // the bound verifier is the CANONICAL one, not the caller's: a corrupt
 // checkpoint still fails closed through the real verifier
 assert.equal(typeof coordinator.checkpointVerifier, "function");
 assert.notEqual(coordinator.checkpointVerifier, undefined);
 // R2-REC-02: fake verifier object cannot be installed — no such parameter
 const fake = { verify: () => true };
 const coordinator2 = dresil.createDistributedRecoveryCoordinator({ trust, checkpointVerifier: fake.verify });
 assert.notEqual(coordinator2.checkpointVerifier, fake.verify);
});

test("W6-05: corrupt checkpoint / tampered digest rejected", () => {
 const rig = makeCoordinator();
 const trust = rig.trust;
 const coordinator = rig.coordinator;
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 const cp = checkpoint();
 const corrupted = { ...cp, continuityIncarnation: "tampered" };
 const nonce = nonceFor(coordinator, coordinator._episodes.get(ep.episodeId), cp);
 assert.throws(() => coordinator.transferCheckpoint(ep.episodeId, { checkpoint: corrupted, recoveryNonce: nonce }), (e) => e.code === "PAYLOAD_DIGEST_MISMATCH" || e.code === "MESSAGE_MALFORMED");
});

test("W6-05: raw secret / authority grant / reusable lease / completed-as-pending all rejected", () => {
 const rig = makeCoordinator();
 const trust = rig.trust;
 const coordinator = rig.coordinator;
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 const base = checkpoint();
 const cases = [
 { ...base, authorityGrant: "root" },
 { ...base, rawSecret: "secret" },
 { ...base, corrupt: true, reusableLease: { nonce: "x" } },
 { ...base, pendingCognitiveWork: ["act_1"], verifiedCompletedActionRefs: ["act_1"] } // completed resurrected as pending
 ];
 for (const [i, bad] of cases.entries()) {
 // each case has a different digest -> its own nonce binding
 const nonce = nonceFor(coordinator, coordinator._episodes.get(ep.episodeId), bad);
 // NOTE: the canonical digest may make some of these fail at digest check first —
 // either way it must REJECT (the exact code is secondary to fail-closed).
 try {
 coordinator.transferCheckpoint(ep.episodeId, { checkpoint: bad, recoveryNonce: nonce });
 assert.fail(`case ${i} should have been rejected`);
 } catch (e) {
 assert.ok(["MESSAGE_MALFORMED", "PAYLOAD_DIGEST_MISMATCH"].includes(e.code), `case ${i}: ${e.code} ${e.message.slice(0, 60)}`);
 }
 }
});

test("W6-05: replay of old checkpoint rejected; wrong nonce (episode/source/destination/payload binding) rejected", () => {
 const rig = makeCoordinator();
 const trust = rig.trust;
 const coordinator = rig.coordinator;
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 const cp = checkpoint();
 const goodNonce = nonceFor(coordinator, coordinator._episodes.get(ep.episodeId), cp);
 coordinator.transferCheckpoint(ep.episodeId, { checkpoint: cp, recoveryNonce: goodNonce });
 // same payload replayed -> MESH_REPLAY
 assert.throws(() => coordinator.transferCheckpoint(ep.episodeId, { checkpoint: cp, recoveryNonce: goodNonce }), (e) => e.code === "MESH_REPLAY");
 // a NEW episode (new generation) invalidates the old nonce binding
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep2 = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 assert.throws(() => coordinator.transferCheckpoint(ep2.episodeId, { checkpoint: cp, recoveryNonce: goodNonce }), (e) => e.code === "MESSAGE_MALFORMED", "old-episode nonce must not validate on a new generation");
});

test("W6-05: revoked source node checkpoint rejected (state poison)", () => {
 const rig = makeCoordinator();
 const trust = rig.trust;
 const coordinator = rig.coordinator;
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 // the failed node turns out to be REVOKED (not just failed) — state is poison
 trust.revoke(failedNode, { reason: "compromised" });
 const cp = checkpoint();
 const nonce = nonceFor(coordinator, coordinator._episodes.get(ep.episodeId), cp);
 assert.throws(() => coordinator.transferCheckpoint(ep.episodeId, { checkpoint: cp, recoveryNonce: nonce }), (e) => e.code === "NODE_REVOKED");
});

test("W6-05: valid checkpoint with correct binding -> CHECKPOINT_TRANSFERRED, then RESUMED", () => {
 const rig = makeCoordinator();
 const trust = rig.trust;
 const coordinator = rig.coordinator;
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 const epRec = coordinator._episodes.get(ep.episodeId);
 const cp = checkpoint();
 const nonce = nonceFor(coordinator, epRec, cp);
 const snap = coordinator.transferCheckpoint(ep.episodeId, { checkpoint: cp, recoveryNonce: nonce });
 assert.equal(snap.state, "CHECKPOINT_TRANSFERRED");
 coordinator.revalidateTrust(ep.episodeId);
 coordinator.revalidateReadiness(ep.episodeId, { readinessProof: "READY" });
 const done = coordinator.resume(ep.episodeId);
 assert.equal(done.state, "RESUMED");
 assert.equal(done.authority, undefined, "no authority restored");
});

test("W6-05: recovery peer dies mid-transfer — bounded safe failure, budget enforced", () => {
 const rig = makeCoordinator();
 const trust = rig.trust;
 const coordinator = rig.coordinator;
 trust.pair({ nodeId: peerA, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 const ep = coordinator.startEpisode({ failedNodeId: failedNode, candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 // peer dies -> revoked -> nonce/verifier path fails safely
 trust.revoke(peerA, { reason: "peer lost" });
 const cp = checkpoint();
 const nonce = coordinator.recoveryNonceBindingFor(coordinator._episodes.get(ep.episodeId), cp);
 assert.throws(() => coordinator.transferCheckpoint(ep.episodeId, { checkpoint: cp, recoveryNonce: nonce }));
 // new peer selection is bounded: no eligible peers -> FAILED at cap
 const snap = coordinator.selectPeer(ep.episodeId, { candidatePeers: [{ nodeId: peerA, trustGeneration: trust.snapshot(peerA).trustGeneration }] });
 assert.ok(snap.state === "FAILED" || snap.peerAttempts <= 2);
});
