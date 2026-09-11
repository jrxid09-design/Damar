"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createTestWave6Lane3Facade, brandTestWave6Adapter, isCanonicalWave6ExecutionAdapter } = require("../../manager/productionHarness");
const { makeActuationHarness } = require("../../actuation/harness");
const { createDamarManagerComposition } = require("../../../src/manager/internal/managerBootstrap");
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
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_SUCCESS, verificationId: "v1" }), compensate: async () => ({}) }
        },
        trustedChannelAdapters: [],
        ...(wave6Distributed ? { wave6Distributed: brandTestWave6Adapter(wave6Distributed) } : {})
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

test("R3-04/R4-04: wave6Distributed seam rejects malformed + un-branded adapters", async () => {
    // Malformed (missing tryDistributed function) -> rejected by the test
    // harness brander (test-only composition privilege).
    await assert.rejects(
        () => makeFullManager({ wave6Distributed: { tryDistributed: "nope" } }),
        /requires \{ tryDistributed \}/
    );
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

test("R4-04: Manager composition rejects a duck-typed (un-branded) adapter — caller seam cannot reach it", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    // A caller-constructed duck-typed adapter is NEVER canonical: the Manager
    // composition itself rejects it at composition time (brand check).
    const duck = { tryDistributed: async () => ({ distributed: false }) };
    assert.equal(isCanonicalWave6ExecutionAdapter(duck), false,
        "duck-typed adapter must not be canonical before branding");
    assert.throws(() => createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_SUCCESS, verificationId: "v1" }), compensate: async () => ({}) }
        },
        trustedChannelAdapters: [],
        wave6Distributed: duck
    }), /BRANDED canonical Wave 6 execution adapter/, "composition must reject un-branded adapter (R4-04)");
});

test("R3-04: createTestWave6Lane3Facade validates members + disabled default", async () => {
    assert.throws(() => createTestWave6Lane3Facade({ route: 42 }), TypeError);
    assert.throws(() => createTestWave6Lane3Facade({ route: async () => null, claim: "no", execute: async () => ({}) }), TypeError);
    const d = createTestWave6Lane3Facade({});
    assert.equal(d.disabled, true);
    const out = await d.tryDistributed({ intent: {}, parameters: {} });
    assert.equal(out.distributed, false);
});