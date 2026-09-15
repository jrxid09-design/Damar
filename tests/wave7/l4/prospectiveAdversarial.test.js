const test = require("node:test");
const assert = require("node:assert");

const { createProspectiveMemory, BOUNDS } = require("../../../src/cognition/prospective");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

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

function fakeLengthArray(items, badLen) {
    return new Proxy(items.slice(), {
        get(t, p, r) { return p === "length" ? badLen : Reflect.get(t, p, r); }
    });
}

function hostileThrowObj() {
    const h = new Proxy({}, { getPrototypeOf() { throw new Error("RAW"); } });
    return new Proxy({}, {
        getOwnPropertyDescriptor() { throw h; },
        ownKeys() { return ["a"]; },
        getPrototypeOf() { return Object.prototype; }
    });
}

test("PM-repair-22: arm(null) is rejected as INVALID_RECORD, not a raw TypeError (independent audit AUD21-ADV-1)", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.arm(null), "INVALID_RECORD");
});

test("PM-repair-61: arm()'s payloadRef honors a caller-sanctioned override of MAX_PAYLOAD_ARRAY_LENGTH -- buildSafePayloadRef/validatePayloadRef read the module's fixed BOUNDS constant directly instead of the sanitized per-instance bounds (independent audit round 65, Codex, AUD65-P2-1, escalation of a round-64 disclosed-but-unfixed item)", async () => {
    const pm = await createProspectiveMemory({ bounds: { MAX_PAYLOAD_ARRAY_LENGTH: 1 } });
    assertThrowsReason(() => pm.arm({
        reminderId: "m1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: "2030-01-01T00:00:00.000Z" },
        payloadRef: { list: [1, 2, 3] }
    }), "PAYLOAD_TOO_LARGE");
});

test("PM-repair-62: arm()'s trigger.extra and MAX_RECURRENCE_OCCURRENCES, and armExpectation()'s window.extra, all honor a caller-sanctioned bounds override -- round 65 only threaded bounds through makeReminder's payloadRef, missing validateTrigger/makeExpectation's OWN buildSafePayloadRef calls and the recurrence-validation reads (independent audit round 66, Codex, W7R66-P2-1, escalation of a round-65 disclosed-but-unfixed item)", async () => {
    const pmArr = await createProspectiveMemory({ bounds: { MAX_PAYLOAD_ARRAY_LENGTH: 1 } });
    assertThrowsReason(() => pmArr.arm({
        reminderId: "m2", wakeClass: "NOTIFY_OWNER",
        trigger: { kind: "AT", at: "2030-01-01T00:00:00.000Z", extra: [1, 2, 3] }
    }), "PAYLOAD_TOO_LARGE");

    const pmRecur = await createProspectiveMemory({ bounds: { MAX_RECURRENCE_OCCURRENCES: 1 } });
    assertThrowsReason(() => pmRecur.arm({
        reminderId: "m3", wakeClass: "NOTIFY_OWNER",
        trigger: { kind: "RECURRING", intervalMs: 120_000, maxOccurrences: 2 }
    }), "RECURRENCE_UNBOUNDED");

    const pmWin = await createProspectiveMemory({ bounds: { MAX_PAYLOAD_ARRAY_LENGTH: 1 } });
    assertThrowsReason(() => pmWin.armExpectation({
        subject: { entityId: "e1" }, attribute: "status", expectedValue: "done",
        window: { latestAt: new Date(1000).toISOString(), extra: [1, 2, 3] }
    }), "PAYLOAD_TOO_LARGE");
});

test("PM-repair-63: an AT trigger with a stateful getter for a non-named ('extra', rest-captured) field is rejected without the getter ever being invoked -- validateTrigger's old rest-destructure (...triggerRest) performed an ordinary [[Get]]/rest-spread over every property of trigger, executing any accessor before any sanitization; the whole trigger is now copied via property descriptor FIRST, rejecting accessors closed (independent audit round 67, Codex, AUD67-P2-3)", async () => {
    const pm = await createProspectiveMemory();
    let n = 0;
    const trigger = { kind: "AT", at: new Date(9e12).toISOString() };
    Object.defineProperty(trigger, "extra", { enumerable: true, configurable: true, get() { n++; return "x"; } });
    assertThrowsReason(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "trigger.extra's getter must never be invoked");
});

test("PM-repair-64: an AT trigger carrying an enumerable data property '__proto__' is rejected, not silently accepted with the value dropped -- validateTrigger's descriptor-copy accumulator was a plain {} literal, so `safeTrigger['__proto__'] = desc.value` set the accumulator's PROTOTYPE instead of an own property, hiding the dangerous key from downstream validation entirely (independent audit round 68, Codex, AUD68-P2-1)", async () => {
    const pm = await createProspectiveMemory();
    const trigger = { kind: "AT", at: new Date(9e12).toISOString() };
    Object.defineProperty(trigger, "__proto__", { enumerable: true, configurable: true, value: { capabilityId: "forged" } });
    assertThrowsReason(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-repair-65: armExpectation's window with a stateful getter for a non-named ('extra', rest-captured) field is rejected without the getter ever being invoked -- makeExpectation's old rest-destructure (...windowRest) performed an ordinary [[Get]]/rest-spread over every property of window, executing any accessor before buildSafePayloadRef could sanitize it; window is now sanitized via buildSafePayloadRef FIRST, and latestAt/earliestAt are derived from that safe copy (independent audit round 68, Codex, AUD68-P2-2)", async () => {
    const pm = await createProspectiveMemory();
    let n = 0;
    const window = { latestAt: new Date(9e12).toISOString() };
    Object.defineProperty(window, "extra", { enumerable: true, configurable: true, get() { n++; return { authProof: "forged" }; } });
    assertThrowsReason(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: "a", expectedValue: 1, window }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "window.extra's getter must never be invoked");
});

test("PM-repair-66: a reloaded snapshot's firedOccurrenceIds is compacted to the ACTIVE MAX_FIRED_OCCURRENCE_IDS bound at construction, not left oversized from a prior process that ran under a larger bound -- the runtime eviction in fireReminder() only trims ONE entry per call (sufficient for a size that grows by at most one at a time), but never runs at all between a restart and the next fireReminder() call (independent audit round 71, Codex, AUD71-P2-2)", async () => {
    const store = createMemoryAccStore();
    const clock1 = manualClock(0);
    const pm1 = await createProspectiveMemory({ clock: clock1, store, bounds: { ...BOUNDS, MAX_RECURRENCE_OCCURRENCES: 50, MAX_FIRED_OCCURRENCE_IDS: 100 } });
    pm1.arm({ reminderId: "R", wakeClass: "MAINTENANCE", trigger: { kind: "RECURRING", intervalMs: 60_000, maxOccurrences: 50 } });
    for (let i = 0; i < 50; i++) {
        clock1.advance(60_001);
        pm1.tick();
    }
    assert.equal(pm1.firedOccurrenceIdsSize(), 50);
    await pm1.persist();

    const pm2 = await createProspectiveMemory({ store, bounds: { ...BOUNDS, MAX_FIRED_OCCURRENCE_IDS: 10 } });
    assert.ok(pm2.firedOccurrenceIdsSize() <= 10, "a reloaded firedOccurrenceIds must be compacted to the ACTIVE (possibly lower) bound at construction time");
});

