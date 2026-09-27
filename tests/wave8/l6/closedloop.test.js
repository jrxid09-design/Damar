"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createClosedLoop, createCompletionVerifier, PHASE, LOOP_ORDER, BOUNDS } = require("../../../src/cognition/closedloop");
const { createRuntimeCore } = require("../../../src/integration/canonicalRuntimeComposition");

function makeEvidence(records = {}) {
    return ({ probeId }) => (probeId in records ? records[probeId] : null);
}

function completion(overrides = {}) {
    return {
        outcome: "VERIFIED", probeId: "p-1", questionRef: "q-1", capabilityId: "cap-1",
        observation: { tier: "T4", sensor: { sensorId: "camera-1" }, frame: { kind: "ROOM" }, quality: 0.8 },
        ...overrides
    };
}

const REQUEST = { probeId: "p-1", questionRef: "q-1", capabilityId: "cap-1" };

test("W8-L6 completion: a verified canonical completion is accepted exactly once", () => {
    const evidence = makeEvidence({ "p-1": completion() });
    const verifier = createCompletionVerifier({ completionEvidence: evidence });
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: REQUEST, outcome: "SUCCESS", observation: completion().observation }), true);
    // Duplicate completion cannot charge or complete twice.
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: REQUEST, outcome: "SUCCESS", observation: completion().observation }), false);
});

test("W8-L6 completion: absent canonical evidence fails closed", () => {
    const verifier = createCompletionVerifier({ completionEvidence: makeEvidence({}) });
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: REQUEST, outcome: "SUCCESS", observation: completion().observation }), false);
});

test("W8-L6 completion: caller-substituted observation is rejected", () => {
    const evidence = makeEvidence({ "p-1": completion() });
    const verifier = createCompletionVerifier({ completionEvidence: evidence });
    const forged = { tier: "T4", sensor: { sensorId: "camera-1" }, frame: { kind: "ROOM" }, quality: 0.99 };
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: REQUEST, outcome: "SUCCESS", observation: forged }), false);
});

test("W8-L6 completion: wrong binding (questionRef/capabilityId) fails closed", () => {
    const evidence = makeEvidence({ "p-1": completion() });
    const verifier = createCompletionVerifier({ completionEvidence: evidence });
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: { probeId: "p-1", questionRef: "q-OTHER", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: completion().observation }), false);
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: { probeId: "p-1", questionRef: "q-1", capabilityId: "cap-OTHER" }, outcome: "SUCCESS", observation: completion().observation }), false);
});

test("W8-L6 completion: denial and timeout require matching owner-verified outcomes", () => {
    const denied = makeEvidence({ "p-d": { outcome: "DENIED", probeId: "p-d", questionRef: "q-1", capabilityId: "cap-1" } });
    const dv = createCompletionVerifier({ completionEvidence: denied });
    assert.equal(dv.verifyCompletion({ probeId: "p-d", request: { probeId: "p-d", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "DENIED" }), true);
    assert.equal(dv.verifyCompletion({ probeId: "p-d", request: { probeId: "p-d", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: completion().observation }), false);

    const timedOut = makeEvidence({ "p-t": { outcome: "TIMEOUT", probeId: "p-t", questionRef: "q-1", capabilityId: "cap-1" } });
    const tv = createCompletionVerifier({ completionEvidence: timedOut });
    assert.equal(tv.verifyCompletion({ probeId: "p-t", request: { probeId: "p-t", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "TIMEOUT" }), true);
    assert.equal(tv.verifyCompletion({ probeId: "p-t", request: { probeId: "p-t", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "DENIED" }), false);
});

test("W8-L6 completion: hostile inputs and unknown outcomes are refused without code execution", () => {
    const verifier = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-1": completion() }) });
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps++; throw new Error("must not inspect"); } });
    assert.equal(verifier.verifyCompletion(hostile), false);
    assert.equal(traps, 0);
    assert.equal(verifier.verifyCompletion(null), false);
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: REQUEST, outcome: "FORGED", observation: completion().observation }), false);
});

