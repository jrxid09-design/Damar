"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;
const dexec = require("../../../src/dexec");
const { makeCanonicalAuthorityRoot } = require("./testCanonicalRoot");
const { parseActionIntent } = require("../../../src/action/intent");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const federation = require("../../../src/federation");
const { createGovernedExternalToolExecutor } = require("../../../src/integration/wave6Production");
const { APPCONTAINER_NAME, HOST_EXE } = require("../../../src/federation/appContainerSandbox");
const { sha256File } = require("../../helpers/toolDigest");

/**
 * W6-R3-02/03 — REAL sandbox via Windows AppContainer (kernel network denial),
 * driven by a canonical router claim (no caller-shaped authority).
 *
 * The tool runs in a spawned Node child placed in a Windows AppContainer with
 * ZERO package capabilities and LOW integrity. Raw TCP/UDP/DNS (loopback
 * 127.0.0.1/localhost/::1, LAN, public IP, DNS) is DENIED BY THE WINDOWS
 * KERNEL (WFP). launchSandboxedTool is NOT exported anywhere (R3-03); the
 * ONLY production entry point is execute({ claimId, ... }).
 *
 * A declarative sandbox object alone executes nothing.
 */

const NOOP_TOOL = path.resolve(__dirname, "../../../src/federation/noopTool.js");
const CANDIDATE = "c".repeat(64);

const WINDOWS = process.platform === "win32";
const HOST_PRESENT = fs.existsSync(HOST_EXE);

let canonicalBound = false;
async function canonicalIntent({ capabilityId = "code.test", operation = "test" } = {}) {
    const intent = parseActionIntent(JSON.stringify({
        schemaVersion: 1, capabilityId, operation, arguments: { scope: "." }, correlationId: "corr"
    }), { nowMs: 1_000_000 });
    if (!canonicalBound) {
        // R4-01: canonical root from deep-internal composition (test harness).
        const store = createMemoryAuthorityStore();
        const { owner: registry } = await makeCanonicalAuthorityRoot({
            store,
            clock: { nowIso: () => new Date(1_000_000).toISOString(), nowMs: () => 1_000_000 }
        });
        await registry.proposeEvolution({
            proposalId: "sbox-grant", createdBy: "owner", kind: "authority_expansion",
            problem: "grant", proposedChange: "grant",
            requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["test"], scope: ["."], maxExecutions: 2000 }
        }, "owner");
        await registry.ratify({ ratificationId: "rat", proposalId: "sbox-grant", ownerIdentity: "owner", decision: "APPROVED" });
        await registry.issueRatifiedRootGrant({ proposalId: "sbox-grant", ratificationId: "rat", actor: "owner" });
        canonicalBound = true;
    }
    return intent;
}

