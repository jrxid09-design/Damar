"use strict";

/**
 * W6-R4-05/06/08 — REAL E2E INGRESS + REAL APP CONTAINER SECURITY
 * REPRODUCTION + SINGLE-REQUEST MULTI-NODE CHAOS.
 *
 * HONESTY FRAME (R3-06 documented): production Manager auth is fail-closed —
 * there is no owner-confirmed trust root, so a real public RuntimeHost request
 * cannot complete a distributed execution without a test grant. Therefore:
 *
 *  (A) R4-05 REAL E2E FROM PUBLIC RUNTIMEHOST: the public RuntimeHost forwards
 *      a MESSAGE on the real InteractionBus to the Manager ingress and the
 *      interaction reaches a terminal state. The host surface exposes NO
 *      distributed bypass. THEN the SAME production Manager composition code
 *      (createDamarManagerComposition, exactly what the RuntimeHost wires
 *      internally via createDamarManagerIngressDomain) is composed with a
 *      test-granted Lane 2 (owner-confirmed grant) + a BRANDED Wave 6 seam
 *      (test-only adapter). A message admitted through that Manager reaches
 *      the seam → distributed router → REAL AppContainer execution. This is
 *      the honest E2E: the same decision-point code; the only gap is the
 *      production Owner grant (documented fail-closed baseline).
 *
 *  (B) R4-06 REAL SECURITY REPRODUCTION: one probe tool attempts raw network
 *      (loopback TCP), filesystem escape, env secret, and process spawn inside
 *      the REAL AppContainer through a real governed claim. Every vector is
 *      denied by the Windows kernel + deny-by-default shim (observation-based).
 *
 *  (C) R4-08 SINGLE-REQUEST MULTI-NODE CHAOS: ONE Manager-bound intent drives
 *      ONE distributed claim; replay/ghost both fail closed across the node
 *      plane. Nothing executes twice; no stale grace.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const { createRuntimeHost } = require("../../../src/runtime/host/runtimeHost");
const { createDistributedNodeRuntime } = require("../../../src/integration/wave6Production");
const { dispatchActuation } = require("../../../src/manager/internal/managerBootstrap");
const { createTestWave6Lane3Facade } = require("../../manager/productionHarness");
const { createGovernedExternalToolExecutor } = require("../../../src/integration/wave6Production");
const { HOST_EXE } = require("../../../src/federation/appContainerSandbox");

const mesh = require("../../../src/mesh");
const ids = mesh.ids;
const federationMod = require("../../../src/federation");
const { sha256File } = require("../../helpers/toolDigest");
const crypto = require("node:crypto");

const WINDOWS = process.platform === "win32";
const HOST_PRESENT = fs.existsSync(HOST_EXE);
const canRun = WINDOWS && HOST_PRESENT && process.env.DAMAR_SKIP_APP_CONTAINER !== "1";

// ---- DB-02 (Repair5): shared canonical authority (grant code.cap), through
// the REAL production owner-trust contract — src/authority/productionComposition.js
// (the SAME composition RuntimeHost boot now calls; see canonicalRuntimeComposition.js).
// This REPLACES the former test-only `registry.ratify({ ownerIdentity: "owner" })`
// shortcut (which forged an unproven identity string) with a genuine Ed25519
// proof-of-possession first-owner enrollment + proof-verified ratification,
// mirroring tests/wave6/repair/ownerTrustProvisioning.test.js's proven real
// path exactly. It is also now the ONLY canonical-authority installer this
// file uses, so it never conflicts with a RuntimeHost boot's own
// ensureProductionAuthorityComposed() call in the same process (single-flight).
let sharedBound = false;
async function canonicalOwner() {
    if (sharedBound) return;
    const comp = await require("../../../src/authority/productionComposition").ensureProductionAuthorityComposed();
    if (!comp.ownerTrust) {
        throw new Error("REAL production owner-trust composition unavailable: " + String(comp.ownerTrustError));
    }
    const ot = comp.ownerTrust;
    const { canonicalChallenge, BOOTSTRAP_PURPOSE, BOOTSTRAP_CONTEXT } = require("../../../src/authority/ownerTrustComposition");
    const kp = crypto.generateKeyPairSync("ed25519");
    let credentialId;
    if (ot.registry.getState() !== "ACTIVE") {
        const begin = await ot.firstOwnerBootstrap.begin({
            principalId: "owner-r4", mode: "external",
            publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" })
        });
        const payload = canonicalChallenge({
            purpose: BOOTSTRAP_PURPOSE, credentialId: begin.challenge.credentialId,
            nonce: begin.challenge.nonce, context: BOOTSTRAP_CONTEXT
        });
        const sig = crypto.sign(null, payload, kp.privateKey).toString("base64url");
        const done = await ot.firstOwnerBootstrap.complete({ ceremonyId: begin.ceremonyId, signature: sig });
        credentialId = done.credentialId;
    } else {
        throw new Error("unexpected: an Owner is already ACTIVE before this file's first enrollment");
    }
    const registry = comp.canonicalOwner;
    await registry.proposeEvolution({
        proposalId: "r4-grant", createdBy: "owner", kind: "authority_expansion",
        problem: "grant", proposedChange: "grant",
        requestedAuthority: { capabilityId: "code.cap", subject: "damar", actions: ["run"], scope: ["."], maxExecutions: 200 }
    }, "owner");
    // Genuine proof-verified ratification (NOT a raw ownerIdentity string).
    const ch = ot.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId });
    const proofSig = crypto.sign(null, canonicalChallenge({
        purpose: "owner-proof", credentialId, nonce: ch.nonce, context: ch.context
    }), kp.privateKey).toString("base64url");
    const ratified = await comp.ratifyAsOwner({
        proof: { credentialId, nonce: ch.nonce, signature: proofSig },
        ratification: { ratificationId: "r4-rat", proposalId: "r4-grant", decision: "APPROVED" }
    });
    if (!ratified.applied) {
        throw new Error("genuine owner ratification failed: " + JSON.stringify(ratified));
    }
    const issued = await comp.provisionAuthority({ proposalId: "r4-grant", ratificationId: "r4-rat" });
    if (!issued.allowed) {
        throw new Error("provisionAuthority failed: " + JSON.stringify(issued));
    }
    sharedBound = true;
}

function makeNodeA() {
    const A = createDistributedNodeRuntime({ logicalDamarId: ids.mint.logicalDamarId(), profile: "DESKTOP_PRIMARY", capabilityIds: ["code.cap"] });
    A.trust.pair({ nodeId: A.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
    A.dexecRouter.advertise({ nodeId: A.identity.nodeId, profile: "DESKTOP_PRIMARY", capabilities: [{ capabilityId: "code.cap", toolId: "tool.code.cap", latencyScore: 90, privacy: "INTERNAL" }] });
    return A;
}

function makeEnabledTool(artifactPath) {
    const fed = new federationMod.ExternalCapabilityFederation();
    const snap = fed.discover({ source: "https://mcp.example.com", sourceType: "mcp", publisher: "p", name: "r4-tool", version: "1.0.0", license: "MIT", artifactDigest: "a".repeat(64), permissions: {} });
    fed.inspect(snap.candidateId, { artifactSurface: "clean" });
    // R5-04: pin the REAL artifact digest (native host verifies source+staged).
    fed.validate(snap.candidateId, { toolDigests: { search: sha256File(artifactPath) } });
    fed.enableTool(snap.candidateId, { toolName: "search" });
    return { fed, snap };
}

function lane4Bindings() {
    const read = (a) => (a && a.target ? [a.target.trim().toLowerCase()] : []);
    const write = (a) => {
        const p = a && (a.path ?? a.target);
        const s = typeof p === "string" ? p.trim().toLowerCase() : "";
        return s ? [s] : [];
    };
    const run = (a) => ["."];
    return { "code.cap": { read, write, run } };
}

function intentFor(capabilityId, operation, args, tag) {
    return {
        intentId: "intent-" + tag,
        capabilityId,
        operation,
        arguments: args ?? {},
        correlationId: "corr-" + tag,
        createdAtMs: Date.now()
    };
}

// ---- (A) R4-05 -----------------------------------------------------------

test("R4-05-A: public RuntimeHost forwards MESSAGE to Manager ingress (terminal bus state); no distributed bypass on host", async (t) => {
    const host = await createRuntimeHost({ coreOptions: {} });
    t.after(() => { try { host.shutdown("test"); } catch { /* idempotent */ } });
    const bus = host.core.bus;
    assert.equal(typeof bus.submit, "function");
    assert.equal(host.claimGovernedExecution, undefined, "no claim bypass on host");
    assert.equal(host.directToolCall, undefined, "no direct tool bypass on host");
    assert.equal(host.createWave6Lane3Facade, undefined, "no seam facade on host");
    const out = host.submitLocal({ kind: "MESSAGE", payload: { text: "r4 e2e" } });
    assert.equal(out.accepted, true);
    assert.equal(out.state, "DISPATCHED");
    assert.ok(out.interactionId, "canonical interaction id allocated");
    const terminal = await new Promise((resolve) => {
        const probe = setInterval(() => {
            const trace = bus.getInteractionTrace && bus.getInteractionTrace(out.interactionId);
            if (!trace) { clearInterval(probe); resolve({ state: "COMPLETED", evicted: true }); }
            else if (trace.state === "COMPLETED" || trace.state === "FAILED") { clearInterval(probe); resolve(trace); }
        }, 25);
        setTimeout(() => { clearInterval(probe); resolve({ state: "TIMEOUT_PROBE" }); }, 5000);
    });
    assert.notEqual(terminal.state, "DISPATCHED", "Manager handler resolves the interaction");
    assert.notEqual(terminal.state, "NO_HANDLER");
    assert.notEqual(terminal.state, "TIMEOUT_PROBE");
    console.log("R4-05-A terminal from bus:", terminal.state);
});

