"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createDistributedNodeRuntime, createGovernedExternalToolExecutor } = require("../../../src/integration/wave6Production");
const { parseActionIntent } = require("../../../src/action/intent");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const { makeCanonicalAuthorityRoot } = require("../repair/testCanonicalRoot");
const dexec = require("../../../src/dexec");
const federationMod = require("../../../src/federation");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;
const { sha256File } = require("../../helpers/toolDigest");

/**
 * W6-R2-06/R3-01 / R2-CHAOS-01 — REAL canonical ingress + end-to-end chaos.
 *
 * The ONLY production ingress for distributed execution is the canonical
 * node runtime (`createDistributedNodeRuntime`):
 *
 *   ActionIntent (frozen parseActionIntent) ->
 *   LIVE canonical Authority evaluation (composition-root registry) ->
 *   capability resolution -> DistributedExecutionRouter ->
 *   governed execution claim -> sandbox (AppContainer) -> verification.
 *
 * No direct model->node path, no caller-supplied evaluation/artifact, no
 * toolFn bypass. Chaos scenarios (revoke, replay, mutation, relocation,
 * concurrent consume) all fail closed.
 */

const NOOP_TOOL = path.resolve(__dirname, "../../../src/federation/noopTool.js");

// ---- ONE shared canonical registry is produced by the composition-root
// factory ONCE per process (R3-01). Each test uses its OWN capability id so
// live revocations never leak across tests. ----
let canonicalStore = null;
let canonicalRegistry = null;
let canonicalBound = false;

async function bindCanonical() {
    if (canonicalBound) return canonicalRegistry;
    const store = createMemoryAuthorityStore();
    // R4-01: canonical root from deep-internal composition (test harness).
    const { owner: registry } = await makeCanonicalAuthorityRoot({
        store,
        clock: { nowIso: () => new Date(1_000_000).toISOString(), nowMs: () => 1_000_000 }
    });
    canonicalStore = store;
    canonicalRegistry = registry;
    for (const capabilityId of ["code.test", "chaos.test", "chaos2.test"]) {
        await canonicalRegistry.proposeEvolution({
            proposalId: `grant-${capabilityId}`, createdBy: "owner", kind: "authority_expansion",
            problem: "grant", proposedChange: "grant",
            requestedAuthority: { capabilityId, subject: "damar", actions: ["test"], scope: ["."], maxExecutions: 500 }
        }, "owner");
        await canonicalRegistry.ratify({ ratificationId: `rat-${capabilityId}`, proposalId: `grant-${capabilityId}`, ownerIdentity: "owner", decision: "APPROVED" });
        await canonicalRegistry.issueRatifiedRootGrant({ proposalId: `grant-${capabilityId}`, ratificationId: `rat-${capabilityId}`, actor: "owner" });
    }
    canonicalBound = true;
    return canonicalRegistry;
}

function intentFor(capabilityId) {
    return parseActionIntent(JSON.stringify({
        schemaVersion: 1, capabilityId, operation: "test",
        arguments: { scope: "." }, correlationId: "corr"
    }), { nowMs: 1_000_000 });
}

