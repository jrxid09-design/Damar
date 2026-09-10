"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;
const dexec = require("../../../src/dexec");
const { bindCanonicalAuthorityRegistry } = require("../../../src/dexec/authoritySource");
const { parseActionIntent } = require("../../../src/action/intent");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const { AuthorityRegistry } = require("../../../src/authority/registry");
const federation = require("../../../src/federation");
const { createGovernedExternalToolExecutor } = require("../../../src/integration/wave6Production");

/**
 * W6-R2-05/07 — REAL sandbox enforcement via child process + Node permission
 * model, driven by a canonical router claim (no caller-shaped authority).
 *
 * The tool runs in a spawned Node child with --permission (default-deny),
 * scrubbed env, no child_process, no worker threads, timeout + output caps.
 * A declarative sandbox object alone executes nothing.
 */

const NOOP_TOOL = path.resolve(__dirname, "../../../src/federation/noopTool.js");
const CANDIDATE = "c".repeat(64);

let canonicalBound = false;
async function canonicalIntent({ capabilityId = "code.test", operation = "test" } = {}) {
    const intent = parseActionIntent(JSON.stringify({
        schemaVersion: 1, capabilityId, operation, arguments: { scope: "." }, correlationId: "corr"
    }), { nowMs: 1_000_000 });
    if (!canonicalBound) {
        const store = createMemoryAuthorityStore();
        const registry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(1_000_000).toISOString() } });
        await registry.proposeEvolution({
            proposalId: "sbox-grant", createdBy: "owner", kind: "authority_expansion",
            problem: "grant", proposedChange: "grant",
            requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["test"], scope: ["."], maxExecutions: 2000 }
        }, "owner");
        await registry.ratify({ ratificationId: "rat", proposalId: "sbox-grant", ownerIdentity: "owner", decision: "APPROVED" });
        await registry.issueRatifiedRootGrant({ proposalId: "sbox-grant", ratificationId: "rat", actor: "owner" });
        bindCanonicalAuthorityRegistry(registry);
        canonicalBound = true;
    }
    return intent;
}

function makeExecutor({ sandboxPolicy = {}, toolDigests = {}, enabled = true } = {}) {
    const fed = new federation.ExternalCapabilityFederation();
    const snap = fed.discover({
        source: "https://mcp.example.com", sourceType: "mcp", publisher: "pub",
        name: "sandbox-tool", version: "1.0.0", license: "MIT", artifactDigest: "a".repeat(64),
        permissions: { network: [], filesystem: [] }
    });
    fed.inspect(snap.candidateId, { artifactSurface: "clean" });
    fed.validate(snap.candidateId, { toolDigests: { search: toolDigests.search ?? "b".repeat(64) } });
    if (enabled) fed.enableTool(snap.candidateId, { toolName: "search" });
    // canonical execution router (self-trusted local node)
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const identity = mesh.meshIdentity.mintNodeIdentity({ logicalDamarId: ids.mint.logicalDamarId() });
    registry.register({ identity, displayName: "sandbox-node" });
    const router = new dexec.DistributedExecutionRouter({ trust, registry });
    router.bindLocalNodeId(identity.nodeId);
    router.advertise({ nodeId: identity.nodeId, profile: "DESKTOP_PRIMARY", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 90, privacy: "INTERNAL" }] });
    trust.pair({ nodeId: identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
    const executor = createGovernedExternalToolExecutor({
        federation: fed,
        sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false, ...sandboxPolicy },
        executionRouter: router
    });
    return { fed, snap, executor, router };
}

async function claimFor({ executor, router, snap, toolName = "search", toolArtifactPath = NOOP_TOOL, sandboxNeeds = {}, capabilityId = "code.test" } = {}) {
    const intent = await canonicalIntent({ capabilityId });
    const claim = await router.claimGovernedExecution({
        intent, toolId: "code_test", candidateId: snap.candidateId, toolName,
        toolArtifactPath, sandboxNeeds
    });
    return { intent, claim };
}

test("R2-SBOX: compliant noop tool runs in sandbox and returns result", async () => {
    const { snap, executor, router } = makeExecutor();
    const { claim } = await claimFor({ executor, router, snap });
    const result = await executor.execute({ claimId: claim.claimId, args: { query: "test" } });
    assert.equal(result.ok, true);
    assert.equal(result.output.args.query, "test");
    assert.ok(result.sandbox.pid > 0, "executed in a child process");
});

