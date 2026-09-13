const test = require("node:test");
const assert = require("node:assert");

const { createWorldModel, BOUNDS } = require("../../../src/cognition/worldmodel");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

function manualClock(startMs) {
    let t = startMs;
    return { nowMs: () => t, advance: (ms) => { t += ms; } };
}

test("W7-L2 structural: createWorldModel exposes the frozen public contract", async () => {
    const wm = await createWorldModel();
    for (const method of ["declareEntity", "declareRelation", "ingestObservation",
        "ingestDeclaration", "query", "neighbors", "subgraph", "path",
        "entitiesByKind", "openContradictions", "resolveContradiction"]) {
        assert.equal(typeof wm[method], "function", `missing ${method}`);
    }
    assert.ok(wm.laws.WORLD_MODEL_NOT_GROUND_TRUTH);
});

test("W7-L2 functional: query on never-observed subject returns unknown, not a bare value", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "test" });
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "status" });
    assert.equal(r.unknown, true);
    assert.equal(r.reason, "NEVER_OBSERVED");
});

test("W7-L2 functional: REINFORCE then read returns OBSERVED with rising corroboration", async () => {
    const clock = manualClock(1000);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "test" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(2).toISOString() });
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "status" });
    assert.equal(r.value, "on");
    assert.equal(r.epistemicClass, "OBSERVED");
    assert.equal(r.revision, 2);
});

test("W7-L2 functional: CONTEST opens a contradiction set without changing the value", async () => {
    const clock = manualClock(1000);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "test" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    const result = wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "off",
        sensor: { sensorId: "s2" }, tier: "T1", observedAt: new Date(2).toISOString() });
    assert.equal(result.case, "CONTEST");

    const r = wm.query({ subject: { entityId: "e1" }, attribute: "status" });
    assert.equal(r.value, "on", "nilai tidak berubah pada CONTEST");
    assert.equal(r.contested, true);
    assert.equal(wm.openContradictions().length, 1);
});

test("W7-L2 functional: SUPERSEDE only after the incumbent belief has expired", async () => {
    const clock = manualClock(1000);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "test" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });

    clock.advance(31 * 60_000); // past default 30-minute TTL
    const result = wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "off",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(2).toISOString() });
    assert.equal(result.case, "SUPERSEDE");
    assert.equal(wm.query({ subject: { entityId: "e1" }, attribute: "status" }).value, "off");
});

test("W7-L2 functional: query decays to STALE at read time after TTL, without any write", async () => {
    const clock = manualClock(1000);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "test" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    clock.advance(31 * 60_000);
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "status" });
    assert.equal(r.epistemicClass, "STALE");
    assert.equal(r.value, "on", "absennya keyakinan segar tidak pernah dilaporkan sebagai false");
});

test("W7-L2 functional: requireFresh returns unknown instead of a stale value (Q-2)", async () => {
    const clock = manualClock(1000);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "test" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    clock.advance(31 * 60_000);
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "status", requireFresh: true });
    assert.equal(r.unknown, true);
    assert.equal(r.reason, "STALE_SOURCE");
});

test("W7-L2 graph: neighbors/path/entitiesByKind stay within bounds", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "a", entityKind: "device", source: "t" });
    wm.declareEntity({ entityId: "b", entityKind: "device", source: "t" });
    wm.declareEntity({ entityId: "c", entityKind: "device", source: "t" });
    wm.declareRelation({ relationId: "r1", kind: "near", from: "a", to: "b" });
    wm.declareRelation({ relationId: "r2", kind: "near", from: "b", to: "c" });

    const n = wm.neighbors("a", null, 1);
    assert.deepEqual(n.entities.map(e => e.entityId), ["b"]);

    const p = wm.path("a", "c", 5);
    assert.deepEqual(p.path, ["a", "b", "c"]);

    const byKind = wm.entitiesByKind("device", 2);
    assert.equal(byKind.entities.length, 2);
    assert.equal(byKind.truncated, true);
});

test("W7-L2 boundedness: entity overflow evicts by lastSeenAt, never crashes", async () => {
    const clock = manualClock(0);
    const wm = await createWorldModel({ clock, bounds: { ...BOUNDS, MAX_ENTITIES: 5, MAX_ENTITIES_PER_SOURCE: 100 } });
    for (let i = 0; i < 8; i++) {
        clock.advance(1);
        wm.declareEntity({ entityId: `e${i}`, entityKind: "device", source: "t" });
    }
    const byKind = wm.entitiesByKind("device", 100);
    assert.equal(byKind.entities.length, 5);
    assert.ok(!byKind.entities.some(e => e.entityId === "e0"), "entitas tertua dievict");
});

test("W7-L2 restart/persistence: beliefs and entities survive a fresh createWorldModel", async () => {
    const store = createMemoryAccStore();
    const wm1 = await createWorldModel({ store });
    wm1.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    wm1.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    await wm1.persist();

    const wm2 = await createWorldModel({ store });
    assert.equal(wm2.worldModelColdStart, false);
    const r = wm2.query({ subject: { entityId: "e1" }, attribute: "status" });
    assert.equal(r.value, "on");
});

test("W7-L2 restart: cold start with no store is marked, never fabricates state", async () => {
    const wm = await createWorldModel();
    assert.equal(wm.worldModelColdStart, true);
});
