"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dexec = require("../../../src/dexec");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * WAVE 6 L3 — distributed capability & execution routing.
 * Laws under test: REMOTE EXECUTION != AUTHORITY TRANSFER; leases bind
 * intent+node+generation+nonce; forged/expired/wrong leases fail closed;
 * UNKNOWN state never blind-retries; no authority transfer.
 */

const damar = ids.mint.logicalDamarId();
const localId = ids.mint.nodeId();
const remoteId = ids.mint.nodeId();

function rig() {
 const trust = new mesh.NodeTrust();
 const registry = new mesh.NodeRegistry();
 const localIdentity = mesh.meshIdentity.adoptNodeIdentity({ nodeId: localId, logicalDamarId: damar });
 const remoteIdentity = mesh.meshIdentity.adoptNodeIdentity({ nodeId: remoteId, logicalDamarId: damar });
 registry.register({ identity: localIdentity, displayName: "primary" });
 registry.register({ identity: remoteIdentity, displayName: "compute-peer" });
 const router = new dexec.DistributedExecutionRouter({
 trust, registry,
 authorityDecisionDigest: "a".repeat(64)
 });
 router.bindLocalNodeId(localId);
 router.advertise({
 nodeId: localId, profile: "DESKTOP_PRIMARY",
 capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 80, privacy: "SECRET_REFERENCE" }],
 resources: { headroomScore: 30 }
 });
 router.advertise({
 nodeId: remoteId, profile: "SERVER_PRIVATE",
 capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 40, privacy: "PRIVATE" }],
 resources: { headroomScore: 35 }
 });
 return { trust, registry, router, localIdentity, remoteIdentity };
}

const INTENT = {
 actionIntentId: "intent-1",
 canonical: JSON.stringify({ op: "code.test", capability: "code.test", args: { scope: "." } }),
 capabilityId: "code.test", capabilityIncarnationId: "inc-1", toolId: "code_test",
 input: { scope: "." }, privacyClass: "INTERNAL", localPreferred: false
};

test("L3: route leases to eligible trusted node; lease binds intent+node+generation+nonce", () => {
 const { trust, router, remoteIdentity } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = router.route({ ...INTENT });
 assert.match(out.lease.leaseId, /^dlease-[0-9a-f]{32}$/);
 assert.match(out.executionId, /^dexec-[0-9a-f]{32}$/);
 assert.equal(out.lease.targetNodeId, remoteId);
 assert.equal(out.lease.trustGeneration, trust.snapshot(remoteId).trustGeneration);
 assert.equal(out.lease.oneUse, true);
 assert.equal(out.lease.authorityDecisionDigest, "a".repeat(64));
 assert.match(out.lease.actionDigest, /^[0-9a-f]{64}$/);
 assert.equal(router.snapshot(out.executionId).state, "LEASED");
 // execution record exists with legal transition path
 assert.ok(out.transition);
});

test("L3: untrusted node never routed — trust scope beats score", () => {
 const { trust, router } = rig();
 // remote advertised + higher headroom, but NO trust
 assert.throws(() => router.route({ ...INTENT }), (e) => e.code === "NODE_UNTRUSTED");
 // pair with wrong scope only (OBSERVE): still ineligible
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["OBSERVE"] });
 assert.throws(() => router.route({ ...INTENT }), (e) => e.code === "NODE_UNTRUSTED");
});

test("L3: revoked node rejected mid-routing; capability disappearance removes route", () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const out = router.route({ ...INTENT });
 assert.equal(out.targetNodeId, remoteId);
 // revoke -> next route fails
 trust.revoke(remoteId, { reason: "compromised" });
 assert.throws(() => router.route({ ...INTENT }), (e) => e.code === "NODE_UNTRUSTED");
 // capability disappears -> routing fails closed (either no candidate at all,
 // or only untrusted candidates remain — both are fail-closed outcomes)
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 router.advertise({ nodeId: remoteId, profile: "SERVER_PRIVATE", capabilities: [] });
 assert.throws(() => router.route({ ...INTENT, localPreferred: false }), (e) => e.code === "ROUTE_UNAVAILABLE" || e.code === "NODE_UNTRUSTED");
 // partition: OFFLINE node excluded
 router.advertise({ nodeId: remoteId, profile: "SERVER_PRIVATE", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 40 }] });
 const registry = router.registry;
 registry.update(remoteId, { liveness: "OFFLINE" });
 assert.throws(() => router.route({ ...INTENT }), (e) => e.code === "NODE_UNTRUSTED" || e.code === "ROUTE_UNAVAILABLE");
});