test("R2-SBOX-01: process.env access fails in sandbox (env not inherited)", async () => {
    const markerTool = path.join(path.dirname(NOOP_TOOL), "env_probe_tool.js");
    fs.writeFileSync(markerTool, `
"use strict";
module.exports = function(args) {
    const val = process.env.DAMAR_TEST_MARKER;
    if (val) return { leaked: val };
    return { clean: true };
};
`);
    try {
        const { snap, executor, router } = makeExecutor();
        const { claim } = await claimFor({ executor, router, snap, toolArtifactPath: markerTool });
        const result = await executor.execute({ claimId: claim.claimId, args: {} });
        const output = result.output ?? {};
        assert.equal(output.leaked, undefined, "parent env marker NOT leaked into sandbox");
        assert.equal(output.clean, true);
    } finally {
        fs.unlinkSync(markerTool);
    }
});

test("R2-SBOX-02: filesystem traversal rejected", async () => {
    const { snap, executor, router } = makeExecutor({ sandboxPolicy: { filesystem: [] } });
    const { claim } = await claimFor({
        executor, router, snap,
        sandboxNeeds: { needsFilesystem: ["/etc/passwd"] }
    });
    await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "SANDBOX_VIOLATION" && /sandbox violations/.test(e.message));
});

test("R2-SBOX-03: unauthorized network need fail-closed (Node permission model does not enforce network)", async () => {
    const { snap, executor, router } = makeExecutor();
    const { claim } = await claimFor({
        executor, router, snap,
        sandboxNeeds: { needsNetwork: ["evil.example.com"] }
    });
    await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "SANDBOX_VIOLATION" && /network.*fail-closed/.test(e.message));
});

test("R2-SBOX-04: child_process in sandbox — Node permission model denies", async () => {
    const spawnTool = path.join(path.dirname(NOOP_TOOL), "spawn_probe_tool.js");
    fs.writeFileSync(spawnTool, `
"use strict";
module.exports = function(args) {
    const { exec } = require("node:child_process");
    return new Promise((resolve, reject) => {
        exec("echo pwned", (err, stdout) => {
            if (err) reject(new Error("SPAWN_DENIED"));
            else resolve({ leaked: stdout.trim() });
        });
    });
};
`);
    try {
        const { snap, executor, router } = makeExecutor();
        const { claim } = await claimFor({ executor, router, snap, toolArtifactPath: spawnTool });
        let sandboxError = null;
        let sandboxResult = null;
        try {
            sandboxResult = await executor.execute({ claimId: claim.claimId, args: {} });
        } catch (e) { sandboxError = e; }
        if (sandboxError) {
            assert.ok(["SANDBOX_VIOLATION", "MESSAGE_MALFORMED", "BOUNDS_EXCEEDED", "MESSAGE_EXPIRED"].includes(sandboxError.code), `sandbox error code: ${sandboxError.code}`);
        } else if (sandboxResult) {
            const output = JSON.stringify(sandboxResult.output ?? "");
            assert.ok(!output.includes("pwned"), "child_process spawn leaked into sandbox output");
        }
    } finally {
        fs.unlinkSync(spawnTool);
    }
});

test("R2-SBOX-05: timeout kills sandbox process", async () => {
    const hangTool = path.join(path.dirname(NOOP_TOOL), "hang_tool.js");
    fs.writeFileSync(hangTool, `
"use strict";
module.exports = function() { return new Promise(() => {}); };
`);
    try {
        const { snap, executor, router } = makeExecutor({ sandboxPolicy: { config: { timeoutMs: 1500 } } });
        const { claim } = await claimFor({ executor, router, snap, toolArtifactPath: hangTool });
        await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "MESSAGE_EXPIRED");
    } finally {
        fs.unlinkSync(hangTool);
    }
});