test("PM-repair-23: armExpectation(null) is rejected as INVALID_RECORD, not a raw TypeError -- arm()'s sibling in the same file was missed in round 21 (independent audit AUD22-F-4)", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.armExpectation(null), "INVALID_RECORD");
});

test("PM-repair-30: an ON_STATE trigger with subject:null is rejected instead of silently accepted as {} (independent audit AUD24-P2-4)", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.arm({
        reminderId: "R-null-subject", wakeClass: "NOTIFY_OWNER",
        trigger: { kind: "ON_STATE", subject: null, attribute: "status" }
    }), "INVALID_TRIGGER");
});

test("PM-repair-31: a hostile toString on trigger.kind never executes, and a Symbol trigger.kind is rejected as a domain error, not a raw TypeError (independent audit AUD25-P2-1)", async () => {
    const pm = await createProspectiveMemory();
    let called = 0;
    const evil = { toString() { called++; return "AT"; } };
    assertThrowsReason(() => pm.arm({ reminderId: "R", wakeClass: "NOTIFY_OWNER", trigger: { kind: evil, at: new Date(1).toISOString() } }), "INVALID_TRIGGER");
    assert.equal(called, 0, "trigger.kind's toString must never be invoked before the enum check");
    assertThrowsReason(() => pm.arm({ reminderId: "R2", wakeClass: "NOTIFY_OWNER", trigger: { kind: Symbol("k") } }), "INVALID_TRIGGER");
});

test("PM-repair-32: a Symbol wakeClass is rejected as INVALID_RECORD, not a raw TypeError (independent audit AUD26-P2-1)", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.arm({
        reminderId: "R", trigger: { kind: "AT", at: new Date(Date.now() + 60_000).toISOString() }, wakeClass: Symbol("w")
    }), "INVALID_RECORD");
});

test("PM-repair-34: reminderId is read exactly once, so a stateful getter cannot leak armed capacity via inconsistent reads (independent audit AUD30-P2-1)", async () => {
    const pm = await createProspectiveMemory({ bounds: { ...BOUNDS, MAX_ARMED_REMINDERS: 1 } });
    pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(5000).toISOString() } });

    let n = 0;
    const spec = { wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(6000).toISOString() } };
    Object.defineProperty(spec, "reminderId", { enumerable: true, configurable: true, get() { n++; return "R1"; } });
    assertThrowsReason(() => pm.arm(spec), "DUPLICATE_RECORD_ID");
    assert.equal(n, 1, "reminderId must be read exactly once");
    assert.equal(pm.reminderCount(), 1, "the existing reminder must not be double-counted or overwritten");
});

test("PM-repair-60: armExpectation retains ZERO pending expectations when MAX_PENDING_EXPECTATIONS is 0 -- the empty-eviction-search guard (if (oldest)) already prevented a raw-throw, but the newly built expectation was still stored unconditionally afterward, silently exceeding a sanctioned zero cap (independent audit round 59, Codex, W7R59-P2-3)", async () => {
    const pm = await createProspectiveMemory({ clock: manualClock(100), bounds: { MAX_PENDING_EXPECTATIONS: 0 } });
    pm.armExpectation({
        subject: { entityId: "e1" }, attribute: "status", expectedValue: "done",
        window: { latestAt: new Date(1000).toISOString() }
    });
    const results = pm.checkExpectations(() => ({ value: "done", atMs: 500 }));
    assert.equal(results.length, 0, "tidak ada expectation yang boleh dipertahankan pada kapasitas 0");
});

test("PM-repair-33: an expectation with no earliestAt is satisfied by ANY observation at or before latestAt, not just ones after year 2000 (independent audit AUD30-P2-4)", async () => {
    const pm = await createProspectiveMemory({ clock: manualClock(100) });
    pm.armExpectation({
        subject: { entityId: "e1" }, attribute: "status", expectedValue: "done",
        window: { latestAt: new Date(1000).toISOString() } // earliestAt omitted
    });
    const results = pm.checkExpectations(() => ({ value: "done", atMs: 500 }));
    assert.equal(results[0].outcome, "SATISFIED", "an omitted earliestAt must mean no lower bound (epoch), not 'after year 2000'");
});

test("PM-repair-35: an object-valued expectation is SATISFIED by a structurally-equal observation, not just a reference-identical one (independent audit AUD31-P2-2)", async () => {
    const pm = await createProspectiveMemory({ clock: manualClock(100) });
    pm.armExpectation({
        subject: { entityId: "e1" }, attribute: "status", expectedValue: { nested: { deep: "orig" } },
        window: { latestAt: new Date(1000).toISOString() }
    });
    const results = pm.checkExpectations(() => ({ value: { nested: { deep: "orig" } }, atMs: 500 }));
    assert.equal(results[0].outcome, "SATISFIED", "a structurally-equal object value must satisfy the expectation, not require reference identity");
});

test("PM-repair-57: checkOnStateReminders never raw-throws on a throwing/revoked evaluate port and keeps sweeping the remaining ON_STATE reminders -- the exact sibling of checkExpectations's own evaluatePort fix, one function away in the same file (independent audit W7R51-P2-1)", async () => {
    const pm = await createProspectiveMemory({ clock: manualClock(0) });
    pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "ON_STATE", subject: { entityId: "e1" }, attribute: "status" } });
    assert.doesNotThrow(() => pm.checkOnStateReminders(() => { throw new Error("port refuses"); }));
    const { proxy, revoke } = Proxy.revocable(function () {}, {});
    revoke();
    assert.doesNotThrow(() => pm.checkOnStateReminders(proxy));
});

test("PM-repair-58: tick() never raw-throws on a throwing/revoked goalStatusPort and keeps firing due reminders (independent audit W7R51-P2-2)", async () => {
    const c = manualClock(0);
    const pm = await createProspectiveMemory({ clock: c });
    pm.arm({ reminderId: "R1", ownerRef: "g1", wakeClass: "RESUME_GOAL", trigger: { kind: "AT", at: new Date(1000).toISOString() } });
    c.advance(1500);
    assert.doesNotThrow(() => pm.tick({ isTerminal: () => { throw new Error("refuses"); } }));
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.doesNotThrow(() => pm.tick(proxy));
});

test("PM-repair-59: createProspectiveMemory never raw-throws on a revoked/throwing clock or bounds -- normalized once at construction (independent audit AUD53-P2-2)", async () => {
    const rev = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    await assert.doesNotReject(() => createProspectiveMemory({ clock: rev() }));
    await assert.doesNotReject(() => createProspectiveMemory({ bounds: rev() }));
    const pm = await createProspectiveMemory({ clock: { nowMs() { throw new Error("x"); } } });
    assert.doesNotThrow(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(Date.now() + 60000).toISOString() } }));
});

