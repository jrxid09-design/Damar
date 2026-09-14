const test = require("node:test");
const assert = require("node:assert");

const { createAttentionEconomy, BOUNDS } = require("../../../src/cognition/attention");

function manualClock(startMs) {
    let t = startMs;
    return { nowMs: () => t, advance: (ms) => { t += ms; } };
}

function assertThrowsReason(fn, reason) {
    assert.throws(fn, (err) => {
        assert.equal(err.reason, reason, `expected reason '${reason}', got '${err.reason}': ${err.message}`);
        return true;
    });
}

test("AT-repair-12: ingestSignal(null, workKind) is rejected as INVALID_RECORD, not a raw TypeError (independent audit AUD21-ADV-1)", async () => {
    const ae = await createAttentionEconomy();
    assertThrowsReason(() => ae.ingestSignal(null, "PERCEIVE"), "INVALID_RECORD");
});

test("AT-repair-18: a hostile evidenceRef toString is never invoked, and two distinct object evidenceRefs count as two distinct corroboration pairs (independent audit AUD24-P2-3)", async () => {
    const ae = await createAttentionEconomy();
    let called = 0;
    const evil = { originKind: "SYSTEM", toString() { called++; return "x"; } };
    ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s1", subjectRef: { entityId: "e1" }, evidenceRef: evil }, "PERCEIVE");
    assert.equal(called, 0, "evidenceRef's toString must never be invoked during ingest/recompute");

    // Bug review independen (audit putaran-29): tanpa clock manual,
    // effectivePriority's komponen aging (wall-clock nyata) berbeda tipis
    // antara dua instance yang dibuat di saat nyata berbeda, membuat
    // perbandingan persis flaky (kelas yang sama dengan WM-repair-13,
    // putaran-23) -- bukan bug pada logika dedup itu sendiri.
    const control = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tControl } = control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "A" }, "PERCEIVE");
    control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "B" }, "PERCEIVE");
    const objectRefs = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tObj } = objectRefs.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: { ev: "A" } }, "PERCEIVE");
    objectRefs.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: { ev: "B" } }, "PERCEIVE");
    assert.equal(objectRefs.getTarget(tObj).effectivePriority, control.getTarget(tControl).effectivePriority,
        "two distinct object evidenceRefs must count as two distinct corroboration pairs, same as two distinct string evidenceRefs");
});

test("AT-repair-19: hostile toString on workKind/sourceKind/targetId never executes, Symbol variants are rejected as domain errors, and mapToGovernorPriority never coerces a hostile priorityClass (independent audit AUD25-P2-1/AUD25-ADV-2)", async () => {
    const ae = await createAttentionEconomy();
    let calledWorkKind = 0;
    const evilWorkKind = { toString() { calledWorkKind++; return "PERCEIVE"; } };
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" } }, evilWorkKind), "INVALID_RECORD");
    assert.equal(calledWorkKind, 0, "workKind's toString must never be invoked before the enum check");
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" } }, Symbol("w")), "INVALID_RECORD");

    let calledSourceKind = 0;
    const evilSourceKind = { toString() { calledSourceKind++; return "SENSOR"; } };
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: evilSourceKind, sourceId: "s1", subjectRef: { entityId: "e1" } }, "PERCEIVE"), "INVALID_RECORD");
    assert.equal(calledSourceKind, 0, "sourceKind's toString must never be invoked before the enum check");

    let calledTargetId = 0;
    const evilTargetId = { toString() { calledTargetId++; return "nonexistent"; } };
    assertThrowsReason(() => ae.preempt(evilTargetId), "UNKNOWN_TARGET");
    assert.equal(calledTargetId, 0, "an unknown targetId's toString must never be invoked while building the error message");

    let calledPriority = 0;
    const evilPriority = { toString() { calledPriority++; return "CRITICAL"; } };
    assert.equal(ae.toGovernorPriority(evilPriority), "LOW", "a non-string priorityClass must fall back to LOW without coercion");
    assert.equal(calledPriority, 0, "priorityClass's toString must never be invoked while mapping to a governor priority");
    assert.equal(ae.governorMappingAudit().some(e => e.priorityClass === evilPriority), false, "the raw hostile object must never be logged to the audit trail");
});

