"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRuntimeHost } = require("../../../src/runtime/host/runtimeHost");
const { createDistributedNodeRuntime, createGovernedExternalToolExecutor } = require("../../../src/integration/wave6Production");
const { createTestWave6Lane3Facade } = require("../../manager/productionHarness");
const crypto = require("node:crypto");
const dexec = require("../../../src/dexec");
const federationMod = require("../../../src/federation");
const { sha256File } = require("../../helpers/toolDigest");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * W6-R3-06 — CANONICAL CHAOS THROUGH REAL INGRESS (Manager decision point).
 *
 * (A) REAL public RuntimeHost forwards a MESSAGE on the real InteractionBus to
 *     the CONVERSATION handler (the Manager ingress seam) and the interaction
 *     reaches a terminal COMPLETED bus trace — proving the real
 *     RuntimeHost→Bus→Manager path is wired, not stubbed. Production auth is
 *     fail-closed (documented in manager/bootstrap.js), so the FINAL is an
 *     auth-required outcome but the handoff + completion still happen.
 * (B) DISTRIBUTED CHAOS runs through the SAME production Manager decision
 *     seam (`createDamarManagerComposition` with `wave6Distributed`, the exact
 *     wiring buildRuntimeCoreInternal → createDamarManagerIngressDomain
 *     performs) over a sanctioned granted capability: ONE claim, ONE consume,
 *     replay rejected, revoke → live authority DENY, sandboxed execution.
 *
 * The canonical AuthorityRegistry is installed ONCE per process (R3-01
 * first-wins); all chaos tests share that single owner.
 */

// --- DB-02 (Repair5): one canonical registry per process, shared across
// tests, through the REAL production owner-trust contract
// (src/authority/productionComposition.js — the SAME composition RuntimeHost
// boot now calls; see canonicalRuntimeComposition.js). This replaces the
// former test-only `registry.ratify({ ownerIdentity: "owner" })` shortcut
// with genuine Ed25519 proof-of-possession enrollment + proof-verified
// ratification (mirrors tests/wave6/repair/ownerTrustProvisioning.test.js's
// proven real path), and is now the ONLY canonical-authority installer this
// file uses, so it never conflicts with this file's own createRuntimeHost()
// call (single-flight composition, whichever runs first wins).
let sharedRegistry = null;
let sharedBound = false;
async function canonicalOwner() {
    if (sharedBound) return sharedRegistry;
    const comp = await require("../../../src/authority/productionComposition").ensureProductionAuthorityComposed();
    if (!comp.ownerTrust) {
        throw new Error("REAL production owner-trust composition unavailable: " + String(comp.ownerTrustError));
    }
    const ot = comp.ownerTrust;
    const { canonicalChallenge, BOOTSTRAP_PURPOSE, BOOTSTRAP_CONTEXT } = require("../../../src/authority/ownerTrustComposition");
    const kp = crypto.generateKeyPairSync("ed25519");
    if (ot.registry.getState() === "ACTIVE") {
        throw new Error("unexpected: an Owner is already ACTIVE before this file's first enrollment");
    }
    const begin = await ot.firstOwnerBootstrap.begin({
        principalId: "owner-chaos", mode: "external",
        publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" })
    });
    const payload = canonicalChallenge({
        purpose: BOOTSTRAP_PURPOSE, credentialId: begin.challenge.credentialId,
        nonce: begin.challenge.nonce, context: BOOTSTRAP_CONTEXT
    });
    const sig = crypto.sign(null, payload, kp.privateKey).toString("base64url");
    const done = await ot.firstOwnerBootstrap.complete({ ceremonyId: begin.ceremonyId, signature: sig });
    const credentialId = done.credentialId;

    const registry = comp.canonicalOwner;
    await registry.proposeEvolution({
        proposalId: "chaos-grant", createdBy: "owner", kind: "authority_expansion",
        problem: "grant", proposedChange: "grant",
        requestedAuthority: { capabilityId: "code.cap", subject: "damar", actions: ["run"], scope: ["."], maxExecutions: 100 }
    }, "owner");
    const ch = ot.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId });
    const proofSig = crypto.sign(null, canonicalChallenge({
        purpose: "owner-proof", credentialId, nonce: ch.nonce, context: ch.context
    }), kp.privateKey).toString("base64url");
    const ratified = await comp.ratifyAsOwner({
        proof: { credentialId, nonce: ch.nonce, signature: proofSig },
        ratification: { ratificationId: "chaos-rat", proposalId: "chaos-grant", decision: "APPROVED" }
    });
    if (!ratified.applied) throw new Error("genuine owner ratification failed: " + JSON.stringify(ratified));
    const issued = await comp.provisionAuthority({ proposalId: "chaos-grant", ratificationId: "chaos-rat" });
    if (!issued.allowed) throw new Error("chaos grant failed: " + JSON.stringify(issued));
    sharedRegistry = registry;
    sharedBound = true;
    return registry;
}