test("PM-repair-56: checkExpectations never raw-throws when the evaluate port returns a revoked Proxy, throws itself, or returns an object with a throwing value/atMs getter -- treated as 'not observed', the sweep continues for other expectations (independent audit W7R50-P2-1)", async () => {
    const pm = await createProspectiveMemory({ clock: manualClock(100) });
    pm.armExpectation({ subject: { entityId: "e1" }, attribute: "status", expectedValue: "done", window: { latestAt: new Date(1000).toISOString() } });

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.doesNotThrow(() => pm.checkExpectations(() => proxy));

    assert.doesNotThrow(() => pm.checkExpectations(() => { throw new Error("port refuses"); }));

    const hostileValue = {};
    Object.defineProperty(hostileValue, "value", { enumerable: true, get() { throw new Error("RAW-value"); } });
    assert.doesNotThrow(() => pm.checkExpectations(() => hostileValue));

    const hostileAt = { value: "done" };
    Object.defineProperty(hostileAt, "atMs", { enumerable: true, get() { throw new Error("RAW-atMs"); } });
    assert.doesNotThrow(() => pm.checkExpectations(() => hostileAt));

    // sanity: a legitimate observation still satisfies afterward
    const results = pm.checkExpectations(() => ({ value: "done", atMs: 500 }));
    assert.equal(results[0].outcome, "SATISFIED");
});

test("PM-repair-37: checkExpectations never crashes or falsely SATISFIES on a BigInt/cyclic/NaN/Infinity observed value from the evaluate port (independent audit AUD32-P1-1, BLOCKING)", async () => {
    const pm1 = await createProspectiveMemory({ clock: manualClock(100) });
    pm1.armExpectation({ subject: { entityId: "e1" }, attribute: "status", expectedValue: null, window: { latestAt: new Date(1000).toISOString() } });
    const r1 = pm1.checkExpectations(() => ({ value: NaN, atMs: 500 }));
    assert.deepEqual(r1, [], "NaN observed must never satisfy an expectedValue of null");

    const pm2 = await createProspectiveMemory({ clock: manualClock(100) });
    pm2.armExpectation({ subject: { entityId: "e1" }, attribute: "status", expectedValue: null, window: { latestAt: new Date(1000).toISOString() } });
    const r2 = pm2.checkExpectations(() => ({ value: Infinity, atMs: 500 }));
    assert.deepEqual(r2, [], "Infinity observed must never satisfy an expectedValue of null");

    const pm3 = await createProspectiveMemory({ clock: manualClock(100) });
    pm3.armExpectation({ subject: { entityId: "e1" }, attribute: "status", expectedValue: 5, window: { latestAt: new Date(1000).toISOString() } });
    assert.doesNotThrow(() => pm3.checkExpectations(() => ({ value: 10n, atMs: 500 })), "a BigInt observed value must not raw-throw and abort the whole sweep");

    const pm4 = await createProspectiveMemory({ clock: manualClock(100) });
    pm4.armExpectation({ subject: { entityId: "e1" }, attribute: "status", expectedValue: 5, window: { latestAt: new Date(1000).toISOString() } });
    const cyc = {}; cyc.self = cyc;
    assert.doesNotThrow(() => pm4.checkExpectations(() => ({ value: cyc, atMs: 500 })), "a cyclic observed value must not raw-throw and abort the whole sweep");
});

test("PM-repair-39: checkExpectations never crashes on a Symbol/hostile observed.atMs, the sibling raw field to observed.value on the same port result (independent audit AUD33-P2-3)", async () => {
    const pm = await createProspectiveMemory({ clock: manualClock(100) });
    pm.armExpectation({ subject: { entityId: "e1" }, attribute: "status", expectedValue: "done", window: { latestAt: new Date(1000).toISOString() } });
    let results;
    assert.doesNotThrow(() => { results = pm.checkExpectations(() => ({ value: "done", atMs: Symbol("boom") })); }, "a Symbol atMs must not raw-throw and abort the whole sweep");
    assert.deepEqual(results, [], "an invalid atMs must never be treated as satisfying the window");
});

test("PM-repair-40: an ON_STATE trigger's subject is now sanitized via a descriptor-based whole-trigger copy BEFORE any destructuring, so a stateful getter (which could once be read multiple times across guard vs. store) is rejected outright and never invoked at all -- superseded, stronger contract than the original 'read exactly once' guarantee (independent audit AUD33-P2-4, tightened by round 67, Codex, AUD67-P2-3)", async () => {
    const pm = await createProspectiveMemory();
    let n = 0;
    const trigger = { kind: "ON_STATE", attribute: "status" };
    Object.defineProperty(trigger, "subject", { enumerable: true, configurable: true, get() { n++; return n <= 3 ? { entityId: "e1" } : {}; } });
    assertThrowsReason(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "trigger.subject's getter must never be invoked -- the whole trigger is descriptor-sanitized before any named field is ever read");
});

test("PM-repair-41: armExpectation(subject:null) is rejected instead of silently stored as {} (independent audit AUD33-ADV-2)", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.armExpectation({ subject: null, attribute: "status", expectedValue: 1, window: { latestAt: new Date(9e12).toISOString() } }), "INVALID_RECORD");
});

test("PM-repair-42: an ON_STATE trigger's subject is sanitized via buildSafePayloadRef before the guard, so an accessor entityId is rejected closed without ever being invoked (independent audit AUD34-P2-2, tightened by AUD38-P2-1)", async () => {
    const pm = await createProspectiveMemory();
    let n = 0;
    const subject = {};
    Object.defineProperty(subject, "entityId", { enumerable: true, configurable: true, get() { n++; return "e1"; } });
    // Bug review independen (audit putaran-39, AUD39-ADV-2): `assert.throws`
    // polos tidak memverifikasi ALASAN penolakan -- dipertegas.
    assertThrowsReason(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "ON_STATE", subject, attribute: "status" } }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "buildSafePayloadRef must reject the accessor via its property descriptor without ever invoking it");

    const r = pm.arm({ reminderId: "R2", wakeClass: "NOTIFY_OWNER", trigger: { kind: "ON_STATE", subject: { entityId: "e1" }, attribute: "status" } });
    assert.equal(r.trigger.subject.entityId, "e1", "a plain (non-accessor) subject must still be accepted");
});

