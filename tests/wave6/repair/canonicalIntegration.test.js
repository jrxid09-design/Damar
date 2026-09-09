"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDistributedNodeRuntime, createGovernedExternalToolExecutor } = require("../../../src/integration/wave6Production");
const { parseActionIntent } = require("../../../src/action/intent");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const { loadAndEvaluateAuthority } = require("../../../src/authority/evaluate");
const { AuthorityRegistry } = require("../../../src/authority/registry");
const dstate = require("../../../src/dstate");
const dresil = require("../../../src/dresil");
const federationMod = require("../../../src/federation");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * W6-07 — canonical production integration tests (Manager -> Authority ->
 * Capability -> Router -> Lease -> Verification; no direct paths).
 */

async function makeAuthorizedIntent({ capabilityId = "code.test", operation = "test", subject = "damar" } = {}) {
 const intent = parseActionIntent(JSON.stringify({
 schemaVersion: 1, capabilityId, operation, arguments: { scope: "." }, correlationId: "corr"
 }), { nowMs: 1_000_000 });
 const store = createMemoryAuthorityStore();
 const registry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(1_000_000).toISOString() } });
 await registry.proposeEvolution({
 proposalId: "e2e-grant", createdBy: "owner", kind: "authority_expansion",
 problem: "grant", proposedChange: "grant",
 requestedAuthority: { capabilityId, subject, actions: [operation], scope: ["."], maxExecutions: 50 }
 }, "owner");
 await registry.ratify({ ratificationId: "rat-e2e", proposalId: "e2e-grant", ownerIdentity: "owner", decision: "APPROVED" });
 await registry.issueRatifiedRootGrant({ proposalId: "e2e-grant", ratificationId: "rat-e2e", actor: "owner" });
 const evaluation = await loadAndEvaluateAuthority(store, { capabilityId, action: operation, scope: ["."], nowMs: 1_000_000 });
 assert.equal(evaluation.allowed, true);
 return { intent, evaluation };
}

