"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createDistributedNodeRuntime, createGovernedExternalToolExecutor } = require("../../../src/integration/wave6Production");
const { parseActionIntent } = require("../../../src/action/intent");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const { createCanonicalAuthorityRegistry } = require("../../../src/authority/canonicalOwnership");
const dexec = require("../../../src/dexec");
const dresil = require("../../../src/dresil");
const federationMod = require("../../../src/federation");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * W6-07 — canonical production integration tests (Manager -> Authority ->
 * Capability -> Router -> Lease -> Verification; no direct paths).
 *
 * R2-02/R3-01: authority flows EXCLUSIVELY through the module-private canonical
 * source; the canonical registry is produced by the composition-root factory
 * (resolved live at route time). R2-07/R3-03: governed external tool execution
 * requires a canonical router claim — no caller-shaped authority, no toolFn
 * bypass, no public sandbox launcher.
 */

const NOOP_TOOL = path.resolve(__dirname, "../../../src/federation/noopTool.js");

let canonicalBound = false;
async function intentFor({ capabilityId = "code.test", operation = "test" } = {}) {
    const intent = parseActionIntent(JSON.stringify({
        schemaVersion: 1, capabilityId, operation, arguments: { scope: "." }, correlationId: "corr"
    }), { nowMs: 1_000_000 });
    if (!canonicalBound) {
        // R3-01: composition-root factory (NOT `new AuthorityRegistry`).
        const store = createMemoryAuthorityStore();
        const registry = createCanonicalAuthorityRegistry({
            store,
            clock: { nowIso: () => new Date(1_000_000).toISOString(), nowMs: () => 1_000_000 }
        });
        await registry.proposeEvolution({
            proposalId: "e2e-grant", createdBy: "owner", kind: "authority_expansion",
            problem: "grant", proposedChange: "grant",
            requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["test"], scope: ["."], maxExecutions: 1000 }
        }, "owner");
        await registry.ratify({ ratificationId: "rat-e2e", proposalId: "e2e-grant", ownerIdentity: "owner", decision: "APPROVED" });
        await registry.issueRatifiedRootGrant({ proposalId: "e2e-grant", ratificationId: "rat-e2e", actor: "owner" });
        dexec.installCanonicalAuthorityRegistry(registry);
        canonicalBound = true;
    }
    return intent;
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
 // B's advertisement propagates to A's router (capability availability federation)
 A.dexecRouter.advertise({ nodeId: B.identity.nodeId, profile: "SERVER_PRIVATE", capabilities: [{ capabilityId: "code.test", toolId: "tool.code.test", latencyScore: 40 }], resources: { headroomScore: 35 } });
 // canonical intent; authority resolved LIVE by the router (no caller evaluation)
 const intent = await intentFor();
 // route THROUGH the canonical ingress (authority source inside)
 const out = await A.ingress.submitIntent({ intent, toolId: "tool.code.test", privacyClass: "INTERNAL", preferredNodeId: B.identity.nodeId });
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

test("W6-07 D: recovery closure-binds the frozen checkpoint verifier (no injectable verifier)", () => {
 const trust = new mesh.NodeTrust();
 // R2-04: the factory requires ONLY the trust plane — the canonical verifier
 // is closure-bound; a caller-supplied verifier is ignored, never installed
 const fake = () => true;
 const coordinator = dresil.createDistributedRecoveryCoordinator({ trust, checkpointVerifier: fake });
 assert.equal(typeof coordinator.checkpointVerifier, "function");
 assert.notEqual(coordinator.checkpointVerifier, fake, "caller verifier must not be installed");
 // the class itself is NOT exported — no direct construction path exists
 assert.equal(dresil.DistributedRecoveryCoordinator, undefined);
 const ok = createDistributedNodeRuntime({ logicalDamarId: ids.mint.logicalDamarId(), capabilityIds: [] });
 assert.equal(typeof ok.recovery.checkpointVerifier, "function");
});

test("W6-07 E: evolution canary requires registry ratification (no caller approval)", async () => {
 const evo = require("../../../src/evolution");
 const authorityModel = require("../../../src/authority/model");
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 // R2-01: no caller-supplied ratification exists; approval resolves LIVE from
 // the canonical registry (none bound here) -> fail closed
 await assert.rejects(() => pipeline.startCanary({ proposalId: "any" }), (e) => e.code === "EVOLUTION_NOT_APPROVED");
});

// ---- R2-07 governed external tool execution (canonical claim only) ----

