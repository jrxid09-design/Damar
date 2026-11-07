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
const { isCanonicalAuthorityRegistry } = require("../../../src/authority/canonicalOwnership");
const { makeCanonicalAuthorityRoot } = require("./testCanonicalRoot");

/**
 * W6-02 / R2-02 / R3-01 / R4-01 — canonical authority provenance + lease
 * consumption. Authority is resolved via LIVE evaluation through the
 * module-private canonical source. The canonical registry comes from the
 * deep-internal composition root (via test-only harness); `new
 * AuthorityRegistry` is NEVER canonical. No caller-supplied digest/bridge/
 * evaluation object.
 */

const damar = ids.mint.logicalDamarId();
const localId = ids.mint.nodeId();
const remoteId = ids.mint.nodeId();

let canonicalBound = false;

async function canonicalIntent({ capabilityId = "code.test", operation = "test", subject = "damar" } = {}) {
 const intent = parseActionIntent(JSON.stringify({
 schemaVersion: 1, capabilityId, operation, arguments: { scope: "." }, correlationId: "corr-1"
 }), { nowMs: 1_000_000 });
if (!canonicalBound) {
   const store = createMemoryAuthorityStore();
   // R4-01: canonical root from deep-internal composition (test harness).
   const { owner: registry } = await makeCanonicalAuthorityRoot({
   store, clock: { nowIso: () => new Date(1_000_000).toISOString(), nowMs: () => 1_000_000 }
   });
   await registry.proposeEvolution({
   proposalId: "e2e-grant", createdBy: "owner", kind: "authority_expansion",
   problem: "grant", proposedChange: "grant",
   requestedAuthority: { capabilityId, subject, actions: [operation], scope: ["."], maxExecutions: 100 }
   }, "owner");
   await registry.ratify({ ratificationId: "rat-e2e", proposalId: "e2e-grant", ownerIdentity: "owner", decision: "APPROVED" });
   await registry.issueRatifiedRootGrant({ proposalId: "e2e-grant", ratificationId: "rat-e2e", actor: "owner" });
   canonicalBound = true;
   }
 return intent;
}

function rig() {
 const trust = new mesh.NodeTrust();
 const registry = new mesh.NodeRegistry();
 const localIdentity = mesh.meshIdentity.adoptNodeIdentity({ nodeId: localId, logicalDamarId: damar });
 const remoteIdentity = mesh.meshIdentity.adoptNodeIdentity({ nodeId: remoteId, logicalDamarId: damar });
 registry.register({ identity: localIdentity, displayName: "primary" });
 registry.register({ identity: remoteIdentity, displayName: "compute-peer" });
 const router = new dexec.DistributedExecutionRouter({ trust, registry });
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

test("W6-02: canonical path end-to-end — intent -> LIVE authority evaluation -> router -> lease", async () => {
 const intent = await canonicalIntent();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = await router.route({ intent, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 assert.equal(out.targetNodeId, remoteId);
 assert.match(out.lease.leaseId, /^dlease-/);
 // the authority digest derives from the LIVE branded snapshot, not caller input
 assert.equal(out.lease.authorityDecisionDigest.length, 64);
 assert.equal(out.lease.authorityBinding.subject, "damar");
 assert.equal(out.lease.authorityBinding.authorityGeneration, 0);
 assert.deepEqual(out.lease.authorityBinding.authorityActions, ["test"]);
});

test("W6-02: no caller-supplied evaluation or digest path exists", async () => {
 const intent = await canonicalIntent();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 // an extra 'evaluation' param is simply ignored (not in the API)
 const out = await router.route({ intent, evaluation: { forged: true }, toolId: "code_test", preferredNodeId: remoteId });
 assert.equal(out.targetNodeId, remoteId);
 assert.ok(!out.lease.authorityBinding.forged);
});

test("W6-02: canonical authority DENY -> route fails with typed error", async () => {
 const intent = await canonicalIntent({ capabilityId: "other.cap", operation: "other" });
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE"] });
 // 'other.cap' has no grant in the canonical store -> LIVE evaluation denies
 await assert.rejects(
 () => router.route({ intent, toolId: "other_tool", privacyClass: "INTERNAL", preferredNodeId: remoteId }),
 (e) => e.failureClass === "AUTHORITY_DENIED"
 );
});

test("R4-01: `new AuthorityRegistry` is NOT canonical; no public installer/factory exists", () => {
   // Construction does NOT confer canonical provenance.
   const store = createMemoryAuthorityStore();
   const callerRegistry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(1_000_000).toISOString() } });
   // A caller-created instance must NOT pass the brand predicate.
   assert.equal(isCanonicalAuthorityRegistry(callerRegistry), false,
     "caller-created AuthorityRegistry must not be canonical (R4-01)");
   // The PUBLIC dexec surface must NOT expose an installer, factory, or first-bind.
   assert.equal(typeof dexec.installCanonicalAuthorityRegistry, "undefined",
     "public dexec surface must NOT expose installCanonicalAuthorityRegistry (R4-01)");
   assert.equal(dexec.createCanonicalAuthorityRegistry, undefined,
     "public dexec surface must NOT expose a canonical factory");
   // Even if someone reaches into the deep-internal module by absolute path,
   // a caller-created registry is still not canonical (WeakSet identity).
   assert.equal(isCanonicalAuthorityRegistry({ ...callerRegistry }), false);
   assert.equal(isCanonicalAuthorityRegistry(JSON.parse(JSON.stringify(callerRegistry))), false);
   const patched = Object.create(null);
   Object.assign(patched, callerRegistry);
   assert.equal(isCanonicalAuthorityRegistry(patched), false);
});