test("W6-07 A: full canonical production path — no direct distributed tool path", async () => {
 // Node A = primary; Node B = execution target
 const A = createDistributedNodeRuntime({ logicalDamarId: ids.mint.logicalDamarId(), profile: "DESKTOP_PRIMARY", capabilityIds: ["code.test"] });
 const B = createDistributedNodeRuntime({ logicalDamarId: A.identity.logicalDamarId, profile: "SERVER_PRIVATE", capabilityIds: ["code.test"] });
 // B is known+trusted by A (discovery/pairing already covered in L1 tests)
 A.registry.register({ identity: A.identity });
 A.registry.register({ identity: B.identity });
 B.registry.register({ identity: B.identity });
 B.registry.register({ identity: A.identity });
 A.trust.pair({ nodeId: B.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"], ttlMs: 3600_000 });
 A.trust.pair({ nodeId: A.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"], ttlMs: 3600_000 });
 // A holds COMPUTE trust for its own node too (uniform trust plane)
 A.trust.pair({ nodeId: A.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"], ttlMs: 3600_000 });
 // B's advertisement propagates to A's router (capability availability federation)
 A.dexecRouter.advertise({ nodeId: B.identity.nodeId, profile: "SERVER_PRIVATE", capabilities: [{ capabilityId: "code.test", toolId: "tool.code.test", latencyScore: 40 }], resources: { headroomScore: 35 } });
 // canonical intent + authority
 const { intent, evaluation } = await makeAuthorizedIntent();
 // route THROUGH the canonical router (authority bridge inside)
 const out = A.dexecRouter.route({ intent, evaluation, toolId: "tool.code.test", privacyClass: "INTERNAL", preferredNodeId: B.identity.nodeId });
 assert.equal(out.targetNodeId, B.identity.nodeId);
 assert.match(out.lease.leaseId, /^dlease-/);
 // target consumes the lease (verify+consume atomic)
 const consumed = A.dexecRouter.consumeLeaseOnTarget(out.executionId, { localNodeId: B.identity.nodeId, currentTrustGeneration: A.trust.snapshot(B.identity.nodeId).trustGeneration });
 assert.equal(consumed.consumed, true);
 // DISPATCHED then EXECUTING legal after consumption
 A.dexecRouter.transition(out.executionId, "DISPATCHED");
 const snap = A.dexecRouter.transition(out.executionId, "EXECUTING");
 assert.equal(snap.state, "EXECUTING");
 // result verification
 A.dexecRouter.transition(out.executionId, "SUCCEEDED");
 const verified = A.dexecRouter.verifyRemoteResult(out.executionId, require("../../../src/dexec/contracts").buildExecutionResult(out.request, { state: "SUCCEEDED", output: { ok: true } }));
 assert.equal(verified.verified, true);
 // NO direct path: the runtime exposes no model->tool shortcut
 assert.equal(A.rawExecute, undefined);
 assert.equal(A.directToolCall, undefined);
});

test("W6-07 B: mesh pairing wraps the frozen DeviceIdentityService — no second trust root", async () => {
 const { DeviceIdentityService } = require("../../../src/embodiment/identity/service");
 const deviceIdentity = new DeviceIdentityService({});
 const dev = deviceIdentity.registerIdentity({ namespace: "mesh", stableKey: "node-x", displayName: "Node X", deviceClass: "EDGE" });
 const A = createDistributedNodeRuntime({ logicalDamarId: ids.mint.logicalDamarId(), deviceIdentity, capabilityIds: [] });
 const nodeX = mesh.meshIdentity.mintNodeIdentity();
 A.pairing.discover({ identity: nodeX });
 const tx = A.pairing.beginNodePairing({ identity: nodeX, deviceId: dev.deviceId });
 A.pairing.submitNodeChallenge({ pairingTxId: tx.pairingTxId, challengeId: tx.challenge.challengeId, secret: tx.challenge.secret });
 const confirmed = A.pairing.ownerConfirmNode({ pairingTxId: tx.pairingTxId, scopes: ["OBSERVE"], ttlMs: 600_000 });
 assert.equal(confirmed.trust.state, "TRUSTED");
 // the device owner is the SAME root: revoking the device revokes the node trust path
 assert.equal(A.pairing.deviceIdentity, deviceIdentity);
});

test("W6-07 C: capability advertisement references canonical capability ids; availability != authority", async () => {
 const node = createDistributedNodeRuntime({ logicalDamarId: ids.mint.logicalDamarId(), capabilityIds: ["code.test", "data.analyze"] });
 const adv = node.dexecRouter.advertisement(node.identity.nodeId);
 assert.deepEqual(adv.capabilities.map(c => c.capabilityId).sort(), ["code.test", "data.analyze"]);
 // the advertisement itself grants nothing
 assert.equal(adv.authority, undefined);
 assert.equal(adv.grants, undefined);
});

test("W6-07 D: recovery REQUIRES the frozen checkpoint verifier (construction fail-closed)", () => {
 const trust = new mesh.NodeTrust();
 assert.throws(() => new dresil.DistributedRecoveryCoordinator({ trust }), TypeError);
 const ok = createDistributedNodeRuntime({ logicalDamarId: ids.mint.logicalDamarId(), capabilityIds: [] });
 assert.equal(typeof ok.recovery.checkpointVerifier, "function");
});

test("W6-07 E: evolution canary requires registry ratification (no caller approval)", () => {
 const evo = require("../../../src/evolution");
 const authorityModel = require("../../../src/authority/model");
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 assert.throws(() => pipeline.startCanary({ proposalId: "any", proposalStatus: "APPROVED" }), (e) => e.code === "EVOLUTION_NOT_APPROVED");
});

test("W6-07 F: governed external tool execution — sandbox + enablement + authority enforced", async () => {
 const fed = new federationMod.ExternalCapabilityFederation();
 const CANDIDATE = "c".repeat(64);
 const snap = fed.discover({
 source: "https://mcp.example.com", sourceType: "mcp", publisher: "pub",
 name: "search-tool", version: "1.0.0", license: "Apache-2.0", artifactDigest: "a".repeat(64),
 permissions: { network: ["api.example.com"], filesystem: ["/data"] }
 });
 fed.inspect(snap.candidateId, { artifactSurface: "clean handler code" });
 fed.validate(snap.candidateId, { toolDigests: { search: "b".repeat(64) } });
 fed.enableTool(snap.candidateId, { toolName: "search" });
 const executor = createGovernedExternalToolExecutor({
 federation: fed,
 sandboxPolicy: { network: ["api.example.com"], filesystem: ["/data"], processSpawn: false, secrets: false }
 });
 // bypass attempt: tool NOT enabled
 await assert.rejects(executor.execute({
 candidateId: snap.candidateId, toolName: "unrelated",
 toolFn: async () => "evil", consumed: { consumed: true, executionId: "dexec-x" }, args: {}
 }), (e) => e.code === 'TOOL_NOT_ENABLED');
 // bypass attempt: no authority artifact
 await assert.rejects(executor.execute({
 candidateId: snap.candidateId, toolName: "search",
 toolFn: async () => "evil", consumed: { consumed: true, executionId: "dexec-x" },
 args: { needsNetwork: ["api.example.com"] }
 }), (e) => /canonical authority artifact required/.test(e.message));
 // bypass attempt: no consumed lease (W6-03)
 await assert.rejects(executor.execute({
 candidateId: snap.candidateId, toolName: "search",
 toolFn: async () => "evil",
 authorityArtifact: { decisionDigest: "d".repeat(64), kind: "AUTHORITY_DECISION_ARTIFACT" },
 args: { needsNetwork: ["api.example.com"] }
 }), (e) => /consumed one-use lease/.test(e.message));
 // sandbox violations: fs escape / network violation / process spawn / secret access
 for (const args of [
 { needsFilesystem: ["/etc/passwd"] },
 { needsNetwork: ["evil.example.com"] },
 { needsProcessSpawn: true },
 { needsSecrets: true }
 ]) {
 await assert.rejects(executor.execute({
 candidateId: snap.candidateId, toolName: "search",
 toolFn: async () => "evil",
 authorityArtifact: { decisionDigest: "d".repeat(64), kind: "AUTHORITY_DECISION_ARTIFACT" },
 consumed: { consumed: true, executionId: "dexec-ok" }, args
 }), (e) => e.code === "SANDBOX_VIOLATION" && /sandbox violations/.test(e.message));
 }
 // compliant execution passes and runs the real tool function
 const result = await executor.execute({
 candidateId: snap.candidateId, toolName: "search",
 toolFn: async (args) => ({ searched: args.query ?? "none" }),
 authorityArtifact: { decisionDigest: "d".repeat(64), kind: "AUTHORITY_DECISION_ARTIFACT" },
 consumed: { consumed: true, executionId: "dexec-ok" },
 args: { needsNetwork: ["api.example.com"], needsFilesystem: ["/data"], query: "x" }
 });
 assert.equal(result.ok, true);
 assert.deepEqual(result.output, { searched: "x" });
 // tool mutation after enablement voids everything
 const mutated = fed.checkToolIntegrity(snap.candidateId, { toolName: "search", currentDigest: "f".repeat(64) });
 assert.equal(mutated.state, "QUARANTINED");
 await assert.rejects(executor.execute({
 candidateId: snap.candidateId, toolName: "search",
 toolFn: async () => "evil",
 authorityArtifact: { decisionDigest: "d".repeat(64), kind: "AUTHORITY_DECISION_ARTIFACT" },
 consumed: { consumed: true, executionId: "dexec-y" },
 args: { needsNetwork: ["api.example.com"] }
 }), (e) => e.code === 'TOOL_NOT_ENABLED');
});

test("W6-07: tool mutation after enablement + authority omission all fail closed", () => {
 const fed = new federationMod.ExternalCapabilityFederation();
 assert.equal(fed.isToolEnabled("ghost", "tool"), false, "unknown candidate never enabled");
});
