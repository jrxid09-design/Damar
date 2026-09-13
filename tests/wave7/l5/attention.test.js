const test = require("node:test");
const assert = require("node:assert");

const { createAttentionEconomy, BOUNDS } = require("../../../src/cognition/attention");

function manualClock(startMs) {
    let t = startMs;
    return { nowMs: () => t, advance: (ms) => { t += ms; } };
}

function ownerSignal(overrides = {}) {
    return { sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "e1" }, ...overrides };
}

test("W7-L5 structural: createAttentionEconomy exposes the frozen public contract", async () => {
    const ae = await createAttentionEconomy();
    for (const method of ["ingestSignal", "pick", "preempt", "complete", "getTarget", "overloadState", "toGovernorPriority"]) {
        assert.equal(typeof ae[method], "function", `missing ${method}`);
    }
    assert.ok(ae.laws.HIGH_SALIENCE_NOT_HIGH_PRIVILEGE);
});

test("W7-L5 functional: owner signal is classed P1_OWNER by policy, not by the caller", async () => {
    const ae = await createAttentionEconomy();
    const { targetId } = ae.ingestSignal(ownerSignal(), "REASON");
    assert.equal(ae.getTarget(targetId).priorityClass, "P1_OWNER");
});

test("W7-L5 functional: P0_SAFETY only reachable via allowlisted origin", async () => {
    const ae = await createAttentionEconomy();
    const { targetId } = ae.ingestSignal({
        sourceKind: "SYSTEM", sourceId: "safety-monitor", subjectRef: { entityId: "e1" },
        evidenceRef: { originKind: "SAFETY_MONITOR" }
    }, "VERIFY");
    assert.equal(ae.getTarget(targetId).priorityClass, "P0_SAFETY");
});

test("W7-L5 functional: pick() is deterministic given the same state and clock", async () => {
    const clock = manualClock(0);
    const ae1 = await createAttentionEconomy({ clock });
    ae1.ingestSignal(ownerSignal({ subjectRef: { entityId: "a" } }), "REASON");
    ae1.ingestSignal(ownerSignal({ subjectRef: { entityId: "b" } }), "REASON");
    const first = ae1.pick();

    const clock2 = manualClock(0);
    const ae2 = await createAttentionEconomy({ clock: clock2 });
    ae2.ingestSignal(ownerSignal({ subjectRef: { entityId: "a" } }), "REASON");
    ae2.ingestSignal(ownerSignal({ subjectRef: { entityId: "b" } }), "REASON");
    const second = ae2.pick();

    assert.equal(first.subjectRef.entityId, second.subjectRef.entityId, "replay identik menghasilkan pilihan identik");
});

test("W7-L5 functional: preemption is bounded, then must run to completion", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_PREEMPTIONS: 1 } });
    const { targetId } = ae.ingestSignal(ownerSignal(), "REASON");
    ae.pick();
    ae.preempt(targetId);
    ae.pick();
    assert.throws(() => ae.preempt(targetId), (err) => err.reason === "PREEMPTION_LIMIT_EXCEEDED");
});

test("W7-L5 functional: attention-to-governor mapping is explicit and audited, never a raw copy", async () => {
    const ae = await createAttentionEconomy();
    const mapped = ae.toGovernorPriority("P1_OWNER");
    assert.equal(mapped, "HIGH");
    assert.equal(ae.governorMappingAudit().length, 1);
});

test("W7-L5 overload: overloadState reports SOFT/HARD as queue depth rises", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_QUEUED_TARGETS: 10 } });
    for (let i = 0; i < 8; i++) ae.ingestSignal(ownerSignal({ subjectRef: { entityId: `e${i}` } }), "REASON");
    assert.equal(ae.overloadState(), "SOFT");
});
