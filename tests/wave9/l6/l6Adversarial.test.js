"use strict";

/**
 * W9-L6 Strategic Simulation — adversarial tests (RT-W9-39..40).
 * PM-34: tests written BEFORE implementation.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

const { makeStrategyStore } = require("../../../src/cognition/strategy/store");
const { makeScenario } = require("../../../src/cognition/strategy/scenario");
const { BOUNDS } = require("../../../src/cognition/strategy/bounds");

function makePorts() {
    const acc = createMemoryAccStore();
    const store = makeStrategyStore(acc);
    const scenario = makeScenario(store);
    return { store, scenario };
}

// RT-W9-39: scenario presented as fact → labelled prediction
test("RT-W9-39: strategy scenario is labelled PREDICTION, not fact", async () => {
    const { scenario } = makePorts();
    const s = await scenario.create("s-39", { label: "ETH hits $10k", branches: [] });
    assert.equal(s.kind, "PREDICTION");
    assert.ok(!s.isFactual);
});

// RT-W9-39b: scenario claiming to be factual refused
test("RT-W9-39b: scenario claiming isFactual:true is refused", async () => {
    const { scenario } = makePorts();
    await assert.rejects(
        () => scenario.create("s-39b", { label: "certain outcome", isFactual: true }),
        { message: /factual.*refused|prediction.*label|scenario.*fact/i }
    );
});

// RT-W9-40: branching explosion capped
test("RT-W9-40: scenario branch count exceeding MAX_SCENARIO_BRANCHES is refused", async () => {
    const { scenario } = makePorts();
    const branches = Array.from({ length: BOUNDS.MAX_SCENARIO_BRANCHES + 1 }, (_, i) => ({ id: `b${i}` }));
    await assert.rejects(
        () => scenario.create("s-40", { label: "exploding", branches }),
        { message: /branch.*cap|MAX_SCENARIO_BRANCHES|truncat/i }
    );
});