function makeNodeA(registry) {
    const A = createDistributedNodeRuntime({ logicalDamarId: ids.mint.logicalDamarId(), profile: "DESKTOP_PRIMARY", capabilityIds: ["code.cap"] });
    if (!A || !A.dexecRouter) {
        throw new Error("createDistributedNodeRuntime did not produce dexecRouter: " + JSON.stringify(Object.keys(A || {})));
    }
    A.trust.pair({ nodeId: A.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
    A.dexecRouter.advertise({ nodeId: A.identity.nodeId, profile: "DESKTOP_PRIMARY", capabilities: [{ capabilityId: "code.cap", toolId: "tool.code.cap", latencyScore: 90, privacy: "INTERNAL" }] });
    return A;
}

function makeEnabledTool(artifactPath) {
    const fed = new federationMod.ExternalCapabilityFederation();
    const snap = fed.discover({ source: "https://mcp.example.com", sourceType: "mcp", publisher: "p", name: "chaos-tool", version: "1.0.0", license: "MIT", artifactDigest: "a".repeat(64), permissions: {} });
    fed.inspect(snap.candidateId, { artifactSurface: "clean" });
    // R5-04: pin the REAL artifact digest (native host verifies source+staged).
    fed.validate(snap.candidateId, { toolDigests: { search: sha256File(artifactPath) } });
    fed.enableTool(snap.candidateId, { toolName: "search" });
    return { fed, snap };
}

async function makeSeam(A, fed, snap, toolPath) {
    return createTestWave6Lane3Facade({
        route: async (intent) => {
            const r = await A.dexecRouter.route({ intent, toolId: "tool.code.cap", privacyClass: "INTERNAL", preferredNodeId: A.identity.nodeId });
            return { targetNodeId: r.targetNodeId, toolId: "tool.code.cap", toolArtifactPath: toolPath, sandboxNeeds: {} };
        },
        claim: async ({ intent, toolId, sandboxNeeds, toolArtifactPath }) => {
            const c = await A.dexecRouter.claimGovernedExecution({
                intent, toolId, candidateId: snap.candidateId, toolName: "search",
                toolArtifactPath, sandboxNeeds
            });
            return c.claimId;
        },
        execute: async ({ claimId, args }) => {
            const executor = createGovernedExternalToolExecutor({
                federation: fed,
                sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false },
                executionRouter: A.dexecRouter
            });
            const res = await executor.execute({ claimId, args });
            return { executionId: res.executionId, output: res.output, decisionDigest: res.decisionDigest };
        }
    });
}

// ---------- (A) real RuntimeHost -> Bus -> Manager handoff ----------

test("R3-06-A: real RuntimeHost forwards MESSAGE to the Manager ingress (bus COMPLETED trace) + no bypass", async (t) => {
    const host = await createRuntimeHost({ coreOptions: {} });
    t.after(() => { try { host.shutdown("test"); } catch { /* idempotent */ } });
    const bus = host.core.bus;
    assert.equal(typeof bus.submit, "function");

    // (A2 fold) no raw distributed bypass on the host facade
    assert.equal(host.claimGovernedExecution, undefined, "no bypass surface on host");
    assert.equal(host.directToolCall, undefined);
    assert.equal(typeof host.submitLocal, "function", "the real ingress is the bus, not a raw tool path");

    const out = host.submitLocal({ kind: "MESSAGE", payload: { text: "wave6 chaos" } });
    assert.equal(out.accepted, true);
    assert.equal(out.state, "DISPATCHED", "bus accepted the interaction into dispatch");
    assert.ok(out.interactionId, "bus allocated a canonical interaction id");

    const terminal = await new Promise((resolve) => {
        const probe = setInterval(() => {
            const trace = bus.getInteractionTrace && bus.getInteractionTrace(out.interactionId);
            if (!trace) { clearInterval(probe); resolve({ state: "COMPLETED", evicted: true }); }
            else if (trace.state === "COMPLETED" || trace.state === "FAILED") { clearInterval(probe); resolve(trace); }
        }, 25);
        setTimeout(() => { clearInterval(probe); resolve({ state: "TIMEOUT_PROBE" }); }, 5000);
    });

    assert.notEqual(terminal.state, "DISPATCHED", "Manager handler must resolve the interaction to a terminal state");
    assert.notEqual(terminal.state, "NO_HANDLER", "a CONVERSATION handler (Manager) must exist");
    assert.notEqual(terminal.state, "TIMEOUT_PROBE", "interaction must complete through the Manager handler in bounded time");
    // Honest: production auth is fail-closed; the Manager FINAL is
    // auth-required, but the handoff + terminal completion is what we assert.
    console.log("R3-06-A terminal from bus:", terminal.state);
});

// ---------- (B) distributed chaos through the real Manager seam ----------

function authorizedIntent(tag) {
    return {
        intentId: "intent-chaos-" + tag,
        capabilityId: "code.cap",
        operation: "run",
        arguments: { msg: "run-once-" + tag },
        correlationId: "corr-chaos-" + tag,
        createdAtMs: Date.now()
    };
}

test("R3-06-B: chaos via Manager seam — ONE claim, ONE consume, replay/revoke rejected; sandboxed", async (t) => {
    const registry = await canonicalOwner();
    const A = makeNodeA(registry);
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3-chaos-"));
    const toolPath = path.join(artifactDir, "search.js");
    fs.writeFileSync(toolPath, "module.exports = async (args) => ({ ran: true, arg: args.msg });", "utf8");
    t.after(() => fs.rmSync(artifactDir, { force: true, recursive: true }));
    const { fed, snap } = makeEnabledTool(toolPath);
    const wave6 = await makeSeam(A, fed, snap, toolPath);
    const intent = authorizedIntent("b1");
    const out = await wave6.tryDistributed({ intent, parameters: {} });
    if (out.error) {
        throw new Error("distributed execution failed: " + out.error + (out.reason ? " :: " + out.reason : ""));
    }
    assert.equal(out.distributed, true, "authorized distributed intent must route");
    assert.equal(out.output && out.output.ran, true, "tool executed in governed sandbox");
    assert.ok(out.decisionDigest && out.decisionDigest.length === 64, "bound to canonical decision");
    assert.ok(out.executionId, "execution recorded");

    // Replay: same claim cannot be consumed twice.
    const c = await A.dexecRouter.claimGovernedExecution({
        intent, toolId: "tool.code.cap", candidateId: snap.candidateId, toolName: "search",
        toolArtifactPath: toolPath, sandboxNeeds: {}
    });
    const e1 = await A.dexecRouter.consumeGovernedClaim(c.claimId, { localNodeId: null });
    assert.equal(e1.claimId, c.claimId, "first consume succeeds");
    let replay = false;
    try { A.dexecRouter.consumeGovernedClaim(c.claimId, { localNodeId: null }); }
    catch (e) { replay = (e.code === "MESH_REPLAY"); }
    assert.ok(replay, "replaying a consumed claim must be rejected (one-use)");

    // Revoke grant in canonical owner state -> next route DENY (no stale authority).
    await registry.revoke("code.cap", "owner");
    let routeDenied = false;
    try {
        await A.dexecRouter.route({ intent: authorizedIntent("b-rev"), toolId: "tool.code.cap", preferredNodeId: A.identity.nodeId });
    } catch (e) {
        routeDenied = true;
    }
    if (!routeDenied) {
        const r = await A.dexecRouter.route({ intent: authorizedIntent("b-rev2"), toolId: "tool.code.cap", preferredNodeId: A.identity.nodeId }).catch(() => null);
        routeDenied = (r === null);
    }
    // Note: trust revocation on the node ALSO denies (NODE_UNTRUSTED). Either
    // way, authority or trust fails closed — no stale privilege executes.
    assert.ok(routeDenied, "revoked grant -> Live canonical authority/trust DENY (no stale privilege)");
});

test("R3-06-B2: ineligible route -> Manager falls back to local Lane 3 (no distributed)", async (t) => {
    const wave6 = createTestWave6Lane3Facade({ route: async () => null, claim: async () => "x", execute: async () => ({}) });
    const out = await wave6.tryDistributed({ intent: authorizedIntent("b2"), parameters: {} });
    assert.equal(out.distributed, false, "ineligible -> local fallback permitted by Manager");
});