test("PM-repair-43: an expectation's subject is sanitized via buildSafePayloadRef before the guard, so an accessor entityId is rejected closed without ever being invoked (independent audit AUD34-P2-3, tightened by AUD38-P2-1)", async () => {
    const pm = await createProspectiveMemory();
    let n = 0;
    const subject = {};
    Object.defineProperty(subject, "entityId", { enumerable: true, configurable: true, get() { n++; return "e1"; } });
    // Bug review independen (audit putaran-39, AUD39-ADV-2): `assert.throws`
    // polos tidak memverifikasi ALASAN penolakan -- dipertegas.
    assertThrowsReason(() => pm.armExpectation({ subject, attribute: "status", expectedValue: "done", window: { latestAt: new Date(9e12).toISOString() } }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "buildSafePayloadRef must reject the accessor via its property descriptor without ever invoking it");

    const e = pm.armExpectation({ subject: { entityId: "e1" }, attribute: "status", expectedValue: "done", window: { latestAt: new Date(9e12).toISOString() } });
    assert.equal(e.subject.entityId, "e1", "a plain (non-accessor) subject must still be accepted");
});

test("PM-repair-44: trigger.kind is now sanitized via a descriptor-based whole-trigger copy BEFORE any destructuring, so a stateful getter (which could once be read multiple times across guard vs. store) is rejected outright and never invoked at all -- superseded, stronger contract than the original 'read exactly once' guarantee (independent audit AUD34-P2-4, tightened by round 67, Codex, AUD67-P2-3)", async () => {
    const pm = await createProspectiveMemory();
    let n = 0;
    const trigger = { at: new Date(9e12).toISOString() };
    Object.defineProperty(trigger, "kind", { enumerable: true, configurable: true, get() { n++; return n <= 7 ? "AT" : "ON_STATE"; } });
    assertThrowsReason(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "trigger.kind's getter must never be invoked -- the whole trigger is descriptor-sanitized before any named field is ever read");
});

test("PM-repair-45: ownerRef is read exactly once end-to-end (guard AND construction), not just guard-vs-store consistent (independent audit AUD34-ADV-1)", async () => {
    const pm = await createProspectiveMemory();
    let n = 0;
    const spec = { reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(9e12).toISOString() } };
    Object.defineProperty(spec, "ownerRef", { enumerable: true, configurable: true, get() { n++; return "owner-1"; } });
    const r = pm.arm(spec);
    assert.equal(n, 1, "ownerRef must be read exactly once, including during construction");
    assert.equal(r.ownerRef, "owner-1");
});

test("PM-repair-47: a non-ON_STATE trigger never dereferences subject's inner fields at all (independent audit AUD37-P2-2)", async () => {
    const pm = await createProspectiveMemory();
    let called = 0;
    const subject = {};
    Object.defineProperty(subject, "entityId", { enumerable: true, configurable: true, get() { called++; throw new Error("must not run"); } });
    const r = pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(9e12).toISOString(), subject } });
    assert.equal(r.trigger.kind, "AT");
    assert.equal(called, 0, "an AT trigger must never touch subject's inner fields -- subject is ON_STATE-only");
});

test("PM-repair-50: buildSafePayloadRef rejects a nested trigger array whose .length is negative/NaN/Infinity/fractional instead of skipping or infinite-looping (independent audit W7R42-P2-1)", async () => {
    const pm = await createProspectiveMemory();
    for (const badLen of [-1, NaN, Infinity, 1.5]) {
        const arr = fakeLengthArray([1], badLen);
        assertThrowsReason(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(9e12).toISOString(), extra: arr } }), "PAYLOAD_TOO_LARGE");
    }
});

test("PM-repair-51: arm/armExpectation fail closed (not raw-throw) on a revoked-Proxy trigger/payloadRef/subject/expectedValue (independent audit W7R43-P2-1/W7R43-P2-7)", async () => {
    const pm = await createProspectiveMemory();
    const trig = Proxy.revocable({ kind: "AT", at: new Date(1).toISOString() }, {});
    trig.revoke();
    assertThrowsReason(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: trig.proxy }), "INVALID_TRIGGER");

    const payload = Proxy.revocable([1], {});
    payload.revoke();
    assertThrowsReason(() => pm.arm({ reminderId: "R2", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(1).toISOString(), extra: payload.proxy } }), "EXECUTABLE_MATERIAL_REJECTED");

    const subj = Proxy.revocable({ entityId: "e1" }, {});
    subj.revoke();
    assertThrowsReason(() => pm.armExpectation({ subject: subj.proxy, attribute: "a", expectedValue: 1, window: { latestAt: new Date(9e12).toISOString() } }), "EXECUTABLE_MATERIAL_REJECTED");

    const ev = Proxy.revocable({ a: 1 }, {});
    ev.revoke();
    assertThrowsReason(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: "a", expectedValue: ev.proxy, window: { latestAt: new Date(9e12).toISOString() } }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-repair-52: buildSafePayloadRef's fail-closed catch itself does not raw-throw when the caught value is a hostile object whose own inspection throws (independent audit W7R44-P2-1)", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: "a", expectedValue: hostileThrowObj(), window: { latestAt: new Date(9e12).toISOString() } }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-repair-53: arm/armExpectation fail closed (not raw-throw) on a revoked-Proxy TOP-LEVEL spec argument (independent audit W7R44-P2-2)", async () => {
    const pm = await createProspectiveMemory();
    const rev = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    assertThrowsReason(() => pm.arm(rev()), "INVALID_RECORD");
    assertThrowsReason(() => pm.armExpectation(rev()), "INVALID_RECORD");
});

test("PM-repair-54: armExpectation fails closed (not raw-throw) on a revoked-Proxy NESTED window argument, one level below where round 44's subject/expectedValue guard stopped (independent audit W7R45-P2-6; reason superseded in round 68, AUD68-P2-2 -- window is now sanitized via buildSafePayloadRef BEFORE the latestAt-specific check ever runs, so a revoked proxy fails closed as EXECUTABLE_MATERIAL_REJECTED, not NO_LATEST_AT)", async () => {
    const pm = await createProspectiveMemory();
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsReason(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: "a", expectedValue: "x", window: r.proxy }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-repair-55: armExpectation rejects a non-string window.earliestAt (including a revoked Proxy) instead of raw-throwing inside Date.parse's implicit ToString, closing the gap round 45's own window fix left in its sibling field (independent audit W7R46-P2-2; reason superseded in round 68, AUD68-P2-2 -- window is now sanitized whole via buildSafePayloadRef BEFORE latestAt/earliestAt are read, so a revoked proxy nested at earliestAt fails closed as EXECUTABLE_MATERIAL_REJECTED, not NO_LATEST_AT)", async () => {
    const pm = await createProspectiveMemory();
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsReason(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: "a", expectedValue: 1, window: { latestAt: new Date(1).toISOString(), earliestAt: r.proxy } }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-repair-49: compaction only removes a victim's OWN firedOccurrenceIds entries, not a differently-terminated reminder whose id happens to be a string-prefix of the victim's (independent audit AUD38-ADV-1)", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock, bounds: { ...BOUNDS, MAX_TOTAL_REMINDERS_RETAINED: 1, MAX_ARMED_REMINDERS: 100 } });
    pm.arm({ reminderId: "R", wakeClass: "MAINTENANCE", trigger: { kind: "AT", at: new Date(500).toISOString() } });
    clock.advance(1000);
    pm.tick(); // fires "R" -> firedOccurrenceIds = { "R:0" }; reminders.size===1, not yet over bound
    pm.arm({ reminderId: "R:x", wakeClass: "MAINTENANCE", trigger: { kind: "AT", at: new Date(1500).toISOString() } });
    clock.advance(1000);
    pm.tick(); // fires "R:x" -> reminders.size===2 > MAX_TOTAL_REMINDERS_RETAINED(1) -> compacts the OLDER terminal reminder, "R"
    assert.equal(pm.firedOccurrenceIdsSize(), 1, "compacting 'R' must remove only 'R:0', not 'R:x:0' (a false string-prefix match)");
});

