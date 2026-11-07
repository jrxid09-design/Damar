"use strict";

const test = require("node:test");
const { assert, manualClock, FakeObserver, ThrowingObserver, makeGovernor, BASE_CONFIG, demand } = require("./helpers");
const { createWorkloadId } = require("../../src/runtime/resourceGovernor/ids");
const { ADMISSION_OUTCOMES: OUT } = require("../../src/runtime/resourceGovernor/model");

test("status: immutable, complete, and free of lease handles", () => {
    const gov = makeGovernor({ config: BASE_CONFIG });
    const d = gov.admit(createWorkloadId("status-1"), demand());
    const st = gov.getResourceStatus();
    assert.equal(Object.isFrozen(st), true);
    for (const key of ["pressureBand", "activeLeases", "queueDepth", "limits", "perGroup", "perClass", "metrics", "diagnostics", "recentDecisions"]) {
        assert.ok(key in st, `status missing ${key}`);
    }
    const json = JSON.stringify(st);
    assert.equal(json.includes(d.lease.leaseId), false, "lease id must not leak via status");
    assert.equal(json.includes("reservedDemand"), false);
});

test("status: reflects queue depth and per-group concurrency", () => {
    const gov = makeGovernor({
        config: { globalConcurrencyLimit: 2, groupLimits: { default: 2 }, maxQueue: 10 }
    });
    gov.admit(createWorkloadId("s-a"), demand({ concurrencyGroup: "default" }));
    gov.admit(createWorkloadId("s-b"), demand({ concurrencyGroup: "default" }));
    gov.admit(createWorkloadId("s-c"), demand({ concurrencyGroup: "default" }));
    const st = gov.getResourceStatus();
    assert.equal(st.activeLeases, 2);
    assert.equal(st.queueDepth, 1);
    assert.equal(st.perGroup.default, 2);
});

test("status: observer failure surfaces diagnostics, never fake health", () => {
    const gov = makeGovernor({ config: BASE_CONFIG, observer: new ThrowingObserver() });
    const st = gov.getResourceStatus();
    assert.equal(st.observerHealthy, false);
    assert.equal(st.pressureBand, "UNKNOWN");
});

test("recommendations: data-only pressure signals under load", () => {
    const clock = manualClock();
    const observer = new FakeObserver({ eventLoopLagMs: 5 });
    const gov = makeGovernor({ config: BASE_CONFIG, observer, clock });
    assert.deepEqual(gov.recommendations(), []);

    const { lease } = gov.admit(createWorkloadId("rec-bg"), demand({ workloadClass: "BACKGROUND" }));
    assert.notEqual(lease, null);
    clock.advance(31_000);
    observer.eventLoopLagMs = 2000;
    const recs = gov.recommendations();
    const types = recs.map(r => r.type);
    assert.ok(types.includes("PAUSE_BACKGROUND"));
    assert.ok(types.includes("REDUCE_CONCURRENCY"));
    assert.ok(types.includes("RELEASE_IDLE_LEASES"));
    assert.ok(types.includes("CANCEL_PREEMPTIBLE"));
    for (const r of recs) {
        assert.equal(Object.isFrozen(r), true);
        assert.equal(typeof r.type, "string");
        assert.ok(!("abort" in r) && !("execute" in r) && !("kill" in r));
    }
});

test("hooks: integration ports are inert data channels, bound once", () => {
    const { createIntegrationPorts } = require("../../src/runtime/resourceGovernor/integrationPorts");
    const ports = createIntegrationPorts();
    let received = null;
    assert.equal(ports.presenceRuntime.registerPressureListener(p => { received = p; }), true);
    assert.throws(() => ports.presenceRuntime.registerPressureListener(() => {}), /PORT_ALREADY_BOUND/);
    assert.throws(() => ports.watchdog.registerPressureListener("nope"), TypeError);

    const n = ports.actuationFabric.publish([{ type: "PAUSE_BACKGROUND", detail: {} }]);
    assert.equal(n, 0, "unbound port must deliver nothing");

    ports.presenceRuntime.publish([Object.freeze({ type: "REDUCE_CONCURRENCY", detail: { band: "HIGH" } })]);
    assert.equal(received.source, "resource-governor");
    assert.equal(received.recommendations[0].type, "REDUCE_CONCURRENCY");
    assert.equal(Object.isFrozen(received), true);
});

test("hooks: unknown port name fails closed", () => {
    const { createIntegrationPort } = require("../../src/runtime/resourceGovernor/integrationPorts");
    assert.throws(() => createIntegrationPort("skynet"), /UNKNOWN_INTEGRATION_PORT/);
});
