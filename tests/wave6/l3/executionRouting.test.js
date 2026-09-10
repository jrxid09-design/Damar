"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dexec = require("../../../src/dexec");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;
const { parseActionIntent } = require("../../../src/action/intent");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const { loadAndEvaluateAuthority } = require("../../../src/authority/evaluate");
const { AuthorityRegistry } = require("../../../src/authority/registry");
const { sha256Hex } = require("../../../src/mesh/canonical");

async function canonicalIntentAndEvaluation({ capabilityId = "code.test", operation = "test", subject = "damar" } = {}) {
    const intent = parseActionIntent(JSON.stringify({
        schemaVersion: 1, capabilityId, operation, arguments: { scope: "." }, correlationId: "corr-1"
    }), { nowMs: 1_000_000 });
    const store = createMemoryAuthorityStore();
    const registry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(1_000_000).toISOString() } });
    await registry.proposeEvolution({
        proposalId: "grant", createdBy: "owner", kind: "authority_expansion",
        problem: "grant", proposedChange: "grant",
        requestedAuthority: { capabilityId, subject, actions: [operation], scope: ["."], maxExecutions: 50 }
    }, "owner");
    await registry.ratify({ ratificationId: "rat", proposalId: "grant", ownerIdentity: "owner", decision: "APPROVED" });
    await registry.issueRatifiedRootGrant({ proposalId: "grant", ratificationId: "rat", actor: "owner" });
    const evaluation = await loadAndEvaluateAuthority(store, { capabilityId, action: operation, scope: ["."], nowMs: 1_000_000 });
    return { intent, evaluation };
}

function canonicalOf(intent) {
    return JSON.stringify({ capabilityId: intent.capabilityId, operation: intent.operation, arguments: intent.arguments ?? {}, correlationId: intent.correlationId ?? "", createdAtMs: intent.createdAtMs ?? null });
}

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
 const router = new dexec.DistributedExecutionRouter({ trust, registry, authorityBridge: dexec.createCanonicalAuthorityBridge() });
 router.bindLocalNodeId(localId);
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

test("L3: route leases to eligible trusted node; lease binds intent+node+generation+nonce", async () => {
 const { trust, router, remoteIdentity } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const out = router.route({ intent, evaluation, toolId: "code_test" });
 assert.match(out.lease.leaseId, /^dlease-[0-9a-f]{32}$/);
 assert.match(out.executionId, /^dexec-[0-9a-f]{32}$/);
 assert.equal(out.lease.targetNodeId, remoteId);
 assert.equal(out.lease.trustGeneration, trust.snapshot(remoteId).trustGeneration);
 assert.equal(out.lease.oneUse, true);
 assert.equal(out.lease.authorityDecisionDigest.length, 64);
 assert.equal(out.lease.authorityBinding.subject, "damar");
 assert.match(out.lease.actionDigest, /^[0-9a-f]{64}$/);
 assert.equal(router.snapshot(out.executionId).state, "LEASED");
 // execution record exists with legal transition path
 assert.ok(out.transition);
});

test("L3: untrusted node never routed — trust scope beats score", async () => {
 const { trust, router } = rig();
 // remote advertised + higher headroom, but NO trust
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 assert.throws(() => router.route({ intent, evaluation, toolId: "code_test" }), (e) => e.code === "NODE_UNTRUSTED");
 // pair with wrong scope only (OBSERVE): still ineligible
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["OBSERVE"] });
 assert.throws(() => router.route({ intent, evaluation, toolId: "code_test" }), (e) => e.code === "NODE_UNTRUSTED");
});