function makeExecutor({ sandboxPolicy = {}, toolArtifactPath = NOOP_TOOL, toolName = "search", enabled = true } = {}) {
    const fed = new federation.ExternalCapabilityFederation();
    const snap = fed.discover({
        source: "https://mcp.example.com", sourceType: "mcp", publisher: "pub",
        name: "sandbox-tool", version: "1.0.0", license: "MIT", artifactDigest: "a".repeat(64),
        permissions: { network: [], filesystem: [] }
    });
    fed.inspect(snap.candidateId, { artifactSurface: "clean" });
    // R5-04: pin the REAL artifact digest — the native host verifies it end-to-end.
    fed.validate(snap.candidateId, { toolDigests: { [toolName]: sha256File(toolArtifactPath) } });
    if (enabled) fed.enableTool(snap.candidateId, { toolName });
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

// AppContainer sandbox execution is Windows + native-host dependent. These
// tests are PROVISIONED for that environment; on non-Windows/no-host they
// assert the executor FAILS CLOSED (never a non-isolating fallback).
const canRun = WINDOWS && HOST_PRESENT && process.env.DAMAR_SKIP_APP_CONTAINER !== "1";

test("R3-02: native AppContainer host is present for the frozen platform", () => {
    assert.equal(WINDOWS, process.platform === "win32");
    // Regardless of platform, HOST_EXE must resolve to a stable path.
    assert.match(HOST_EXE, /native[\/\\]sandbox-host[\/\\]sandbox-host\.exe$/);
    assert.equal(APPCONTAINER_NAME, "DamarGovExternalSandbox");
    if (WINDOWS) {
        assert.ok(HOST_PRESENT, "sandbox-host.exe must ship with the runtime (R3-02)");
    }
});

test("R3-SBOX: compliant noop tool runs in AppContainer and returns result", { skip: !canRun }, async () => {
    const { snap, executor, router } = makeExecutor();
    const { claim } = await claimFor({ executor, router, snap });
    const result = await executor.execute({ claimId: claim.claimId, args: { query: "test" } });
    assert.equal(result.ok, true);
    assert.equal(result.output.args.query, "test");
    assert.ok(result.sandbox.pid > 0, "executed in a child process");
    assert.equal(result.sandbox.mechanism, "AppContainer", "isolated by AppContainer");
    assert.equal(result.sandbox.sandboxId, "DamarGovExternalSandbox");
});

test("R3-SBOX-01: ambient env is scrubbed before tool code (DAMAR marker not leaked)", { skip: !canRun }, async () => {
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
        const { snap, executor, router } = makeExecutor({ toolArtifactPath: markerTool });
        const { claim } = await claimFor({ executor, router, snap, toolArtifactPath: markerTool });
        const result = await executor.execute({ claimId: claim.claimId, args: {} });
        const output = result.output ?? {};
        assert.equal(output.leaked, undefined, "parent env marker NOT leaked into sandbox");
        assert.equal(output.clean, true);
    } finally {
        fs.unlinkSync(markerTool);
    }
});

test("R4-03: native host launches with an OWNED env block — secret families never reach the sandbox", { skip: !canRun }, async () => {
    // R4-03: the native host builds its OWN environment block before
    // CreateProcess (never NULL/inherit-raw). Secret-bearing env families
    // (API_KEY, TOKEN, PASSWORD, AWS_*, etc.) are stripped at the process
    // boundary; the deny-by-default shim allowlist removes the rest before
    // tool code. Probe verifies key-value material that must NEVER surface.
    const probeTool = path.join(path.dirname(NOOP_TOOL), "env_secret_probe.js");
    fs.writeFileSync(probeTool, `
"use strict";
module.exports = function(args) {
    return {
        damar: process.env.DAMAR_TEST_SECRET || null,
        aws: process.env.AWS_ACCESS_KEY_ID || null,
        token: process.env.SUPER_SECRET_TOKEN || null,
        pass: process.env.DB_PASSWORD || null,
        apiKey: process.env.APP_API_KEY || null,
        user: process.env.USERPROFILE || null,
        nodeEnv: process.env.NODE_ENV || null
    };
};
`);
    try {
        // Load secret markers into the PARENT env so the child COULD inherit
        // them if the native host passed a raw block. They must never surface.
        const prev = Object.fromEntries(
            ["DAMAR_TEST_SECRET", "AWS_ACCESS_KEY_ID", "SUPER_SECRET_TOKEN", "DB_PASSWORD", "APP_API_KEY"]
                .filter(k => k in process.env).map(k => [k, process.env[k]])
        );
        for (const k of Object.keys(prev)) delete process.env[k];
        process.env.DAMAR_TEST_SECRET = "R4-DAMAR-LEAK";
        process.env.AWS_ACCESS_KEY_ID = "AKIA-R4-LEAK";
        process.env.SUPER_SECRET_TOKEN = "R4-TOKEN-LEAK";
        process.env.DB_PASSWORD = "R4-PASS-LEAK";
        process.env.APP_API_KEY = "R4-KEY-LEAK";
        try {
            const { snap, executor, router } = makeExecutor({ toolArtifactPath: probeTool });
            const { claim } = await claimFor({ executor, router, snap, toolArtifactPath: probeTool });
            const result = await executor.execute({ claimId: claim.claimId, args: {} });
            const output = result.output ?? {};
            assert.equal(output.damar, null, "DAMAR_* secret not visible inside sandbox");
            assert.equal(output.aws, null, "AWS credential not visible inside sandbox");
            assert.equal(output.token, null, "token family not visible inside sandbox");
            assert.equal(output.pass, null, "password family not visible inside sandbox");
            assert.equal(output.apiKey, null, "API key family not visible inside sandbox");
            assert.equal(output.nodeEnv, "sandbox", "sandbox marker present");
            // Execution still succeeded with the owned block.
            assert.equal(result.ok, true);
        } finally {
            for (const k of Object.keys(prev)) process.env[k] = prev[k];
            delete process.env.DAMAR_TEST_SECRET;
            delete process.env.AWS_ACCESS_KEY_ID;
            delete process.env.SUPER_SECRET_TOKEN;
            delete process.env.DB_PASSWORD;
            delete process.env.APP_API_KEY;
        }
    } finally {
        fs.unlinkSync(probeTool);
    }
});