test("AT-repair-20: two distinct NESTED-object evidenceRefs still count as two distinct corroboration pairs, not just flat ones (independent audit AUD25-P2-2)", async () => {
    // Bug review independen (audit putaran-29): sama seperti AT-repair-18,
    // dibekukan supaya perbandingan tidak flaky karena wall-clock nyata.
    const control = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tControl } = control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "A" }, "PERCEIVE");
    control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "B" }, "PERCEIVE");

    const nested = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tNested } = nested.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: { nested: { x: 1 } } }, "PERCEIVE");
    nested.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: { nested: { x: 2 } } }, "PERCEIVE");
    assert.equal(nested.getTarget(tNested).effectivePriority, control.getTarget(tControl).effectivePriority,
        "two distinct nested-object evidenceRefs must count as two distinct corroboration pairs, same as two distinct string evidenceRefs");
});

test("AT-repair-21: a shared-reference DAG evidenceRef must not cause exponential CPU cost in evidenceRefIdentity (independent audit AUD26-P1-1, BLOCKING)", async () => {
    // Build a DAG where every one of 5 levels has FANOUT keys all pointing
    // at the SAME child object -- a shared reference (not a cycle), the
    // exact shape that made putaran-25's unbudgeted recursion O(fanout^5).
    function sharedDag(fanout, levels) {
        let node = {};
        for (let d = 0; d < levels; d++) {
            const child = node;
            node = {};
            for (let i = 0; i < fanout; i++) node["k" + i] = child;
        }
        return node;
    }
    const ae = await createAttentionEconomy();
    const dag = sharedDag(30, 5);
    const start = process.hrtime.bigint();
    ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" }, evidenceRef: dag }, "PERCEIVE");
    // ingest twice more from the same source to confirm no compounding cost
    ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" }, evidenceRef: dag }, "PERCEIVE");
    ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" }, evidenceRef: dag }, "PERCEIVE");
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 500, `3 ingests of a fanout=30/depth=5 shared-reference DAG took ${elapsedMs}ms, expected well under 500ms with a memoized/budgeted walk`);
});

test("AT-repair-22: two distinct evidenceRefs nested past the recursion depth cap still count as two distinct corroboration pairs (independent audit AUD26-P2-2)", async () => {
    function deepObject(depth, leafValue) {
        let v = { leaf: leafValue };
        for (let i = 0; i < depth; i++) v = { child: v };
        return v;
    }
    // Bug review independen (audit putaran-29): dibekukan supaya
    // perbandingan tidak flaky karena wall-clock nyata.
    const control = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tControl } = control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "A" }, "PERCEIVE");
    control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "B" }, "PERCEIVE");

    const deep = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tDeep } = deep.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: deepObject(6, "A") }, "PERCEIVE");
    deep.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: deepObject(6, "B") }, "PERCEIVE");
    assert.equal(deep.getTarget(tDeep).effectivePriority, control.getTarget(tControl).effectivePriority,
        "two distinct evidenceRefs nested past the recursion depth cap must still count as two distinct corroboration pairs");
});

test("AT-repair-23: mapToGovernorPriority never returns an inherited Object.prototype member for a prototype-shaped priorityClass string, and makeTarget rejects a Symbol workKind (independent audit AUD26-P2-3/AUD26-P2-1)", async () => {
    const ae = await createAttentionEconomy();
    for (const hostileClass of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        assert.equal(ae.toGovernorPriority(hostileClass), "LOW", `toGovernorPriority('${hostileClass}') must fall back to LOW, not an inherited Object.prototype member`);
    }
    assert.equal(ae.governorMappingAudit().every(e => typeof e.mapped === "string"), true, "every audit entry's mapped value must be a string");
});