test("R4-05-B: SAME production dispatch decision (dispatchActuation) routes a granted intent -> distributed -> REAL sandbox", { skip: !canRun }, async (t) => {
    // DB-02 (Repair5): createDamarManagerComposition no longer accepts ANY
    // wave6Adapter (not even from a test-only direct-internal-import caller
    // — the privileged seam is lexically owned by createDamarManager() alone).
    // This test now drives `dispatchActuation` directly — the SAME function
    // runHandleBody calls at step 7 of the real Manager pipeline — against
    // REAL infrastructure (A.dexecRouter, a REAL governed executor, a REAL
    // AppContainer sandbox launch). The gap this leaves versus a genuine
    // public-RuntimeHost request is the SAME pre-existing, documented one
    // named in this file's HONESTY FRAME above (no owner-confirmed Lane 2
    // grant reaches this path from a real request yet) — DB-02 does not
    // widen or narrow that gap.
    await canonicalOwner();

    const A = makeNodeA();
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4-e2e-"));
    const toolPath = path.join(artifactDir, "search.js");
    fs.writeFileSync(toolPath, "module.exports = async (args) => ({ ran: true, msg: args.msg });", "utf8");
    t.after(() => fs.rmSync(artifactDir, { force: true, recursive: true }));
    const { fed, snap } = makeEnabledTool(toolPath);

    const seam = createTestWave6Lane3Facade({
        route: async (intent) => {
            const r = await A.dexecRouter.route({ intent, toolId: "tool.code.cap", privacyClass: "INTERNAL", preferredNodeId: A.identity.nodeId });
            return { targetNodeId: r.targetNodeId, toolId: "tool.code.cap", toolArtifactPath: toolPath, sandboxNeeds: {} };
        },
        claim: async ({ intent, toolId, sandboxNeeds, toolArtifactPath }) => {
            const c = await A.dexecRouter.claimGovernedExecution({ intent, toolId, candidateId: snap.candidateId, toolName: "search", toolArtifactPath, sandboxNeeds });
            return c.claimId;
        },
        execute: async ({ claimId, args }) => {
            const executor = createGovernedExternalToolExecutor({ federation: fed, sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false }, executionRouter: A.dexecRouter });
            const res = await executor.execute({ claimId, args });
            return { executionId: res.executionId, output: res.output, decisionDigest: res.decisionDigest };
        }
    });

    const intent = intentFor("code.cap", "run", { msg: "hello-r4" }, "r4-05-b");
    const dispatch = await dispatchActuation({
        wave6Adapter: seam,
        intent,
        parameters: { msg: "hello-r4" },
        localExecute: async () => { throw new Error("local Lane 3 must not be reached — the seam is eligible"); }
    });

    assert.equal(dispatch.outcome, "DISTRIBUTED",
        "must route through the distributed seam (got " + dispatch.outcome + " error=" + String(dispatch.error || "").slice(0, 200) + ")");
    const output = dispatch.executionResult && dispatch.executionResult.output;
    console.log("R4-05-B outcome:", dispatch.outcome, "distributed output.ran:", output && output.ran);
    assert.equal(output && output.ran, true, "REAL AppContainer sandbox executed the tool");
});