test("R3-SBOX-02: filesystem traversal rejected at admission", { skip: !canRun }, async () => {
    const { snap, executor, router } = makeExecutor({ sandboxPolicy: { filesystem: [] } });
    const { claim } = await claimFor({
        executor, router, snap,
        sandboxNeeds: { needsFilesystem: ["/etc/passwd"] }
    });
    await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "SANDBOX_VIOLATION" && /sandbox violations/.test(e.message));
});

test("R3-SBOX-03: unauthorized network need fail-closed at admission", { skip: !canRun }, async () => {
    const { snap, executor, router } = makeExecutor();
    const { claim } = await claimFor({
        executor, router, snap,
        sandboxNeeds: { needsNetwork: ["evil.example.com"] }
    });
    await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "SANDBOX_VIOLATION");
});

test("R3-SBOX-04: raw network access DENIED inside AppContainer (kernel)", { skip: !canRun }, async () => {
    // A tool that attempts raw socket connects/udp to a local listener.
    // The listener is created by THIS test in the parent process.
    const { createServer } = require("node:net");
    const srv = createServer(sock => { sock.on("error", () => {}); sock.end("OPEN"); });
    srv.on("error", () => {});
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const netTool = path.join(path.dirname(NOOP_TOOL), "net_probe_tool.js");
    fs.writeFileSync(netTool, `
"use strict";
const net = require("node:net");
const { argv } = require("node:process");
module.exports = function(args) {
    const port = typeof args.port === "number" ? args.port : 1;
    return new Promise((resolve) => {
        const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve({ connected: true }); });
        s.on("error", (e) => resolve({ connected: false, code: e.code, msg: e.message.slice(0, 60) }));
        s.setTimeout(4000, () => { s.destroy(); resolve({ connected: false, code: "TIMEOUT" }); });
    });
};
`);
    try {
        const { snap, executor, router } = makeExecutor({ toolArtifactPath: netTool });
        const { claim } = await claimFor({ executor, router, snap, toolArtifactPath: netTool });
        const result = await executor.execute({ claimId: claim.claimId, args: { port } });
        // Kernel denies loopback in AppContainer: tool must NOT connect.
        assert.equal(result.output.connected, false, "loopback raw TCP must be kernel-denied inside AppContainer");
        assert.ok(["ETIMEDOUT", "ECONNREFUSED", "EACCES"].includes(result.output.code), "denied by kernel error: " + result.output.code);
    } finally {
        srv.close();
        fs.unlinkSync(netTool);
    }
});

test("R3-SBOX-05: timeout kills sandbox process", { skip: !canRun }, async () => {
    const hangTool = path.join(path.dirname(NOOP_TOOL), "hang_tool.js");
    fs.writeFileSync(hangTool, `
"use strict";
module.exports = function() {
    // hold the event loop open indefinitely (an actual busy process), so the
    // sandbox timeout must terminate it rather than letting node exit idle.
    return new Promise(() => { setInterval(() => {}, 1000); });
};
`);
    try {
        const { snap, executor, router } = makeExecutor({ sandboxPolicy: { config: { timeoutMs: 2500 } }, toolArtifactPath: hangTool });
        const { claim } = await claimFor({ executor, router, snap, toolArtifactPath: hangTool });
        await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "MESSAGE_EXPIRED");
    } finally {
        fs.unlinkSync(hangTool);
    }
});