test("AT-repair-24: replaying the SAME object evidenceRef from the same source is one corroboration pair, not N (independent audit AUD27-P2-3)", async () => {
    // Bug review independen (audit putaran-29): dibekukan supaya
    // perbandingan tidak flaky karena wall-clock nyata.
    const ae = await createAttentionEconomy({ clock: manualClock(1000) });
    const obj = { ev: "X" };
    const { targetId } = ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s", subjectRef: { entityId: "z" }, evidenceRef: obj }, "PERCEIVE");
    for (let i = 0; i < 6; i++) {
        ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s", subjectRef: { entityId: "z" }, evidenceRef: obj }, "PERCEIVE");
    }
    const one = await createAttentionEconomy({ clock: manualClock(1000) });
    const single = one.ingestSignal({ sourceKind: "SENSOR", sourceId: "s", subjectRef: { entityId: "z" }, evidenceRef: { ev: "X" } }, "PERCEIVE");
    assert.equal(ae.getTarget(targetId).effectivePriority, one.getTarget(single.targetId).effectivePriority,
        "replaying the same evidenceRef object reference must not inflate corroboration past a single pair");
});

test("AT-repair-25: a replayed signalId is not counted twice (independent audit AUD27-P2-7)", async () => {
    const ae = await createAttentionEconomy();
    const ev = { e: 1 };
    ae.ingestSignal({ signalId: "S", sourceKind: "SENSOR", sourceId: "s", subjectRef: { entityId: "e" }, evidenceRef: ev }, "PERCEIVE");
    const r = ae.ingestSignal({ signalId: "S", sourceKind: "SENSOR", sourceId: "s", subjectRef: { entityId: "e" }, evidenceRef: ev }, "PERCEIVE");
    assert.equal(ae.supportingSignalCount(r.targetId), 1, "a replayed signalId must not add a second support entry");
});

test("AT-repair-26: a Symbol/hostile-object proposedUrgency is rejected as INVALID_RECORD, not a raw TypeError, and never invokes caller valueOf (independent audit AUD28-P2-2)", async () => {
    const ae = await createAttentionEconomy();
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "AGENT", sourceId: "s", subjectRef: { entityId: "e" }, proposedUrgency: Symbol("u") }, "REASON"), "INVALID_RECORD");
    let called = 0;
    const evil = { valueOf() { called++; return 0.5; } };
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "AGENT", sourceId: "s", subjectRef: { entityId: "e" }, proposedUrgency: evil }, "REASON"), "INVALID_RECORD");
    assert.equal(called, 0, "proposedUrgency's valueOf must never be invoked before the type check");
});

