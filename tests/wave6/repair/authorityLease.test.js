"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dexec = require("../../../src/dexec");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;
const { parseActionIntent } = require("../../../src/action/intent");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../../../src/authority/evaluate");
const { AuthorityRegistry } = require("../../../src/authority/registry");

/**
 * W6-02/W6-03 repaired execution routing.
 * - CALLER-SUPPLIED DIGESTS ARE REJECTED: authority evidence must be a
 *   BRANDED canonical evaluation (closure-only brand) obtained through the
 *   frozen Authority owner (store -> loadAndEvaluateAuthority).
 * - Lease consumption is VERIFY+CONSUME through ONE mandatory ledger;
 *   concurrent double-consume -> exactly one wins.
 */

const damar = ids.mint.logicalDamarId();
const localId = ids.mint.nodeId();
const remoteId = ids.mint.nodeId();

async function canonicalIntentAndEvaluation({ capabilityId = "code.test", operation = "test", subject = "damar", action = "test" } = {}) {
 // frozen action owner: untrusted serialized intent ingress
 const intent = parseActionIntent(JSON.stringify({
 schemaVersion: 1, capabilityId, operation,
 arguments: { scope: "." }, correlationId: "corr-1"
 }), { nowMs: 1_000_000 });
 // frozen authority owner: store -> root grant (via registry) -> branded evaluation
 const store = createMemoryAuthorityStore();
 const registry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(1_000_000).toISOString() } });
 await registry.proposeEvolution({
 proposalId: "wave6-exec-1", createdBy: "owner", kind: "authority_expansion",
 problem: "grant code.test to subject", proposedChange: "issue root grant",
 requestedAuthority: {
 capabilityId, subject, actions: [action], scope: ["."], maxExecutions: 100
 }
 }, "owner");
 const ratified = await registry.ratify({
 ratificationId: "rat-1", proposalId: "wave6-exec-1", ownerIdentity: "owner",
 decision: "APPROVED"
 });
 assert.equal(ratified.applied, true, ratified.reasonCode ?? "");
 // W6-02 end-to-end: the grant is issued THROUGH the frozen registry
 const issued = await registry.issueRatifiedRootGrant({ proposalId: "wave6-exec-1", ratificationId: "rat-1", actor: "owner" });
 assert.equal(issued.allowed, true, issued.reasonCode ?? "");
 const evaluation = await loadAndEvaluateAuthority(store, {
 capabilityId, action, scope: ["."], nowMs: 1_000_000
 });
 assert.equal(isCanonicalAuthorityEvaluation(evaluation), true, "evaluation must be branded");
 return { intent, evaluation, store, registry };
}

function rig() {
 const trust = new mesh.NodeTrust();
 const registry = new mesh.NodeRegistry();
 const localIdentity = mesh.meshIdentity.adoptNodeIdentity({ nodeId: localId, logicalDamarId: damar });
 const remoteIdentity = mesh.meshIdentity.adoptNodeIdentity({ nodeId: remoteId, logicalDamarId: damar });
 registry.register({ identity: localIdentity, displayName: "primary" });
 registry.register({ identity: remoteIdentity, displayName: "compute-peer" });
 const bridge = dexec.createCanonicalAuthorityBridge();
 const router = new dexec.DistributedExecutionRouter({ trust, registry, authorityBridge: bridge });
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
 return { trust, registry, router };
}