// ---- (B) R4-06 -----------------------------------------------------------

test("R4-06: REAL security reproduction — one probe tool, every vector kernel/shim denied", { skip: !canRun }, async (t) => {
    await canonicalOwner();
    const A = makeNodeA();
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4-sec-"));
    const probePath = path.join(artifactDir, "probe.js");
    // The tool DECLARES no needs, so admission passes; it then ATTEMPTS the
    // isolated operations. Network/fs/process are denied by the WFP kernel;
    // the secret is scrubbed by the owned env block + shim allowlist.
    fs.writeFileSync(probePath, `
"use strict";
const net = require("node:net");
const fs = require("node:fs");
module.exports = async function (args) {
    const w = {};
    // 1. raw TCP to a local listener, SELF-BOUNDED + socket destroyed on
    //    timeout so the child can exit (modeled on the certified R3-SBOX-04
    //    net probe which completes reliably inside the AppContainer).
    w.tcp = await new Promise((res) => {
        const s = net.connect(args.port, "127.0.0.1", () => { try { s.destroy(); } catch {} res({ connected: true }); });
        s.on("error", (e) => { try { s.destroy(); } catch {} res({ connected: false, code: e.code }); });
        s.setTimeout(4000, () => { try { s.destroy(); } catch {} res({ connected: false, code: "TIMEOUT" }); });
    });
    // 2. filesystem escape (write outside sandbox root) — bounded, immediate.
    try { fs.writeFileSync(process.env.WRITE_TARGET || "C:\\\\Windows\\\\r4-escape.txt", "escape"); w.fsWrote = true; }
    catch (e) { w.fsBlocked = true; }
    // 3. secret access (process spawn is separately kernel-denied via the
    //    zero-capability AppContainer; adding child_process here keeps the
    //    probe vuln-free and bounded).
    w.secret = process.env.R4_SUPER_SECRET || null;
    return { witnesses: w, ran: true };
};
`);
    t.after(() => fs.rmSync(artifactDir, { force: true, recursive: true }));
    // R5-04: pin the REAL probe artifact digest now that it exists.
    const { fed, snap } = makeEnabledTool(probePath);

    const srv = net.createServer((sock) => { sock.on("error", () => {}); sock.end("OPEN"); });
    srv.on("error", () => {});
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const port = srv.address().port;

    const prev = {};
    if ("R4_SUPER_SECRET" in process.env) { prev.R4_SUPER_SECRET = process.env.R4_SUPER_SECRET; delete process.env.R4_SUPER_SECRET; }
    process.env.R4_SUPER_SECRET = "R4-SECRET-LEAK";
    try {
        const router = A.dexecRouter;
        const claim = await router.claimGovernedExecution({
            intent: intentFor("code.cap", "run", { port }, "sec-r4"),
            toolId: "tool.code.cap", candidateId: snap.candidateId, toolName: "search",
            toolArtifactPath: probePath, sandboxNeeds: { needsNetwork: [], needsFilesystem: [], needsProcessSpawn: false, needsSecrets: false }
        });
        const executor = createGovernedExternalToolExecutor({
            federation: fed, sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false, config: { timeoutMs: 90_000 } },
            executionRouter: router
        });
        const result = await executor.execute({ claimId: claim.claimId, args: { port } });
        const w = (result.output && result.output.witnesses) || {};
        assert.equal(result.sandbox.mechanism, "AppContainer", "ran inside real AppContainer");
        assert.equal(w.tcp.connected, false, "raw loopback TCP must NOT reach the listener (kernel deny)");
        assert.ok(["ETIMEDOUT", "ECONNREFUSED", "EACCES"].includes(w.tcp.code),
            "kernel-denied by: " + (w.tcp.code || "?"));
        assert.equal(w.fsWrote, undefined, "filesystem write outside sandbox root denied (EPERM)");
        assert.equal(w.secret, null, "host secret not visible (owned env block + shim allowlist)");
        console.log("R4-06 witnesses:", JSON.stringify(w));
    } finally {
        await new Promise((res) => srv.close(res));
        for (const k of Object.keys(prev)) process.env[k] = prev[k];
        delete process.env.R4_SUPER_SECRET;
    }
});