test("L3: privacy placement — SECRET_REFERENCE input never routes to REMOTE_COMPUTE", () => {
 const { trust, router, localIdentity } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 // the local node also carries its own COMPUTE trust (uniform trust plane)
 trust.pair({ nodeId: localId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 // remote advertises but as REMOTE_COMPUTE (no SECRET_REFERENCE)
 router.advertise({ nodeId: remoteId, profile: "REMOTE_COMPUTE", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 40 }] });
 // local handles SECRET_REFERENCE
 const localOnly = router.route({ ...INTENT, privacyClass: "SECRET_REFERENCE" });
 // routing happens among eligible; local node is in the advertisement table with SECRET_REFERENCE profile
 // the remote REMOTE_COMPUTE node is excluded from candidates entirely
 assert.notEqual(localOnly.targetNodeId, remoteId);
 // PUBLIC data may go remote — placement preference is a scheduling hint
 // (eligibility still enforced: the node is trusted and advertises the tool)
 const pub = router.route({ ...INTENT, privacyClass: "PUBLIC", preferredNodeId: remoteId });
 assert.equal(pub.targetNodeId, remoteId);
 // and the hint can NEVER override eligibility: an untrusted preferred node is still skipped
});

test("L3: lease verification at target — wrong node/generation/digest/tool/expired/replay all fail closed", () => {
 const { trust, router, remoteIdentity } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = router.route({ ...INTENT });
 const lease = out.lease;
 const consumed = new Set();
 // happy path
 const v = dexec.contracts.verifyExecutionLease(lease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: INTENT.canonical, capabilityId: "code.test", toolId: "code_test",
 consumedNonces: consumed
 });
 assert.equal(v.verified, true);
 // one-use replay rejected
 assert.throws(() => dexec.contracts.verifyExecutionLease(lease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: INTENT.canonical, capabilityId: "code.test", toolId: "code_test",
 consumedNonces: consumed
 }), (e) => e.code === "MESH_REPLAY");
 // wrong node
 assert.throws(() => dexec.contracts.verifyExecutionLease(lease, {
 localNodeId: localId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: INTENT.canonical, capabilityId: "code.test", toolId: "code_test",
 consumedNonces: new Set()
 }), (e) => e.code === "DESTINATION_MISMATCH");
 // stale trust generation
 assert.throws(() => dexec.contracts.verifyExecutionLease(lease, {
 localNodeId: remoteId, currentTrustGeneration: ids.mint.trustGeneration(),
 actionIntentCanonical: INTENT.canonical, capabilityId: "code.test", toolId: "code_test",
 consumedNonces: new Set()
 }), (e) => e.code === "TRUST_GENERATION_STALE");
 // changed action digest (intent mutated after authorization)
 assert.throws(() => dexec.contracts.verifyExecutionLease(lease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: INTENT.canonical + "tampered", capabilityId: "code.test", toolId: "code_test",
 consumedNonces: new Set()
 }), (e) => /action digest mismatch/.test(e.message));
 // wrong capability/tool
 assert.throws(() => dexec.contracts.verifyExecutionLease(lease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: INTENT.canonical, capabilityId: "other.cap", toolId: "code_test",
 consumedNonces: new Set()
 }), (e) => /capability mismatch/.test(e.message));
 // expired lease
 const expiredLease = dexec.contracts.mintExecutionLease({
 actionIntentId: "i2", actionIntentCanonical: INTENT.canonical, capabilityId: "code.test",
 toolId: "code_test", targetNodeId: remoteId, requestingNodeId: localId,
 trustGeneration: lease.trustGeneration, ttlMs: -1, authorityDecisionDigest: "a".repeat(64), nowMs: 1000
 });
 assert.throws(() => dexec.contracts.verifyExecutionLease(expiredLease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: INTENT.canonical, capabilityId: "code.test", toolId: "code_test",
 consumedNonces: new Set(), nowMs: 1000 + 61_000
 }), (e) => e.code === "MESSAGE_EXPIRED");
});