function nodePair(registry, logicalDamarId) {
    // R4-01: no authorityRegistry param — the canonical root is installed by
    // the composition harness (bindCanonical) and the router resolves live.
    const A = createDistributedNodeRuntime({
        logicalDamarId, profile: "DESKTOP_PRIMARY", capabilityIds: ["code.test", "chaos.test"]
    });
    const B = createDistributedNodeRuntime({
        logicalDamarId, profile: "SERVER_PRIVATE", capabilityIds: ["code.test", "chaos.test", "chaos2.test"]
    });
    A.registry.register({ identity: B.identity });
    A.trust.pair({ nodeId: B.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"], ttlMs: 3600_000 });
    A.trust.pair({ nodeId: A.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"], ttlMs: 3600_000 });
    // chaos2.test is advertised ONLY by B so the revoke-Node case is meaningful
    A.dexecRouter.advertise({
        nodeId: B.identity.nodeId, profile: "SERVER_PRIVATE",
        capabilities: [
            { capabilityId: "code.test", toolId: "tool.code.test", latencyScore: 40 },
            { capabilityId: "chaos.test", toolId: "tool.chaos.test", latencyScore: 40 },
            { capabilityId: "chaos2.test", toolId: "tool.chaos2.test", latencyScore: 40 }
        ],
        resources: { headroomScore: 35 }
    });
    A.dexecRouter.advertise({
        nodeId: A.identity.nodeId, profile: "DESKTOP_PRIMARY",
        capabilities: [
            { capabilityId: "code.test", toolId: "tool.code.test", latencyScore: 90 },
            { capabilityId: "chaos.test", toolId: "tool.chaos.test", latencyScore: 90 }
        ],
        resources: { headroomScore: 30 }
    });
    return { A, B };
}

test("R2-06 A: canonical action facade is the frozen owner surface — no options accepted", () => {
    const { createCanonicalActionFacade } = require("../../../src/action/bootstrap");
    const facade = createCanonicalActionFacade();
    assert.deepEqual(Object.keys(facade).sort(), ["admit", "authenticate", "evaluate", "session"]);
    assert.throws(() => createCanonicalActionFacade({ authorityStore: {} }));
    assert.equal(facade.registrar, undefined);
    assert.equal(facade.execute, undefined);
});

test("R2-06 B: node runtime ingress resolves authority LIVE from the bound canonical registry", async () => {
    const registry = await bindCanonical();
    const { A, B } = nodePair(registry, ids.mint.logicalDamarId());
    const intent = intentFor("chaos.test");
    // sanity: NOT yet revoked -> routes
    const routed = await A.ingress.submitIntent({ intent, toolId: "tool.chaos.test", preferredNodeId: B.identity.nodeId });
    assert.equal(routed.targetNodeId, B.identity.nodeId);
    // revoke the grant in the canonical store -> LIVE evaluation DENY at route time
    await registry.revoke("chaos.test", "owner");
    await assert.rejects(
        () => A.ingress.submitIntent({ intent, toolId: "tool.chaos.test", preferredNodeId: B.identity.nodeId }),
        (e) => e.failureClass === "AUTHORITY_DENIED"
    );
});

test("R2-CHAOS-01: canonical end-to-end -> claim -> sandbox -> verify; replay/revoke/mutation fail closed", async () => {
    const registry = await bindCanonical();
    const { A, B } = nodePair(registry, ids.mint.logicalDamarId());
    // chaos2.test is NOT revoked by the preceding test (chaos.test is)
    const intent = intentFor("chaos2.test");

    // federation + executor bound to A's canonical router (R2-07)
    const fed = new federationMod.ExternalCapabilityFederation();
    const CANDIDATE = "c".repeat(64);
    const snap = fed.discover({
        source: "https://mcp.example.com", sourceType: "mcp", publisher: "pub",
        name: "chaos-tool", version: "1.0.0", license: "MIT", artifactDigest: "a".repeat(64),
        permissions: {}
    });
    fed.inspect(snap.candidateId, { artifactSurface: "clean" });
    // R5-04: pin the REAL artifact digest (native host verifies source+staged).
    fed.validate(snap.candidateId, { toolDigests: { search: sha256File(NOOP_TOOL) } });
    fed.enableTool(snap.candidateId, { toolName: "search" });
    const executor = createGovernedExternalToolExecutor({
        federation: fed,
        sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false },
        executionRouter: A.dexecRouter
    });

    // ---- canonical path: intent -> live authority -> claim -> sandbox ----
    const claim = await A.ingress.claimGovernedToolExecution({
        intent, toolId: "tool.chaos2.test", candidateId: snap.candidateId, toolName: "search",
        toolArtifactPath: NOOP_TOOL, sandboxNeeds: {}
    });
    const result = await executor.execute({ claimId: claim.claimId, args: { k: "v" } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.output.args, { k: "v" });
    assert.equal(result.decisionDigest.length, 64);
    assert.ok(result.sandbox.pid > 0);

    // ---- replay: same claim cannot run twice ----
    await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "MESH_REPLAY");

    // ---- revoke node mid-flight: a NEW claim after trust revoke fails closed ----
    A.trust.revoke(B.identity.nodeId, { reason: "compromised" });
    await assert.rejects(
        () => A.ingress.claimGovernedToolExecution({
            intent, toolId: "tool.chaos2.test", candidateId: snap.candidateId, toolName: "search",
            toolArtifactPath: NOOP_TOOL, sandboxNeeds: {}
        }),
        (e) => e.code === "NODE_UNTRUSTED" || e.code === "ROUTE_UNAVAILABLE"
    );
    A.trust.pair({ nodeId: B.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"], ttlMs: 3600_000 });

    // ---- tool mutation after validation -> re-quarantined -> execution denied ----
    const snap2 = fed.checkToolIntegrity(snap.candidateId, { toolName: "search", currentDigest: "f".repeat(64) });
    assert.equal(snap2.state, "QUARANTINED");
    const claim2 = await A.ingress.claimGovernedToolExecution({
        intent, toolId: "tool.chaos2.test", candidateId: snap.candidateId, toolName: "search",
        toolArtifactPath: NOOP_TOOL, sandboxNeeds: {}
    });
    await assert.rejects(executor.execute({ claimId: claim2.claimId }), (e) => e.code === "TOOL_NOT_ENABLED");

    // ---- live authority revoke -> LIVE evaluation DENY at next route ----
    await registry.revoke("chaos2.test", "owner");
    await assert.rejects(
        () => A.ingress.claimGovernedToolExecution({
            intent, toolId: "tool.chaos2.test", candidateId: snap.candidateId, toolName: "search",
            toolArtifactPath: NOOP_TOOL, sandboxNeeds: {}
        }),
        (e) => e.failureClass === "AUTHORITY_DENIED"
    );

    // ---- verification law: the runtime exposes NO model->node shortcut ----
    assert.equal(A.rawExecute, undefined);
    assert.equal(A.directToolCall, undefined);
    assert.equal(typeof A.ingress.submitIntent, "function");
    assert.equal(typeof A.ingress.claimGovernedToolExecution, "function");
});
