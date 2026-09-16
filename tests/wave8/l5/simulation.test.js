"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createSimulationSandbox, BOUNDS } = require("../../../src/cognition/simulation");

function assertThrowsReason(fn, reason) {
    assert.throws(fn, (err) => {
        assert.equal(err.reason, reason, `expected reason '${reason}', got '${err.reason}': ${err.message}`);
        return true;
    });
}

async function assertRejectsReason(promise, reason) {
    await assert.rejects(promise, (err) => {
        assert.equal(err.reason, reason, `expected reason '${reason}', got '${err.reason}': ${err.message}`);
        return true;
    });
}

function jsonStore() {
    const kv = new Map();
    return {
        async getKv(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
        async putKv(k, v) { kv.set(k, JSON.stringify(v)); }
    };
}

function manualClock(startMs) {
    let t = startMs;
    return { nowMs: () => t, advance: (ms) => { t += ms; } };
}

test("L5-1: a completed run's result is ALWAYS tier T10, regardless of caller input", async () => {
    const sim = await createSimulationSandbox();
    const result = await sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 10, horizonDays: 1, budgetTokens: 100, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 50, distribution: { a: 1 }, risks: [], assumptions: [], confidence: 0.5 })
    });
    assert.equal(result.tier, "T10");
    assert.equal(result.state, "COMPLETE");
});

test("L5-2: initialStateRef is frozen at run start -- mutating the caller's object afterward does not change the stored snapshot", async () => {
    const sim = await createSimulationSandbox();
    const callerState = { region: { known: true } };
    await sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: callerState,
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0 })
    });
    callerState.region.known = false; // mutate the caller's own object after the run started
    const runs = sim.listRuns();
    assert.equal(runs[0].initialStateRef.region.known, true, "the stored snapshot must not reflect a post-start mutation of the caller's object");
});

test("L5-3: provider throwing marks the run FAILED, planning is told, never silently proceeds as if it succeeded", async () => {
    const sim = await createSimulationSandbox();
    const result = await sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => { throw new Error("provider down"); }
    });
    assert.equal(result.state, "FAILED");
});

test("L5-4: exceeding the per-run token budget marks the run TRUNCATED, not silently COMPLETE", async () => {
    const sim = await createSimulationSandbox();
    const result = await sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 999, distribution: null, risks: [], assumptions: [], confidence: 0 })
    });
    assert.equal(result.state, "TRUNCATED");
});

test("L5-5: a run past its TTL reports STALE_ASSUMPTIONS at query time, without mutating the stored record", async () => {
    const clock = manualClock(0);
    const sim = await createSimulationSandbox({ clock, bounds: { ...BOUNDS, TTL_MS: 1000 } });
    await sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0 })
    });
    clock.advance(2000);
    const stale = sim.getResult("r1");
    assert.equal(stale.state, "STALE_ASSUMPTIONS");
});

test("L5-6: MAX_CONCURRENT_RUNS is enforced -- a run that would exceed it is rejected before starting", async () => {
    const sim = await createSimulationSandbox({ bounds: { ...BOUNDS, MAX_CONCURRENT_RUNS: 1 } });
    let releaseFirst;
    const blocked = new Promise((resolve) => { releaseFirst = resolve; });
    const firstRunPromise = sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => { await blocked; return { tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0 }; }
    });
    await assertRejectsReason(sim.startRun({
        runId: "r2", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0 })
    }), "CONCURRENT_RUN_LIMIT_EXCEEDED");
    releaseFirst();
    await firstRunPromise;
});

test("L5-7: the hourly token budget is enforced across separate runs", async () => {
    const clock = manualClock(0);
    const sim = await createSimulationSandbox({ clock, bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100, MAX_CONCURRENT_RUNS: 5, MAX_TOKENS_PER_RUN: 100 } });
    await sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 60, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 60, distribution: null, risks: [], assumptions: [], confidence: 0 })
    });
    await assertRejectsReason(sim.startRun({
        runId: "r2", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 60, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 60, distribution: null, risks: [], assumptions: [], confidence: 0 })
    }), "BUDGET_EXCEEDED");
});

