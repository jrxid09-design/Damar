"use strict";

const test = require("node:test");
const { assert, manualClock, FakeObserver, makeGovernor, demand } = require("./helpers");
const { createWorkloadId } = require("../../src/runtime/resourceGovernor/ids");
const { ADMISSION_OUTCOMES: OUT } = require("../../src/runtime/resourceGovernor/model");

test("storm: 1000 mixed-class admissions respect every hard limit", () => {
    const clock = manualClock();
    const observer = new FakeObserver({ eventLoopLagMs: 5 });
    const gov = makeGovernor({
        config: {
            globalConcurrencyLimit: 12,
            groupLimits: { "llm-heavy": 3, "re-analysis": 2, voice: 2, tool: 4, background: 2, tests: 2, default: 12 },
            maxQueue: 100,
            classConcurrencyLimits: { RE_ANALYSIS: 2 },
            leaseTtlMs: 600000
        },
        observer,
        clock
    });

    const classes = [
        ["INTERACTIVE", "voice"], ["AGENT", "llm-heavy"], ["RE_ANALYSIS", "re-analysis"],
        ["BACKGROUND", "background"], ["TEST", "tests"], ["TOOL", "tool"]
    ];
    let admitted = 0, queued = 0, rejected = 0;
    for (let i = 0; i < 1000; i++) {
        const [cls, group] = classes[i % classes.length];
        const d = gov.admit(createWorkloadId(`storm-${i}`), demand({
            workloadClass: cls, concurrencyGroup: group, priority: (i * 7) % 101
        }));
        if (d.outcome === OUT.ADMIT) admitted++;
        else if (d.outcome === OUT.QUEUE) queued++;
        else rejected++;
    }

    assert.equal(admitted + queued + rejected, 1000);
    assert.equal(admitted, 12, "exactly global-limit workloads admitted");

    const st = gov.getResourceStatus();
    assert.equal(st.activeLeases, 12);
    assert.equal(st.queueDepth <= 100, true);
    assert.ok(st.faulted === null);

    let perGroupActive = 0;
    for (const [g, n] of Object.entries(st.perGroup)) {
        perGroupActive += n;
        const limit = st.limits.groups[g];
        assert.ok(n <= limit, `group ${g}: ${n} exceeds ${limit}`);
    }
    assert.equal(perGroupActive, 12);
});

test("storm: duplicate release across all admitted leases is harmless", () => {
    const clock = manualClock();
    const observer = new FakeObserver({ eventLoopLagMs: 2000 });
    const gov = makeGovernor({
        config: { globalConcurrencyLimit: 6, groupLimits: { default: 6 }, maxQueue: 50 },
        observer, clock
    });
    const leases = [];
    for (let i = 0; i < 30; i++) {
        const d = gov.admit(createWorkloadId(`dup-${i}`), demand({ workloadClass: "INTERACTIVE", priority: i }));
        if (d.lease) leases.push(d.lease);
    }
    const releasedBefore = gov.getResourceStatus().metrics.released;
    for (let pass = 1; pass <= 3; pass++) {
        for (const l of leases) {
            const r = gov.release(l);
            if (pass > 1) {
                assert.deepEqual(r, { released: false, alreadyReleased: true, leaseId: l.leaseId });
            }
        }
    }
    const st = gov.getResourceStatus();
    assert.equal(st.metrics.released - releasedBefore, leases.length,
        "each lease must be released exactly once regardless of duplicate calls");
});

test("storm: fake lease objects are rejected mid-storm", () => {
    const clock = manualClock();
    const gov = makeGovernor({
        config: { globalConcurrencyLimit: 4, groupLimits: { default: 4 }, maxQueue: 50 },
        observer: new FakeObserver(), clock
    });
    const genuine = [];
    for (let i = 0; i < 10; i++) {
        const d = gov.admit(createWorkloadId(`fake-${i}`), demand({ workloadClass: "TOOL" }));
        if (d.lease) genuine.push(d.lease);
    }
    const fakes = genuine.map(l => JSON.parse(JSON.stringify(l)));
    for (const f of fakes) {
        assert.throws(() => gov.release(f), /UNKNOWN_LEASE/);
        assert.throws(() => gov.account(f), /UNKNOWN_LEASE/);
    }
    assert.equal(gov.getResourceStatus().activeLeases, genuine.length);
});

test("storm: final snapshot is deterministic on replay of identical scenario", () => {
    function runScenario() {
        const clock = manualClock(777_000);
        const observer = new FakeObserver({ totalMemBytes: 16e9, freeMemBytes: 8e9, eventLoopLagMs: 10 });
        const gov = makeGovernor({
            config: { globalConcurrencyLimit: 3, groupLimits: { default: 3 }, maxQueue: 20, leaseTtlMs: 5000 },
            observer, clock
        });
        const trace = [];
        for (let i = 0; i < 40; i++) {
            const cls = ["INTERACTIVE", "AGENT", "BACKGROUND"][i % 3];
            const d = gov.admit(createWorkloadId(`replay-${i}`), demand({ workloadClass: cls, priority: i % 11 }));
            trace.push(`${d.outcome}:${d.reason}`);
            if (i === 10) clock.advance(6000); // expire first wave
            if (i % 9 === 8) gov.reclaimExpired(clock.nowMs());
        }
        return { trace, status: JSON.stringify(gov.getResourceStatus()) };
    }
    const a = runScenario();
    const b = runScenario();
    assert.deepEqual(a.trace, b.trace);
    assert.equal(a.status, b.status);
});

test("storm: governor structures stay bounded (no unbounded growth)", () => {
    const clock = manualClock();
    const observer = new FakeObserver({ eventLoopLagMs: 1 });
    const gov = makeGovernor({
        config: { globalConcurrencyLimit: 2, groupLimits: { default: 2 }, maxQueue: 10, historyCapacity: 32 },
        observer, clock
    });
    for (let i = 0; i < 500; i++) {
        const d = gov.admit(createWorkloadId(`mem-${i}`), demand({ workloadClass: "INTERACTIVE" }));
        if (d.lease && i % 2 === 0) gov.release(d.lease);
        if (i % 25 === 0) gov.reclaimExpired(clock.nowMs());
        clock.advance(60_000);
    }
    assert.equal(gov._history.length <= 32, true);
    assert.equal(gov._diagnostics.length <= 64, true);
    assert.equal(gov._queue.size <= 10, true);
    const st = gov.getResourceStatus();
    assert.equal(Object.isFrozen(st), true);
});