test("W8-L6 completion: a throwing evidence port fails closed", () => {
    const verifier = createCompletionVerifier({ completionEvidence: () => { throw new Error("boom"); } });
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: REQUEST, outcome: "SUCCESS", observation: completion().observation }), false);
});

test("W8-L6 loop: fixed order, bounded rate, and missing-stage honesty", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock });
    const phases = [];
    for (let i = 0; i < LOOP_ORDER.length; i++) {
        const report = loop.runCycle();
        phases.push(report.phase);
        now += 100;
    }
    assert.deepEqual(phases, LOOP_ORDER);
    assert.equal(loop.getPhase(), PHASE.UPDATE);
    assert.equal(loop.getLoopStatus().cycleCount, 1);
});

test("W8-L6 loop: loop rate is bounded", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock });
    loop.runCycle();
    now += 1;
    assert.throws(() => loop.runCycle(), { reason: "LOOP_RATE_EXCEEDED" });
});

test("W8-L6 loop: AUTHORIZE and VERIFY report degraded, never pretend authorization or verification", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock }); // no perceptionLane/effectors
    const reports = {};
    for (let i = 0; i < LOOP_ORDER.length; i++) {
        const r = loop.runCycle();
        reports[r.phase] = r;
        now += 100;
    }
    assert.equal(reports[PHASE.AUTHORIZE].degraded, "AUTHORIZE_UNAVAILABLE");
    assert.equal(reports[PHASE.VERIFY].degraded, "VERIFY_UNAVAILABLE");
    // AUTHORIZE/VERIFY are present in the sequence (never skipped), just degraded.
    assert.ok(LOOP_ORDER.includes(PHASE.AUTHORIZE));
    assert.ok(LOOP_ORDER.includes(PHASE.VERIFY));
});

test("W8-L6 loop: published bounds and laws match the frozen contract surface", () => {
    assert.deepEqual(BOUNDS, {
        MAX_LOOP_RATE_HZ: 20, MAX_CONCURRENT_LOOPS: 1, MAX_STAGES: 9,
        MAX_COMPLETION_RECORDS: 1024, MIN_LOOP_INTERVAL_MS: 50
    });
    const loop = createClosedLoop();
    assert.equal(loop.laws.ONE_FRESH_EVALUATION_PER_EFFECT, true);
    assert.equal(loop.laws.NO_SECOND_DISPATCHER, true);
    assert.equal(loop.laws.VERIFY_AUTHORIZE_NEVER_SILENTLY_SKIPPED, true);
});

test("W8-L6 integration: closedLoop is opt-in, composition-owned, and the L2 handoff stays fail-closed without canonical execution", async () => {
    const disabled = await createRuntimeCore({});
    assert.equal(disabled.closedLoop, null);
    disabled.shutdown();

    const core = await createRuntimeCore({
        enableCognition: true,
        cognitionMode: "shadow",
        cognitionCapabilityRegistry: { get: () => null, has: () => false, getAvailability: () => "UNKNOWN" },
        cognitionAuditLedger: { append() { return { ignored: true }; } }
    });
    try {
        assert.ok(core.closedLoop);
        assert.equal(typeof core.closedLoop.runCycle, "function");
        assert.equal(typeof core.closedLoop.getPhase, "function");
        assert.equal(typeof core.closedLoop.getLoopStatus, "function");
        assert.equal(typeof core.closedLoop.admitCanonicalProbeCompletion, "function");
        // A caller-shaped object is NOT canonical execution evidence; the
        // admission seam rejects it, so the L2 handoff remains fail-closed.
        const forged = { outcome: "EXECUTED_VERIFIED", result: { tier: "T4" } };
        assert.equal(core.closedLoop.admitCanonicalProbeCompletion({ probeId: "x", request: { questionRef: "q", capabilityId: "c" }, executionResult: forged }), false);
        assert.equal(core.perceptionLane, core.closedLoop !== null ? core.perceptionLane : null);
    } finally {
        core.shutdown();
    }
});
