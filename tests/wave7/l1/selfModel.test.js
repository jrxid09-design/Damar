const test = require("node:test");
const assert = require("node:assert");

const { createSelfModel, BOUNDS } = require("../../../src/cognition/selfmodel");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

/** Fake Capability Registry port — hanya permukaan yang dikonsumsi L1. */
function fakeRegistry(descriptors = {}) {
    const map = new Map(Object.entries(descriptors));
    return {
        get: (id) => (map.has(id) ? { id, ...map.get(id) } : null),
        has: (id) => map.has(id),
        getAvailability: () => { throw new Error("not used directly by L1 in these tests"); },
        _define(id, descriptor) { map.set(id, descriptor); },
        _remove(id) { map.delete(id); }
    };
}

function manualClock(startMs) {
    let t = startMs;
    return { nowMs: () => t, advance: (ms) => { t += ms; } };
}

test("W7-L1 structural: createSelfModel exposes the frozen public contract", async () => {
    const sm = await createSelfModel({ capabilityRegistry: fakeRegistry() });
    for (const method of ["snapshot", "assess", "unknowns", "ingestOutcome",
        "ingestAvailability", "ingestHealth", "limitations"]) {
        assert.equal(typeof sm[method], "function", `missing ${method}`);
    }
    assert.ok(sm.laws.SELF_MODEL_NOT_AUTHORITY);
    assert.ok(Object.isFrozen(sm));
});

test("W7-L1 structural: capabilityRegistry port is required and validated", async () => {
    await assert.rejects(() => createSelfModel({}), (err) => err.reason === "INVALID_PORT");
});

test("W7-L1 functional: assess() with descriptor but no availability yet -> UNKNOWN, not usable", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    const a = sm.assess("cap.x");
    assert.equal(a.selfBelief, "UNKNOWN");
    assert.equal(a.availability, "UNKNOWN");
});

test("W7-L1 functional: ingestAvailability AVAILABLE -> USABLE with no outcome history", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const clock = manualClock(1000);
    const sm = await createSelfModel({ capabilityRegistry: registry, clock });
    const a = sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 1000 });
    assert.equal(a.selfBelief, "USABLE");
    assert.equal(a.confidence.basis, "NO_EVIDENCE");
});

test("W7-L1 functional: ingestOutcome updates successWindow and confidence basis", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const clock = manualClock(1000);
    const sm = await createSelfModel({ capabilityRegistry: registry, clock });
    sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 1000 });
    sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: "t1", evidenceRef: "ev-1" });
    const a = sm.assess("cap.x");
    assert.equal(a.successWindow.attempts, 1);
    assert.equal(a.successWindow.successes, 1);
    assert.equal(a.confidence.basis, "OUTCOME_HISTORY");
    assert.equal(a.confidence.value, 1);
});

test("W7-L1 boundedness: MAX_SUCCESS_WINDOW keeps only the most recent N attempts", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 1 });
    for (let i = 0; i < BOUNDS.MAX_SUCCESS_WINDOW + 10; i++) {
        sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: `t${i}`, evidenceRef: `ev-${i}` });
    }
    const a = sm.assess("cap.x");
    assert.equal(a.successWindow.attempts, BOUNDS.MAX_SUCCESS_WINDOW);
});

test("W7-L1 boundedness: MAX_UNKNOWNS overflow truncates and never crashes", async () => {
    const registry = fakeRegistry();
    const sm = await createSelfModel({ capabilityRegistry: registry });
    for (let i = 0; i < BOUNDS.MAX_UNKNOWNS + 20; i++) {
        sm.assess(`missing.${i}`);
    }
    assert.ok(sm.unknowns().length <= BOUNDS.MAX_UNKNOWNS);
});

test("W7-L1 boundedness: MAX_CAPABILITY_ASSESSMENTS evicts by lastUsedAt ascending", async () => {
    const descriptors = {};
    for (let i = 0; i < BOUNDS.MAX_CAPABILITY_ASSESSMENTS + 5; i++) descriptors[`cap.${i}`] = { kind: "tool" };
    const registry = fakeRegistry(descriptors);
    const clock = manualClock(0);
    const sm = await createSelfModel({ capabilityRegistry: registry, clock });

    for (let i = 0; i < BOUNDS.MAX_CAPABILITY_ASSESSMENTS + 5; i++) {
        clock.advance(1);
        sm.ingestAvailability({ capabilityId: `cap.${i}`, availability: "AVAILABLE", generation: 1, observedAtMs: clock.nowMs() });
    }

    // cap.0 was touched first (oldest lastUsedAt) -> evicted; becomes UNKNOWN again, not crash.
    const evicted = sm.assess("cap.0");
    assert.equal(evicted.availability, "UNKNOWN");

    // the most recently touched one must still be cached.
    const recent = sm.assess(`cap.${BOUNDS.MAX_CAPABILITY_ASSESSMENTS + 4}`);
    assert.equal(recent.availability, "AVAILABLE");
});

test("W7-L1 restart/persistence: successWindow survives a fresh createSelfModel, availability never restored fresh", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const store = createMemoryAccStore();
    const clock = manualClock(1000);

    const sm1 = await createSelfModel({ capabilityRegistry: registry, store, clock });
    sm1.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 1000 });
    sm1.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: "t1", evidenceRef: "ev-1" });
    await sm1.persist();

    // "restart": brand new instance, same durable store, fresh in-memory cache.
    const sm2 = await createSelfModel({ capabilityRegistry: registry, store, clock: manualClock(2000) });
    const a = sm2.assess("cap.x");

    assert.equal(a.successWindow.attempts, 1, "successWindow DURABLE_LOCAL survives restart");
    assert.equal(a.availability, "UNKNOWN", "availability is NEVER restored fresh across restart");
    assert.equal(a.selfBelief, "UNKNOWN");
});

test("W7-L1 snapshot: bounded byte size, deterministic truncation flag", async () => {
    const descriptors = {};
    for (let i = 0; i < 50; i++) descriptors[`cap.${i}`] = { kind: "tool" };
    const registry = fakeRegistry(descriptors);
    const sm = await createSelfModel({ capabilityRegistry: registry, bounds: { ...BOUNDS, MAX_SNAPSHOT_BYTES: 500 } });
    for (let i = 0; i < 50; i++) {
        sm.ingestAvailability({ capabilityId: `cap.${i}`, availability: "AVAILABLE", generation: 1, observedAtMs: 1 });
    }
    const snap = sm.snapshot();
    assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= 500 * 4, "truncation actually shrinks the snapshot");
    assert.equal(snap.snapshotTruncated, true);
});