test("PM-repair-48: origin is passed to the sanitizer without a pre-spread, so a hostile origin.kind accessor is rejected without being invoked (independent audit AUD37-P2-3)", async () => {
    const pm = await createProspectiveMemory();
    let called = 0;
    const origin = {};
    Object.defineProperty(origin, "kind", { enumerable: true, configurable: true, get() { called++; throw new Error("must not run"); } });
    assert.throws(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(9e12).toISOString() }, origin }));
    assert.equal(called, 0, "the sanitizer must reject the accessor via its property descriptor without ever invoking it");
});

test("PM-repair-46: expectationId is read exactly once end-to-end in armExpectation (guard AND construction) (independent audit AUD35-ADV-1)", async () => {
    const pm = await createProspectiveMemory();
    let n = 0;
    const spec = { subject: { entityId: "e1" }, attribute: "status", expectedValue: 1, window: { latestAt: new Date(9e12).toISOString() } };
    Object.defineProperty(spec, "expectationId", { enumerable: true, configurable: true, get() { n++; return "E1"; } });
    const e = pm.armExpectation(spec);
    assert.equal(n, 1, "expectationId must be read exactly once, including during construction");
    assert.equal(e.expectationId, "E1");
});

test("PM-repair-38: window.latestAt is rejected outright when it is a stateful getter, never invoked -- superseded, stronger contract than the original 'read exactly once' guarantee (independent audit AUD32-P2-2; strengthened round 68, AUD68-P2-2, once window is sanitized whole via buildSafePayloadRef before latestAt is read at all)", async () => {
    const pm = await createProspectiveMemory({ clock: manualClock(100) });
    let n = 0;
    const window = {};
    Object.defineProperty(window, "latestAt", { enumerable: true, configurable: true, get() { n++; return new Date(1000).toISOString(); } });
    assertThrowsReason(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: "status", expectedValue: "done", window }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "window.latestAt's getter must never be invoked");
});

test("PM-repair-36: ownerRef is read exactly once, so a stateful getter cannot exceed MAX_REMINDERS_PER_GOAL via inconsistent reads (independent audit AUD31-P2-4)", async () => {
    const pm = await createProspectiveMemory({ bounds: { ...BOUNDS, MAX_REMINDERS_PER_GOAL: 1 } });
    pm.arm({ reminderId: "R-B1", ownerRef: "B", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(9e12).toISOString() } });

    let n = 0;
    const spec = { reminderId: "R-B2", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(9e12).toISOString() } };
    Object.defineProperty(spec, "ownerRef", { enumerable: true, configurable: true, get() { n++; return "B"; } });
    assertThrowsReason(() => pm.arm(spec), "PER_GOAL_LIMIT_EXCEEDED");
    assert.equal(n, 1, "ownerRef must be read exactly once");
});

test("PM-A1: reminder carrying executable/authority-shaped payload is rejected", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE",
        payloadRef: { capabilityId: "cap.x" }
    }), "EXECUTABLE_MATERIAL_REJECTED");
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE",
        payloadRef: () => 1
    }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-A1-repair: forbidden fields nested inside payloadRef are rejected too (Codex P2 finding)", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE",
        payloadRef: { nested: { capabilityId: "cap.x" } }
    }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-A1-repair-2: forbidden fields beyond the old depth-8 cutoff are rejected, not silently skipped (Codex P1 finding round 2)", async () => {
    const pm = await createProspectiveMemory();
    let deep = { capabilityId: "cap.x" };
    for (let i = 0; i < 9; i++) deep = { nested: deep }; // 9 levels below the payload root
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE",
        payloadRef: deep
    }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-A1-repair-3: a toJSON hook on payloadRef never executes -- rejected before serialization (Codex P1 round 5)", async () => {
    const pm = await createProspectiveMemory();
    let executed = false;
    const hostile = {
        note: "looks harmless",
        toJSON() { executed = true; return { capabilityId: "cap.x" }; }
    };
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE",
        payloadRef: hostile
    }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(executed, false, "toJSON tidak boleh pernah dipanggil -- fungsi ditolak sebelum JSON.stringify");
});

test("PM-A1-repair-8: inherited/class toJSON is never invoked and cannot fabricate forbidden keys (independent audit AUD-P1-2)", async () => {
    const pm = await createProspectiveMemory();
    const proto = { toJSON() { return { capabilityId: "cap.x" }; } };
    const hostile = Object.create(proto);
    hostile.note = "x";
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "AT", at: new Date(1).toISOString() }, wakeClass: "MAINTENANCE",
        payloadRef: hostile
    }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-A1-repair-7: payloadRef is deeply frozen -- post-validation mutation cannot inject forbidden keys (independent audit AUD-P1-1)", async () => {
    const pm = await createProspectiveMemory({ clock: { nowMs: () => 1000 } });
    const r = pm.arm({
        reminderId: "r1", trigger: { kind: "AT", at: new Date(1100).toISOString() },
        wakeClass: "NOTIFY_OWNER", payloadRef: { note: "safe" }
    });
    assert.equal(Object.isFrozen(r.payloadRef), true);
    assert.throws(() => { "use strict"; r.payloadRef.capabilityId = "X"; });
    assert.equal(Object.prototype.hasOwnProperty.call(r.payloadRef, "capabilityId"), false);
});

test("PM-A1-repair-9: array with a redefined prototype carrying inherited toJSON cannot fabricate forbidden keys (independent audit AUD2-P1-1)", async () => {
    const pm = await createProspectiveMemory();
    const arr = [1];
    Object.setPrototypeOf(arr, { toJSON() { return { capabilityId: "cap.x" }; } });
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "AT", at: new Date(1).toISOString() }, wakeClass: "MAINTENANCE",
        payloadRef: arr
    }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("PM-A1-repair-10: a Proxy with consistent-but-lying traps cannot smuggle a hidden toJSON into a fired WakeEvent (independent audit AUD3-P1-1)", async () => {
    const pm = await createProspectiveMemory({ clock: { nowMs: () => 1000 } });
    let toJsonExecuted = false;
    const target = { note: "safe" };
    const proxy = new Proxy(target, {
        getPrototypeOf() { return Object.prototype; },
        ownKeys() { return ["note"]; },
        getOwnPropertyDescriptor() { return { enumerable: true, configurable: true, value: "safe", writable: true }; },
        get(t, p) {
            if (p === "toJSON") return () => { toJsonExecuted = true; return { capabilityId: "cap.proxy", authProof: "P" }; };
            return t[p];
        }
    });
    const r = pm.arm({
        reminderId: "r1", trigger: { kind: "AT", at: new Date(1).toISOString() },
        wakeClass: "MAINTENANCE", payloadRef: proxy
    });
    assert.equal(toJsonExecuted, false, "trap get proxy (dan toJSON tersembunyinya) tidak boleh pernah terpanggil");
    assert.deepEqual(r.payloadRef, { note: "safe" });
    assert.equal(Object.prototype.hasOwnProperty.call(r.payloadRef, "capabilityId"), false);
});

