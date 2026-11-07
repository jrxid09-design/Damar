"use strict";

const test = require("node:test");
const { assert, manualClock, FakeObserver, makeGovernor, BASE_CONFIG, demand } = require("./helpers");
const { createWorkloadId } = require("../../src/runtime/resourceGovernor/ids");
const { ADMISSION_OUTCOMES: OUT } = require("../../src/runtime/resourceGovernor/model");

test("lease: admitted lease is frozen and carries full provenance fields", () => {
    const gov = makeGovernor({ config: BASE_CONFIG });
    const d = gov.admit(createWorkloadId("lease-fields"), demand());
    const l = d.lease;
    for (const f of ["leaseId", "workloadId", "workloadClass", "group", "admittedAt", "expiresAt", "reservedDemand", "generation"]) {
        assert.ok(f in l, `missing ${f}`);
    }
    assert.equal(Object.isFrozen(l), true);
    assert.equal(l.generation, 1);
});

test("lease: forged plain-object copy fails release, renew, and account (fail closed)", () => {
    const gov = makeGovernor({ config: BASE_CONFIG });
    const d = gov.admit(createWorkloadId("forge-me"), demand());
    const original = d.lease;

    const serialized = JSON.parse(JSON.stringify({
        kind: original.kind, leaseId: original.leaseId, workloadId: original.workloadId,
        workloadClass: original.workloadClass, group: original.group,
        admittedAt: original.admittedAt, expiresAt: original.expiresAt,
        reservedDemand: original.reservedDemand, generation: original.generation
    }));
    assert.throws(() => gov.release(serialized), /UNKNOWN_LEASE/);
    assert.throws(() => gov.renew(serialized), /UNKNOWN_LEASE/);
    assert.throws(() => gov.account(serialized), /UNKNOWN_LEASE/);

    const shallowCopy = { ...original };
    assert.throws(() => gov.release(shallowCopy), /UNKNOWN_LEASE/);
    assert.equal(gov.getResourceStatus().activeLeases, 1);
});

test("lease: unknown but well-formed id fails closed", () => {
    const gov = makeGovernor({ config: BASE_CONFIG });
    assert.throws(() => gov.release({ kind: "ResourceLease", leaseId: "lease-does-not-exist" }), /UNKNOWN_LEASE/);
    assert.throws(() => gov.release(null), /UNKNOWN_LEASE|not a lease/);
    assert.throws(() => gov.account(undefined), Error);
});

test("lease: double release is harmless — no negative counters", () => {
    const gov = makeGovernor({ config: BASE_CONFIG });
    const { lease } = gov.admit(createWorkloadId("dbl-rel"), demand());
    const first = gov.release(lease);
    const second = gov.release(lease);
    assert.deepEqual(first, { released: true, alreadyReleased: false, leaseId: lease.leaseId });
    assert.deepEqual(second, { released: false, alreadyReleased: true, leaseId: lease.leaseId });
    const st = gov.getResourceStatus();
    assert.equal(st.metrics.released, 1);
    assert.equal(st.activeLeases, 0);
});

test("lease: expiry is reclaimable deterministically via injected clock", () => {
    const clock = manualClock(10_000);
    const gov = makeGovernor({ config: { ...BASE_CONFIG, leaseTtlMs: 5_000 }, clock });
    const { lease } = gov.admit(createWorkloadId("ttl-1"), demand());
    clock.advance(4_999);
    assert.equal(gov.reclaimExpired(clock.nowMs()), 0);
    assert.equal(gov.getResourceStatus().activeLeases, 1);
    clock.advance(2);
    assert.equal(gov.reclaimExpired(clock.nowMs()), 1);
    const st = gov.getResourceStatus();
    assert.equal(st.activeLeases, 0);
    assert.equal(st.metrics.expired, 1);
    assert.throws(() => gov.account(lease), /UNKNOWN_LEASE/);
});

test("lease: renew rotates handle — old handle invalidated, generation increments", () => {
    const clock = manualClock(50_000);
    const gov = makeGovernor({ config: { ...BASE_CONFIG, leaseTtlMs: 10_000 }, clock });
    const { lease } = gov.admit(createWorkloadId("renew-1"), demand());
    clock.advance(9_000);
    const renewed = gov.renew(lease);
    assert.equal(renewed.generation, 2);
    assert.notEqual(renewed.leaseId, lease.leaseId);
    assert.ok(renewed.expiresAt > lease.expiresAt);
    const retired = gov.release(lease);
    assert.deepEqual(retired, {
        released: false, alreadyReleased: true, leaseId: lease.leaseId
    });
    assert.doesNotThrow(() => gov.account(renewed));
});

test("lease: expired slot frees capacity for a queued waiter (promotion)", () => {
    const clock = manualClock(1000);
    const observer = new FakeObserver({ eventLoopLagMs: 2000 });
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, globalConcurrencyLimit: 2, groupLimits: { default: 2 } },
        observer,
        clock
    });
    const a = gov.admit(createWorkloadId("hold-a"), demand({ workloadClass: "INTERACTIVE" }));
    const b = gov.admit(createWorkloadId("hold-b"), demand({ workloadClass: "INTERACTIVE" }));
    const c = gov.admit(createWorkloadId("wait-c"), demand({ workloadClass: "INTERACTIVE" }));
    assert.equal(a.outcome, OUT.ADMIT);
    assert.equal(b.outcome, OUT.ADMIT);
    assert.equal(c.outcome, OUT.QUEUE);
    clock.advance(BASE_CONFIG.leaseTtlMs + 1);
    gov.reclaimExpired(clock.nowMs());
    const st = gov.getResourceStatus();
    assert.equal(st.metrics.expired, 2);
    assert.equal(st.activeLeases, 1);
});