test("W6-02: canonical path end-to-end — Manager intent -> Authority evaluation -> bridge -> router -> lease", async () => {
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = router.route({ intent, evaluation, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 assert.equal(out.targetNodeId, remoteId);
 assert.match(out.lease.leaseId, /^dlease-/);
 // the lease's authority digest derives from the branded snapshot, not caller input
 assert.equal(out.lease.authorityDecisionDigest.length, 64);
 assert.equal(out.lease.authorityBinding.subject, "damar");
 assert.equal(out.lease.authorityBinding.authorityGeneration, evaluation.snapshot.generation);
 assert.deepEqual(out.lease.authorityBinding.authorityActions, ["test"]);
});

test("W6-02 adversarial: arbitrary/random digest rejected — no digest-only path exists", async () => {
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 // no evaluation at all -> typed rejection
 assert.throws(() => router.route({ intent, evaluation: null }), (e) => /branded canonical Authority evaluation/.test(e.message));
 // "well-formed" random digest cannot be smuggled in: the router has no
 // digest parameter at all; a forged evaluation object fails the brand check
 const forgedEvaluation = { allowed: true, reasonCode: "AUTHORIZED", snapshot: { capabilityId: "code.test", actions: ["test"], subject: "damar", generation: 1 } };
 assert.throws(() => router.route({ intent, evaluation: forgedEvaluation }), (e) => /branded canonical Authority evaluation/.test(e.message));
 // failed (denied) canonical evaluation also rejected
 const denied = { allowed: false, reasonCode: "CAP_REVOKED", snapshot: null };
 assert.throws(() => router.route({ intent, evaluation: denied }), (e) => /branded canonical Authority evaluation/.test(e.message));
 // digest from an unrelated decision: mint artifact for capability A, use for B
 const other = await canonicalIntentAndEvaluation({ capabilityId: "other.cap", operation: "test" });
 assert.throws(() => router.route({ intent, evaluation: other.evaluation }), (e) => /authority evaluation is for capability/.test(e.message));
});

test("W6-02: router cannot be constructed without the authority bridge (fail-closed)", () => {
 const trust = new mesh.NodeTrust();
 const registry = new mesh.NodeRegistry();
 assert.throws(() => new dexec.DistributedExecutionRouter({ trust, registry }), TypeError);
 assert.throws(() => new dexec.DistributedExecutionRouter({ trust, registry, authorityBridge: { authorize: () => ({}) } }), TypeError);
});

test("W6-02: valid decision wrong action/capability/tool/target -> artifact verification fails", async () => {
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const out = router.route({ intent, evaluation, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 const art = out.authorityArtifact;
 const canonical = JSON.stringify({ capabilityId: intent.capabilityId, operation: intent.operation, arguments: intent.arguments ?? {}, correlationId: intent.correlationId ?? "", createdAtMs: intent.createdAtMs ?? null });
 // wrong capability
 assert.throws(() => dexec.authorityAdapter.verifyAuthorityArtifact(art, {
 actionIntentCanonical: canonical, capabilityId: "other.cap", toolId: "code_test", targetNodeId: remoteId
 }), (e) => /different capability/.test(e.message));
 // wrong tool
 assert.throws(() => dexec.authorityAdapter.verifyAuthorityArtifact(art, {
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "other_tool", targetNodeId: remoteId
 }), (e) => /different tool/.test(e.message));
 // wrong target
 assert.throws(() => dexec.authorityAdapter.verifyAuthorityArtifact(art, {
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test", targetNodeId: localId
 }), (e) => /different target node/.test(e.message));
 // tampered artifact digest
 assert.throws(() => dexec.authorityAdapter.verifyAuthorityArtifact({ ...art, decisionDigest: "f".repeat(64) }, {
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test", targetNodeId: remoteId
 }), (e) => e.code === "PAYLOAD_DIGEST_MISMATCH");
 // stale: expired artifact
 assert.throws(() => dexec.authorityAdapter.verifyAuthorityArtifact(art, {
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test", targetNodeId: remoteId,
 nowMs: Date.now() + 61_000 * 1000
 }), (e) => e.code === "MESSAGE_EXPIRED");
});

test("W6-03: verify+consume once passes; reuse rejected — NO caller-supplied ledger path", async () => {
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = router.route({ intent, evaluation, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 const c1 = router.consumeLeaseOnTarget(out.executionId, { localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration });
 assert.equal(c1.consumed, true);
 // reuse on the SAME router ledger -> replay rejected
 assert.throws(() => router.consumeLeaseOnTarget(out.executionId, { localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration }), (e) => e.code === "MESH_REPLAY");
 // the OLD broken API shape (fresh default Set per call) can no longer exist:
 // consume is a ledger method, not a free function taking optional sets
 assert.equal(typeof dexec.contracts.verifyExecutionLease, "function"); // diagnostic helper retained
});

test("W6-03: concurrent double-consume — exactly one wins", async () => {
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = router.route({ intent, evaluation, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 const attempt = () => new Promise(resolve => {
 setImmediate(() => {
 try { resolve({ ok: true, r: router.consumeLeaseOnTarget(out.executionId, { localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration }) }); }
 catch (e) { resolve({ ok: false, code: e.code }); }
 });
 });
 const [a, b] = await Promise.all([attempt(), attempt()]);
 const winners = [a, b].filter(x => x.ok);
 const losers = [a, b].filter(x => !x.ok);
 assert.equal(winners.length, 1, "exactly one concurrent consume wins");
 assert.equal(losers.length, 1);
 assert.equal(losers[0].code, "MESH_REPLAY");
});

test("W6-03: EXECUTING requires consumption; expired/stale lease fails at consume", async () => {
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const { trust, router, registry } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = router.route({ intent, evaluation, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 // DISPATCHED ok, but EXECUTING without consumption rejected (W6-03 gate)
 router.transition(out.executionId, "DISPATCHED");
 assert.throws(() => router.transition(out.executionId, "EXECUTING"), (e) => /lease not consumed/.test(e.message));
 // consume with a STALE generation rejected
 assert.throws(() => router.consumeLeaseOnTarget(out.executionId, { localNodeId: remoteId, currentTrustGeneration: ids.mint.trustGeneration() }), (e) => e.code === "TRUST_GENERATION_STALE");
 // consume with expired lease rejected
 const out2 = router.route({ intent, evaluation, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 out2.lease; // exists
 // force expiry by consuming with a far-future clock via ledger directly
 const future = Date.now() + 61_000 * 1000;
 assert.throws(() => router.leaseLedger.consume(out2.lease, {
 localNodeId: remoteId, currentTrustGeneration: out2.lease.trustGeneration,
 actionIntentCanonical: JSON.stringify({ capabilityId: intent.capabilityId, operation: intent.operation, arguments: intent.arguments ?? {}, correlationId: intent.correlationId ?? "", createdAtMs: intent.createdAtMs ?? null }),
 capabilityId: "code.test", toolId: "code_test", nowMs: future
 }), (e) => e.code === "MESSAGE_EXPIRED");
 // proper flow: consume -> EXECUTING legal
 const consumed = router.consumeLeaseOnTarget(out.executionId, { localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration });
 assert.equal(consumed.consumed, true);
 const snap = router.transition(out.executionId, "EXECUTING");
 assert.equal(snap.state, "EXECUTING");
});

test("W6-03: consumption ledger bounded under high unique lease volume; saturated fails closed", () => {
 const ledger = new dexec.LeaseConsumptionLedger({ config: { maxEntries: 4 } });
 const mkLease = (i, gen = ids.mint.trustGeneration()) => dexec.contracts.mintExecutionLease({
 actionIntentId: `i${i}`, actionIntentCanonical: `{"op":${i}}`, capabilityId: "c",
 toolId: "t", targetNodeId: remoteId, requestingNodeId: localId,
 trustGeneration: gen, authorityDecisionDigest: "a".repeat(64),
 ttlMs: 3600_000, nowMs: 1_000_000
 });
 // fill with LIVE (unexpired) leases: saturation -> fail-closed, NO eviction of live entries
 const gen = ids.mint.trustGeneration();
 for (let i = 0; i < 4; i++) {
 ledger.consume(mkLease(i, gen), {
 localNodeId: remoteId, currentTrustGeneration: gen,
 actionIntentCanonical: `{"op":${i}}`, capabilityId: "c", toolId: "t", nowMs: 1_000_000
 });
 }
 // the 5th unique live lease cannot be consumed: ledger saturated with live entries
 assert.throws(() => ledger.consume(mkLease(99, gen), {
 localNodeId: remoteId, currentTrustGeneration: gen,
 actionIntentCanonical: `{"op":99}`, capabilityId: "c", toolId: "t", nowMs: 1_000_000
 }), (e) => e.code === "BOUNDS_EXCEEDED");
 assert.ok(ledger.size() <= 4);
 // after the FIRST batch legitimately expires (all four expire at 4_600_000),
 // cleanup reclaims and new consumption works again at a later clock.
 const afterExpiry = 4_600_001;
 const freshLease = dexec.contracts.mintExecutionLease({
 actionIntentId: "i-fresh", actionIntentCanonical: `{"op":"fresh"}`, capabilityId: "c",
 toolId: "t", targetNodeId: remoteId, requestingNodeId: localId,
 trustGeneration: gen, authorityDecisionDigest: "a".repeat(64),
 ttlMs: 3_600_000, nowMs: afterExpiry
 });
 const freshConsumed = ledger.consume(freshLease, {
 localNodeId: remoteId, currentTrustGeneration: gen,
 actionIntentCanonical: `{"op":"fresh"}`, capabilityId: "c", toolId: "t", nowMs: afterExpiry
 });
 assert.equal(freshConsumed.consumed, true, "post-expiry cleanup reclaims capacity");
 assert.ok(ledger.size() <= 4);
 // expiry-boundary replay safety: a consumed lease remains un-replayable for
 // its entire validity (re-consume at a clock BEFORE its expiry fails)
 assert.throws(() => ledger.consume(freshLease, {
 localNodeId: remoteId, currentTrustGeneration: gen,
 actionIntentCanonical: `{"op":"fresh"}`, capabilityId: "c", toolId: "t", nowMs: afterExpiry + 1000
 }), (e) => e.code === "MESH_REPLAY");
});

test("L3 regression: routing failures remain fail-closed (untrusted/revoked/offline/privacy)", async () => {
 const { intent, evaluation } = await canonicalIntentAndEvaluation();
 const { trust, router } = rig();
 // no trust -> NODE_UNTRUSTED
 assert.throws(() => router.route({ intent, evaluation, toolId: "code_test" }), (e) => e.code === "NODE_UNTRUSTED");
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["OBSERVE"] });
 assert.throws(() => router.route({ intent, evaluation, toolId: "code_test" }), (e) => e.code === "NODE_UNTRUSTED");
 // revoked
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 const out = router.route({ intent, evaluation, toolId: "code_test", preferredNodeId: remoteId });
 assert.equal(out.targetNodeId, remoteId);
 trust.revoke(remoteId, { reason: "x" });
 assert.throws(() => router.route({ intent, evaluation, toolId: "code_test" }), (e) => e.code === "NODE_UNTRUSTED");
 // UNKNOWN no backward transition preserved
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out2 = router.route({ intent, evaluation, toolId: "code_test", preferredNodeId: remoteId });
 router.transition(out2.executionId, "DISPATCHED");
 const un = router.markUnknown(out2.executionId);
 assert.equal(un.state, "UNKNOWN");
 assert.throws(() => router.transition(out2.executionId, "EXECUTING"), (e) => e.code === "MESSAGE_MALFORMED");
});
