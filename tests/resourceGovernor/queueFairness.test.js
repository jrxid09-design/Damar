"use strict";

const test = require("node:test");
const { assert, manualClock, FakeObserver, makeGovernor, BASE_CONFIG, demand } = require("./helpers");
const { createWorkloadId } = require("../../src/runtime/resourceGovernor/ids");
const { ADMISSION_OUTCOMES: OUT } = require("../../src/runtime/resourceGovernor/model");

function criticalGovernor(clock, extra = {}) {
    return makeGovernor({
        config: { ...BASE_CONFIG, ...extra },
        observer: new FakeObserver({ eventLoopLagMs: 2000 }),
        clock
    });
}

test("queue: FIFO within equal priority", () => {
    const clock = manualClock();
    const gov = criticalGovernor(clock);
    for (const n of ["fq-a", "fq-b", "fq-c"]) {
        gov.admit(createWorkloadId(n), demand({ priority: 50 }));
    }
    const order = gov.queueEntries(clock.nowMs()).map(e => e.workloadId);
    assert.deepEqual(order, ["fq-a", "fq-b", "fq-c"]);
});

test("queue: higher base priority dequeues first", () => {
    const clock = manualClock();
    const gov = criticalGovernor(clock);
    const low = gov.admit(createWorkloadId("low-p"),
        demand({ workloadClass: "MAINTENANCE", concurrencyGroup: "background", priority: 10 }));
    const high = gov.admit(createWorkloadId("high-p"),
        demand({ workloadClass: "AGENT", concurrencyGroup: "llm-heavy", priority: 90 }));
    assert.equal(low.outcome, OUT.QUEUE);
    assert.equal(high.outcome, OUT.QUEUE);
    const order = gov.queueEntries(clock.nowMs()).map(e => e.workloadId);
    assert.equal(order[0], "high-p");
});

test("queue: bounded capacity — overflow rejected with QUEUE_FULL", () => {
    const clock = manualClock();
    const gov = criticalGovernor(clock, { maxQueue: 3 });
    let fullSeen = false;
    for (let i = 0; i < 5; i++) {
        const d = gov.admit(createWorkloadId(`ovf-${i}`), demand());
        if (d.reason === "QUEUE_FULL") fullSeen = true;
    }
    assert.equal(fullSeen, true);
    assert.equal(gov.getResourceStatus().queueDepth <= 3, true);
});

test("fairness: aging lifts long-waiting BACKGROUND above fresh INTERACTIVE", () => {
    const clock = manualClock();
    const gov = criticalGovernor(clock);
    gov.admit(createWorkloadId("bg-old"), demand({ workloadClass: "BACKGROUND", priority: 20 }));
    clock.advance(120_000);
    gov.admit(createWorkloadId("ui-new"), demand({ workloadClass: "INTERACTIVE", priority: 90 }));
    const order = gov.queueEntries(clock.nowMs()).map(e => e.workloadId);
    assert.equal(order[0], "bg-old", "aged background must outrank fresh interactive");
});

test("fairness: no starvation — BACKGROUND eventually admitted after pressure clears and slots free", () => {
    const clock = manualClock();
    const observer = new FakeObserver({ eventLoopLagMs: 2000 });
    const gov = makeGovernor({
        config: {
            globalConcurrencyLimit: 1, groupLimits: { default: 1 },
            maxQueue: 16, leaseTtlMs: 3_600_000
        },
        observer,
        clock
    });
    const holder = gov.admit(createWorkloadId("holder"), demand({ workloadClass: "INTERACTIVE" }));
    assert.equal(holder.outcome, OUT.ADMIT);

    const bg = gov.admit(createWorkloadId("bg-waiter"), demand({ workloadClass: "BACKGROUND", priority: 5 }));
    assert.equal(bg.outcome, OUT.QUEUE);

    for (let tick = 0; tick < 50; tick++) {
        clock.advance(10_000);
        const interactiveSpam = gov.admit(createWorkloadId(`spam-${tick}`),
            demand({ workloadClass: "INTERACTIVE", priority: 99 }));
        assert.notEqual(interactiveSpam.outcome, OUT.ADMIT, "global limit holds under spam");
    }

    observer.eventLoopLagMs = 2;
    clock.advance(1000);
    const released = gov.release(holder.lease);
    assert.equal(released.released, true);
    const promoted = gov.getResourceStatus();
    assert.equal(promoted.activeLeases, 1);
    assert.equal(promoted.metrics.admitted >= 2, true, "background waiter must have been promoted");
});

test("queue: entries are immutable snapshots", () => {
    const clock = manualClock();
    const gov = criticalGovernor(clock);
    gov.admit(createWorkloadId("immut-1"), demand());
    const [entry] = [...gov._queue.entries()];
    assert.throws(() => { entry.priority = 999; }, TypeError);
});
