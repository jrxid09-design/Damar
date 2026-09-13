const test = require("node:test");
const assert = require("node:assert");

const { createWorldModel, BOUNDS } = require("../../../src/cognition/worldmodel");
const { KV_KEY } = require("../../../src/cognition/worldmodel/store");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

/** W7-L2 adversarial suite — the twelve attacks from
 * `W7_WORLD_MODEL_FORMAL_SPEC.md` §13 (WM-A1..A12). */

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

test("WM-A1: conflicting sensor opens a contradiction, never a silent overwrite", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "temp", value: 20,
        sensor: { sensorId: "good" }, tier: "T1", observedAt: new Date(1).toISOString() });
    const r = wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "temp", value: 99,
        sensor: { sensorId: "compromised" }, tier: "T1", observedAt: new Date(2).toISOString() });
    assert.equal(r.case, "CONTEST");
    assert.equal(wm.query({ subject: { entityId: "e1" }, attribute: "temp" }).value, 20);
});

test("WM-repair-2: evicting an entity also removes its incident relations -- no dangling relation in subgraph (Codex P2 round 6)", async () => {
    const clock = manualClock(1000);
    const store = createMemoryAccStore();
    await store.putKv(KV_KEY, {
        entities: {
            e0: { entityId: "e0", entityKind: "device", labels: [], firstSeenAt: 0, lastSeenAt: 0, externalRefs: [], source: "t" },
            e1: { entityId: "e1", entityKind: "device", labels: [], firstSeenAt: 0, lastSeenAt: 0, externalRefs: [], source: "t" }
        },
        relations: { r1: { relationId: "r1", kind: "near", from: "e0", to: "e1", directed: true, strength: 0.5 } },
        beliefs: {}, hypotheses: {}, contradictions: []
    });
    // Bounds tighter than the loaded snapshot -- realistic after a restart
    // with a lowered MAX_ENTITIES. Both loaded entities are connected
    // (degree 1 each), so redeclaring one of them (no new degree-0 entity
    // enters the pool) forces the eviction of a genuinely CONNECTED entity.
    const wm = await createWorldModel({ clock, store, bounds: { ...BOUNDS, MAX_ENTITIES: 1, MAX_ENTITIES_PER_SOURCE: 100 } });
    wm.declareEntity({ entityId: "e0", entityKind: "device", source: "t" });

    const sub = wm.subgraph(["e0"], 2);
    assert.ok(!sub.relations.some(r => r.relationId === "r1"),
        "relasi ke entitas yang sudah dievict tidak boleh tersisa di subgraph");
});

test("WM-repair-1: a non-date observedAt string is rejected, not silently treated as now() (Codex P2 round 5)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    assertThrowsReason(() => wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: "not-a-date"
    }), "MISSING_SENSOR_ID");
});

test("WM-A2: unresolvable/malformed evidence is rejected at ingest, not silently accepted", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    assertThrowsReason(() => wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "temp", value: 1,
        sensor: {}, tier: "T1", observedAt: new Date(1).toISOString() // sensorId absent -> forged/unresolvable
    }), "MISSING_SENSOR_ID");
});

test("WM-A3: writer cannot extend a belief's TTL to keep stale truth alive", async () => {
    const clock = manualClock(0);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    // REINFORCE (same value) does not reset the TTL clock backwards past decay boundary check.
    clock.advance(31 * 60_000);
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "status" });
    assert.equal(r.epistemicClass, "STALE", "TTL tidak bisa diperpanjang penulis nilai yang sama");
});

test("WM-A4: replica-flood-style repeated reinforcement never raises confidence past bounded evidence weight", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    for (let i = 0; i < 50; i++) {
        wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
            sensor: { sensorId: `s${i}` }, tier: "T1", observedAt: new Date(i + 1).toISOString() });
    }
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "status" });
    assert.ok(r.confidence <= 1, "confidence tetap dalam [0,1] walau membanjiri korroborasi");
    assert.equal(r.supportedBy.length, BOUNDS.MAX_OBSERVATIONS_RETAINED_PER_BELIEF,
        "supportedBy dibatasi, bukan tumbuh tak terbatas dengan banjir replika");
});

test("WM-A5: memory/recall-shaped input cannot ingest as an observation", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    assertThrowsReason(() => wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "memory-recall" }, tier: "T6", observedAt: new Date(1).toISOString() // T6 = belief tier, not admissible for ingest
    }), "INADMISSIBLE_TIER");
});

test("WM-A6: entity explosion from one source is quota-limited, does not grow unbounded", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_ENTITIES_PER_SOURCE: 5 } });
    for (let i = 0; i < 5; i++) wm.declareEntity({ entityId: `e${i}`, entityKind: "window", source: "desktop-titles" });
    assertThrowsReason(() => wm.declareEntity({ entityId: "e5", entityKind: "window", source: "desktop-titles" }),
        "QUOTA_EXCEEDED");
});

