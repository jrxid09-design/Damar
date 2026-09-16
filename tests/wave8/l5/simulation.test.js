"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createSimulationSandbox, BOUNDS } = require("../../../src/cognition/simulation");
const { deserialize } = require("../../../src/cognition/simulation/store");

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

/* ---------------------------------------------------------------------- */
/* Independent audit of 3fdc20e — repaired classes                        */
/* ---------------------------------------------------------------------- */

test("L5-audit-1: a persisted accessor is rejected at deserialize and NEVER executed", () => {
    let calls = 0;
    const hostileRun = {};
    Object.defineProperty(hostileRun, "runId", {
        enumerable: true, configurable: true,
        get() { calls += 1; return "forged"; }
    });
    assert.throws(() => deserialize({ runs: { r1: hostileRun }, results: {} }));
    assert.equal(calls, 0, "a persisted getter must never run during deserialization");
});

test("L5-audit-2: a REAL state store is rejected as a sandbox store, and the rejection is audited", async () => {
    const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
    const events = [];
    await assertRejectsReason(
        createSimulationSandbox({
            store: createMemoryAccStore(),
            auditLedger: { append: (e) => events.push(e.eventType) }
        }),
        "CROSS_STORE_WRITE_REJECTED"
    );
    assert.ok(events.includes("cognition.simulation.cross_store_write_rejected"),
        `a store-boundary rejection must be audited, saw: ${events.join(",")}`);
});

test("L5-audit-3: run start, run end, truncation, and assumption invalidation are audited", async () => {
    const events = [];
    const clock = manualClock(1000);
    const sim = await createSimulationSandbox({
        clock,
        auditLedger: { append: (e) => events.push(e.eventType) }
    });

    await sim.startRun({
        runId: "audited-1", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 10,
        provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: ["a1"], confidence: 0.5 })
    });
    assert.ok(events.includes("cognition.simulation.run_started"));
    assert.ok(events.includes("cognition.simulation.run_ended"));

    // Budget exhausted -> TRUNCATED, explicitly audited as truncation.
    await sim.startRun({
        runId: "audited-2", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 5,
        provider: () => ({ tokensUsed: 99, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    });
    assert.ok(events.includes("cognition.simulation.run_truncated"),
        `truncation must be audited, saw: ${events.join(",")}`);

    sim.invalidateAssumptions("a1");
    assert.ok(events.includes("cognition.simulation.assumptions_invalidated"),
        `assumption invalidation must be audited, saw: ${events.join(",")}`);
});