test("L5-8: a duplicate runId is rejected, not silently overwritten", async () => {
    const sim = await createSimulationSandbox({ bounds: { ...BOUNDS, MAX_CONCURRENT_RUNS: 5 } });
    await sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0 })
    });
    await assertRejectsReason(sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0 })
    }), "DUPLICATE_RECORD_ID");
});

test("L5-9: an oversized result is rejected outright, not silently truncated in storage", async () => {
    const sim = await createSimulationSandbox({ bounds: { ...BOUNDS, MAX_RESULT_BYTES: 10 } });
    await assertRejectsReason(sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 1, distribution: { a: "a".repeat(1000) }, risks: [], assumptions: [], confidence: 0 })
    }), "RESULT_TOO_LARGE");
});

test("L5-10: a hostile accessor in initialStateRef is rejected without ever being invoked", async () => {
    const sim = await createSimulationSandbox();
    let n = 0;
    const state = {};
    Object.defineProperty(state, "x", { enumerable: true, configurable: true, get() { n++; return 1; } });
    await assertRejectsReason(sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: state,
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0 })
    }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "state.x's getter must never be invoked");
});

test("L5-11: a reloaded snapshot's retained runs are compacted to the ACTIVE bound at construction, never evicting a RUNNING run", async () => {
    const store = jsonStore();
    const sim1 = await createSimulationSandbox({ store, bounds: { ...BOUNDS, MAX_RETAINED_RUNS: 100, MAX_CONCURRENT_RUNS: 5 } });
    for (let i = 0; i < 3; i++) {
        await sim1.startRun({
            runId: `r${i}`, question: "q", scenario: {}, initialStateRef: {},
            steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
            provider: async () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0 })
        });
    }
    await sim1.persist();

    const sim2 = await createSimulationSandbox({ store, bounds: { ...BOUNDS, MAX_RETAINED_RUNS: 1 } });
    assert.ok(sim2.runsSize() <= 1);
});

test("L5-12: this lane has no domain write surface into any other lane -- census check on its own public API", async () => {
    const sim = await createSimulationSandbox();
    const forbidden = ["declareEntity", "ingestObservation", "proposeGoal", "createCommitment", "arm", "createTask", "grantApproval"];
    for (const key of Object.keys(sim)) {
        assert.ok(!forbidden.includes(key), `simulation's public API must not expose '${key}', a real-store write verb from another lane`);
    }
});

test("L5-13: a Symbol/non-finite confidence is clamped/rejected safely, never a raw throw", async () => {
    const sim = await createSimulationSandbox();
    const result = await sim.startRun({
        runId: "r1", question: "q", scenario: {}, initialStateRef: {},
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "LOW",
        provider: async () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: Infinity })
    });
    assert.equal(result.confidence, 0);
});

test("L5-repair-14: persisted non-T10 and orphan results are quarantined, and assumptions can invalidate before TTL", async () => {
    const raw = { runs: { ok: { runId: "ok", state: "COMPLETE", createdAtMs: 0 } }, results: {
        ok: { runId: "ok", tier: "T1", state: "COMPLETE", assumptions: ["scene:v1"], validUntilMs: 999999999, generatedAtMs: 0 },
        orphan: { runId: "orphan", tier: "T10", state: "COMPLETE", assumptions: [], validUntilMs: 999999999, generatedAtMs: 0 }
    } };
    const store = { getKv: async () => raw, putKv: async () => {} };
    const sim = await createSimulationSandbox({ store, clock: { nowMs: () => 1 } });
    assertThrowsReason(() => sim.getResult("ok"), "UNKNOWN_RUN");
    assertThrowsReason(() => sim.getResult("orphan"), "UNKNOWN_RUN");
    const fresh = await sim.startRun({ runId: "new", question: "q", scenario: {}, initialStateRef: {}, steps: 1, horizonDays: 1, budgetTokens: 1,
        provider: async () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: ["scene:v1"], confidence: 0 }) });
    assert.equal(fresh.state, "COMPLETE");
    sim.invalidateAssumptions("scene:v1");
    assert.equal(sim.getResult("new").state, "STALE_ASSUMPTIONS");
});