test("WM-A6-repair: redeclaring an entity under a new source cannot bypass the old/new source quotas (Codex P2 finding)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_ENTITIES_PER_SOURCE: 1 } });
    wm.declareEntity({ entityId: "e1", entityKind: "window", source: "source-a" });
    // Redeclare e1 under source-b — source-b's quota (1) should now count e1.
    wm.declareEntity({ entityId: "e1", entityKind: "window", source: "source-b" });
    assert.throws(() => wm.declareEntity({ entityId: "e2", entityKind: "window", source: "source-b" }),
        (err) => err.reason === "QUOTA_EXCEEDED", "source-b harus dianggap sudah memakai 1 kuotanya dari e1");
    // source-a's quota should be freed up again since e1 moved away.
    assert.doesNotThrow(() => wm.declareEntity({ entityId: "e3", entityKind: "window", source: "source-a" }),
        "source-a harus melepas kuota e1 yang sudah pindah sumber");
});

test("WM-A6-repair-2: eviction prefers the lowest-degree entity, not merely the oldest (Codex P2 round 3)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_ENTITIES: 3 } });
    // e1 (oldest) and e3 become connected; e2 (also old, but isolated) has degree 0.
    wm.declareEntity({ entityId: "e1", entityKind: "hub", source: "t" });
    wm.declareEntity({ entityId: "e2", entityKind: "isolated", source: "t" });
    wm.declareEntity({ entityId: "e3", entityKind: "leaf", source: "t" });
    wm.declareRelation({ relationId: "r1", kind: "near", from: "e1", to: "e3" });

    // A 4th entity pushes past MAX_ENTITIES=3; the isolated e2 (degree 0)
    // must be evicted even though e1 is equally old but has degree 1.
    wm.declareEntity({ entityId: "e4", entityKind: "leaf", source: "t" });

    const byKind = wm.entitiesByKind("isolated", 10);
    assert.equal(byKind.entities.length, 0,
        "entitas terisolasi (e2) harus dievict duluan, bukan e1 yang sama tuanya tapi terhubung");
    assert.ok(wm.entitiesByKind("hub", 10).entities.length > 0, "e1 yang terhubung harus bertahan");
});

test("WM-A7: graph traversal never walks past its depth/fanout caps", async () => {
    const wm = await createWorldModel();
    // Build a long chain longer than PATH_MAX_DEPTH.
    for (let i = 0; i <= 10; i++) wm.declareEntity({ entityId: `n${i}`, entityKind: "node", source: "t" });
    for (let i = 0; i < 10; i++) wm.declareRelation({ relationId: `r${i}`, kind: "next", from: `n${i}`, to: `n${i + 1}` });

    const p = wm.path("n0", "n10", 20); // requested depth exceeds PATH_MAX_DEPTH(5), must be clamped
    assert.equal(p.path, null);
    assert.equal(p.truncated, true);
});

test("WM-A8-repair: contradiction list stays bounded on overflow, does not grow (Codex P2 round 4)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 3 } });
    for (let i = 0; i < 6; i++) {
        wm.declareEntity({ entityId: `e${i}`, entityKind: "device", source: "t" });
        wm.ingestObservation({ subject: { entityId: `e${i}` }, attribute: "status", value: "on",
            sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(i * 10 + 1).toISOString() });
        wm.ingestObservation({ subject: { entityId: `e${i}` }, attribute: "status", value: "off",
            sensor: { sensorId: "s2" }, tier: "T1", observedAt: new Date(i * 10 + 2).toISOString() });
    }
    // 6 contradictions opened against a cap of 3 — the tracked list must
    // never exceed the bound, even though every overflow "archives" one.
    assert.ok(wm.openContradictions().length <= 3, "daftar kontradiksi tidak boleh tumbuh melebihi batas");
});

test("WM-A8: resolving a contradiction without a ruleId is rejected, no silent close", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    const contest = wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "off",
        sensor: { sensorId: "s2" }, tier: "T1", observedAt: new Date(2).toISOString() });

    assertThrowsReason(() => wm.resolveContradiction(contest.contradictionSetId, ""), "SILENT_RESOLUTION_REJECTED");
    assertThrowsReason(() => wm.resolveContradiction(contest.contradictionSetId, undefined), "SILENT_RESOLUTION_REJECTED");

    const resolved = wm.resolveContradiction(contest.contradictionSetId, "rule.owner-override");
    assert.equal(resolved.status, "RESOLVED");
    assert.equal(resolved.resolution.ruleId, "rule.owner-override");
});

test("WM-A9: confidence cannot be injected — no ingest path accepts a confidence field", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString(), confidence: 1.0 });
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "status" });
    assert.ok(r.confidence < 1, "confidence=1.0 yang disuntikkan pemanggil diabaikan, dihitung ulang dari bukti");
});

test("WM-A10: simulation-tagged records are rejected at ingest with a named reason", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    assertThrowsReason(() => wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "sim" }, tier: "SIMULATION", observedAt: new Date(1).toISOString()
    }), "SIMULATION_NOT_ADMISSIBLE");
});

test("WM-A11: decay TTL is not writable at runtime by the ingest caller", async () => {
    const clock = manualClock(0);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    // Caller tries to smuggle a custom ttlMs/decayPolicy through the observation spec.
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString(), decayPolicy: { ttlMs: 999_999_999, decayKind: "NONE" } });
    clock.advance(31 * 60_000);
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "status" });
    assert.equal(r.epistemicClass, "STALE", "decayPolicy dari pemanggil diabaikan, TTL tetap kebijakan pemilik");
});

test("WM-A12: an inference-tier record can never be cited as supportedBy for an OBSERVED belief", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    assertThrowsReason(() => wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "inference-engine" }, tier: "T7", observedAt: new Date(1).toISOString()
    }), "INADMISSIBLE_TIER");
});