test("PM-repair-7: remindersPerGoal deletes an ownerRef key once its count reaches zero (independent audit W7R4-P2-3)", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock });
    for (let i = 0; i < 50; i++) {
        pm.arm({ ownerRef: `goal-${i}`, trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "RESUME_GOAL" });
    }
    clock.advance(1500);
    pm.tick(); // fires and releases capacity for all 50 distinct ownerRefs
    assert.equal(pm.remindersPerGoalSize(), 0,
        "kunci ownerRef harus dihapus begitu hitungannya kembali ke nol, bukan menumpuk selamanya");
});

function jsonStore() {
    const kv = new Map();
    return {
        async getKv(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
        async putKv(k, v) { kv.set(k, JSON.stringify(v)); }
    };
}

test("PM-restart-freeze: a reloaded reminder's payloadRef cannot be forged after a JSON-round-tripping restart (independent audit W7R7-P1-2)", async () => {
    const store = jsonStore();
    const p1 = await createProspectiveMemory({ store });
    p1.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: "2030-01-01T00:00:00.000Z" }, payloadRef: { safe: true } });
    await p1.persist();

    const p2 = await createProspectiveMemory({ store });
    const r = p2.getReminder("R1");
    assert.equal(Object.isFrozen(r), true);
    assert.equal(Object.isFrozen(r.payloadRef), true);
    assert.throws(() => { "use strict"; r.payloadRef = { capabilityId: "forge.exec" }; });
    assert.deepEqual(p2.getReminder("R1").payloadRef, { safe: true });
});

test("PM-repair-9: mutating the caller's ON_STATE trigger.subject after arm() cannot rewrite the stored trigger (independent audit W7R8-P2-2)", async () => {
    const pm = await createProspectiveMemory({});
    const subject = { entityId: "e1" };
    const r = pm.arm({ reminderId: "R-state", wakeClass: "NOTIFY_OWNER", trigger: { kind: "ON_STATE", subject, attribute: "status" } });
    subject.entityId = "HACKED";
    const stored = pm.getReminder(r.reminderId);
    assert.equal(stored.trigger.subject.entityId, "e1");
    assert.throws(() => { "use strict"; stored.trigger.subject.entityId = "HACKED2"; });
});

test("PM-repair-10: a nested object inside an ON_STATE trigger.subject stays immutable (independent audit AUD9-P2-1)", async () => {
    const pm = await createProspectiveMemory({});
    const subject = { entityId: "e1", nested: { deep: "orig" } };
    const r = pm.arm({ reminderId: "R-state-2", wakeClass: "NOTIFY_OWNER", trigger: { kind: "ON_STATE", subject, attribute: "status" } });
    subject.nested.deep = "MUTATED";
    const stored = pm.getReminder(r.reminderId);
    assert.equal(stored.trigger.subject.nested.deep, "orig");
    assert.throws(() => { "use strict"; stored.trigger.subject.nested.deep = "MUTATED2"; });
});

test("PM-repair-11: a BigInt in an expectation's expectedValue is rejected, not accepted and left to crash persist() (independent audit AUD9-P2-3)", async () => {
    const pm = await createProspectiveMemory({});
    assert.throws(() => pm.armExpectation({
        subject: { entityId: "e1" }, attribute: "status", expectedValue: { big: 7n },
        window: { latestAt: new Date(1000).toISOString() }
    }));
});

test("PM-repair-12: an expectation's expectedValue is frozen, not just sanitized (independent audit AUD10-P1-1)", async () => {
    const pm = await createProspectiveMemory({});
    const e = pm.armExpectation({
        subject: { entityId: "e1" }, attribute: "status", expectedValue: { nested: { deep: "orig" } },
        window: { latestAt: new Date(1000).toISOString() }
    });
    assert.equal(Object.isFrozen(e.expectedValue), true);
    assert.throws(() => { "use strict"; pm.getExpectation(e.expectationId).expectedValue.nested.deep = "MUTATED"; });
});

test("PM-repair-13: replaying an already-used reminderId/expectationId is rejected, not resurrected to a fresh armed/pending state (independent audit AUD10-P1-2/AUD10-P2-4)", async () => {
    const pm = await createProspectiveMemory({ bounds: { ...BOUNDS, MAX_ARMED_REMINDERS: 2 } });
    const spec = { reminderId: "R-FIXED", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(5000).toISOString() } };
    pm.arm(spec);
    assertThrowsReason(() => pm.arm(spec), "DUPLICATE_RECORD_ID");
    assert.equal(pm.reminderCount(), 1, "a rejected replay must not consume a second armed-capacity slot");
    pm.arm({ ...spec, reminderId: "R-OTHER" });
    assertThrowsReason(() => pm.arm({ ...spec, reminderId: "R-THIRD" }), "PROSPECTIVE_FULL");

    const es = { expectationId: "E-FIXED", subject: { entityId: "e1" }, attribute: "status", expectedValue: "done", window: { latestAt: new Date(1000).toISOString() } };
    pm.armExpectation(es);
    assertThrowsReason(() => pm.armExpectation(es), "DUPLICATE_RECORD_ID");
});

test("PM-repair-14: a nested value inside a non-ON_STATE trigger (AT/AFTER/RECURRING) stays immutable (independent audit AUD10-P2-2)", async () => {
    const pm = await createProspectiveMemory({});
    const r = pm.arm({ reminderId: "R-nested", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(1).toISOString(), extra: { nested: { deep: "orig" } } } });
    assert.equal(Object.isFrozen(r.trigger.extra), true);
    assert.throws(() => { "use strict"; pm.getReminder(r.reminderId).trigger.extra.nested.deep = "MUTATED"; });
});

test("PM-repair-15: a BigInt anywhere in a reminder's origin/trigger-extra or an expectation's subject/window is rejected, not accepted and left to crash persist() (independent audit AUD11-P2-1)", async () => {
    const pm = await createProspectiveMemory({});
    assert.throws(() => pm.arm({ reminderId: "R-big-1", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(1).toISOString() }, origin: { kind: "SELF", n: 10n } }));
    assert.throws(() => pm.arm({ reminderId: "R-big-2", wakeClass: "NOTIFY_OWNER", trigger: { kind: "AT", at: new Date(1).toISOString(), extra: { n: 10n } } }));
    assert.throws(() => pm.arm({ reminderId: "R-big-3", wakeClass: "NOTIFY_OWNER", trigger: { kind: "ON_STATE", subject: { entityId: "e1", n: 10n }, attribute: "status" } }));
    assert.throws(() => pm.armExpectation({ subject: { entityId: "e1", n: 10n }, attribute: "status", expectedValue: "done", window: { latestAt: new Date(1000).toISOString() } }));
    assert.throws(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: "status", expectedValue: "done", window: { latestAt: new Date(1000).toISOString(), n: 10n } }));
});

test("PM-repair-20: an ON_EVENT trigger is rejected fail-closed, since no dispatch path exists to ever fire it (independent audit AUD18-P2-2)", async () => {
    const pm = await createProspectiveMemory({});
    assertThrowsReason(() => pm.arm({ reminderId: "R-evt", wakeClass: "RESUME_GOAL", trigger: { kind: "ON_EVENT", eventKind: "X" } }), "INVALID_TRIGGER");
});

