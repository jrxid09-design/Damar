"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestWave6Lane3Facade, isCanonicalWave6ExecutionAdapter } = require("../../manager/productionHarness");
const { makeActuationHarness } = require("../../actuation/harness");
const { createDamarManagerComposition } = require("../../../src/manager/internal/managerBootstrap");
const { createDamarManager } = require("../../../src/manager/bootstrap");
const { VERIFICATION_STATE } = require("../../../src/action/verification/errors");
const { CHANNEL_TYPES, OUTCOME } = require("../../../src/manager");

/**
 * W6-R3-04/05/06 — CANONICAL MANAGER → WAVE 6 LANE-3 SEAM (real decision point).
 *
 * The REAL production Manager (createDamarManagerComposition, same code used
 * by src/manager/bootstrap.js) is composed over the sanctioned actuation
 * harness: capability registered + granted to principal "alice", actuator +
 * verifier wired. A narrow `wave6Distributed` seam is threaded via the SAME
 * composition the production RuntimeHost wires
 * (buildRuntimeCoreInternal → createDamarManagerIngressDomain → composition).
 * When the intent is AUTHORIZED (Lane 2 ALLOW), the Manager's Lane-3 boundary
 * prefers the Wave 6 distributed seam; otherwise it uses the frozen local
 * Lane 3 default. This mirrors security.test.js test "14" (the certified LANE
 * 5 fabric invocation pattern) — no parallel object graph.
 */

function lane4Bindings() {
    const read = (a) => (a && a.target ? [a.target.trim().toLowerCase()] : []);
    const write = (a) => {
        const p = a && (a.path ?? a.target);
        const s = typeof p === "string" ? p.trim().toLowerCase() : "";
        return s ? [s] : [];
    };
    return { "fs.cap": { read, write }, "fs.restore": { write, read } };
}

const REQUEST_INPUT = (overrides = {}) => ({
    channelType: CHANNEL_TYPES.CONSOLE,
    channelId: "console",
    sessionId: "sess-alice",
    correlationId: "corr-1",
    receivedAtMs: 1_000_000,
    ...overrides
});

function authAlice(lane3) {
    return (evidence) => lane3.lane2.authDomain.authenticate({
        ...(evidence ?? {}), claimedPrincipal: "alice"
    });
}

async function makeFullManager({ wave6Distributed = null, lane3LocalCalls = null } = {}) {
    // SAME pattern as manager/security.test.js test 14: authorized action.
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => { if (lane3LocalCalls) lane3LocalCalls.push("act"); return { ok: true }; }
    });
    // R5-02: the distributed seam is wired through the TRUSTED-INTERNAL
    // composition parameter `wave6Adapter`. The public ingress never accepts it;
    // tests drive the internal composition directly (test-only composition
    // privilege). The adapter is passed UNBRANDED — R5-02 removed the production
    // branding primitive entirely.
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_SUCCESS, verificationId: "v1" }), compensate: async () => ({}) }
        },
        trustedChannelAdapters: [],
        ...(wave6Distributed ? { wave6Adapter: wave6Distributed } : {})
    });
    return { manager, lane3 };
}

function actionRequest() {
    return REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }, expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } } }
    });
}

test("R3-04: default (no seam) — authorized intent reaches LOCAL Lane 3 (frozen path)", async () => {
    const lane3Local = [];
    const { manager } = await makeFullManager({ lane3LocalCalls: lane3Local });
    const r = await manager.handle(actionRequest());
    assert.equal(r.outcome, OUTCOME.COMPLETED, "authorized local intent completes through fabric");
    assert.equal(lane3Local.length, 1, "local Lane 3 actuator invoked exactly once");
    void r;
});

test("R3-04: Wave 6 seam present — authorized intent routes through DISTRIBUTED lane-3", async () => {
    const claims = [];
    const executes = [];
    const lane3Local = [];
    const wave6 = createTestWave6Lane3Facade({
        route: async (intent) => ({ targetNodeId: "dnode-b", toolId: "tool.fs", sandboxNeeds: {}, toolArtifactPath: null }),
        claim: async ({ intent }) => { claims.push(intent.capabilityId); return "dclaim-r3"; },
        execute: async ({ claimId }) => { executes.push(claimId); return { executionId: "dexec-r3", output: { ok: true }, decisionDigest: "d".repeat(64) }; }
    });
    const { manager } = await makeFullManager({ wave6Distributed: wave6, lane3LocalCalls: lane3Local });
    const r = await manager.handle(actionRequest());
    assert.equal(claims.length, 1, "Seam claim invoked exactly once for the authorized intent");
    assert.equal(executes.length, 1, "Seam execute invoked exactly once");
    assert.equal(lane3Local.length, 0, "local Lane 3 must NOT be used when the seam claims it");
    assert.equal(r.outcome, OUTCOME.COMPLETED, "Manager still verifies + completes after distributed execution");
    void r;
});

test("R3-04: Wave 6 seam ineligible — Manager falls back to local Lane 3", async () => {
    const lane3Local = [];
    const wave6 = createTestWave6Lane3Facade({
        route: async () => null,
        claim: async () => "x",
        execute: async () => ({})
    });
    const { manager } = await makeFullManager({ wave6Distributed: wave6, lane3LocalCalls: lane3Local });
    const r = await manager.handle(actionRequest());
    assert.equal(lane3Local.length, 1, "local Lane 3 actuator invoked when Wave 6 ineligible");
    assert.equal(r.outcome, OUTCOME.COMPLETED);
    void r;
});