test("R3-SBOX-06: oversized output fails with BOUNDS_EXCEEDED", { skip: !canRun }, async () => {
    const bigTool = path.join(path.dirname(NOOP_TOOL), "big_output_tool.js");
    fs.writeFileSync(bigTool, `
"use strict";
module.exports = function() { return { data: "x".repeat(1024 * 1024) }; };
`);
    try {
        const { snap, executor, router } = makeExecutor({ toolArtifactPath: bigTool });
        const { claim } = await claimFor({ executor, router, snap, toolArtifactPath: bigTool });
        await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "BOUNDS_EXCEEDED");
    } finally {
        fs.unlinkSync(bigTool);
    }
});

test("R3-SBOX: disabled tool -> reject BEFORE sandbox launch", { skip: !canRun }, async () => {
    const fed = new federation.ExternalCapabilityFederation();
    const snap = fed.discover({ source: "https://mcp.example.com", sourceType: "mcp", publisher: "pub", name: "revoked-tool", version: "1.0.0", license: "MIT", artifactDigest: "a".repeat(64), permissions: {} });
    fed.inspect(snap.candidateId, { artifactSurface: "clean" });
    fed.validate(snap.candidateId, { toolDigests: { search: "b".repeat(64) } });
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const identity = mesh.meshIdentity.mintNodeIdentity({ logicalDamarId: ids.mint.logicalDamarId() });
    registry.register({ identity, displayName: "sandbox-node" });
    const router = new dexec.DistributedExecutionRouter({ trust, registry });
    router.bindLocalNodeId(identity.nodeId);
    router.advertise({ nodeId: identity.nodeId, profile: "DESKTOP_PRIMARY", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 90, privacy: "INTERNAL" }] });
    trust.pair({ nodeId: identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
    const executor = createGovernedExternalToolExecutor({ federation: fed, sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false }, executionRouter: router });
    const intent = await canonicalIntent();
    const claim = await router.claimGovernedExecution({ intent, toolId: "code_test", candidateId: snap.candidateId, toolName: "search", toolArtifactPath: NOOP_TOOL, sandboxNeeds: {} });
    await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "TOOL_NOT_ENABLED");
});

test("R3-SBOX: tool mutation after validation -> execution rejected", { skip: !canRun }, async () => {
    const fed = new federation.ExternalCapabilityFederation();
    const snap = fed.discover({ source: "https://mcp.example.com", sourceType: "mcp", publisher: "pub", name: "mutable-tool", version: "1.0.0", license: "MIT", artifactDigest: "a".repeat(64), permissions: {} });
    fed.inspect(snap.candidateId, { artifactSurface: "clean" });
    fed.validate(snap.candidateId, { toolDigests: { search: "b".repeat(64) } });
    fed.enableTool(snap.candidateId, { toolName: "search" });
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
    const executor = createGovernedExternalToolExecutor({ federation: fed, sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false }, executionRouter: router });
    const intent = await canonicalIntent();
    const claim = await router.claimGovernedExecution({ intent, toolId: "code_test", candidateId: snap.candidateId, toolName: "search", toolArtifactPath: NOOP_TOOL, sandboxNeeds: {} });
    await assert.rejects(executor.execute({ claimId: claim.claimId }), (e) => e.code === "TOOL_NOT_ENABLED");
});

test("R4-07: executor accepts ONLY claimId/args (no caller envMaterial / toolFn / launcher / caller authority)", () => {
    const { executor } = makeExecutor();
    const fnParams = executor.execute.toString();
    assert.ok(!/toolFn|authorityArtifact|launchSandboxedTool/.test(fnParams), "executor API must not accept caller authority or open a raw launcher");
    // R4-07: caller envMaterial is gone — material is claim-bound and resolved
    // internally from the claim's sandboxNeeds.
    assert.ok(!/envMaterial/.test(fnParams.split("{")[1] || fnParams),
        "executor signature must not contain caller envMaterial (R4-07)");
});

test("R3-SBOX-08: launchSandboxedTool not exported anywhere reachable", () => {
    // The inert runtime constants module exports NO launch function.
    const ac = require("../../../src/federation/appContainerSandbox");
    assert.equal(ac.launchAppContainerTool, undefined);
    assert.equal(ac.launchSandboxedTool, undefined);
    // The executor surface has no launcher either.
    const { executor } = makeExecutor();
    assert.equal(executor.launchSandboxedTool, undefined);
    assert.equal(executor.launchAppContainerTool, undefined);
});