test("PM-repair-21: firedOccurrenceIds is bounded by an explicit MAX_FIRED_OCCURRENCE_IDS, not left to grow with one reminder's full occurrence history (independent audit AUD19-P2-3)", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({
        clock, bounds: { ...BOUNDS, MAX_RECURRENCE_OCCURRENCES: 50, MAX_FIRED_OCCURRENCE_IDS: 10 }
    });
    pm.arm({ reminderId: "R", wakeClass: "MAINTENANCE", trigger: { kind: "RECURRING", intervalMs: 60_000, maxOccurrences: 50 } });
    for (let i = 0; i < 50; i++) {
        clock.advance(60_001);
        pm.tick();
    }
    assert.ok(pm.firedOccurrenceIdsSize() <= 10, "firedOccurrenceIds must stay bounded by MAX_FIRED_OCCURRENCE_IDS regardless of a single reminder's occurrence count");
});

test("PM-repair-16: an ON_STATE trigger's non-subject fields are sanitized+frozen and cannot crash persist() (independent audit AUD12-P1-1)", async () => {
    const store = jsonStore();
    const pm = await createProspectiveMemory({ store });
    assert.throws(() => pm.arm({
        reminderId: "R1", wakeClass: "NOTIFY_OWNER",
        trigger: { kind: "ON_STATE", subject: { entityId: "e1" }, attribute: "a", predicate: { n: 10n } }
    }));
    const extra = { deep: { v: "orig" } };
    const r = pm.arm({
        reminderId: "R2", wakeClass: "NOTIFY_OWNER",
        trigger: { kind: "ON_STATE", subject: { entityId: "e1" }, attribute: "a", extra }
    });
    extra.deep.v = "MUTATED";
    assert.equal(pm.getReminder(r.reminderId).trigger.extra.deep.v, "orig");
    assert.throws(() => { "use strict"; pm.getReminder(r.reminderId).trigger.extra.deep.v = "MUTATED2"; });
    await pm.persist();
});

test("PM-repair-17: a BigInt in reminder.ownerRef or expectation.{attribute,onSatisfied,onViolated} is rejected (independent audit AUD12-P2-3)", async () => {
    const pm = await createProspectiveMemory({});
    assert.throws(() => pm.arm({ reminderId: "R1", wakeClass: "NOTIFY_OWNER", ownerRef: 10n, trigger: { kind: "AT", at: new Date(1).toISOString() } }));
    assert.throws(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: 10n, expectedValue: "x", window: { latestAt: new Date(1).toISOString() } }));
    assert.throws(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: "a", expectedValue: "x", onViolated: 10n, window: { latestAt: new Date(1).toISOString() } }));
});

test("PM-repair-18: a shared-reference DAG (not a cycle) in an expectation's expectedValue is rejected via a node budget, not expanded exponentially (independent audit AUD14-P1-1)", async () => {
    function dag(d, f) {
        let n = { leaf: 1 };
        for (let i = 0; i < d; i++) { const o = {}; for (let k = 0; k < f; k++) o["k" + k] = n; n = o; }
        return n;
    }
    const pm = await createProspectiveMemory({});
    const t = Date.now();
    assert.throws(() => pm.armExpectation({ subject: { entityId: "e1" }, attribute: "a", expectedValue: dag(16, 4), window: { latestAt: new Date(1000).toISOString() } }));
    assert.ok(Date.now() - t < 500, "shared-reference DAG must be rejected via a node budget, not expanded in full");
});

test("PM-repair-19: a rejected armExpectation call must not evict an existing pending expectation (independent audit AUD14-P1-2)", async () => {
    const pm = await createProspectiveMemory({ bounds: { ...BOUNDS, MAX_PENDING_EXPECTATIONS: 1 } });
    pm.armExpectation({ expectationId: "E-KEEP", subject: { entityId: "e1" }, attribute: "a", expectedValue: "x", window: { latestAt: new Date(1000).toISOString() } });
    assert.throws(() => pm.armExpectation({ subject: { entityId: "e2" }, attribute: "a", expectedValue: "x", window: { latestAt: "not-a-date" } }));
    assert.ok(pm.getExpectation("E-KEEP"), "a rejected armExpectation call must not evict an existing pending expectation");
});

test("PM-repair-8: an until-only recurring reminder still bounds occurrences and firedOccurrenceIds (independent audit W7R7-P2-2)", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock, bounds: { ...BOUNDS, MAX_RECURRENCE_OCCURRENCES: 5 } });
    pm.arm({
        reminderId: "R1", wakeClass: "MAINTENANCE",
        trigger: { kind: "RECURRING", intervalMs: 60_000, until: new Date(1e12).toISOString() }
    });
    for (let i = 0; i < 20; i++) {
        clock.advance(60_001);
        pm.tick();
    }
    assert.ok(pm.reminderCount() >= 1, "reminder harus tetap ada (jadi terminal setelah occurrence habis)");
    const r = pm.getReminder("R1");
    assert.equal(r.state, "FIRED", "recurring until-saja harus berhenti setelah MAX_RECURRENCE_OCCURRENCES, bukan tak terbatas");
});

test("PM-repair-4: restart rebuild counts only ARMED reminders toward the per-goal cap (Codex P2 round 7)", async () => {
    const store = createMemoryAccStore();
    const clock = manualClock(0);
    let pm = await createProspectiveMemory({ clock, store, bounds: { ...BOUNDS, MAX_REMINDERS_PER_GOAL: 1 } });
    pm.arm({ ownerRef: "goal-1", trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "RESUME_GOAL" });
    clock.advance(1500);
    pm.tick(); // reminder fires -> becomes FIRED (terminal), per-goal slot released live
    await pm.persist();

    // "Restart": a fresh instance loads the same persisted snapshot, which
    // still contains the terminal (FIRED) reminder for goal-1.
    pm = await createProspectiveMemory({ clock, store, bounds: { ...BOUNDS, MAX_REMINDERS_PER_GOAL: 1 } });
    assert.doesNotThrow(() => pm.arm({
        ownerRef: "goal-1", trigger: { kind: "AT", at: new Date(9999).toISOString() }, wakeClass: "RESUME_GOAL"
    }), "reminder terminal yang tersisa tidak boleh menghitung ke batas per-goal pasca-restart");
});

test("PM-repair-5: a valid non-null payloadRef is accepted, not rejected by a dead reference (Codex P1 round 9)", async () => {
    const pm = await createProspectiveMemory();
    const r = pm.arm({
        trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE",
        payloadRef: { note: "safe reference data", count: 3 }
    });
    assert.deepEqual(r.payloadRef, { note: "safe reference data", count: 3 });
});

test("PM-repair-6: a sparse/huge array in payloadRef is rejected before JSON.stringify materializes it (Codex P1 round 9)", async () => {
    const pm = await createProspectiveMemory();
    const hugeSparse = new Array(2 ** 32 - 1); // no own indexed keys, would defeat a Reflect.ownKeys-only walk
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE",
        payloadRef: hugeSparse
    }), "PAYLOAD_TOO_LARGE");
});

