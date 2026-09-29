"use strict";

/**
 * W9-L5 Resource and Constraint Planning — adversarial tests (RT-W9-34..38).
 * PM-34: tests written BEFORE implementation — must fail initially.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

const { makeResourcePlanStore } = require("../../../src/resourceplan/store");
const { makeKinds } = require("../../../src/resourceplan/kinds");
const { makePlan } = require("../../../src/resourceplan/plan");
const { makeMeters } = require("../../../src/resourceplan/meters");
const { makeSlice } = require("../../../src/resourceplan/slice");
const { makeShortfall } = require("../../../src/resourceplan/shortfall");
const { LAWS } = require("../../../src/resourceplan/laws");

function makePorts() {
    const acc = createMemoryAccStore();
    const store = makeResourcePlanStore(acc);
    const kinds = makeKinds(store);
    const plan = makePlan(store, kinds);
    const meters = makeMeters(store);
    const slice = makeSlice(store, kinds);
    const shortfall = makeShortfall(store);
    return { store, kinds, plan, meters, slice, shortfall };
}

// RT-W9-34: budget replan without owner approval must be refused
test("RT-W9-34: budget replan without owner approval is refused", async () => {
    const { plan, kinds } = makePorts();
    await kinds.registerKind("cpu", { unit: "cores", limit: 100 });
    await plan.createPlan("plan-34", { label: "initial" });
    await assert.rejects(
        () => plan.replanBudget("plan-34", { cpu: 200 }),
        { message: /owner approval required/i }
    );
});

// RT-W9-35: money kind must be unavailable (BLK-04 not resolved)
test("RT-W9-35: registering money kind is refused (MONEY_KIND_UNAVAILABLE)", async () => {
    const { kinds } = makePorts();
    assert.equal(LAWS.MONEY_KIND_UNAVAILABLE, true);
    await assert.rejects(
        () => kinds.registerKind("money", { unit: "USD", limit: 1000 }),
        { message: /money.*unavailable/i }
    );
});

// RT-W9-36: consumer cannot spoof meter readings
test("RT-W9-36: consumer cannot write meter readings (spoof refused)", async () => {
    const { meters } = makePorts();
    await assert.rejects(
        () => meters.writeReading("cpu", 999, { source: "consumer-self-report" }),
        { message: /consumer.*cannot.*write|spoof|unauthorized/i }
    );
});

// RT-W9-37: reservation hoard — single consumer cannot hold all capacity
test("RT-W9-37: reservation hoard throttled — cannot reserve 100% of kind limit", async () => {
    const { kinds, slice } = makePorts();
    await kinds.registerKind("gpu", { unit: "cards", limit: 10 });
    await assert.rejects(
        () => slice.reserve("gpu", 10, { owner: "agent-a", planId: "p1" }),
        { message: /hoard|limit|exceeded/i }
    );
});

// RT-W9-38: degraded state must surface shortfall, not hide it
test("RT-W9-38: shortfall surfaced and retrievable, not hidden", async () => {
    const { shortfall } = makePorts();
    const record = await shortfall.record("cpu", { available: 2, needed: 10, planId: "p38" });
    assert.ok(record.id);
    assert.equal(record.kind, "cpu");
    assert.equal(record.available, 2);
    assert.equal(record.needed, 10);
    const all = await shortfall.list("cpu");
    assert.ok(all.some(r => r.id === record.id));
});