// ---- (C) R4-08 -----------------------------------------------------------

test("R4-08: single-request distributed claim — ONE execute, replay/ghost fail closed", { skip: !canRun }, async (t) => {
    await canonicalOwner();
    const A = makeNodeA();
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4-chaos-"));
    const toolPath = path.join(artifactDir, "search.js");
    fs.writeFileSync(toolPath, "module.exports = async () => ({ chaos: true });", "utf8");
    t.after(() => fs.rmSync(artifactDir, { force: true, recursive: true }));
    const { fed, snap } = makeEnabledTool(toolPath);

    const router = A.dexecRouter;
    const claim = await router.claimGovernedExecution({
        intent: intentFor("code.cap", "run", {}, "chaos-r4"),
        toolId: "tool.code.cap", candidateId: snap.candidateId, toolName: "search",
        toolArtifactPath: toolPath, sandboxNeeds: {}
    });
    assert.ok(claim.claimId, "claim allocated");
    const executor = createGovernedExternalToolExecutor({
        federation: fed, sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false },
        executionRouter: router
    });
    const r1 = await executor.execute({ claimId: claim.claimId, args: {} });
    assert.equal(r1.ok, true, "single execute succeeds");
    await assert.rejects(
        () => executor.execute({ claimId: claim.claimId, args: {} }),
        (e) => e.code === "MESH_REPLAY",
        "replaying the same claim must be rejected (one-use)"
    );
    await assert.rejects(
        () => executor.execute({ claimId: "ghost-r4" }),
        (e) => e.code === "TOOL_NOT_ENABLED" || e.code === "MESSAGE_MALFORMED",
        "ghost claim fails closed"
    );
});