test("PM-repair-2: deferred wake events are bounded, drops are counted not silently lost (Codex P2 round 6)", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock, bounds: { ...BOUNDS, MAX_WAKE_EVENTS_PER_MINUTE: 1, MAX_DEFERRED_WAKE_EVENTS: 2 } });
    for (let i = 0; i < 5; i++) {
        pm.arm({ trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE" });
    }
    clock.advance(1500);
    pm.tick();
    assert.ok(pm.deferredCount() <= 2, "antrean deferred tidak boleh tumbuh tanpa batas");
    assert.equal(pm.droppedDeferredCount(), 2, "kelebihan deferred dibuang TAPI tetap terhitung, tidak hilang diam-diam");
});

test("PM-repair-3: terminal (fired/retired) reminders are compacted once retention cap is exceeded (Codex P2 round 6)", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock, bounds: { ...BOUNDS, MAX_TOTAL_REMINDERS_RETAINED: 2, MAX_ARMED_REMINDERS: 100 } });
    for (let i = 0; i < 5; i++) {
        pm.arm({ trigger: { kind: "AT", at: new Date(1000 + i).toISOString() }, wakeClass: "MAINTENANCE" });
    }
    clock.advance(2000);
    pm.tick();
    assert.ok(pm.reminderCount() <= 2, "retensi reminder terminal harus dipangkas, bukan tumbuh tanpa batas");
});

test("PM-A5-repair: an unparsable expectation deadline is rejected, not silently accepted (Codex P2 round 4)", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.armExpectation({
        subject: { entityId: "e1" }, attribute: "status", expectedValue: "done",
        window: { earliestAt: new Date(0).toISOString(), latestAt: "tomorrowish" }
    }), "NO_LATEST_AT");
});

test("PM-A2: reminder flood is bounded by arm cap, not unbounded DoS on cognition", async () => {
    const pm = await createProspectiveMemory({ bounds: { ...BOUNDS, MAX_ARMED_REMINDERS: 3 } });
    for (let i = 0; i < 3; i++) pm.arm({ trigger: { kind: "AT", at: new Date(1000 + i).toISOString() }, wakeClass: "MAINTENANCE" });
    assertThrowsReason(() => pm.arm({ trigger: { kind: "AT", at: new Date(9999).toISOString() }, wakeClass: "MAINTENANCE" }),
        "PROSPECTIVE_FULL");
});

test("PM-A3: sub-floor recurrence period and unbounded recurrence are both rejected", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "RECURRING", intervalMs: 1000, maxOccurrences: 5 }, wakeClass: "MAINTENANCE"
    }), "RECURRENCE_PERIOD_TOO_SHORT");
    assertThrowsReason(() => pm.arm({
        trigger: { kind: "RECURRING", intervalMs: 120_000 }, wakeClass: "MAINTENANCE" // no until/maxOccurrences
    }), "RECURRENCE_UNBOUNDED");
});

test("PM-A4: wall-clock jump does not fire a reminder early relative to its own recorded due time", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock });
    pm.arm({ trigger: { kind: "AT", at: new Date(1_000_000).toISOString() }, wakeClass: "MAINTENANCE" });
    // Small forward tick, nowhere near due — must not fire.
    clock.advance(1000);
    assert.equal(pm.tick().length, 0, "belum jatuh tempo, tidak boleh tembak dini");
});

test("PM-A5: catch-up storm after a long outage is capped, remainder MISSED_EXPIRED", async () => {
    const store = createMemoryAccStore();
    const clock1 = manualClock(0);
    const pm1 = await createProspectiveMemory({ clock: clock1, store, bounds: { ...BOUNDS, MAX_CATCHUP_FIRES_PER_RESTART: 2 } });
    for (let i = 0; i < 5; i++) pm1.arm({ trigger: { kind: "AT", at: new Date(100 + i).toISOString() }, wakeClass: "MAINTENANCE" });
    await pm1.persist();

    const clock2 = manualClock(1_000_000);
    const pm2 = await createProspectiveMemory({ clock: clock2, store, bounds: { ...BOUNDS, MAX_CATCHUP_FIRES_PER_RESTART: 2 } });
    assert.equal(pm2.catchUpEvents.length, 2, "catch-up dibatasi, tidak burst-fire semua yang basi");
});

test("PM-A6: waking a dead (terminal) goal is refused — reminder retires instead of firing", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock });
    pm.arm({ ownerRef: "goal-dead", trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "RESUME_GOAL" });
    clock.advance(1500);
    const events = pm.tick({ isTerminal: (goalId) => goalId === "goal-dead" });
    assert.equal(events.length, 0, "goal terminal tidak pernah menerima wake event");
});

test("PM-A7: deterministic occurrence id collapses duplicate firing (cross-node simulation)", async () => {
    const store = createMemoryAccStore();
    const clock = manualClock(0);
    const pm1 = await createProspectiveMemory({ clock, store });
    pm1.arm({ trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE" });
    clock.advance(1500);
    const first = pm1.tick();
    assert.equal(first.length, 1);
    await pm1.persist();

    // "node 2" loads the same durable snapshot (same firedOccurrenceIds) and
    // attempts the same occurrence — must collapse, not double-fire.
    const pm2 = await createProspectiveMemory({ clock: manualClock(2000), store });
    assert.equal(pm2.catchUpEvents.length, 0, "occurrence sudah tercatat fired, tidak ditembak ulang");
});

test("PM-A8: violated expectation never asserts the opposite value, only opens a policy path", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock });
    const e = pm.armExpectation({
        subject: { entityId: "e1" }, attribute: "status", expectedValue: "done",
        window: { earliestAt: new Date(0).toISOString(), latestAt: new Date(1000).toISOString() },
        onViolated: "OPEN_CONTRADICTION"
    });
    clock.advance(1500);
    const results = pm.checkExpectations(() => null);
    assert.equal(results[0].outcome, "VIOLATED");
    assert.equal(pm.getExpectation(e.expectationId).state, "VIOLATED");
    assert.equal(Object.prototype.hasOwnProperty.call(pm.getExpectation(e.expectationId), "assertedValue"), false);
});

test("PM-A9: MISSED is never suppressed — catch-up MISSED events are always returned, never swallowed", async () => {
    const store = createMemoryAccStore();
    const clock1 = manualClock(0);
    const pm1 = await createProspectiveMemory({ clock: clock1, store });
    pm1.arm({ trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "NOTIFY_OWNER" });
    await pm1.persist();

    const pm2 = await createProspectiveMemory({ clock: manualClock(50_000), store });
    assert.equal(pm2.catchUpEvents.length, 1);
    assert.equal(pm2.catchUpEvents[0].missed, true);
});

test("PM-A10: agent-suggested reminder is recorded with that origin, not silently treated as owner-trusted", async () => {
    const pm = await createProspectiveMemory();
    const r = pm.arm({
        trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE",
        origin: { kind: "AGENT_SUGGESTION", ref: "agent-1" }
    });
    assert.equal(r.origin.kind, "AGENT_SUGGESTION");
});