test("AT-repair-28: evidenceRef is read exactly once in ingestSignal, so the corroboration identity always describes the same object that is actually stored (independent audit AUD33-ADV-1)", async () => {
    const ae = await createAttentionEconomy();
    let n = 0;
    const objA = { ev: "A" };
    const objB = { ev: "B" };
    const spec = { sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" } };
    Object.defineProperty(spec, "evidenceRef", { enumerable: true, configurable: true, get() { n++; return n === 1 ? objA : objB; } });
    const { signal } = ae.ingestSignal(spec, "PERCEIVE");
    assert.equal(n, 1, "evidenceRef must be read exactly once");
    assert.deepEqual(signal.evidenceRef, objA, "the stored evidenceRef must come from the same read that the corroboration identity was computed from");
});

test("AT-repair-29: a BigInt or non-finite number nested in subjectRef/evidenceRef is rejected, matching the sanitizer parity every other lane already has (independent audit AUD34-ADV-4)", async () => {
    const ae = await createAttentionEconomy();
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s1", subjectRef: { entityId: "e1", n: 10n } }, "PERCEIVE"), "EXECUTABLE_MATERIAL_REJECTED");
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s2", subjectRef: { entityId: "e1" }, evidenceRef: { n: Infinity } }, "PERCEIVE"), "EXECUTABLE_MATERIAL_REJECTED");
    // A hostile toString/toJSON must still be tolerated as inert data (deliberate contract, AT-repair-5/18).
    let called = 0;
    const evil = { entityId: "e1", toString() { called++; return "x"; } };
    assert.doesNotThrow(() => ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s3", subjectRef: evil }, "PERCEIVE"));
    assert.equal(called, 0);
});

test("AT-repair-31: targetKey reads subjectRef.entityId exactly once (independent audit AUD35-ADV-4)", async () => {
    const { targetKey } = require("../../../src/cognition/attention");
    let n = 0;
    const subjectRef = {};
    Object.defineProperty(subjectRef, "entityId", { enumerable: true, configurable: true, get() { n++; return "e1"; } });
    const key = targetKey(subjectRef, "PERCEIVE");
    assert.equal(n, 1, "subjectRef.entityId must be read exactly once");
    assert.equal(key, "entity:e1::PERCEIVE");
});

test("AT-repair-38: deepFreeze's fail-closed catch itself does not raw-throw when the caught value is a hostile object whose own inspection throws (independent audit W7R44-P2-1)", async () => {
    const ae = await createAttentionEconomy();
    const h = new Proxy({}, { getPrototypeOf() { throw new Error("RAW"); } });
    const hostile = new Proxy({}, {
        getOwnPropertyDescriptor() { throw h; },
        ownKeys() { return ["a"]; },
        getPrototypeOf() { return Object.prototype; }
    });
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s1", subjectRef: hostile }, "PERCEIVE"), "EXECUTABLE_MATERIAL_REJECTED");
});

test("AT-repair-39: ingestSignal fails closed (not raw-throw) on a revoked-Proxy TOP-LEVEL spec argument (independent audit W7R44-P2-2)", async () => {
    const ae = await createAttentionEconomy();
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsReason(() => ae.ingestSignal(r.proxy, "PERCEIVE"), "INVALID_RECORD");
});

test("AT-repair-37: a revoked-Proxy OBJECT evidenceRef (and subjectRef) fails closed with a controlled domain reason instead of a raw TypeError (independent audit AUD41-P2-3)", async () => {
    const ae = await createAttentionEconomy();
    const r1 = Proxy.revocable({ originKind: "SAFETY_MONITOR" }, {});
    r1.revoke();
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s1", subjectRef: { entityId: "e" }, evidenceRef: r1.proxy }, "PERCEIVE"), "EXECUTABLE_MATERIAL_REJECTED");

    const r2 = Proxy.revocable({ entityId: "e" }, {});
    r2.revoke();
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s2", subjectRef: r2.proxy }, "PERCEIVE"), "EXECUTABLE_MATERIAL_REJECTED");
});

test("AT-repair-36: assignPriorityClass never reads originKind/ownerTrustVerified off a function evidenceRef -- a Proxy-wrapped function's trap never fires, and a revoked Proxy never raw-throws (independent audit AUD40-P2-1)", async () => {
    const ae = await createAttentionEconomy();
    const seen = [];
    const p = new Proxy(function () {}, { get(t, k, r) { seen.push(String(k)); return Reflect.get(t, k, r); } });
    const { targetId } = ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s1", subjectRef: { entityId: "e1" }, evidenceRef: p }, "PERCEIVE");
    assert.equal(seen.length, 0, "a function evidenceRef's Proxy trap must never fire during priority assignment");
    assert.notEqual(ae.getTarget(targetId).priorityClass, "P0_SAFETY", "a function evidenceRef must never be able to claim P0_SAFETY");

    const { proxy, revoke } = Proxy.revocable(function () {}, {});
    revoke();
    assert.doesNotThrow(() => ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s2", subjectRef: { entityId: "e1" }, evidenceRef: proxy }, "PERCEIVE"),
        "a revoked-Proxy function evidenceRef must not raw-throw out of ingestSignal");
});

test("AT-repair-35: a function evidenceRef's toString is never invoked, and two SAME-description Symbols / two SAME-source functions still count as two distinct corroboration pairs (independent audit AUD39-P2-1)", async () => {
    const ae = await createAttentionEconomy();
    let called = 0;
    function fn() {}
    fn.toString = function () { called++; return "X"; };
    ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" }, evidenceRef: fn }, "PERCEIVE");
    assert.equal(called, 0, "a function evidenceRef's toString must never be invoked (deliberate contract, AT-repair-18/29)");

    const control = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tControl } = control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "A" }, "PERCEIVE");
    control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "B" }, "PERCEIVE");

    const sameDescSymbols = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tSym } = sameDescSymbols.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: Symbol("x") }, "PERCEIVE");
    sameDescSymbols.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: Symbol("x") }, "PERCEIVE");
    assert.equal(sameDescSymbols.getTarget(tSym).effectivePriority, control.getTarget(tControl).effectivePriority,
        "two distinct Symbol('x') references (same description) must still count as two distinct corroboration pairs");

    const sameSourceFns = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tFn } = sameSourceFns.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: () => {} }, "PERCEIVE");
    sameSourceFns.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: () => {} }, "PERCEIVE");
    assert.equal(sameSourceFns.getTarget(tFn).effectivePriority, control.getTarget(tControl).effectivePriority,
        "two distinct function references with identical source text must still count as two distinct corroboration pairs");
});

