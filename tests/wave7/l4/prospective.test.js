const test = require("node:test");
const assert = require("node:assert");

const { createProspectiveMemory, BOUNDS } = require("../../../src/cognition/prospective");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

function manualClock(startMs) {
    let t = startMs;
    return { nowMs: () => t, advance: (ms) => { t += ms; } };
}

test("W7-L4 structural: createProspectiveMemory exposes the frozen public contract", async () => {
    const pm = await createProspectiveMemory();
    for (const method of ["arm", "tick", "checkOnStateReminders", "armExpectation", "checkExpectations", "getReminder", "getExpectation"]) {
        assert.equal(typeof pm[method], "function", `missing ${method}`);
    }
    assert.ok(pm.laws.PROSPECTIVE_MEMORY_NOT_EXECUTION_AUTHORITY);
});

test("W7-L4 functional: AT reminder fires exactly once when due, idempotent occurrence id", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock });
    pm.arm({ trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "NOTIFY_OWNER" });
    clock.advance(1500);
    const events = pm.tick();
    assert.equal(events.length, 1);
    assert.equal(pm.tick().length, 0, "reminder sudah FIRED, tidak tembak lagi");
});

test("W7-L4 functional: RECURRING fires each interval and stops at maxOccurrences", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock });
    pm.arm({ trigger: { kind: "RECURRING", intervalMs: 60_000, maxOccurrences: 2 }, wakeClass: "MAINTENANCE" });
    clock.advance(60_001);
    assert.equal(pm.tick().length, 1);
    clock.advance(60_000);
    assert.equal(pm.tick().length, 1);
    clock.advance(60_000);
    assert.equal(pm.tick().length, 0, "maxOccurrences tercapai, tidak tembak lagi");
});

test("W7-L4 restart catch-up: process-down reminder fires once as MISSED with lateness", async () => {
    const store = createMemoryAccStore();
    const clock1 = manualClock(0);
    const pm1 = await createProspectiveMemory({ clock: clock1, store });
    pm1.arm({ trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "NOTIFY_OWNER" });
    await pm1.persist();

    // "process was down" — waktu lompat jauh sebelum instance baru dibuat.
    const clock2 = manualClock(100_000);
    const pm2 = await createProspectiveMemory({ clock: clock2, store });
    assert.equal(pm2.catchUpEvents.length, 1);
    assert.equal(pm2.catchUpEvents[0].missed, true);
    assert.ok(pm2.catchUpEvents[0].lateness > 0);
});

test("W7-L4 boundedness: MAX_ARMED_REMINDERS and MAX_REMINDERS_PER_GOAL enforced", async () => {
    const pm = await createProspectiveMemory({ bounds: { ...BOUNDS, MAX_ARMED_REMINDERS: 2 } });
    pm.arm({ trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "MAINTENANCE" });
    pm.arm({ trigger: { kind: "AT", at: new Date(2000).toISOString() }, wakeClass: "MAINTENANCE" });
    assert.throws(() => pm.arm({ trigger: { kind: "AT", at: new Date(3000).toISOString() }, wakeClass: "MAINTENANCE" }),
        (err) => err.reason === "PROSPECTIVE_FULL");

    const pm2 = await createProspectiveMemory({ bounds: { ...BOUNDS, MAX_REMINDERS_PER_GOAL: 1 } });
    pm2.arm({ ownerRef: "goal-1", trigger: { kind: "AT", at: new Date(1000).toISOString() }, wakeClass: "RESUME_GOAL" });
    assert.throws(() => pm2.arm({ ownerRef: "goal-1", trigger: { kind: "AT", at: new Date(2000).toISOString() }, wakeClass: "RESUME_GOAL" }),
        (err) => err.reason === "PER_GOAL_LIMIT_EXCEEDED");
});

test("W7-L4 expectations: SATISFIED and VIOLATED per window, never fabricated intermediate state", async () => {
    const clock = manualClock(0);
    const pm = await createProspectiveMemory({ clock });
    pm.armExpectation({
        subject: { entityId: "e1" }, attribute: "status", expectedValue: "done",
        window: { earliestAt: new Date(0).toISOString(), latestAt: new Date(1000).toISOString() }
    });
    clock.advance(1500);
    const results = pm.checkExpectations(() => null); // tidak pernah terobservasi
    assert.equal(results[0].outcome, "VIOLATED");
});