test("R2-SBOX-06: oversized output terminated/fails", async () => {
    const bigTool = path.join(path.dirname(NOOP_TOOL), "big_output_tool.js");
    fs.writeFileSync(bigTool, `
"use strict";
module.exports = function() { return { data: "x".repeat(1024 * 1024) }; };
`);
    try {
        const { snap, executor, router } = makeExecutor({ sandboxPolicy: { config: { maxOutputBytes: 64 * 1024 } } });
        const { claim } = await claimFor({ executor, router, snap, toolArtifactPath: bigTool });
        await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "BOUNDS_EXCEEDED");
    } finally {
        fs.unlinkSync(bigTool);
    }
});

test("R2-SBOX: disabled tool -> reject BEFORE sandbox launch", async () => {
    const fed = new federation.ExternalCapabilityFederation();
    const snap = fed.discover({
        source: "https://mcp.example.com", sourceType: "mcp", publisher: "pub",
        name: "revoked-tool", version: "1.0.0", license: "MIT", artifactDigest: "a".repeat(64),
        permissions: {}
    });
    fed.inspect(snap.candidateId, { artifactSurface: "clean" });
    fed.validate(snap.candidateId, { toolDigests: { search: "b".repeat(64) } });
    // NOT enabled (skipped enableTool)
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const identity = mesh.meshIdentity.mintNodeIdentity({ logicalDamarId: ids.mint.logicalDamarId() });
    registry.register({ identity, displayName: "sandbox-node" });
    const router = new dexec.DistributedExecutionRouter({ trust, registry });
    router.bindLocalNodeId(identity.nodeId);
    router.advertise({ nodeId: identity.nodeId, profile: "DESKTOP_PRIMARY", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 90, privacy: "INTERNAL" }] });
    trust.pair({ nodeId: identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
    const executor = createGovernedExternalToolExecutor({
        federation: fed,
        sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false },
        executionRouter: router
    });
    const intent = await canonicalIntent();
    const claim = await router.claimGovernedExecution({
        intent, toolId: "code_test", candidateId: snap.candidateId, toolName: "search",
        toolArtifactPath: NOOP_TOOL, sandboxNeeds: {}
    });
    await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "TOOL_NOT_ENABLED");
});

test("R2-SBOX: tool mutation after validation -> re-quarantined, execution rejected", async () => {
    const fed = new federation.ExternalCapabilityFederation();
    const snap = fed.discover({
        source: "https://mcp.example.com", sourceType: "mcp", publisher: "pub",
        name: "mutable-tool", version: "1.0.0", license: "MIT", artifactDigest: "a".repeat(64),
        permissions: {}
    });
    fed.inspect(snap.candidateId, { artifactSurface: "clean" });
    fed.validate(snap.candidateId, { toolDigests: { search: "b".repeat(64) } });
    fed.enableTool(snap.candidateId, { toolName: "search" });
    // tool digest changes after validation
    const mutated = fed.checkToolIntegrity(snap.candidateId, { toolName: "search", currentDigest: "f".repeat(64) });
    assert.equal(mutated.state, "QUARANTINED");
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const identity = mesh.meshIdentity.mintNodeIdentity({ logicalDamarId: ids.mint.logicalDamarId() });
    registry.register({ identity, displayName: "sandbox-node" });
    const router = new dexec.DistributedExecutionRouter({ trust, registry });
    router.bindLocalNodeId(identity.nodeId);
    router.advertise({ nodeId: identity.nodeId, profile: "DESKTOP_PRIMARY", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 90, privacy: "INTERNAL" }] });
    trust.pair({ nodeId: identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
    const executor = createGovernedExternalToolExecutor({
        federation: fed,
        sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false },
        executionRouter: router
    });
    const intent = await canonicalIntent();
    const claim = await router.claimGovernedExecution({
        intent, toolId: "code_test", candidateId: snap.candidateId, toolName: "search",
        toolArtifactPath: NOOP_TOOL, sandboxNeeds: {}
    });
    await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "TOOL_NOT_ENABLED");
});

test("R2-SBOX-07: no caller-shaped authority — executor has no toolFn/authorityArtifact/consumed params", async () => {
    const { snap, executor, router } = makeExecutor();
    const fnParams = executor.execute.toString();
    // the ONLY accepted inputs are claimId/args/envMaterial
    assert.ok(!/toolFn|authorityArtifact|consumed\s*:/.test(fnParams), "executor API must not accept caller authority");
});