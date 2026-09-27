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

test("W8-L6 completion: hostile observation getters are never invoked and never make the verifier throw", () => {
    const evidence = makeEvidence({ "p-1": completion() });
    const verifier = createCompletionVerifier({ completionEvidence: evidence });
    let traps = 0;
    const hostileObservation = {
        tier: "T4",
        sensor: { sensorId: "camera-1" },
        frame: { kind: "ROOM" },
        get quality() { traps++; return 0.8; }
    };
    // Accessors are rejected by descriptor read, so the getter is never run.
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: REQUEST, outcome: "SUCCESS", observation: hostileObservation }), false);
    assert.equal(traps, 0, "the hostile getter must never be invoked");
});

test("W8-L6 completion: a self-redefining getter cannot race the check-then-use path", () => {
    const evidence = makeEvidence({ "p-1": completion() });
    const verifier = createCompletionVerifier({ completionEvidence: evidence });
    const forged = {
        tier: "T4",
        sensor: { sensorId: "camera-1" },
        frame: { kind: "ROOM" },
        get quality() { Object.defineProperty(this, "quality", { value: 0.99, enumerable: true, configurable: true, writable: true }); return 0.8; }
    };
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: REQUEST, outcome: "SUCCESS", observation: forged }), false);
});

test("W8-L6 completion: request omitting questionRef/capabilityId is rejected even when evidence has them (P0 bidirectional binding)", () => {
    const evidence = makeEvidence({ "p-1": completion() });
    const verifier = createCompletionVerifier({ completionEvidence: evidence });
    // Omit questionRef and capabilityId from request — evidence has them; must still reject.
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: { probeId: "p-1" }, outcome: "SUCCESS", observation: completion().observation }), false);
});

test("W8-L6 completion: symbol-keyed extra properties in caller observation are rejected", () => {
    const evidence = makeEvidence({ "p-1": completion() });
    const verifier = createCompletionVerifier({ completionEvidence: evidence });
    const obs = Object.assign({}, completion().observation);
    obs[Symbol("forged")] = "extra";
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: REQUEST, outcome: "SUCCESS", observation: obs }), false);
});

test("W8-L6 completion: Proxy used as observation is rejected even when identical by reference", () => {
    const proxyObs = new Proxy({}, {});
    const verifier = createCompletionVerifier({ completionEvidence: () => ({ outcome: "VERIFIED", probeId: "p-proxy", questionRef: "q-1", capabilityId: "cap-1", observation: proxyObs }) });
    assert.equal(verifier.verifyCompletion({ probeId: "p-proxy", request: { probeId: "p-proxy", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: proxyObs }), false);
});

test("W8-L6 completion: evidence with undefined questionRef or capabilityId is rejected", () => {
    const evidenceNoBindings = { outcome: "VERIFIED", probeId: "p-1", questionRef: undefined, capabilityId: undefined, observation: completion().observation };
    const verifier = createCompletionVerifier({ completionEvidence: () => evidenceNoBindings });
    assert.equal(verifier.verifyCompletion({ probeId: "p-1", request: { probeId: "p-1" }, outcome: "SUCCESS", observation: completion().observation }), false);
});

test("W8-L6 completion: Proxy completionEvidence port is rejected at construction", () => {
    const proxyPort = new Proxy(() => null, {});
    assert.throws(() => createCompletionVerifier({ completionEvidence: proxyPort }), TypeError);
});

test("W8-L6 loop: accessor properties in createClosedLoop options are never invoked", () => {
    let traps = 0;
    const opts = {};
    Object.defineProperty(opts, "clock", { get() { traps++; return { nowMs: () => 0 }; }, configurable: true });
    const loop = createClosedLoop(opts);
    assert.ok(loop);
    assert.equal(traps, 0, "accessor on options must never be invoked");
});

test("W8-L6 completion: accessor properties in createCompletionVerifier options are never invoked (R3 P1-1)", () => {
    let traps = 0;
    const opts = {};
    Object.defineProperty(opts, "completionEvidence", { get() { traps++; return () => null; }, configurable: true });
    assert.throws(() => createCompletionVerifier(opts), TypeError);
    assert.equal(traps, 0, "accessor on completionEvidence option must never be invoked");
});

test("W8-L6 completion: deepEqual rejects objects with mismatched descriptor attributes (R3 P1-3)", () => {
    const evidence = makeEvidence({ "p-da": completion({ probeId: "p-da", observation: { x: 1 } }) });
    const verifier = createCompletionVerifier({ completionEvidence: evidence });
    // Non-writable property vs writable — same value, different descriptor, must reject.
    const obs = {};
    Object.defineProperty(obs, "x", { value: 1, writable: false, enumerable: true, configurable: true });
    assert.equal(verifier.verifyCompletion({ probeId: "p-da", request: { probeId: "p-da", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: obs }), false);
});

test("W8-L6 loop: proxied clock nowMs function is never called (R3 P1-4)", () => {
    let traps = 0;
    const proxyFn = new Proxy(() => 12345, { apply() { traps++; return 12345; } });
    const hostileClock = {};
    Object.defineProperty(hostileClock, "nowMs", { value: proxyFn, writable: true, enumerable: true, configurable: true });
    const loop = createClosedLoop({ clock: hostileClock });
    // safeNowMs must detect IS_PROXY(fn) and fall back to Date.now, never calling the proxy.
    assert.doesNotThrow(() => loop.runCycle());
    assert.equal(traps, 0, "proxied clock function must never be called");
});

test("W8-L6 loop: caller-supplied MIN_LOOP_INTERVAL_MS=0 is rejected and default enforced", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock, bounds: { ...BOUNDS, MIN_LOOP_INTERVAL_MS: 0 } });
    loop.runCycle();
    assert.throws(() => loop.runCycle(), { reason: "LOOP_RATE_EXCEEDED" });
});

test("W8-L6 loop: hostile clock getter is never invoked", () => {
    let traps = 0;
    const hostileClock = { get nowMs() { traps++; return () => Date.now(); } };
    const loop = createClosedLoop({ clock: hostileClock });
    assert.doesNotThrow(() => loop.runCycle());
    assert.equal(traps, 0, "hostile clock getter must never be invoked");
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

test("W8-L6 loop: AUTHORIZE and VERIFY always report degraded, never pretend authorization or verification", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock }); // no canonical authorized-intent/verification evidence
    const reports = {};
    for (let i = 0; i < LOOP_ORDER.length; i++) {
        const r = loop.runCycle();
        reports[r.phase] = r;
        now += 100;
    }
    assert.equal(reports[PHASE.AUTHORIZE].degraded, "AUTHORIZE_UNAVAILABLE");
    assert.equal(reports[PHASE.AUTHORIZE].present, false);
    assert.equal(reports[PHASE.VERIFY].degraded, "VERIFY_UNAVAILABLE");
    assert.equal(reports[PHASE.VERIFY].present, false);
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
        // There is NO public completion-admission seam: a caller cannot mint
        // completion evidence. The L2 handoff therefore stays fail-closed.
        assert.equal(core.closedLoop.admitCanonicalProbeCompletion, undefined);
        assert.equal(typeof core.perceptionLane.openQuestion, "function");
    } finally {
        core.shutdown();
    }
});