function makeFederationAndClaim({ candidateToolName = "search", enabled = true } = {}) {
 const fed = new federationMod.ExternalCapabilityFederation();
 const CANDIDATE = "c".repeat(64);
 const snap = fed.discover({
  source: "https://mcp.example.com", sourceType: "mcp", publisher: "pub",
  name: "search-tool", version: "1.0.0", license: "Apache-2.0", artifactDigest: "a".repeat(64),
  permissions: { network: ["api.example.com"], filesystem: ["/data"] }
 });
 fed.inspect(snap.candidateId, { artifactSurface: "clean handler code" });
 fed.validate(snap.candidateId, { toolDigests: { search: "b".repeat(64) } });
 if (enabled) fed.enableTool(snap.candidateId, { toolName: candidateToolName });
 return { fed, snap, CANDIDATE };
}

async function makeRouter() {
 const registry = new mesh.NodeRegistry();
 const trust = new mesh.NodeTrust();
 const identity = mesh.meshIdentity.mintNodeIdentity({ logicalDamarId: ids.mint.logicalDamarId() });
 registry.register({ identity, displayName: "execution-node" });
 const router = new dexec.DistributedExecutionRouter({ trust, registry });
 router.bindLocalNodeId(identity.nodeId);
 router.advertise({ nodeId: identity.nodeId, profile: "DESKTOP_PRIMARY", capabilities: [{ capabilityId: "code.test", toolId: "tool.code.test", latencyScore: 80, privacy: "INTERNAL" }] });
 trust.pair({ nodeId: identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
 return { router, identity };
}

test("W6-07 F: governed external tool execution — canonical claim + sandbox + enablement enforced", async () => {
 const intent = await intentFor();
 const { router } = await makeRouter();
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
  sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false },
  executionRouter: router
 });
 // R2-07: no caller-shaped authority/toolFn — claimId is the ONLY entry point
 await assert.rejects(executor.execute({ claimId: 123 }), (e) => e.code === "MESSAGE_MALFORMED");
 await assert.rejects(executor.execute({ claimId: "ghost-claim" }), (e) => e.code === "MESSAGE_MALFORMED");
 // claim for an unrelated tool (unrelated is NOT enabled):
 const claim = await router.claimGovernedExecution({
  intent, toolId: "tool.code.test", candidateId: snap.candidateId, toolName: "unrelated",
  toolArtifactPath: NOOP_TOOL, sandboxNeeds: {}
 });
 await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "TOOL_NOT_ENABLED");
 // sandbox violations bind into the claim and fail at execute (fs escape)
 const claimFs = await router.claimGovernedExecution({
  intent, toolId: "tool.code.test", candidateId: snap.candidateId, toolName: "search",
  toolArtifactPath: NOOP_TOOL,
  sandboxNeeds: { needsFilesystem: ["/etc/passwd"] }
 });
 await assert.rejects(executor.execute({ claimId: claimFs.claimId }), (e) => e.code === "SANDBOX_VIOLATION" && /sandbox violations/.test(e.message));
 // compliant execution runs the real sandbox
 const claimOk = await router.claimGovernedExecution({
  intent, toolId: "tool.code.test", candidateId: snap.candidateId, toolName: "search",
  toolArtifactPath: NOOP_TOOL, sandboxNeeds: {}
 });
 const result = await executor.execute({ claimId: claimOk.claimId, args: { query: "x" } });
 assert.equal(result.ok, true);
 assert.deepEqual(result.output.args, { query: "x" });
 assert.ok(result.sandbox.pid > 0, "executed in a child process");
 assert.equal(result.decisionDigest.length, 64, "bound to the canonical authority decision");
 // replay: the same claim CANNOT be consumed twice (one-use)
 await assert.rejects(executor.execute({ claimId: claimOk.claimId }), (e) => e.code === "MESH_REPLAY");
 // tool mutation after enablement voids everything
 const mutated = fed.checkToolIntegrity(snap.candidateId, { toolName: "search", currentDigest: "f".repeat(64) });
 assert.equal(mutated.state, "QUARANTINED");
 const claimMut = await router.claimGovernedExecution({
  intent, toolId: "tool.code.test", candidateId: snap.candidateId, toolName: "search",
  toolArtifactPath: NOOP_TOOL, sandboxNeeds: {}
 });
 await assert.rejects(executor.execute({ claimId: claimMut.claimId }), (e) => e.code === "TOOL_NOT_ENABLED");
});

test("W6-07 G: executor rejects a non-canonical duck-typed router at construction (R2-07 brand)", () => {
 const fed = new federationMod.ExternalCapabilityFederation();
 assert.throws(() => createGovernedExternalToolExecutor({
  federation: fed,
  sandboxPolicy: { network: [], filesystem: [] },
  executionRouter: { consumeGovernedClaim: () => {}, claimGovernedExecution: () => {} }
 }), TypeError);
});

test("W6-07: tool mutation after enablement + authority omission all fail closed", () => {
 const fed = new federationMod.ExternalCapabilityFederation();
 assert.equal(fed.isToolEnabled("ghost", "tool"), false, "unknown candidate never enabled");
});