test("AT-repair-34: a BigInt evidenceRef is rejected, and two distinct non-object evidenceRefs (e.g. Symbols) still count as two distinct corroboration pairs (independent audit AUD38-ADV-2)", async () => {
    const ae = await createAttentionEconomy();
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" }, evidenceRef: 1n }, "PERCEIVE"), "EXECUTABLE_MATERIAL_REJECTED");

    const control = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tControl } = control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "A" }, "PERCEIVE");
    control.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "B" }, "PERCEIVE");
    const symbolRefs = await createAttentionEconomy({ clock: manualClock(1000) });
    const { targetId: tSym } = symbolRefs.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: Symbol("A") }, "PERCEIVE");
    symbolRefs.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: Symbol("B") }, "PERCEIVE");
    assert.equal(symbolRefs.getTarget(tSym).effectivePriority, control.getTarget(tControl).effectivePriority,
        "two distinct Symbol evidenceRefs must count as two distinct corroboration pairs, same as two distinct string evidenceRefs");
});

test("AT-repair-33: an accessor on ingestSignal's subjectRef/evidenceRef is rejected without being invoked -- deepFreeze receives the raw value, not a pre-spread copy (independent audit AUD37-P2-3)", async () => {
    const ae = await createAttentionEconomy();
    let called = 0;
    const subjectRef = {};
    Object.defineProperty(subjectRef, "entityId", { enumerable: true, configurable: true, get() { called++; throw new Error("must not run"); } });
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef }, "PERCEIVE"), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(called, 0, "deepFreeze must reject the accessor via its property descriptor without ever invoking it");
});

test("AT-repair-32: targetKey preserves the entityId-first short-circuit -- a valid entityId subject's relationId accessor is never invoked (independent audit AUD36-ADV-2)", async () => {
    const { targetKey } = require("../../../src/cognition/attention");
    let called = 0;
    const subjectRef = { entityId: "e1" };
    Object.defineProperty(subjectRef, "relationId", { enumerable: true, configurable: true, get() { called++; throw new Error("hostile relationId getter executed"); } });
    const key = targetKey(subjectRef, "PERCEIVE");
    assert.equal(key, "entity:e1::PERCEIVE");
    assert.equal(called, 0, "relationId must never be read when entityId already resolved the key");
});

test("AT-repair-30: a governorPort.capacity() that returns NaN/Infinity falls back to bounds.MAX_RUNNING_TARGETS instead of disabling the floor (independent audit AUD34-ADV-5c)", async () => {
    const clock = manualClock(0);
    const governorPort = { capacity: () => NaN };
    const ae = await createAttentionEconomy({ clock, governorPort, bounds: { ...BOUNDS, MAX_RUNNING_TARGETS: 1 } });
    ae.ingestSignal({ sourceKind: "OWNER", sourceId: "o1", subjectRef: { entityId: "t1" } }, "REASON");
    ae.ingestSignal({ sourceKind: "OWNER", sourceId: "o2", subjectRef: { entityId: "t2" } }, "REASON");
    const first = ae.pick();
    assert.ok(first, "the first pick must succeed");
    const second = ae.pick();
    assert.equal(second, null, "a NaN governor capacity must not disable the MAX_RUNNING_TARGETS floor");
});

test("AT-repair-27: a non-finite expiresAtMs (Infinity/NaN) is rejected, not stored raw (independent audit AUD32-ADV-2)", async () => {
    const ae = await createAttentionEconomy();
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s1", subjectRef: { entityId: "e1" }, expiresAtMs: Infinity }, "PERCEIVE"), "INVALID_RECORD");
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s2", subjectRef: { entityId: "e1" }, expiresAtMs: NaN }, "PERCEIVE"), "INVALID_RECORD");
});