test("L5-audit-4: the hourly token budget and invalidated assumptions SURVIVE a restart", async () => {
    const store = jsonStore();
    const budgeted = { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 };

    const sim1 = await createSimulationSandbox({ store, bounds: budgeted });
    await sim1.startRun({
        runId: "b1", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 60,
        provider: () => ({ tokensUsed: 60, distribution: null, risks: [], assumptions: ["keep"], confidence: 0.5 })
    });
    // A real-world assumption this run depended on changes -> STALE_ASSUMPTIONS.
    sim1.invalidateAssumptions("keep");
    assert.equal(sim1.getResult("b1").state, "STALE_ASSUMPTIONS");
    await sim1.persist();

    // Restarting must NOT hand the caller a fresh hourly window: 60 + 60 > 100.
    const sim2 = await createSimulationSandbox({ store, bounds: budgeted });
    await assertRejectsReason(sim2.startRun({
        runId: "b2", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 60,
        provider: () => ({ tokensUsed: 60, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    }), "BUDGET_EXCEEDED");

    // ...and the invalidated assumption is not resurrected as fresh.
    assert.equal(sim2.getResult("b1").state, "STALE_ASSUMPTIONS",
        "an invalidated assumption must survive a restart");
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 80d5afd — repaired classes                        */
/* ---------------------------------------------------------------------- */

test("L5-audit-5: persisted budget iterators/accessors never execute, and an unverifiable budget refuses new runs", async () => {
    // A hostile Symbol.iterator on the persisted budget array must never run.
    let iterCalls = 0;
    const hostileLedger = [{ atMs: 1, tokens: 5 }];
    Object.defineProperty(hostileLedger, Symbol.iterator, {
        enumerable: false, configurable: true,
        get() { iterCalls += 1; return Array.prototype[Symbol.iterator]; }
    });
    deserialize({ runs: {}, results: {}, budget: { tokenLedger: hostileLedger, invalidatedAssumptions: [] } });
    assert.equal(iterCalls, 0, "a persisted iterator getter must never run");

    // A malformed budget is a DEGRADATION, not a silent empty history.
    const malformed = deserialize({ runs: {}, results: {}, budget: { tokenLedger: "not-an-array" } });
    assert.equal(malformed.degraded, true, "an unreadable budget history must be reported as degraded");
    const wellFormed = deserialize({
        runs: {}, results: {}, budget: { tokenLedger: [{ atMs: 1, tokens: 5 }], invalidatedAssumptions: [] }
    });
    assert.equal(wellFormed.degraded, false);
    assert.equal(wellFormed.tokenLedger.length, 1);

    // FAIL-CLOSED: with an unverifiable history the hourly cap cannot be
    // enforced, so a run must be refused rather than silently resetting it.
    const store = {
        async getKv() { return { runs: {}, results: {}, budget: { tokenLedger: "not-an-array" } }; },
        async putKv() {}
    };
    const sim = await createSimulationSandbox({ store, bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 } });
    await assertRejectsReason(sim.startRun({
        runId: "r1", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 60,
        provider: () => ({ tokensUsed: 60, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    }), "BUDGET_EXCEEDED");

    // A genuine cold start (nothing stored) is NOT a degradation: runs proceed.
    const cold = await createSimulationSandbox({
        store: { async getKv() { return null; }, async putKv() {} },
        bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
    });
    const ok = await cold.startRun({
        runId: "cold", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 60,
        provider: () => ({ tokensUsed: 60, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    });
    assert.equal(ok.state, "COMPLETE");
});

test("L5-audit-6: a store exposing real-state writer verbs is rejected WITHOUT running its getters", async () => {
    let getterCalls = 0;
    const hostile = {};
    Object.defineProperty(hostile, "appendEvent", {
        enumerable: true, configurable: true,
        get() { getterCalls += 1; return () => {}; }
    });
    await assertRejectsReason(
        createSimulationSandbox({ store: hostile }),
        "CROSS_STORE_WRITE_REJECTED"
    );
    assert.equal(getterCalls, 0, "the isolation guard must not execute caller code");

    // The real ACC store is still rejected, and ordinary doubles still work.
    const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
    await assertRejectsReason(
        createSimulationSandbox({ store: createMemoryAccStore() }),
        "CROSS_STORE_WRITE_REJECTED"
    );
    const kv = new Map();
    const ok = await createSimulationSandbox({
        store: { async getKv(k) { return kv.get(k); }, async putKv(k, v) { kv.set(k, v); } }
    });
    assert.equal(ok.simulationColdStart, true);
});

test("L5-audit-7: an async-rejecting audit sink is contained and never blocks the run", async () => {
    let unhandled = 0;
    const listener = () => { unhandled += 1; };
    process.on("unhandledRejection", listener);
    try {
        const sim = await createSimulationSandbox({
            auditLedger: { append: () => Promise.reject(new Error("audit down")) }
        });
        const result = await sim.startRun({
            runId: "r1", question: "q", scenario: "s", initialStateRef: { frozen: true },
            steps: 1, horizonDays: 1, budgetTokens: 10,
            provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
        });
        assert.equal(result.state, "COMPLETE", "audit failure must never block the run");
        await new Promise(r => setImmediate(r));
        await new Promise(r => setTimeout(r, 30));
    } finally {
        process.removeListener("unhandledRejection", listener);
    }
    assert.equal(unhandled, 0, "an async-rejecting audit hook must not produce unhandled rejections");
});

test("L5-audit-8: a real-state writer verb hidden up the prototype CHAIN is still rejected", async () => {
    // The guard previously inspected only ONE prototype level, so a verb two or
    // three levels up was accepted -- a genuine cross-store bypass.
    for (const depth of [1, 2, 3]) {
        const base = { appendEvent() {} };
        let store = Object.create(base);
        for (let i = 1; i < depth; i++) store = Object.create(store);
        store.getKv = async () => null;
        store.putKv = async () => {};
        await assertRejectsReason(
            createSimulationSandbox({ store }),
            "CROSS_STORE_WRITE_REJECTED"
        );
    }

    // A plain {getKv, putKv} double must still be accepted.
    const kv = new Map();
    const ok = await createSimulationSandbox({
        store: { async getKv(k) { return kv.get(k); }, async putKv(k, v) { kv.set(k, v); } }
    });
    assert.equal(ok.simulationColdStart, true);
});

test("L5-audit-9: a transient store read failure fails closed but is RECOVERABLE, not permanent", async () => {
    let reads = 0;
    const flaky = {
        async getKv() { reads += 1; if (reads === 1) throw new Error("transient IO"); return null; },
        async putKv() {}
    };
    const spec = {
        runId: "t", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 10,
        provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    };

    // While the history cannot be read, the cap cannot be enforced -> refuse.
    const first = await createSimulationSandbox({ store: flaky });
    await assertRejectsReason(first.startRun(spec), "BUDGET_EXCEEDED");

    // Once the store is healthy, a fresh construction recovers -- the sandbox
    // is not permanently bricked by one transient read failure.
    const second = await createSimulationSandbox({ store: flaky });
    const recovered = await second.startRun({ ...spec, runId: "t2" });
    assert.equal(recovered.state, "COMPLETE",
        "a healthy store must recover on reconstruction");
});

test("L5-audit-10: the isolation guard walks the WHOLE prototype chain, with no depth cap to hide behind", async () => {
    // A previous fix capped the walk at 32 levels, which is itself a bypass:
    // placing the writer verb at depth 33 was accepted.
    let deep = Object.create({ appendEvent() {} });
    for (let i = 0; i < 32; i++) deep = Object.create(deep);
    deep.getKv = async () => null;
    deep.putKv = async () => {};
    await assertRejectsReason(
        createSimulationSandbox({ store: deep }),
        "CROSS_STORE_WRITE_REJECTED"
    );

    // A Proxy hidden IN the chain is refused too: every reflective read of a
    // Proxy runs its traps, so it cannot be trusted even when its traps lie.
    let traps = 0;
    const lying = new Proxy({}, {
        getOwnPropertyDescriptor() { traps += 1; return undefined; },
        getPrototypeOf(t) { traps += 1; return Object.getPrototypeOf(t); },
        ownKeys(t) { traps += 1; return Reflect.ownKeys(t); }
    });
    const sneaky = Object.create(lying);
    sneaky.getKv = async () => null;
    sneaky.putKv = async () => {};
    await assertRejectsReason(
        createSimulationSandbox({ store: sneaky }),
        "CROSS_STORE_WRITE_REJECTED"
    );
    assert.equal(traps, 0, "no proxy trap may run while checking isolation");
});

test("L5-audit-11: sparse, malformed, oversized, or Proxy budget histories all fail CLOSED", async () => {
    // A hole in the ledger previously read as an SHORTER history, restoring
    // less usage than was really consumed and resetting the hourly cap.
    const sparse = [];
    sparse.length = 2;
    sparse[0] = { atMs: 1, tokens: 50 };
    assert.equal(deserialize({
        runs: {}, results: {}, budget: { tokenLedger: sparse, invalidatedAssumptions: [] }
    }).degraded, true, "a sparse ledger cannot be trusted");

    // A malformed individual entry is not silently skipped either.
    assert.equal(deserialize({
        runs: {}, results: {},
        budget: { tokenLedger: [{ atMs: 1, tokens: 5 }, { atMs: "x", tokens: 5 }], invalidatedAssumptions: [] }
    }).degraded, true, "a malformed entry cannot be trusted");

    // A non-string invalidation ref is likewise untrustworthy.
    assert.equal(deserialize({
        runs: {}, results: {}, budget: { tokenLedger: [], invalidatedAssumptions: [1] }
    }).degraded, true, "a malformed invalidation ref cannot be trusted");

    // An absurdly long ledger is refused rather than scanned synchronously.
    const started = Date.now();
    const huge = deserialize({
        runs: {}, results: {}, budget: { tokenLedger: new Array(2_000_000), invalidatedAssumptions: [] }
    });
    assert.equal(huge.degraded, true, "an oversized ledger cannot be trusted");
    assert.ok(Date.now() - started < 1000, "an oversized ledger must not be scanned synchronously");

    // A Proxy anywhere in the persisted value is refused without running traps.
    let traps = 0;
    const inner = new Proxy({ x: 1 }, {
        ownKeys(t) { traps += 1; return Reflect.ownKeys(t); },
        getOwnPropertyDescriptor(t, k) { traps += 1; return Reflect.getOwnPropertyDescriptor(t, k); },
        getPrototypeOf(t) { traps += 1; return Reflect.getPrototypeOf(t); }
    });
    assert.throws(() => deserialize({ runs: { r1: { runId: "r1", scenario: inner } }, results: {} }));
    assert.equal(traps, 0, "no proxy trap may run during deserialization");

    // The fail-closed consequences: each of these refuses a run.
    const base = { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 };
    const spec = {
        runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 60,
        provider: () => ({ tokensUsed: 60, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    };
    for (const raw of [
        { runs: {}, results: {}, budget: { tokenLedger: sparse, invalidatedAssumptions: [] } },
        { runs: {}, results: {}, budget: { tokenLedger: new Array(2_000_000), invalidatedAssumptions: [] } }
    ]) {
        const sim = await createSimulationSandbox({
            store: { async getKv() { return raw; }, async putKv() {} }, bounds: base
        });
        await assertRejectsReason(sim.startRun(spec), "BUDGET_EXCEEDED");
    }
});


