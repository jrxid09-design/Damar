"use strict";

const test = require("node:test");
const { assert, governorFactory } = require("./helpers");
const { createResourceDemand, REASONS, ADMISSION_OUTCOMES, PRESSURE_BANDS, WORKLOAD_CLASSES } = governorFactory.model;

test("demand: valid demand is frozen and defaults are class-derived", () => {
    const d = createResourceDemand({ workloadClass: "INTERACTIVE" });
    assert.equal(d.priority, 90);
    assert.equal(d.concurrencyGroup, "default");
    assert.equal(Object.isFrozen(d), true);
});

test("demand: every workload class is accepted with defaults", () => {
    for (const cls of WORKLOAD_CLASSES) {
        const d = createResourceDemand({ workloadClass: cls });
        assert.ok(Number.isFinite(d.cpuWeight) && d.cpuWeight >= 0);
    }
});

test("demand: unknown workload class rejected", () => {
    assert.throws(() => createResourceDemand({ workloadClass: "SUPER_JOB" }), /INVALID_DEMAND/);
    assert.throws(() => createResourceDemand(null), /INVALID_DEMAND/);
});

test("demand: numeric fields out of range rejected", () => {
    assert.throws(() => createResourceDemand({ workloadClass: "TOOL", cpuWeight: 101 }), /INVALID_DEMAND/);
    assert.throws(() => createResourceDemand({ workloadClass: "TOOL", cpuWeight: -1 }), /INVALID_DEMAND/);
    assert.throws(() => createResourceDemand({ workloadClass: "TOOL", cpuWeight: "high" }), /INVALID_DEMAND/);
    assert.throws(() => createResourceDemand({ workloadClass: "TOOL", priority: 999 }), /INVALID_DEMAND/);
});

test("demand: whitespace-contaminated group rejected at model level", () => {
    assert.throws(() => createResourceDemand({ workloadClass: "TOOL", concurrencyGroup: "llm heavy" }), /INVALID_DEMAND/);
});

test("decision factory: only closed outcomes/reasons permitted", () => {
    assert.throws(() =>
        governorFactory.model.createAdmissionDecision({ outcome: "MAYBE", reason: REASONS.OK_ADMITTED, workloadId: "x" }),
        /INVALID_DECISION/);
    assert.throws(() =>
        governorFactory.model.createAdmissionDecision({ outcome: ADMISSION_OUTCOMES.ADMIT, reason: "MAKE_IT_SO", workloadId: "x" }),
        /INVALID_DECISION/);
});

test("pressure bands enum is closed", () => {
    assert.deepEqual(Object.values(PRESSURE_BANDS).sort(),
        ["CRITICAL", "ELEVATED", "HIGH", "NORMAL", "UNKNOWN"]);
});