test("AT-A1: salience flooding from one sensor is rate-capped and the source marked noisy", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_SIGNALS_PER_SOURCE_PER_MINUTE: 3 } });
    for (let i = 0; i < 3; i++) {
        ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "sensor-1", subjectRef: { entityId: "e1" } }, "PERCEIVE");
    }
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "sensor-1", subjectRef: { entityId: "e1" } }, "PERCEIVE"),
        "SIGNAL_RATE_EXCEEDED");
    assert.equal(ae.isNoisySource("sensor-1"), true);
});

test("AT-repair-9: an invalid workKind must not create/charge a rate-limit slot (independent audit AUD14-P2-2)", async () => {
    const ae = await createAttentionEconomy();
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" } }, "BOGUS_WORK_KIND"), "INVALID_RECORD");
    assert.equal(ae.trackedSourceCount(), 0);
});

test("AT-repair-8: an invalid subjectRef must not create/charge a rate-limit slot or mark the source noisy (independent audit AUD12-P2-4)", async () => {
    const ae = await createAttentionEconomy();
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { bad: true } }, "PERCEIVE"), "INVALID_RECORD");
    assert.equal(ae.trackedSourceCount(), 0);
    assert.equal(ae.isNoisySource("s1"), false);
});

test("AT-repair-7: a rejected (invalid) signal must not consume per-source rate budget before validation (independent audit AUD11-P2-9)", async () => {
    const ae = await createAttentionEconomy();
    assert.throws(() => ae.ingestSignal({ sourceKind: "SENSOR" /* no sourceId, no subjectRef */ }, "PERCEIVE"));
    assert.equal(ae.trackedSourceCount(), 0, "an invalid signal must not create/charge a rate-limit slot");
});

test("AT-repair-6: a malformed subjectRef (neither entityId nor relationId) is rejected, not silently collapsed into another target's key (independent audit AUD10-P2-3)", async () => {
    const ae = await createAttentionEconomy();
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { kind: "alpha", id: "A" } }, "PERCEIVE"), "INVALID_RECORD");
    const a = ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { relationId: "rA" } }, "PERCEIVE");
    const b = ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { relationId: "rB" } }, "PERCEIVE");
    assert.notEqual(a.targetId, b.targetId, "two distinct relationId subjects must not collapse to the same target");
});

test("AT-repair-5: a hostile toJSON on subjectRef is never invoked while keying/deduping targets (independent audit AUD9-P2-2)", async () => {
    const ae = await createAttentionEconomy();
    let toJSONCalls = 0;
    const subjectRef = { entityId: "e1", toJSON() { toJSONCalls++; throw new Error("executed"); } };
    assert.doesNotThrow(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef }, "PERCEIVE"));
    assert.equal(toJSONCalls, 0, "toJSON on caller-supplied subjectRef must never execute inside the cognition process");
});

test("AT-A2: corroboration counts distinct source+evidence pairs, not repeated messengers", async () => {
    const ae = await createAttentionEconomy();
    const { targetId } = ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "ev-1" }, "PERCEIVE");
    for (let i = 0; i < 5; i++) {
        ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "ev-1" }, "PERCEIVE");
    }
    const withRepeats = ae.getTarget(targetId).effectivePriority;

    const ae2 = await createAttentionEconomy();
    const { targetId: t2 } = ae2.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-A", subjectRef: { entityId: "e1" }, evidenceRef: "ev-A" }, "PERCEIVE");
    ae2.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-B", subjectRef: { entityId: "e1" }, evidenceRef: "ev-B" }, "PERCEIVE");
    const withDistinct = ae2.getTarget(t2).effectivePriority;

    assert.ok(withDistinct > withRepeats, "sumber+bukti berbeda menaikkan prioritas lebih dari pesan berulang");
});

test("AT-repair-1: supporting signals per target are bounded across many distinct sources (Codex P1 round 9)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_SUPPORTING_SIGNALS_PER_TARGET: 3 } });
    let targetId;
    for (let i = 0; i < 10; i++) {
        ({ targetId } = ae.ingestSignal(
            { sourceKind: "SENSOR", sourceId: `adapter-${i}`, subjectRef: { entityId: "e1" }, evidenceRef: `ev-${i}` },
            "PERCEIVE"
        ));
    }
    assert.equal(ae.supportingSignalCount(targetId), 3,
        "dukungan per target tidak boleh tumbuh tanpa batas walau tiap sourceId berbeda");
});

