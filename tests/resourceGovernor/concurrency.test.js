"use strict";

const test = require("node:test");
const { assert, manualClock, FakeObserver, makeGovernor } = require("./helpers");
const { createWorkloadId } = require("../../src/runtime/resourceGovernor/ids");
const { ADMISSION_OUTCOMES: OUT } = require("../../src/runtime/resourceGovernor/model");

test("race: concurrent Promise.all admits never exceed global limit", async () => {
    const gov = makeGovernor({
        config: { globalConcurrencyLimit: 5, groupLimits: { default: 5 }, maxQueue: 100 }
    });
    const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
            Promise.resolve().then(() =>
                gov.admit(createWorkloadId(`race-g-${i}`), {
                    workloadClass: "TOOL", concurrencyGroup: "default"
                }))
        )
    );
    const admitted = results.filter(r => r.outcome === OUT.ADMIT).length;
    assert.equal(admitted, 5);
    assert.equal(gov.getResourceStatus().activeLeases, 5);
});

test("race: concurrent Promise.all admits never exceed group limit", async () => {
    const gov = makeGovernor({
        config: { globalConcurrencyLimit: 50, groupLimits: { "llm-heavy": 3, default: 50 }, maxQueue: 100 }
    });
    const results = await Promise.all(
        Array.from({ length: 150 }, (_, i) =>
            Promise.resolve().then(() =>
                gov.admit(createWorkloadId(`race-l-${i}`), {
                    workloadClass: "AGENT", concurrencyGroup: i % 2 === 0 ? "llm-heavy" : "default",
                    priority: (i % 7) * 10
                }))
        )
    );
    let llmActive = 0;
    for (const r of results) {
        if (r.outcome === OUT.ADMIT && r.lease.group === "llm-heavy") llmActive++;
    }
    assert.equal(llmActive, 3);
    const st = gov.getResourceStatus();
    assert.equal(st.activeLeases <= 50, true);
});

test("race: mixed release/admit churn keeps accounting consistent", async () => {
    const clock = manualClock();
    const gov = makeGovernor({
        config: { globalConcurrencyLimit: 4, groupLimits: { default: 4 }, maxQueue: 64 },
        clock
    });
    const leases = [];
    for (let round = 0; round < 20; round++) {
        const batch = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                Promise.resolve().then(() =>
                    gov.admit(createWorkloadId(`churn-${round}-${i}`), { workloadClass: "TOOL" }))
            )
        );
        for (const r of batch) if (r.lease) leases.push(r.lease);
        while (leases.length > 0 && gov.getResourceStatus().activeLeases >= 4) {
            const l = leases.shift();
            gov.release(l);
        }
    }
    const st = gov.getResourceStatus();
    assert.equal(st.activeLeases <= 4, true);
    assert.equal(st.faulted, null);
    assert.ok(st.metrics.admitted >= st.metrics.released);
});