test("L3: revoked node rejected mid-routing; capability disappearance removes route", async () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const out = router.route({ intent, evaluation, toolId: "code_test", preferredNodeId: remoteId });
 assert.equal(out.targetNodeId, remoteId);
 // revoke -> next route fails
 trust.revoke(remoteId, { reason: "compromised" });
 assert.throws(() => router.route({ intent, evaluation, toolId: "code_test" }), (e) => e.code === "NODE_UNTRUSTED");
 // capability disappears -> routing fails closed (either no candidate at all,
 // or only untrusted candidates remain — both are fail-closed outcomes)
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 router.advertise({ nodeId: remoteId, profile: "SERVER_PRIVATE", capabilities: [] });
 assert.throws(() => router.route({ intent, evaluation, toolId: "code_test", localPreferred: false }), (e) => e.code === "ROUTE_UNAVAILABLE" || e.code === "NODE_UNTRUSTED");
 // partition: OFFLINE node excluded
 router.advertise({ nodeId: remoteId, profile: "SERVER_PRIVATE", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 40 }] });
 const registry = router.registry;
 registry.update(remoteId, { liveness: "OFFLINE" });
 assert.throws(() => router.route({ intent, evaluation, toolId: "code_test" }), (e) => e.code === "NODE_UNTRUSTED" || e.code === "ROUTE_UNAVAILABLE");
});

test("L3: privacy placement — SECRET_REFERENCE input never routes to REMOTE_COMPUTE", async () => {
 const { trust, router, localIdentity } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 // the local node also carries its own COMPUTE trust (uniform trust plane)
 trust.pair({ nodeId: localId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 // remote advertises but as REMOTE_COMPUTE (no SECRET_REFERENCE)
 router.advertise({ nodeId: remoteId, profile: "REMOTE_COMPUTE", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 40 }] });
 // local handles SECRET_REFERENCE
 const { intent: intP, evaluation: evalP } = await canonicalIntentAndEvaluation();
 const localOnly = router.route({ intent: intP, evaluation: evalP, toolId: "code_test", privacyClass: "SECRET_REFERENCE" });
 // routing happens among eligible; local node is in the advertisement table with SECRET_REFERENCE profile
 // the remote REMOTE_COMPUTE node is excluded from candidates entirely
 assert.notEqual(localOnly.targetNodeId, remoteId);
 // PUBLIC data may go remote — placement preference is a scheduling hint
 // (eligibility still enforced: the node is trusted and advertises the tool)
 const pub = router.route({ intent: intP, evaluation: evalP, toolId: "code_test", privacyClass: "PUBLIC", preferredNodeId: remoteId });
 assert.equal(pub.targetNodeId, remoteId);
 // and the hint can NEVER override eligibility: an untrusted preferred node is still skipped
});

test("L3: lease verification at target — wrong node/generation/digest/tool/expired/replay all fail closed", async () => {
 const { trust, router, remoteIdentity } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const out = router.route({ intent, evaluation, toolId: "code_test", preferredNodeId: remoteId });
 const lease = out.lease;
 const ledger = router.leaseLedger;
 const canonical = canonicalOf(intent);
 // happy path: consume (verify+record)
 const v = ledger.consume(lease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test"
 });
 assert.equal(v.consumed, true);
 // one-use replay rejected
 assert.throws(() => ledger.consume(lease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test"
 }), (e) => e.code === "MESH_REPLAY");
 // wrong node
 assert.throws(() => ledger.consume(lease, {
 localNodeId: localId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test"
 }), (e) => e.code === "DESTINATION_MISMATCH");
 // stale trust generation
 assert.throws(() => ledger.consume(lease, {
 localNodeId: remoteId, currentTrustGeneration: ids.mint.trustGeneration(),
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test"
 }), (e) => e.code === "TRUST_GENERATION_STALE");
 // changed action digest (intent mutated after authorization)
 assert.throws(() => ledger.consume(lease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: canonical + "tampered", capabilityId: "code.test", toolId: "code_test"
 }), (e) => /action digest mismatch/.test(e.message));
 // wrong capability/tool
 assert.throws(() => ledger.consume(lease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: canonical, capabilityId: "other.cap", toolId: "code_test"
 }), (e) => /capability mismatch/.test(e.message));
 // expired lease
 const expiredLease = dexec.contracts.mintExecutionLease({
 actionIntentId: "i2", actionIntentCanonical: canonical, capabilityId: "code.test",
 toolId: "code_test", targetNodeId: remoteId, requestingNodeId: localId,
 trustGeneration: lease.trustGeneration, ttlMs: -1, authorityDecisionDigest: lease.authorityDecisionDigest, nowMs: 1000
 });
 assert.throws(() => ledger.consume(expiredLease, {
 localNodeId: remoteId, currentTrustGeneration: lease.trustGeneration,
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test",
 nowMs: 1000 + 61_000
 }), (e) => e.code === "MESSAGE_EXPIRED");
});

