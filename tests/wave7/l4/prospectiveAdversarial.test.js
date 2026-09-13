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

test("PM-repair-22: arm(null) is rejected as INVALID_RECORD, not a raw TypeError (independent audit AUD21-ADV-1)", async () => {
    const pm = await createProspectiveMemory();
    assertThrowsReason(() => pm.arm(null), "INVALID_RECORD");
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