test("AT-repair-2: total targets are bounded, not just queued ones (independent audit AUD-P1-3)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_QUEUED_TARGETS: 2, MAX_TOTAL_TARGETS: 10 } });
    const ids = [];
    for (let i = 0; i < 50; i++) {
        ids.push(ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s", subjectRef: { entityId: "e" + i } }, "MAINTAIN").targetId);
    }
    const resident = ids.filter(id => ae.getTarget(id) !== null).length;
    assert.ok(resident <= 10, "target yang didemosi/selesai harus benar-benar dihapus setelah melewati MAX_TOTAL_TARGETS, bukan hanya diberi label DEFERRED selamanya");
});

test("AT-repair-3: tracked-source rate-limiting state is bounded across many distinct sources (independent audit AUD2-P2-2)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_TRACKED_SOURCES: 5 } });
    for (let i = 0; i < 50; i++) {
        ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s" + i, subjectRef: { entityId: "e" + i } }, "MAINTAIN");
    }
    assert.ok(ae.trackedSourceCount() <= 5, "signalsBySource tidak boleh tumbuh tanpa batas walau sourceId berbeda-beda");
});

test("AT-repair-4: the governor-mapping audit journal is bounded (independent audit AUD2-P2-2)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_GOVERNOR_MAPPING_AUDIT: 5 } });
    for (let i = 0; i < 50; i++) ae.toGovernorPriority("P3_GOAL");
    assert.ok(ae.governorMappingAudit().length <= 5, "governorMappingAudit tidak boleh tumbuh tanpa batas");
});

test("AT-A5-repair: a pick() blocked by full capacity never consumes the winning class's scheduling credit (Codex P2 round 5)", async () => {
    const clock = manualClock(0);
    let capacity = 0;
    const governorPort = { capacity: () => capacity };
    const ae = await createAttentionEconomy({ clock, governorPort });
    ae.ingestSignal({ sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "owner-task" } }, "REASON");
    ae.ingestSignal({ sourceKind: "AGENT", sourceId: "agent-1", subjectRef: { entityId: "agent-task" } }, "REASON");

    // Kapasitas penuh: pick() harus null DAN tidak boleh diam-diam menguras
    // giliran kelas pemenang (P1_OWNER, kuota 35 > P4_BACKGROUND, kuota 10).
    assert.equal(ae.pick(), null);

    capacity = 1;
    const started = ae.pick();
    assert.ok(started, "harus ada target yang jalan begitu kapasitas terbuka");
    assert.equal(started.priorityClass, "P1_OWNER",
        "P1_OWNER tetap menang giliran pertama -- percobaan pick() yang diblokir kapasitas tidak boleh mengonsumsi kredit");
});

test("AT-A3: no signal field can set P0_SAFETY directly — only allowlisted origin can", async () => {
    const ae = await createAttentionEconomy();
    const { targetId } = ae.ingestSignal({
        sourceKind: "AGENT", sourceId: "attacker", subjectRef: { entityId: "e1" },
        proposedUrgency: 1, evidenceRef: { originKind: "SAFETY_MONITOR", priorityClass: "P0_SAFETY" }
        // note: an AGENT source can never reach P0 even if it forges the evidence shape.
    }, "REASON");
    assert.notEqual(ae.getTarget(targetId).priorityClass, "P0_SAFETY", "AGENT tidak pernah mencapai P0 walau evidence dipalsukan");
});

test("AT-A4: danger signal (high urgency) never maps to any authority scope", async () => {
    const ae = await createAttentionEconomy();
    const { targetId } = ae.ingestSignal({
        sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" }, proposedUrgency: 1
    }, "VERIFY");
    const target = ae.getTarget(targetId);
    assert.equal(Object.prototype.hasOwnProperty.call(target, "authorityScope"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(target, "grant"), false);
});

test("AT-A5: background flood cannot starve owner work — aging guarantee forces eventual scheduling", async () => {
    const clock = manualClock(0);
    const ae = await createAttentionEconomy({ clock, bounds: { ...BOUNDS, MAX_QUEUED_TARGETS: 5000 } });
    for (let i = 0; i < 500; i++) {
        ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: `bg-${i}`, subjectRef: { entityId: `bg${i}` } }, "MAINTAIN");
    }
    const { targetId: ownerTargetId } = ae.ingestSignal({ sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "owner-work" } }, "REASON");
    clock.advance(BOUNDS.MAX_WAIT_MS + 1);
    const picked = ae.pick();
    assert.equal(picked.targetId, ownerTargetId, "jaminan aging memilih target yang sudah menunggu >= MAX_WAIT_MS");
});