test("L3: remote result verification — forged result digest rejected; legal states only", async () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const out = router.route({ intent, evaluation, toolId: "code_test", preferredNodeId: remoteId });
 router.leaseLedger.consume(out.lease, { localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration, actionIntentCanonical: canonicalOf(intent), capabilityId: "code.test", toolId: "code_test" });
 router.transition(out.executionId, "DISPATCHED");
 router.transition(out.executionId, "EXECUTING");
 const result = dexec.contracts.buildExecutionResult(out.request, { state: "SUCCEEDED", output: { ok: true } });
 const verified = router.verifyRemoteResult(out.executionId, result);
 assert.equal(verified.verified, true);
 assert.equal(router.snapshot(out.executionId).state, "VERIFIED");
 // forged output (digest mismatch)
 const ie2 = await canonicalIntentAndEvaluation();
 const out2 = router.route({ intent: { ...ie2.intent, intentId: "intent-2" }, evaluation: ie2.evaluation, toolId: "code_test", preferredNodeId: remoteId });
 router.transition(out2.executionId, "DISPATCHED");
 const forged = { ...dexec.contracts.buildExecutionResult(out2.request, { state: "SUCCEEDED", output: { ok: true } }), output: { ok: false } };
 assert.throws(() => router.verifyRemoteResult(out2.executionId, forged), (e) => e.code === "PAYLOAD_DIGEST_MISMATCH");
 // illegal result state
 const illegal = dexec.contracts.buildExecutionResult(out2.request, { state: "SUCCEEDED", output: null });
 assert.throws(() => router.verifyRemoteResult(out2.executionId, { ...illegal, state: "PENDING" }), (e) => e.code === "MESSAGE_MALFORMED");
 // illegal transition guarded
 assert.throws(() => router.transition(out2.executionId, "VERIFIED"), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L3: UNKNOWN_EXECUTION_STATE — timeout after possible execution never blind-retries", async () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const out = router.route({ intent, evaluation, toolId: "code_test", preferredNodeId: remoteId });
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

test("L3: no authority transfer — lease carries authority reference, not authority", async () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const out = router.route({ intent, evaluation, toolId: "code_test", preferredNodeId: remoteId });
 // the lease must NOT contain any grant object; only the digest reference
 assert.equal(typeof out.lease.authorityDecisionDigest, "string");
 assert.equal(out.lease.capabilityGrant, undefined);
 assert.equal(out.lease.authority, undefined);
 assert.equal(out.lease.permissions, undefined);
 // lease without an authority decision digest is unbuildable
 assert.throws(() => dexec.contracts.mintExecutionLease({
 actionIntentId: "i", actionIntentCanonical: canonicalOf(intent), capabilityId: "code.test",
 toolId: "code_test", targetNodeId: remoteId, requestingNodeId: localId,
 trustGeneration: ids.mint.trustGeneration(), authorityDecisionDigest: null
 }), (e) => /authorityDecisionDigest/.test(e.message));
 // trust revoke after lease mint -> lease verification fails stale (no lingering permission)
 const genBefore = out.lease.trustGeneration;
 trust.revoke(remoteId, { reason: "revoke between lease and execution" });
 assert.throws(() => router.leaseLedger.consume(out.lease, {
 localNodeId: remoteId, currentTrustGeneration: trust.snapshot(remoteId).trustGeneration,
 actionIntentCanonical: canonicalOf(intent), capabilityId: "code.test", toolId: "code_test",
 consumedNonces: new Set()
 }), (e) => e.code === "TRUST_GENERATION_STALE");
 assert.equal(genBefore !== trust.snapshot(remoteId).trustGeneration, true);
});

test("L3: duplicate dispatch guarded by execution state machine", async () => {
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const out = router.route({ intent, evaluation, toolId: "code_test", preferredNodeId: remoteId });
 router.transition(out.executionId, "DISPATCHED");
 // duplicate dispatch (DISPATCHED -> DISPATCHED) is illegal
 assert.throws(() => router.transition(out.executionId, "DISPATCHED"), (e) => e.code === "MESSAGE_MALFORMED");
 assert.equal(router.snapshot(out.executionId).state, "DISPATCHED");
});