test("R3-04: Wave 6 claim failure — Manager reports FAILED (no silent local double-execute)", async () => {
    const lane3Local = [];
    const wave6 = createTestWave6Lane3Facade({
        route: async () => ({ targetNodeId: "dnode-b", toolId: "tool.fs" }),
        claim: async () => null,
        execute: async () => ({})
    });
    const { manager } = await makeFullManager({ wave6Distributed: wave6, lane3LocalCalls: lane3Local });
    const r = await manager.handle(actionRequest());
    assert.equal(lane3Local.length, 0, "no local execution after a distributed claim failure");
    assert.notEqual(r.outcome, OUTCOME.COMPLETED, "must not complete via local fallback after distributed failure");
    void r;
});

test("R4-04/R5-02: public Manager ingress does NOT accept a wave6Distributed option (seam removed)", async () => {
    // R5-02 STEP 3: createDamarManagerIngressDomain has no wave6Distributed
    // parameter and never installs/forwards a caller-supplied adapter. The only
    // canonical Lane-3 seam is the trusted-internal composition param; there is
    // no public surface that captures it.
    const mb = require("../../../src/manager/bootstrap");
    assert.equal(typeof mb.createDamarManagerIngressDomain, "function");
    // A caller-supplied duck-typed adapter must NOT be canonical (brand primitive
    // removed).
    const duck = { tryDistributed: async () => ({ distributed: false }) };
    assert.equal(isCanonicalWave6ExecutionAdapter(duck), false,
        "duck-typed adapter must not be canonical (brand primitive removed)");
    assert.equal(mb.installCanonicalWave6Seam, undefined,
        "installCanonicalWave6Seam mutator is absent from the public manager surface (R5-02)");
    void duck;
});

test("R5-02: public createDamarManager() rejects ANY options (no caller seam)", async () => {
    assert.throws(() => createDamarManager({ wave6Distributed: { tryDistributed: async () => ({ distributed: false }) } }),
        /canonical manager creation accepts NO options/,
        "canonical Manager creation is zero-argument; no caller adapter option is accepted");
});

test("R4-04: public RuntimeHost / RuntimeCore REJECT a caller-supplied wave6Distributed option", async () => {
    const { createRuntimeHost } = require("../../../src/runtime/host/runtimeHost");
    const { createRuntimeCore } = require("../../../src/integration/canonicalRuntimeComposition");
    await assert.rejects(
        () => createRuntimeHost({ wave6Distributed: { tryDistributed: async () => ({ distributed: false }) } }),
        /HOST_WAVE6_DISTRIBUTED_REJECTED/,
        "public RuntimeHost must reject a caller-supplied seam (R4-04)"
    );
    await assert.rejects(
        () => createRuntimeCore({ wave6Distributed: { tryDistributed: async () => ({ distributed: false }) } }),
        /HOST_WAVE6_DISTRIBUTED_REJECTED/,
        "public RuntimeCore must reject a caller-supplied seam (R4-04)"
    );
});

test("R4-04: production facade no longer exports createWave6Lane3Facade", () => {
    const prod = require("../../../src/integration/wave6Production");
    assert.equal(typeof prod.createWave6Lane3Facade, "undefined",
        "wave6Production must NOT export the caller callback facade (R4-04)");
    const managerBootstrap = require("../../../src/manager/bootstrap");
    assert.equal(typeof managerBootstrap.installCanonicalWave6Seam, "undefined",
        "manager public surface must NOT export installCanonicalWave6Seam (R4-04)");
    assert.equal(typeof managerBootstrap.createWave6Lane3Facade, "undefined");
});

test("R5-02: a caller-controlled adapter cannot reach Manager Lane-3 (no public seam)", async () => {
    // The Manager's Lane-3 distributed seam is a TRUSTED-INTERNAL composition
    // parameter (wave6Adapter). It is NOT exposed on any public Manager/RuntimeHost
    // surface, so a caller-constructed duck-typed / prototype-forged adapter can
    // never occupy it. The internal composition accepts it ONLY when driven by a
    // test-only harness (composition-time privilege), never from a request.
    const duck = { tryDistributed: async () => ({ distributed: false }) };
    const protoDuck = Object.create({ tryDistributed: async () => ({ distributed: false }) });
    assert.equal(isCanonicalWave6ExecutionAdapter(duck), false,
        "duck-typed adapter is not canonical (no brandable mutator exports)");
    assert.equal(isCanonicalWave6ExecutionAdapter(protoDuck), false,
        "prototype-forged adapter is not canonical");
    // Public bootstrap surfaces do not carry an adapter slot:
    assert.equal(typeof createDamarManager, "function");
    assert.equal(createDamarManager.length, 0, "createDamarManager takes no parameters (no adapter slot)");
    const mb = require("../../../src/manager/bootstrap");
    assert.equal(mb.installCanonicalWave6Seam, undefined,
        "installCanonicalWave6Seam mutator is absent from the public manager surface (R5-02)");
    void duck; void protoDuck;
});

test("R3-04: createTestWave6Lane3Facade validates members + disabled default", async () => {
    assert.throws(() => createTestWave6Lane3Facade({ route: 42 }), TypeError);
    assert.throws(() => createTestWave6Lane3Facade({ route: async () => null, claim: "no", execute: async () => ({}) }), TypeError);
    const d = createTestWave6Lane3Facade({});
    assert.equal(d.disabled, true);
    const out = await d.tryDistributed({ intent: {}, parameters: {} });
    assert.equal(out.distributed, false);
});