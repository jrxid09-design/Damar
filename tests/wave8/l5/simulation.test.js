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
    },
    // A well-formed snapshot always carries the budget history: since audit
    // fdda055 a snapshot that EXISTS without it is treated as an unverifiable
    // history (which refuses new runs), so fixtures must be realistic.
    budget: { tokenLedger: [], invalidatedAssumptions: [] } };
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

/* ---------------------------------------------------------------------- */
/* Independent audit of fdda055 -- repaired classes                        */
/* ---------------------------------------------------------------------- */

test("L5-audit-12: EVERY real-state writer verb is enforced, not just the first one scanned", async () => {
    // The per-level `seen` set was shared across the outer verb loop, so after
    // the first verb walked the chain every later verb saw each level as
    // already-seen and bailed immediately: seven of the eight verbs were
    // unenforced (audit of fdda055).
    for (const verb of [
        "appendEvent", "saveSnapshot", "upsertPrediction", "upsertExperience",
        "upsertCommitment", "upsertSubstrateEpoch", "upsertBelief", "appendJournal"
    ]) {
        const store = { async getKv() { return null; }, async putKv() {} };
        store[verb] = () => {};
        await assertRejectsReason(
            createSimulationSandbox({ store }),
            "CROSS_STORE_WRITE_REJECTED"
        );
    }
    // A plain double is still accepted.
    const ok = await createSimulationSandbox({
        store: { async getKv() { return null; }, async putKv() {} }
    });
    assert.equal(ok.simulationColdStart, true);
});