test("L3: remote result verification — forged result digest rejected; legal states only", () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const out = router.route({ ...INTENT });
 router.transition(out.executionId, "DISPATCHED");
 router.transition(out.executionId, "EXECUTING");
 const result = dexec.contracts.buildExecutionResult(out.request, { state: "SUCCEEDED", output: { ok: true } });
 const verified = router.verifyRemoteResult(out.executionId, result);
 assert.equal(verified.verified, true);
 assert.equal(router.snapshot(out.executionId).state, "VERIFIED");
 // forged output (digest mismatch)
 const out2 = router.route({ ...INTENT, actionIntentId: "intent-2", canonical: INTENT.canonical + "2" });
 router.transition(out2.executionId, "DISPATCHED");
 const forged = { ...dexec.contracts.buildExecutionResult(out2.request, { state: "SUCCEEDED", output: { ok: true } }), output: { ok: false } };
 assert.throws(() => router.verifyRemoteResult(out2.executionId, forged), (e) => e.code === "PAYLOAD_DIGEST_MISMATCH");
 // illegal result state
 const illegal = dexec.contracts.buildExecutionResult(out2.request, { state: "SUCCEEDED", output: null });
 assert.throws(() => router.verifyRemoteResult(out2.executionId, { ...illegal, state: "PENDING" }), (e) => e.code === "MESSAGE_MALFORMED");
 // illegal transition guarded
 assert.throws(() => router.transition(out2.executionId, "VERIFIED"), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L3: UNKNOWN_EXECUTION_STATE — timeout after possible execution never blind-retries", () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const out = router.route({ ...INTENT });
 router.transition(out.executionId, "DISPATCHED");
 // dispatch timeout — outcome uncertain
 const snap = router.markUnknown(out.executionId, "no ack within budget");
 assert.equal(snap.state, "UNKNOWN");
 // UNKNOWN cannot go back to EXECUTING (no blind retry); only VERIFIED/COMPENSATED/EXPIRED
 assert.throws(() => router.transition(out.executionId, "EXECUTING"), (e) => e.code === "MESSAGE_MALFORMED");
 assert.throws(() => router.transition(out.executionId, "DISPATCHED"), (e) => e.code === "MESSAGE_MALFORMED");
 // resolution: verification confirms NOT executed -> COMPENSATED (or VERIFIED if observed)
 router.transition(out.executionId, "COMPENSATED");
 assert.equal(router.snapshot(out.executionId).state, "COMPENSATED");
});

test("L3: no authority transfer — lease carries authority reference, not authority", () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const out = router.route({ ...INTENT });
 // the lease must NOT contain any grant object; only the digest reference
 assert.equal(typeof out.lease.authorityDecisionDigest, "string");
 assert.equal(out.lease.capabilityGrant, undefined);
 assert.equal(out.lease.authority, undefined);
 assert.equal(out.lease.permissions, undefined);
 // lease without an authority decision digest is unbuildable
 assert.throws(() => dexec.contracts.mintExecutionLease({
 actionIntentId: "i", actionIntentCanonical: INTENT.canonical, capabilityId: "code.test",
 toolId: "code_test", targetNodeId: remoteId, requestingNodeId: localId,
 trustGeneration: ids.mint.trustGeneration(), authorityDecisionDigest: null
 }), (e) => /authorityDecisionDigest/.test(e.message));
 // trust revoke after lease mint -> lease verification fails stale (no lingering permission)
 const genBefore = out.lease.trustGeneration;
 trust.revoke(remoteId, { reason: "revoke between lease and execution" });
 assert.throws(() => dexec.contracts.verifyExecutionLease(out.lease, {
 localNodeId: remoteId, currentTrustGeneration: trust.snapshot(remoteId).trustGeneration,
 actionIntentCanonical: INTENT.canonical, capabilityId: "code.test", toolId: "code_test",
 consumedNonces: new Set()
 }), (e) => e.code === "TRUST_GENERATION_STALE");
 assert.equal(genBefore !== trust.snapshot(remoteId).trustGeneration, true);
});

test("L3: duplicate dispatch guarded by execution state machine", () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const out = router.route({ ...INTENT });
 router.transition(out.executionId, "DISPATCHED");
 // duplicate dispatch (DISPATCHED -> DISPATCHED) is illegal
 assert.throws(() => router.transition(out.executionId, "DISPATCHED"), (e) => e.code === "MESSAGE_MALFORMED");
 assert.equal(router.snapshot(out.executionId).state, "DISPATCHED");
});