test("AT-A6/AT-A7: MAX_PREEMPTIONS caps repeated preemption of the same target (livelock defense)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_PREEMPTIONS: 1 } });
    const { targetId } = ae.ingestSignal({ sourceKind: "GOAL", sourceId: "g1", subjectRef: { entityId: "e1" } }, "PLAN");
    ae.pick();
    ae.preempt(targetId);
    assertThrowsReason(() => ae.preempt(targetId), "PREEMPTION_LIMIT_EXCEEDED");
});

test("AT-A8: silent discard is impossible — overflow journal accounts for every deferred target", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_QUEUED_TARGETS: 2 } });
    ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s1", subjectRef: { entityId: "e1" } }, "MAINTAIN");
    ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s2", subjectRef: { entityId: "e2" } }, "MAINTAIN");
    ae.ingestSignal({ sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "e3" } }, "REASON");
    assert.equal(ae.overflowCount(), 1);
    assert.equal(ae.overflowEntries().length, 1);
});

test("AT-repair-10: ingestSignal never returns a targetId that its own overflow purge just deleted (independent audit AUD18-P2-3)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_TOTAL_TARGETS: 1, MAX_QUEUED_TARGETS: 1 } });
    ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" } }, "PERCEIVE");
    ae.pick(); // e1 target now RUNNING
    const { targetId } = ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s2", subjectRef: { entityId: "e2" } }, "PERCEIVE");
    assert.notEqual(ae.getTarget(targetId), null, "ingestSignal must never return a targetId already purged by its own MAX_TOTAL_TARGETS eviction");
});

test("AT-repair-11: MAX_TOTAL_TARGETS stays enforceable even once many targets are RUNNING with no governorPort (independent audit AUD19-P2-1)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_TOTAL_TARGETS: 2, MAX_QUEUED_TARGETS: 1, MAX_RUNNING_TARGETS: 1 } });
    const ids = [];
    for (let i = 0; i < 6; i++) {
        const { targetId } = ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s" + i, subjectRef: { entityId: "e" + i } }, "PERCEIVE");
        ids.push(targetId);
        ae.pick();
    }
    const live = ids.filter(id => ae.getTarget(id) !== null).length;
    assert.ok(live <= 3, "targets must stay bounded even when every non-RUNNING candidate keeps getting picked into RUNNING");
});

test("AT-A9: an uncorroborated agent urgency claim never jumps the queue above owner work", async () => {
    const ae = await createAttentionEconomy();
    const { targetId: agentTarget } = ae.ingestSignal({
        sourceKind: "AGENT", sourceId: "agent-1", subjectRef: { entityId: "e-agent" }, proposedUrgency: 1
    }, "REASON");
    const { targetId: ownerTarget } = ae.ingestSignal({
        sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "e-owner" }
    }, "REASON");
    assert.equal(ae.getTarget(agentTarget).priorityClass, "P4_BACKGROUND");
    assert.equal(ae.getTarget(ownerTarget).priorityClass, "P1_OWNER");
});

test("AT-A10: stale signal support decays, does not hold priority forever", async () => {
    const clock = manualClock(0);
    const ae = await createAttentionEconomy({ clock });
    const { targetId } = ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" } }, "PERCEIVE");
    const fresh = ae.getTarget(targetId).effectivePriority;
    clock.advance(3_600_000); // 1 hour later, no new supporting signal
    ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s2", subjectRef: { entityId: "e-other" } }, "PERCEIVE"); // trigger a recompute pass
    const stale = ae.getTarget(targetId).effectivePriority;
    assert.ok(stale < fresh, "sinyal basi meluruh, tidak mempertahankan prioritas selamanya");
});