test("W6-02: wrong capability / wrong tool / wrong target rejected after authorization", async () => {
 const intent = await canonicalIntent();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = await router.route({ intent, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
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
 // tampered artifact
 assert.throws(() => dexec.authorityAdapter.verifyAuthorityArtifact({ ...art, decisionDigest: "f".repeat(64) }, {
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test", targetNodeId: remoteId
 }), (e) => e.code === "PAYLOAD_DIGEST_MISMATCH");
});

test("W6-03: verify+consume once; reuse rejected; NO caller ledger path", async () => {
 const intent = await canonicalIntent();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = await router.route({ intent, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 const c1 = router.consumeLeaseOnTarget(out.executionId, { localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration });
 assert.equal(c1.consumed, true);
 assert.throws(() => router.consumeLeaseOnTarget(out.executionId, { localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration }), (e) => e.code === "MESH_REPLAY");
 // R2-LEASE-01: stateless helper cannot authorize — verifyExecutionLease is gone;
 // the diagnostic inspectExecutionLeaseStructure NEVER returns verified:true
 const diag = dexec.contracts.inspectExecutionLeaseStructure(out.lease, {
 localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration,
 actionIntentCanonical: JSON.stringify({ capabilityId: intent.capabilityId, operation: intent.operation, arguments: intent.arguments ?? {}, correlationId: intent.correlationId ?? "", createdAtMs: intent.createdAtMs ?? null }),
 capabilityId: "code.test", toolId: "code_test"
 });
 assert.equal(diag.structurallyValid, true);
 assert.equal(diag.verified, undefined, "no verified:true from diagnostic helper");
 assert.equal(diag.diagnosticOnly, true);
});

test("W6-03: 100 concurrent same-lease consumes — exactly one wins", async () => {
 const intent = await canonicalIntent();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = await router.route({ intent, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 const attempt = () => new Promise(resolve => {
 setImmediate(() => {
 try { resolve({ ok: true, r: router.consumeLeaseOnTarget(out.executionId, { localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration }) }); }
 catch (e) { resolve({ ok: false, code: e.code }); }
 });
 });
 const results = await Promise.all(Array.from({ length: 100 }, attempt));
 const winners = results.filter(x => x.ok);
 const losers = results.filter(x => !x.ok);
 assert.equal(winners.length, 1, "exactly one concurrent consume wins");
 assert.equal(losers.length, 99);
 assert.ok(losers.every(l => l.code === "MESH_REPLAY"));
});

test("W6-03: expired / stale generation lease -> consume rejects", async () => {
 const intent = await canonicalIntent();
 const { trust, router } = rig();
 trust.pair({ nodeId: remoteId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 const out = await router.route({ intent, toolId: "code_test", privacyClass: "INTERNAL", preferredNodeId: remoteId });
 // stale generation
 assert.throws(() => router.consumeLeaseOnTarget(out.executionId, { localNodeId: remoteId, currentTrustGeneration: ids.mint.trustGeneration() }), (e) => e.code === "TRUST_GENERATION_STALE");
 // expired: consume with far-future clock via ledger
 const canonical = JSON.stringify({ capabilityId: intent.capabilityId, operation: intent.operation, arguments: intent.arguments ?? {}, correlationId: intent.correlationId ?? "", createdAtMs: intent.createdAtMs ?? null });
 const future = Date.now() + 61_000 * 1000;
 assert.throws(() => router.leaseLedger.consume(out.lease, {
 localNodeId: remoteId, currentTrustGeneration: out.lease.trustGeneration,
 actionIntentCanonical: canonical, capabilityId: "code.test", toolId: "code_test", nowMs: future
 }), (e) => e.code === "MESSAGE_EXPIRED");
});

test("W6-03: consumption ledger bounded; saturation fails closed (no live eviction)", () => {
 const ledger = new dexec.LeaseConsumptionLedger({ config: { maxEntries: 4 } });
 const gen = ids.mint.trustGeneration();
 const mkLease = (i, g = gen) => dexec.contracts.mintExecutionLease({
 actionIntentId: `i${i}`, actionIntentCanonical: `{"op":${i}}`, capabilityId: "c",
 toolId: "t", targetNodeId: remoteId, requestingNodeId: localId,
 trustGeneration: g, authorityDecisionDigest: "a".repeat(64),
 ttlMs: 3600_000, nowMs: 1_000_000
 });
 for (let i = 0; i < 4; i++) {
 ledger.consume(mkLease(i), { localNodeId: remoteId, currentTrustGeneration: gen, actionIntentCanonical: `{"op":${i}}`, capabilityId: "c", toolId: "t", nowMs: 1_000_000 });
 }
 assert.throws(() => ledger.consume(mkLease(99), { localNodeId: remoteId, currentTrustGeneration: gen, actionIntentCanonical: '{"op":99}', capabilityId: "c", toolId: "t", nowMs: 1_000_000 }), (e) => e.code === "BOUNDS_EXCEEDED");
 assert.ok(ledger.size() <= 4);
});