test("L5-audit-13: a snapshot that EXISTS without its budget history is unverifiable, and 100k legitimate entries still restore", async () => {
    // Omitting `budget` (or a field inside it) previously read as an empty
    // history, resetting the hourly cap by simply stripping the field.
    assert.equal(deserialize({ runs: {}, results: {} }).degraded, true,
        "a snapshot without a budget history cannot be trusted");
    assert.equal(deserialize({
        runs: {}, results: {}, budget: { invalidatedAssumptions: [] }
    }).degraded, true, "a budget without tokenLedger cannot be trusted");
    assert.equal(deserialize({
        runs: {}, results: {}, budget: { tokenLedger: [] }
    }).degraded, true, "a budget without invalidatedAssumptions cannot be trusted");

    const stripped = await createSimulationSandbox({
        store: { async getKv() { return { runs: {}, results: {} }; }, async putKv() {} },
        bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
    });
    await assertRejectsReason(stripped.startRun({
        runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 60,
        provider: () => ({ tokensUsed: 60, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    }), "BUDGET_EXCEEDED");

    // A LARGE but legitimate one-token history must NOT be treated as
    // unverifiable -- the earlier 100k cap bricked restarts on valid data.
    const ledger = [];
    for (let i = 0; i < 100_001; i += 1) ledger.push({ atMs: 1_000_000, tokens: 1 });
    const restored = deserialize({
        runs: {}, results: {}, budget: { tokenLedger: ledger, invalidatedAssumptions: [] }
    });
    assert.equal(restored.degraded, false, "a large legitimate history is still trustworthy");
    assert.equal(restored.tokenLedger.length, 100_001);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 97a1990 -- repaired classes                        */
/* ---------------------------------------------------------------------- */

test("L5-audit-14: shadowing every writer verb with null does not hide the inherited real writers", async () => {
    // Stopping the chain walk at an own NON-FUNCTION descriptor was a bypass:
    // covering all eight verbs with `null` left the inherited real writers
    // reachable, and the store was still a real-store-shaped backend whose
    // getKv/putKv could be exercised (audit of 97a1990).
    const proto = {
        appendEvent() {}, saveSnapshot() {}, upsertPrediction() {},
        upsertExperience() {}, upsertCommitment() {}, upsertSubstrateEpoch() {},
        upsertBelief() {}, appendJournal() {}
    };
    const store = Object.create(proto);
    for (const verb of [
        "appendEvent", "saveSnapshot", "upsertPrediction", "upsertExperience",
        "upsertCommitment", "upsertSubstrateEpoch", "upsertBelief", "appendJournal"
    ]) {
        store[verb] = null;   // own non-function shadowing an inherited real writer
    }
    let reads = 0;
    let writes = 0;
    Object.defineProperty(store, "getKv", { value: async () => { reads += 1; return null; } });
    Object.defineProperty(store, "putKv", { value: async () => { writes += 1; } });

    await assertRejectsReason(
        createSimulationSandbox({ store }),
        "CROSS_STORE_WRITE_REJECTED"
    );
    assert.equal(reads, 0, "the real backend must never be read");
    assert.equal(writes, 0, "the real backend must never be written");
});

test("L5-audit-15: a VALID retained run is not evicted by a malformed newer one before validation", async () => {
    // Compaction ran BEFORE validation, so with retention 1 a malformed newer
    // run displaced a valid older one and then validation discarded the
    // malformed run -- leaving nothing (audit of 97a1990).
    const nowMs = 1_000_000;
    const raw = {
        runs: {
            // A genuinely well-formed persisted run (every field the lane's own
            // builder requires), so only the MALFORMED sibling is at issue.
            good: {
                runId: "good", question: "q", scenario: {}, initialStateRef: { frozen: true },
                steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "DEFAULT",
                state: "COMPLETE", createdAtMs: nowMs - 5000
            },
            bad: { runId: "MISMATCH", state: "COMPLETE", createdAtMs: nowMs - 1000 }
        },
        results: {
            good: {
                runId: "good", distribution: null, risks: [], assumptions: [], confidence: 0.5,
                tier: "T10", state: "COMPLETE", tokensUsed: 1,
                validUntilMs: nowMs + 1_000_000, generatedAtMs: nowMs - 5000
            }
        },
        budget: { tokenLedger: [], invalidatedAssumptions: [] }
    };
    const sim = await createSimulationSandbox({
        store: { async getKv() { return raw; }, async putKv() {} },
        clock: { nowMs: () => nowMs },
        bounds: { ...BOUNDS, MAX_RETAINED_RUNS: 1 }
    });
    assert.equal(sim.getResult("good").state, "COMPLETE",
        "the valid retained run must survive a malformed newer entry");
    assertThrowsReason(() => sim.getResult("bad"), "UNKNOWN_RUN");
});

test("L5-audit-16: an accessor-backed audit ledger executes no caller code, and a normal one still receives events", async () => {
    // `typeof auditLedger.append === "function"` was a raw [[Get]] that ran a
    // getter BEFORE the audit hook could contain the failure (audit of
    // 97a1990).
    let getterCalls = 0;
    const hostile = {};
    Object.defineProperty(hostile, "append", {
        enumerable: true, configurable: true,
        get() { getterCalls += 1; return () => ({ ok: true }); }
    });

    const sim = await createSimulationSandbox({
        clock: { nowMs: () => 1_000_000 },
        auditLedger: hostile,
        bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
    });
    await sim.startRun({
        runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 10,
        provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    });
    assert.equal(getterCalls, 0, "the audit ledger accessor must never run");

    // A well-formed ledger still receives the lane's contract events.
    const seen = [];
    const good = { append(e) { seen.push(e.eventType); return true; } };
    const sim2 = await createSimulationSandbox({
        clock: { nowMs: () => 1_000_000 }, auditLedger: good,
        bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
    });
    await sim2.startRun({
        runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 10,
        provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    });
    assert.ok(seen.includes("cognition.simulation.run_started"), `saw: ${seen.join(",")}`);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of ba68903 -- full-record validation + `then` once    */
/* ---------------------------------------------------------------------- */

test("L5-audit-17: a malformed run is rejected by FULL record validation, not just runId/state", async () => {
    // Checking only {runId, state} let a run with an invalid createdAtMs survive
    // reconciliation, take capacity, and evict a valid run at retention 1
    // (audit of ba68903). Validation now runs every field through the lane's own
    // builder -- the record's actual shape contract.
    const nowMs = 1_000_000;
    const malformedRuns = [
        // invalid createdAtMs
        { runId: "bad", question: "q", scenario: {}, initialStateRef: {}, steps: 1,
            horizonDays: 1, budgetTokens: 10, state: "COMPLETE", createdAtMs: "newer-but-invalid" },
        // invalid question
        { runId: "bad", question: "", scenario: {}, initialStateRef: {}, steps: 1,
            horizonDays: 1, budgetTokens: 10, state: "COMPLETE", createdAtMs: nowMs - 1000 },
        // invalid budgetTokens
        { runId: "bad", question: "q", scenario: {}, initialStateRef: {}, steps: 1,
            horizonDays: 1, budgetTokens: -5, state: "COMPLETE", createdAtMs: nowMs - 1000 },
        // createdAtMs in the future
        { runId: "bad", question: "q", scenario: {}, initialStateRef: {}, steps: 1,
            horizonDays: 1, budgetTokens: 10, state: "COMPLETE", createdAtMs: nowMs + 999999 }
    ];

    for (const malformed of malformedRuns) {
        const sim = await createSimulationSandbox({
            store: {
                async getKv() {
                    return {
                        runs: {
                            good: {
                                runId: "good", question: "q", scenario: {}, initialStateRef: { frozen: true },
                                steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "DEFAULT",
                                state: "COMPLETE", createdAtMs: nowMs - 5000
                            },
                            bad: malformed
                        },
                        results: {
                            good: {
                                runId: "good", distribution: null, risks: [], assumptions: [], confidence: 0.5,
                                tier: "T10", state: "COMPLETE", tokensUsed: 1,
                                validUntilMs: nowMs + 1_000_000, generatedAtMs: nowMs - 5000
                            }
                        },
                        budget: { tokenLedger: [], invalidatedAssumptions: [] }
                    };
                },
                async putKv() {}
            },
            clock: { nowMs: () => nowMs },
            bounds: { ...BOUNDS, MAX_RETAINED_RUNS: 1 }
        });
        assert.equal(sim.getResult("good").state, "COMPLETE",
            `the valid run must survive ${JSON.stringify(malformed.createdAtMs)}-shaped malformed sibling`);
        assertThrowsReason(() => sim.getResult("bad"), "UNKNOWN_RUN");
    }
});

test("L5-audit-18: an accessor-backed `then` on an audit result NEVER runs", async () => {
    // Two earlier defects are closed here. `Promise.resolve` read `then`
    // repeatedly (~2 getter calls per event, audit of ba68903), and the fix for
    // that still invoked the result through `then.call` / `.catch` -- property
    // lookups on a caller-controlled object (audit of 472b6e0). Handling is now
    // entirely descriptor-based, so an accessor `then` is never executed at all.
    let thenCalls = 0;
    const payload = {};
    Object.defineProperty(payload, "then", {
        enumerable: true, configurable: true,
        get() { thenCalls += 1; return undefined; }   // non-function `then`
    });
    const sim = await createSimulationSandbox({
        clock: { nowMs: () => 1_000_000 },
        auditLedger: { append() { return payload; } },
        bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
    });
    await sim.startRun({
        runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 10,
        provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
    });
    assert.equal(thenCalls, 0, "an accessor `then` must never be executed");
});

/* ---------------------------------------------------------------------- */
/* Independent audit of de9553c -- normalized fields, hostile thenables    */
/* ---------------------------------------------------------------------- */

test("L5-audit-19: a field the builder NORMALIZES cannot smuggle a malformed run past validation", async () => {
    // "Passes the builder" is not "is well formed": the builders normalize some
    // fields (an object-valued `fidelity` became "DEFAULT"), so a malformed
    // record still passed, took capacity, and evicted a valid run at retention 1
    // (audit of de9553c). Fields that are normalized must be checked explicitly.
    const nowMs = 1_000_000;
    const goodRun = () => ({
        runId: "good", question: "q", scenario: {}, initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "DEFAULT",
        state: "COMPLETE", createdAtMs: nowMs - 5000
    });
    const goodResult = () => ({
        runId: "good", distribution: null, risks: [], assumptions: [], confidence: 0.5,
        tier: "T10", state: "COMPLETE", tokensUsed: 1,
        validUntilMs: nowMs + 1_000_000, generatedAtMs: nowMs - 5000
    });

    const malformedRuns = [
        { ...goodRun(), runId: "bad", fidelity: { evil: true }, createdAtMs: nowMs - 1000 },
        { ...goodRun(), runId: "bad", fidelity: 7, createdAtMs: nowMs - 1000 },
        { ...goodRun(), runId: "bad", question: 123, createdAtMs: nowMs - 1000 },
        { ...goodRun(), runId: "bad", budgetTokens: 1.5, createdAtMs: nowMs - 1000 }
    ];

    for (const malformed of malformedRuns) {
        const sim = await createSimulationSandbox({
            store: {
                async getKv() {
                    return {
                        runs: { good: goodRun(), bad: malformed },
                        results: { good: goodResult() },
                        budget: { tokenLedger: [], invalidatedAssumptions: [] }
                    };
                },
                async putKv() {}
            },
            clock: { nowMs: () => nowMs },
            bounds: { ...BOUNDS, MAX_RETAINED_RUNS: 1 }
        });
        assert.equal(sim.getResult("good").state, "COMPLETE",
            "the valid run must survive a normalized-field malformed sibling");
        assertThrowsReason(() => sim.getResult("bad"), "UNKNOWN_RUN");
    }
});

test("L5-audit-20: a hostile async thenable on an audit result leaks no unhandled rejection", async () => {
    // `then.call(...)` returns a value too: a custom async `then` that rejects
    // returns a rejected promise, and ignoring it made the rejection unhandled
    // (audit of de9553c).
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    try {
        const hostile = Object.freeze({ then() { return Promise.reject(new Error("hostile thenable")); } });
        const sim = await createSimulationSandbox({
            clock: { nowMs: () => 1_000_000 },
            auditLedger: { append() { return hostile; } },
            bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
        });
        await sim.startRun({
            runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
            steps: 1, horizonDays: 1, budgetTokens: 10,
            provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
        });
        await new Promise(r => setTimeout(r, 50));
        assert.equal(unhandled, 0, "a hostile thenable must not produce an unhandled rejection");
    } finally {
        process.removeListener("unhandledRejection", onUnhandled);
    }
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 472b6e0 -- canonical equality + property lookups   */
/* ---------------------------------------------------------------------- */

test("L5-audit-21: a persisted result the builder would NORMALIZE is rejected, not exposed", async () => {
    // The builder clamps `confidence` to 0..1 and turns a non-finite
    // `tokensUsed` into 0, so "passes the builder" let the MALFORMED ORIGINAL
    // stay stored and publicly readable through `getResult()` -- e.g.
    // `confidence: 999`, `tokensUsed: -7`, and a far-future timestamp
    // (audit of 472b6e0). Validation now requires the stored record to EQUAL the
    // builder's canonical output, plus the semantics equality cannot express.
    const nowMs = 1_000_000;
    const goodRun = {
        runId: "good", question: "q", scenario: {}, initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 10, fidelity: "DEFAULT",
        state: "COMPLETE", createdAtMs: nowMs - 5000
    };
    const TTL = BOUNDS.TTL_MS;
    // A genuinely well-formed result: within the run's token budget, and its TTL
    // spans no more than the configured TTL from its own generation time.
    const goodResult = () => ({
        runId: "good", distribution: null, risks: [], assumptions: [], confidence: 0.5,
        tier: "T10", state: "COMPLETE", tokensUsed: 1,
        validUntilMs: nowMs - 5000 + TTL, generatedAtMs: nowMs - 5000
    });

    const malformedResults = [
        { ...goodResult(), confidence: 999 },
        { ...goodResult(), confidence: -3 },
        { ...goodResult(), tokensUsed: -7 },
        { ...goodResult(), generatedAtMs: 1e15, validUntilMs: 1e15 },
        { ...goodResult(), validUntilMs: nowMs - 3_600_000 },
        { ...goodResult(), risks: "not-an-array" },
        { ...goodResult(), confidence: "0.5" },
        // Exceeds the paired RUN's token budget: the builder copies tokensUsed
        // through unchanged, so only the budget comparison catches this.
        { ...goodResult(), tokensUsed: 999 },
        // TTL stretched far beyond the configured bound: `validUntilMs` is also
        // copied through, so only the TTL comparison catches this.
        { ...goodResult(), validUntilMs: 1e15 }
    ];

    for (const result of malformedResults) {
        const sim = await createSimulationSandbox({
            store: {
                async getKv() {
                    return {
                        runs: { good: goodRun }, results: { good: result },
                        budget: { tokenLedger: [], invalidatedAssumptions: [] }
                    };
                },
                async putKv() {}
            },
            clock: { nowMs: () => nowMs }
        });
        assertThrowsReason(() => sim.getResult("good"), "UNKNOWN_RUN");
    }

    // A genuinely well-formed result still loads.
    const sim = await createSimulationSandbox({
        store: {
            async getKv() {
                return {
                    runs: { good: goodRun }, results: { good: goodResult() },
                    budget: { tokenLedger: [], invalidatedAssumptions: [] }
                };
            },
            async putKv() {}
        },
        clock: { nowMs: () => nowMs }
    });
    assert.equal(sim.getResult("good").confidence, 0.5);
});

test("L5-audit-22: a throwing `catch` accessor on a thenable's return value leaks no unhandled rejection", async () => {
    // The previous fix absorbed the value returned by `then` through `.catch`,
    // which is itself a property lookup on a caller-controlled object -- a
    // throwing `catch` accessor prevented handler attachment and produced
    // unhandled rejections (audit of 472b6e0). Absorption now uses the intrinsic
    // `Promise.prototype.then` via a frozen `Reflect.apply`.
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    try {
        const evilReturn = {};
        Object.defineProperty(evilReturn, "catch", {
            get() { throw new Error("hostile catch accessor"); }
        });
        const hostile = Object.freeze({ then() { return evilReturn; } });

        const sim = await createSimulationSandbox({
            clock: { nowMs: () => 1_000_000 },
            auditLedger: { append() { return hostile; } },
            bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
        });
        await sim.startRun({
            runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
            steps: 1, horizonDays: 1, budgetTokens: 10,
            provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
        });
        await new Promise(r => setTimeout(r, 60));
        assert.equal(unhandled, 0, "a throwing `catch` accessor must not leak a rejection");
    } finally {
        process.removeListener("unhandledRejection", onUnhandled);
    }
});

test("L5-audit-23: a caller `then` is never invoked, so a detached rejection cannot leak", async () => {
    // The previous fix invoked the caller-supplied `then` and could only absorb
    // the promise it RETURNED. A `then` that rejects on its own and returns
    // `undefined` detached that rejection entirely -- observable only as an
    // `unhandledRejection`, which terminates the process under Node's strict
    // policy (audit of a9cc5db). Caller `then` is now never executed: only real
    // promises (via the intrinsic `util.types.isPromise`) are absorbed.
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    try {
        let thenInvoked = 0;
        const hostile = {
            then() {
                thenInvoked += 1;
                Promise.reject(new Error("detached"));
                return undefined;          // nothing for the hook to absorb
            }
        };
        const sim = await createSimulationSandbox({
            clock: { nowMs: () => 1_000_000 },
            auditLedger: { append() { return hostile; } },
            bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
        });
        await sim.startRun({
            runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
            steps: 1, horizonDays: 1, budgetTokens: 10,
            provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
        });
        await new Promise(r => setTimeout(r, 60));
        assert.equal(thenInvoked, 0, "a caller-supplied `then` must never be invoked");
        assert.equal(unhandled, 0, "and no detached rejection may surface");
    } finally {
        process.removeListener("unhandledRejection", onUnhandled);
    }
});

test("L5-audit-24: a result exceeding its run's token budget or the configured TTL is rejected", async () => {
    // The builder copies `tokensUsed` and `validUntilMs` through unchanged, so
    // canonical equality cannot catch either: a result with tokens far beyond
    // the run's budget, or a TTL spanning millennia, stayed COMPLETE and made
    // both the token quota and freshness meaningless (audit of a9cc5db).
    const nowMs = 1_000_000;
    const goodRun = {
        runId: "good", question: "q", scenario: {}, initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 1, fidelity: "DEFAULT",
        state: "COMPLETE", createdAtMs: nowMs - 5000
    };
    const base = {
        runId: "good", distribution: null, risks: [], assumptions: [], confidence: 0.5,
        tier: "T10", state: "COMPLETE", generatedAtMs: nowMs - 5000,
        tokensUsed: 1, validUntilMs: nowMs - 5000 + BOUNDS.TTL_MS
    };

    const loadWith = async (result) => createSimulationSandbox({
        store: {
            async getKv() {
                return {
                    runs: { good: goodRun }, results: { good: result },
                    budget: { tokenLedger: [], invalidatedAssumptions: [] }
                };
            },
            async putKv() {}
        },
        clock: { nowMs: () => nowMs }
    });

    const readBack = (sim) => {
        try {
            return { state: sim.getResult("good").state };
        } catch (error) {
            return { reason: error.reason };
        }
    };

    assert.equal(readBack(await loadWith(base)).state, "COMPLETE",
        "a result within budget and TTL still loads");
    assert.equal(readBack(await loadWith({ ...base, tokensUsed: 999 })).reason, "UNKNOWN_RUN",
        "tokens beyond the run's budget must be rejected");
    assert.equal(readBack(await loadWith({ ...base, validUntilMs: 1e15 })).reason, "UNKNOWN_RUN",
        "a TTL beyond the configured bound must be rejected");
});

test("L5-audit-25: widened construction bounds do not legitimise over-limit persisted data", async () => {
    // Judging stored evidence against the caller-widened `bounds` meant raising
    // the construction limits let a result with 10^12 tokens and a 10^15 ms TTL
    // pass validation, where the default configuration correctly rejected it
    // (audit of 03956b6). Evidence about PERSISTED data is now judged against the
    // frozen contract ceilings, while a stricter configuration still applies.
    const nowMs = 1_000_000;
    const goodRun = {
        runId: "good", question: "q", scenario: {}, initialStateRef: { frozen: true },
        steps: 1, horizonDays: 1, budgetTokens: 5, fidelity: "DEFAULT",
        state: "COMPLETE", createdAtMs: nowMs - 5000
    };
    const widened = { ...BOUNDS, MAX_TOKENS_PER_RUN: 1e15, MAX_TOKENS_PER_HOUR: 1e15, TTL_MS: 1e15 };

    const loadWith = async (result, bounds) => createSimulationSandbox({
        store: {
            async getKv() {
                return {
                    runs: { good: goodRun }, results: { good: result },
                    budget: { tokenLedger: [], invalidatedAssumptions: [] }
                };
            },
            async putKv() {}
        },
        clock: { nowMs: () => nowMs },
        bounds
    });

    const overLimit = {
        runId: "good", distribution: null, risks: [], assumptions: [], confidence: 0.5,
        tier: "T10", state: "COMPLETE", tokensUsed: 1e12,
        validUntilMs: 1e15, generatedAtMs: nowMs - 5000
    };
    const overLimitSim = await loadWith(overLimit, widened);
    assertThrowsReason(() => overLimitSim.getResult("good"), "UNKNOWN_RUN");

    // A legitimate record still loads under the widened bounds.
    const legitimate = {
        runId: "good", distribution: null, risks: [], assumptions: [], confidence: 0.5,
        tier: "T10", state: "COMPLETE", tokensUsed: 5,
        validUntilMs: nowMs - 5000 + BOUNDS.TTL_MS, generatedAtMs: nowMs - 5000
    };
    assert.equal((await loadWith(legitimate, widened)).getResult("good").tokensUsed, 5);
});

test("L5-audit-26: a hostile `call` getter on the append function cannot detach a rejection or hide the audit", async () => {
    // `append.call(...)` is a property lookup for `call` on a caller-controlled
    // function object: a throwing getter there detached a rejection and made the
    // audit silently fail (audit of 03956b6). The call is now made through a
    // frozen `Reflect.apply`, which performs no property lookup.
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    try {
        let appendInvoked = 0;
        const appendFn = function () { appendInvoked += 1; return undefined; };
        Object.defineProperty(appendFn, "call", {
            get() { Promise.reject(new Error("detached")); return Function.prototype.call; }
        });

        const sim = await createSimulationSandbox({
            clock: { nowMs: () => 1_000_000 },
            auditLedger: { append: appendFn },
            bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
        });
        await sim.startRun({
            runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
            steps: 1, horizonDays: 1, budgetTokens: 10,
            provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
        });
        await new Promise(r => setTimeout(r, 60));
        assert.equal(unhandled, 0, "a hostile `call` getter must not leak a rejection");
        assert.equal(appendInvoked, 2, "the audit hook still reached the sink for both events");
    } finally {
        process.removeListener("unhandledRejection", onUnhandled);
    }
});

test("L5-audit-27: a hostile constructor getter on a returned real promise cannot leak its rejection", async () => {
    // `Promise.prototype.then` reads the promise's `constructor`/`Symbol.species`
    // to pick the result constructor. A throwing getter there made handler
    // attachment fail, so the ORIGINAL rejection leaked (audit of 03956b6).
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    try {
        const hostilePromise = Promise.reject(new Error("original-rejection"));
        Object.defineProperty(hostilePromise, "constructor", {
            configurable: true,
            get() { throw new Error("hostile ctor getter"); }
        });
        const sim = await createSimulationSandbox({
            clock: { nowMs: () => 1_000_000 },
            auditLedger: { append: () => hostilePromise },
            bounds: { ...BOUNDS, MAX_TOKENS_PER_HOUR: 100 }
        });
        await sim.startRun({
            runId: "r", question: "q", scenario: "s", initialStateRef: { frozen: true },
            steps: 1, horizonDays: 1, budgetTokens: 10,
            provider: () => ({ tokensUsed: 1, distribution: null, risks: [], assumptions: [], confidence: 0.5 })
        });
        await new Promise(r => setTimeout(r, 60));
        assert.equal(unhandled, 0, "the original rejection must be absorbed");
    } finally {
        process.removeListener("unhandledRejection", onUnhandled);
    }
});


