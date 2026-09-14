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

/** A real array (so Array.isArray stays true) whose `.length` read is
 * intercepted to return an arbitrary (possibly invalid) value -- a plain
 * array's own `.length` setter enforces the valid-array-length invariant,
 * so a hostile length must come from a Proxy `get` trap instead. */
function fakeLengthArray(items, badLen) {
    return new Proxy(items.slice(), {
        get(t, p, r) { return p === "length" ? badLen : Reflect.get(t, p, r); }
    });
}

/** A plain object whose `getOwnPropertyDescriptor` trap throws a HOSTILE
 * value (a Proxy whose own `getPrototypeOf` trap raw-throws) instead of a
 * normal Error -- exercises whether a walker's `catch(err){ if (err
 * instanceof XError) ... }` guard itself raw-throws on the caught value. */
function hostileThrowObj() {
    const h = new Proxy({}, { getPrototypeOf() { throw new Error("RAW"); } });
    return new Proxy({}, {
        getOwnPropertyDescriptor() { throw h; },
        ownKeys() { return ["a"]; },
        getPrototypeOf() { return Object.prototype; }
    });
}

test("WM-repair-93: ingestObservation retains ZERO new beliefs when MAX_TOTAL_BELIEFS is 0 -- the empty-eviction-search guard (if (victimKey !== null)) already prevented growth beyond the eviction step, but beliefs.set() ran unconditionally afterward, silently exceeding a sanctioned zero cap (self-discovered sweep, sibling of round 59's W7R59-P2-1..5 zero-boundary class)", async () => {
    const wm = await createWorldModel({ bounds: { MAX_TOTAL_BELIEFS: 0 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "temp", value: 20, sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "temp" });
    assert.equal(r.unknown, true);
    assert.equal(r.reason, "NEVER_OBSERVED");
});

test("WM-repair-94: declareHypothesis retains ZERO new hypotheses when MAX_HYPOTHESES is 0 -- the same unconditional-set-after-eviction-attempt class as WM-repair-93, never swept here (self-discovered sweep, sibling of round 59's W7R59-P2-1..5 zero-boundary class)", async () => {
    const wm = await createWorldModel({ bounds: { MAX_HYPOTHESES: 0 } });
    wm.declareEntity({ entityId: "e1", entityKind: "k", source: "s" });
    const spec = {
        hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "a",
        candidateValues: [{ value: "x", weight: 1 }], expiresAt: "2030-01-01T00:00:00.000Z"
    };
    assert.doesNotThrow(() => wm.declareHypothesis(spec));
    // if h1 were actually retained, re-declaring the same hypothesisId would
    // throw DUPLICATE_RECORD_ID -- it must NOT throw, proving nothing was stored.
    assert.doesNotThrow(() => wm.declareHypothesis(spec));
});

test("WM-repair-95: declareEntity retains ZERO entities when MAX_ENTITIES is 0 -- evictEntityIfOverBound's protectedEntityId excluded the just-created (and only) entity from the eviction candidates, leaving no victim and silently exceeding a sanctioned zero cap (independent audit round 60, OpenCode, W7R60-P2-1)", async () => {
    const wm = await createWorldModel({ bounds: { MAX_ENTITIES: 0 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    assert.equal(wm.entitiesByKind("device").entities.length, 0);
});

test("WM-repair-96: declareRelation retains ZERO relations when MAX_RELATIONS is 0 -- the exact sibling of WM-repair-95 in the same file, evictRelationIfOverBound's protectedRelationId excluded the only relation from eviction (independent audit round 60, OpenCode, W7R60-P2-2)", async () => {
    const wm = await createWorldModel({ bounds: { MAX_RELATIONS: 0 } });
    wm.declareEntity({ entityId: "a", entityKind: "k", source: "s" });
    wm.declareEntity({ entityId: "b", entityKind: "k", source: "s" });
    wm.declareRelation({ relationId: "r1", kind: "x", from: "a", to: "b", strength: 1 });
    assert.equal(wm.neighbors("a").entities.length, 0);
});

test("WM-repair-97: a challenger auto-archived at MAX_OPEN_CONTRADICTION_SETS=0 does not mark the belief as actively contested -- round 59's zero-cap fix for openContradictionSet returns an already-archived entry, but applyRecordToBelief still unconditionally wired it as the belief's ACTIVE contradictionSetId, leaking a pointer to a contradiction set that exists nowhere (independent audit round 60, Codex, W7R60-P2-2)", async () => {
    const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
    const store = createMemoryAccStore();
    const wm1 = await createWorldModel({ store, bounds: { MAX_OPEN_CONTRADICTION_SETS: 1 } });
    await wm1.declareEntity({ entityId: "e1", entityKind: "thing", source: "s" });
    wm1.ingestObservation({ observationId: "o1", subject: { entityId: "e1" }, attribute: "color", value: "red", sensor: { sensorId: "s1" }, tier: "T1", observedAt: "2024-01-01T00:00:00.000Z" });
    await wm1.persist();
    const wm2 = await createWorldModel({ store, bounds: { MAX_OPEN_CONTRADICTION_SETS: 0 } });
    const result = wm2.ingestObservation({ observationId: "o2", subject: { entityId: "e1" }, attribute: "color", value: "blue", sensor: { sensorId: "s2" }, tier: "T1", observedAt: "2024-01-01T00:00:01.000Z" });
    assert.equal(result.case, "CONTEST");
    assert.equal(wm2.openContradictions().length, 0);
    const q = wm2.query({ subject: { entityId: "e1" }, attribute: "color" });
    assert.equal(q.contested, false);
    assert.equal(q.contradictionSetId, null);
});

test("WM-repair-98: declareEntity's evictEntityIfOverBound fully compacts down to a newly-lowered MAX_ENTITIES after a store reload, not just one entity per call -- round 60's fix only removed a single victim per invocation, so pre-existing persisted entities (written under a higher bound) never got compacted when reopened with a lower one (independent audit round 61, Codex, AUD61-P2-1, BLOCKING, same class swept to the entity graph)", async () => {
    const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
    const store = createMemoryAccStore();
    const wm1 = await createWorldModel({ store, bounds: { MAX_ENTITIES: 5 } });
    await wm1.declareEntity({ entityId: "e1", entityKind: "thing", source: "s" });
    await wm1.declareEntity({ entityId: "e2", entityKind: "thing", source: "s" });
    await wm1.persist();

    const wm2 = await createWorldModel({ store, bounds: { MAX_ENTITIES: 0 } });
    wm2.declareEntity({ entityId: "e3", entityKind: "thing", source: "s" });
    assert.equal(wm2.entitiesByKind("thing").entities.length, 0);
});

test("WM-repair-99: neighbors/path/entitiesByKind honor a caller-sanctioned override of NEIGHBORS_MAX_FANOUT/PATH_MAX_DEPTH/ENTITIES_BY_KIND_LIMIT -- graph.js's traversal functions read the module's fixed BOUNDS constant directly, never receiving the sanitized per-instance bounds, so overrides (including 0) were silently ignored entirely (independent audit round 64, Codex, AUD64-P2-1)", async () => {
    const wm = await createWorldModel({ bounds: { NEIGHBORS_MAX_FANOUT: 0, PATH_MAX_DEPTH: 0, ENTITIES_BY_KIND_LIMIT: 0 } });
    wm.declareEntity({ entityId: "a", entityKind: "thing", source: "s" });
    wm.declareEntity({ entityId: "b", entityKind: "thing", source: "s" });
    wm.declareRelation({ relationId: "r1", kind: "x", from: "a", to: "b", strength: 1 });

    assert.equal(wm.neighbors("a", null, 1).entities.length, 0);
    assert.equal(wm.path("a", "b", 5).path, null);
    assert.equal(wm.entitiesByKind("thing").entities.length, 0);
});

test("WM-repair-100: applyRevision honors a caller-sanctioned override of MAX_OBSERVATIONS_RETAINED_PER_BELIEF -- beliefAlgebra.js read the module's fixed BOUNDS constant directly instead of the sanitized per-instance bounds (independent audit round 64, Codex, AUD64-P2-1, sibling sweep)", async () => {
    const wm = await createWorldModel({ bounds: { MAX_OBSERVATIONS_RETAINED_PER_BELIEF: 1 } });
    wm.declareEntity({ entityId: "e1", entityKind: "thing", source: "s" });
    for (let i = 0; i < 5; i++) {
        wm.ingestObservation({ observationId: `o${i}`, subject: { entityId: "e1" }, attribute: "temp", value: 20, sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(i + 1).toISOString() });
    }
    const q = wm.query({ subject: { entityId: "e1" }, attribute: "temp" });
    assert.ok(q.supportedBy.length <= 1, "supportedBy harus dibatasi ke override MAX_OBSERVATIONS_RETAINED_PER_BELIEF, bukan default modul 32");
});

test("WM-repair-101: ingestObservation honors a caller-sanctioned override of MAX_VALUE_NODES (including 0) for composite belief values -- buildSafeBeliefValue read the module's fixed BOUNDS constant directly instead of the sanitized per-instance bounds (independent audit round 65, Codex, AUD65-P2-1, escalation of a round-64 disclosed-but-unfixed item)", async () => {
    const wm = await createWorldModel({ bounds: { MAX_VALUE_NODES: 0 } });
    wm.declareEntity({ entityId: "e1", entityKind: "thing", source: "s" });
    assert.throws(() => wm.ingestObservation({
        observationId: "o1", subject: { entityId: "e1" }, attribute: "cfg", value: { mode: "safe" },
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString()
    }));
});

test("WM-repair-102: declareHypothesis honors a caller-sanctioned override of MAX_VALUE_NODES (including 0) for composite candidate values, and declareEntity honors a caller-sanctioned override of MAX_ENTITY_LABEL_KEYS -- makeHypothesis/buildSafeBeliefValue and validateLabels read the module's fixed BOUNDS constant directly instead of the sanitized per-instance bounds (independent audit round 66, Codex, W7R66-P2-2, escalation of a round-65 disclosed-but-unfixed item)", async () => {
    const wmHyp = await createWorldModel({ bounds: { MAX_VALUE_NODES: 0 } });
    wmHyp.declareEntity({ entityId: "e1", entityKind: "thing", source: "s" });
    assert.throws(() => wmHyp.declareHypothesis({
        hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "a",
        candidateValues: [{ value: { nested: "composite" }, weight: 1 }],
        expiresAt: "2030-01-01T00:00:00.000Z"
    }));

    const wmLabel = await createWorldModel({ bounds: { MAX_ENTITY_LABEL_KEYS: 0 } });
    assertThrowsReason(() => wmLabel.declareEntity({
        entityId: "e2", entityKind: "thing", source: "s", labels: { a: "1" }
    }), "BOUND_EXCEEDED");
});

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

test("WM-repair-4: mutating a query() result's value never rewrites the stored belief (independent audit W7R4-P1-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "cfg", value: { mode: "safe" },
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString()
    });
    const r1 = wm.query({ subject: { entityId: "e1" }, attribute: "cfg" });
    assert.throws(() => { "use strict"; r1.value.mode = "PWNED"; });
    const r2 = wm.query({ subject: { entityId: "e1" }, attribute: "cfg" });
    assert.equal(r2.value.mode, "safe", "mutasi hasil query() tidak boleh menulis ulang belief tersimpan");
    assert.equal(r2.revision, 1, "revisi tidak boleh naik hanya karena hasil query() dimutasi");
});

test("WM-repair-5: ingestDeclaration copies its input, post-ingest mutation cannot rewrite the stored belief (independent audit W7R4-P1-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const decl = { owner: "real" };
    wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: "decl", value: decl, declarationId: "d1" });
    decl.owner = "ATTACKER"; // mutate the caller's original object after ingest
    const r = wm.query({ subject: { entityId: "e1" }, attribute: "decl" });
    assert.equal(r.value.owner, "real", "ingestDeclaration harus menyalin input, bukan menyimpan referensi mentah");
});

test("WM-repair-6: a toJSON hook on an observation value is never invoked (independent audit W7R4-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    let calls = 0;
    const value = { toJSON() { calls++; return { pwned: true }; } };
    assertThrowsReason(() => wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "a", value,
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString()
    }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(calls, 0, "toJSON pada value observasi tidak boleh pernah dipanggil");
    assertThrowsReason(() => wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "b", value: () => {},
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString()
    }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("WM-repair-7: entityCountBySource deletes a source key once its count reaches zero (independent audit W7R4-P2-3)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s1" });
    assert.equal(wm.entityCountBySourceSize(), 1);
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s2" }); // source change, s1 count -> 0
    assert.equal(wm.entityCountBySourceSize(), 1,
        "sumber lama dengan hitungan nol harus dihapus, bukan menumpuk sebagai kunci basi");
});

test("WM-repair-8: hypothesis candidateValues/discriminatingProbe reject executable material and never invoke toJSON (independent audit W7R5-P1-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    let calls = 0;
    const hostile = { toJSON() { calls++; return { pwned: true }; } };
    assertThrowsReason(() => wm.declareHypothesis({
        hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "cfg",
        candidateValues: [{ value: hostile, weight: 0.5 }], discriminatingProbe: hostile,
        expiresAt: new Date(9e12).toISOString()
    }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(calls, 0, "toJSON pada candidateValues/discriminatingProbe tidak boleh pernah dipanggil");
});

test("WM-repair-9: buildSafeBeliefValue is bounded on a shared-reference DAG, not just cycles (independent audit W7R5-P1-2)", () => {
    const { buildSafeBeliefValue } = require("../../../src/cognition/worldmodel/beliefAlgebra");
    function dag(d, f) {
        let n = { leaf: 1 };
        for (let i = 0; i < d; i++) { const o = {}; for (let k = 0; k < f; k++) o["k" + k] = n; n = o; }
        return n;
    }
    const t = Date.now();
    assertThrowsReason(() => buildSafeBeliefValue(dag(16, 4)), "EXECUTABLE_MATERIAL_REJECTED");
    assert.ok(Date.now() - t < 500, "DAG referensi-bersama harus ditolak lewat anggaran node, bukan diperluas penuh");
});

test("WM-repair-10: query() result stays immutable after a restart through a JSON-round-tripping store (independent audit W7R5-P1-3)", async () => {
    function jsonStore() {
        const kv = new Map();
        return {
            async putKv(k, v) { kv.set(k, JSON.parse(JSON.stringify(v))); },
            async getKv(k) { return kv.has(k) ? JSON.parse(JSON.stringify(kv.get(k))) : null; }
        };
    }
    const s = jsonStore();
    const wm1 = await createWorldModel({ store: s });
    wm1.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm1.ingestDeclaration({ subject: { entityId: "e1" }, attribute: "cfg", value: { mode: "safe" }, declarationId: "d1" });
    await wm1.persist();

    const wm2 = await createWorldModel({ store: s });
    const r = wm2.query({ subject: { entityId: "e1" }, attribute: "cfg" });
    assert.equal(Object.isFrozen(r.value), true);
    assert.equal(Object.isFrozen(r.supportedBy), true);
    assert.throws(() => { "use strict"; r.value.mode = "PWNED"; });
    assert.throws(() => { "use strict"; r.supportedBy.push("FORGED"); });
    assert.equal(wm2.query({ subject: { entityId: "e1" }, attribute: "cfg" }).value.mode, "safe");
});

test("WM-repair-11: ingestDeclaration's subject is copied, post-ingest mutation cannot rewrite a stored contradiction (independent audit W7R5-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const subject = { entityId: "e1" };
    wm.ingestDeclaration({ subject, attribute: "a", value: 1, declarationId: "d1" });
    subject.entityId = "HACKED";
    wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: "a", value: 2, declarationId: "d2" });
    assert.deepEqual(wm.openContradictions()[0].subject, { entityId: "e1" });
});

test("WM-repair-12: beliefs are retention-bounded across many distinct attribute names on one entity (independent audit W7R7-P1-3)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_TOTAL_BELIEFS: 10 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    for (let i = 0; i < 100; i++) {
        wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: `attr${i}`, value: i, declarationId: `d${i}` });
    }
    assert.ok(wm.beliefsSize() <= 10, "attribute string bebas tidak boleh menumpuk beliefs tanpa batas total");
});

test("WM-restart-freeze-collections: entities/relations/hypotheses/contradictions stay immutable after a JSON-round-tripping restart (independent audit W7R8-P1-1)", async () => {
    function jsonStore() {
        const kv = new Map();
        return {
            async getKv(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
            async putKv(k, v) { kv.set(k, JSON.stringify(v)); }
        };
    }
    const store = jsonStore();
    const wm1 = await createWorldModel({ store });
    wm1.declareEntity({ entityId: "e1", entityKind: "device", source: "trusted-sensor" });
    wm1.declareRelation({ relationId: "r1", kind: "connects", from: "e1", to: "e1" });
    wm1.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    wm1.ingestObservation({
        subject: { entityId: "e1" }, attribute: "state", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString()
    });
    wm1.ingestObservation({
        subject: { entityId: "e1" }, attribute: "state", value: "off",
        sensor: { sensorId: "s2" }, tier: "T1", observedAt: new Date(2).toISOString()
    });
    await wm1.persist();

    const wm2 = await createWorldModel({ store });
    const entity = wm2.entitiesByKind("device").entities[0];
    assert.equal(Object.isFrozen(entity), true);
    assert.throws(() => { "use strict"; entity.entityKind = "HACKED_KIND"; });

    const relation = wm2.subgraph(["e1"], 2).relations[0];
    assert.equal(Object.isFrozen(relation), true);
    assert.throws(() => { "use strict"; relation.from = "e2"; });

    const contradiction = wm2.openContradictions()[0];
    assert.equal(Object.isFrozen(contradiction), true);
    assert.throws(() => { "use strict"; contradiction.status = "RESOLVED"; });
    assert.equal(wm2.openContradictions().length, 1, "kontradiksi tidak boleh tertutup lewat mutasi hasil baca");
});

test("WM-repair-13: a replayed observationId is a no-op, not a fabricated REINFORCE (independent audit AUD9-P1-1)", async () => {
    // Bug review independen (audit putaran-23, AUD23-P2-3): tanpa clock
    // manual, confidence's real-time recency term (query.js's
    // `ageMs = nowMs - belief.updatedAtMs`) berubah antara dua panggilan
    // query() sungguhan, jadi `q2.confidence === q1.confidence` flaky
    // (gagal kalau scheduler menyisipkan >=1ms nyata di antaranya) --
    // bukan bug pada jalur DUPLICATE itu sendiri. Clock dibekukan supaya
    // pengujian menutup semantik replay, bukan artefak wall-clock.
    const clock = manualClock(1000);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const spec = {
        observationId: "OBS-1", subject: { entityId: "e1" }, attribute: "state",
        value: "on", sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1000).toISOString()
    };
    const r1 = wm.ingestObservation(spec);
    const q1 = wm.query({ subject: { entityId: "e1" }, attribute: "state" });
    const r2 = wm.ingestObservation(spec);
    const q2 = wm.query({ subject: { entityId: "e1" }, attribute: "state" });
    assert.equal(r1.case, "REFRESH");
    assert.equal(r2.case, "DUPLICATE", "replaying the same observationId must not be counted as new corroboration");
    assert.equal(q2.revision, q1.revision, "revision must not advance for a duplicate delivery");
    assert.equal(q2.confidence, q1.confidence, "confidence must not increase for a duplicate delivery");
});

test("WM-repair-14: entities stay frozen after ingestObservation touches lastSeenAt, and a re-declareEntity result stays frozen (independent audit AUD9-P1-2)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "state", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString()
    });
    const afterObservation = wm.entitiesByKind("device").entities[0];
    assert.equal(Object.isFrozen(afterObservation), true);
    assert.throws(() => { "use strict"; afterObservation.entityKind = "FORGED"; });
    assert.equal(wm.entitiesByKind("FORGED").entities.length, 0);

    const redeclared = wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    assert.equal(Object.isFrozen(redeclared), true);
    assert.throws(() => { "use strict"; redeclared.source = "FORGED_SOURCE"; });
});

test("WM-repair-15: replaying the same CONTEST challenger recordId does not evict legitimate open contradiction sets (independent audit AUD10-P1-3)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 2 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    const base = { attribute: "status", sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1000).toISOString() };
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "INCUMBENT-1", value: "a" });
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "LEGIT-CHALLENGER", sensor: { sensorId: "s2" }, value: "b" });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "INCUMBENT-2", value: "a" });
    for (let i = 0; i < 5; i++) {
        wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "REPLAY-CHALLENGER", sensor: { sensorId: "s3" }, value: "c" });
    }
    const ids = wm.openContradictions().map(c => c.challengerRecordId);
    assert.equal(ids.filter(id => id === "REPLAY-CHALLENGER").length, 1, "a replayed challenger must not open more than one contradiction set");
    assert.ok(ids.includes("LEGIT-CHALLENGER"), "a replayed challenger elsewhere must not evict a legitimate open contradiction");
});

test("WM-repair-16: a BigInt in ingestDeclaration's 'at' is rejected, not accepted and left to crash persist() (independent audit AUD11-P2-3)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    assert.throws(() => wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: "a", value: "v", declarationId: "D1", at: 10n }));
});

test("WM-repair-18: ingestDeclaration validates attribute/declarationId as non-empty strings, like ingestObservation (independent audit AUD12-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    assert.throws(() => wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: 10n, value: "v", declarationId: "D1" }));
    assert.throws(() => wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: "a", value: "v", declarationId: 10n }));
});

test("WM-repair-19: declareHypothesis's expiresAt is validated as an ISO string, not left to crash persist() or the expiry-eviction sort (proactive, same class as AUD11/AUD12-P2 bigint sweep)", async () => {
    const wm = await createWorldModel();
    assert.throws(() => wm.declareHypothesis({
        hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "cfg",
        candidateValues: [{ value: "a", weight: 0.5 }], expiresAt: 10n
    }));
    assert.throws(() => wm.declareHypothesis({
        hypothesisId: "h2", subject: { entityId: "e1" }, attribute: "cfg",
        candidateValues: [{ value: "a", weight: 0.5 }], expiresAt: "not-a-date"
    }));
});

test("WM-repair-20: declareHypothesis validates attribute as a non-empty string, not left to crash persist() (independent audit AUD13-P2-1)", async () => {
    const wm = await createWorldModel();
    assert.throws(() => wm.declareHypothesis({
        hypothesisId: "h1", subject: { entityId: "e1" }, attribute: 10n,
        candidateValues: [{ value: "a", weight: 0.5 }], expiresAt: new Date(Date.now() + 1000).toISOString()
    }));
});

test("WM-repair-21: replaying an already-used hypothesisId is rejected, not silently overwritten (independent audit AUD13-P2-4)", async () => {
    const wm = await createWorldModel();
    const iso = new Date(Date.now() + 100000).toISOString();
    wm.declareHypothesis({ hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "cfg", candidateValues: [{ value: "v1", weight: 0.5 }], expiresAt: iso });
    assertThrowsReason(() => wm.declareHypothesis({ hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "cfg", candidateValues: [{ value: "v2", weight: 0.9 }], expiresAt: iso }), "DUPLICATE_RECORD_ID");
});

test("WM-repair-22: a shared-reference DAG in a hypothesis candidateValue is rejected via a node budget (independent audit AUD14-P1-1, mirrors W7R5-P1-2)", async () => {
    function dag(d, f) {
        let n = { leaf: 1 };
        for (let i = 0; i < d; i++) { const o = {}; for (let k = 0; k < f; k++) o["k" + k] = n; n = o; }
        return n;
    }
    const wm = await createWorldModel();
    const t = Date.now();
    assertThrowsReason(() => wm.declareHypothesis({
        hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "cfg",
        candidateValues: [{ value: dag(16, 4), weight: 0.5 }], expiresAt: new Date(Date.now() + 1000).toISOString()
    }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.ok(Date.now() - t < 500);
});

test("WM-repair-23: a rejected declareHypothesis call must not evict an existing valid hypothesis (independent audit AUD14-P1-2)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_HYPOTHESES: 1 } });
    const iso = new Date(Date.now() + 100000).toISOString();
    wm.declareHypothesis({ hypothesisId: "H-KEEP", subject: { entityId: "e1" }, attribute: "cfg", candidateValues: [{ value: "v1", weight: 0.5 }], expiresAt: iso });
    assert.throws(() => wm.declareHypothesis({ hypothesisId: "H-BAD", subject: { entityId: "e2" }, attribute: "cfg", candidateValues: [{ value: "v2", weight: 0.5 }], expiresAt: "not-a-date" }));
    // H-KEEP must still exist: re-declaring the same id must still throw DUPLICATE_RECORD_ID, not silently succeed as if evicted.
    assertThrowsReason(() => wm.declareHypothesis({ hypothesisId: "H-KEEP", subject: { entityId: "e1" }, attribute: "cfg", candidateValues: [{ value: "v3", weight: 0.5 }], expiresAt: iso }), "DUPLICATE_RECORD_ID");
});

test("WM-repair-24: a rejected ingestObservation call must not evict an existing valid belief (independent audit AUD14-P1-2)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_TOTAL_BELIEFS: 1 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "a1", value: "v1", sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    assert.equal(wm.query({ subject: { entityId: "e1" }, attribute: "a1" }).epistemicClass, "OBSERVED");
    assert.throws(() => wm.ingestObservation({ subject: { entityId: "e2" }, attribute: "a2", value: 10n, sensor: { sensorId: "s2" }, tier: "T1", observedAt: new Date(2).toISOString() }));
    assert.equal(wm.query({ subject: { entityId: "e1" }, attribute: "a1" }).epistemicClass, "OBSERVED", "a rejected observation must not evict an existing valid belief");
});

test("WM-repair-25: replaying a CONTEST challenger recordId is still deduped after its contradiction set overflows out of the bounded list (independent audit AUD14-P2-1)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 1 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    const base = { attribute: "status", tier: "T1", observedAt: new Date(1000).toISOString() };
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "INCUMBENT-1", value: "a", sensor: { sensorId: "s1" } });
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "c2", value: "b", sensor: { sensorId: "s2" } });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "INCUMBENT-2", value: "a", sensor: { sensorId: "s1" } });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "c3", value: "b", sensor: { sensorId: "s3" } });
    // c3 overflowed c2's set out of the bounded list; c2 is now gone from `openContradictions()`.
    assert.equal(wm.openContradictions().map(c => c.challengerRecordId).includes("c2"), false);
    const replay = wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "c2", value: "b", sensor: { sensorId: "s2" } });
    assert.equal(replay.case, "DUPLICATE", "a challenger recordId already consumed must stay deduped even after its contradiction set overflows");
});

test("WM-repair-26: replaying a CONTEST challenger recordId stays deduped even after 32+ other records applied AND the contradiction set overflows (independent audit AUD15-P1-1)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 1 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    const base = { attribute: "status", tier: "T1" };
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "INCUMBENT-1", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "c2", value: "b", sensor: { sensorId: "s2" }, observedAt: new Date(1001).toISOString() });
    // Push appliedRecordIds well past its 32-entry window with legitimate REINFORCE traffic (same incumbent value "a", unrelated recordIds).
    for (let i = 0; i < 40; i++) {
        wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: `r${i}`, value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(2000 + i).toISOString() });
    }
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "INCUMBENT-2", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "c3", value: "b", sensor: { sensorId: "s3" }, observedAt: new Date(1001).toISOString() });
    assert.equal(wm.openContradictions().map(c => c.challengerRecordId).includes("c2"), false, "c2's set must have overflowed out of the bounded list");
    const replay = wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "c2", value: "b", sensor: { sensorId: "s2" }, observedAt: new Date(1001).toISOString() });
    assert.equal(replay.case, "DUPLICATE", "a challenger recordId must stay deduped past the 32-entry appliedRecordIds window");
    assert.equal(wm.openContradictions().map(c => c.challengerRecordId).includes("c3"), true, "the still-legitimate c3 contradiction must not be evicted by the replay");
});

test("WM-repair-27: an overflowed unresolved contradiction is archived and retrievable, not silently dropped (independent audit AUD16-P2-2)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 1 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    const base = { attribute: "status", tier: "T1" };
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "INC-1", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "c2", value: "b", sensor: { sensorId: "s2" }, observedAt: new Date(1001).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "INC-2", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "c3", value: "b", sensor: { sensorId: "s3" }, observedAt: new Date(1001).toISOString() });
    const overflowed = wm.overflowedContradictions();
    assert.equal(overflowed.length, 1);
    assert.equal(overflowed[0].challengerRecordId, "c2");
    assert.equal(overflowed[0].status, "UNRESOLVABLE");
});

test("WM-repair-60: subjectKeyOf reads subject.entityId exactly once, so a stateful getter cannot pass the type-guard and then crash key construction (independent audit AUD35-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "d", source: "s" });
    let n = 0;
    const subject = {};
    Object.defineProperty(subject, "entityId", { enumerable: true, configurable: true, get() { n++; return n === 1 ? "e1" : Symbol("boom"); } });
    assert.doesNotThrow(() => wm.query({ subject, attribute: "x" }));
    assert.equal(n, 1, "entityId must be read exactly once");
});

test("WM-repair-61: makeEntity's externalRefs[].system/id are each read exactly once, so a stateful getter cannot pass the guard and then crash .slice() (independent audit AUD35-P2-3)", async () => {
    const wm = await createWorldModel();
    let n = 0;
    const ref = { id: "i1" };
    Object.defineProperty(ref, "system", { enumerable: true, configurable: true, get() { n++; return n === 1 ? "sys" : Symbol("boom"); } });
    const e = wm.declareEntity({ entityId: "e1", entityKind: "d", source: "s", externalRefs: [ref] });
    assert.equal(n, 1, "externalRefs[].system must be read exactly once");
    assert.equal(e.externalRefs[0].system, "sys");
});

test("WM-repair-62: makeHypothesis's candidateValues[].weight is read exactly once, so a stateful getter cannot pass the guard and then crash Number() (independent audit AUD35-P2-4)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "d", source: "s" });
    let n = 0;
    const cand = { value: "v" };
    Object.defineProperty(cand, "weight", { enumerable: true, configurable: true, get() { n++; return n === 1 ? 1 : Symbol("boom"); } });
    const h = wm.declareHypothesis({ hypothesisId: "H1", subject: { entityId: "e1" }, attribute: "a", candidateValues: [cand], expiresAt: new Date(9e12).toISOString() });
    assert.equal(n, 1, "candidateValues[].weight must be read exactly once");
    assert.equal(h.candidateValues[0].weight, 1);
});

test("WM-repair-63: a subject whose get/getOwnPropertyDescriptor traps disagree is keyed and stored from the SAME (sanitized) reading, never a mix of both (independent audit AUD35-P2-5)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "d", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "d", source: "s" });
    // get() lies "e1" (what a naive plain-property read would see); the
    // descriptor (what buildSafeBeliefValue actually reads) says "e2".
    // Before the fix, the belief was KEYED under "e1" (subjectKeyOf/beliefKey
    // used the get trap) but STORED under "e2" (applyRevision's
    // buildSafeBeliefValue used the descriptor trap) -- two different
    // subjects for the same belief. After the fix, both must agree: the
    // belief is consistently "e2" everywhere (buildSafeBeliefValue's
    // descriptor-based reading is canonical), never split across two subjects.
    const proxy = new Proxy({ entityId: "e1" }, {
        get(t, p, r) { return p === "entityId" ? "e1" : Reflect.get(t, p, r); },
        getOwnPropertyDescriptor(t, p) {
            return p === "entityId"
                ? { value: "e2", enumerable: true, configurable: true, writable: true }
                : Reflect.getOwnPropertyDescriptor(t, p);
        },
        ownKeys() { return ["entityId"]; },
        has(t, p) { return p === "entityId"; }
    });
    wm.ingestDeclaration({ subject: proxy, attribute: "status", value: "ok" });
    assert.equal(wm.query({ subject: { entityId: "e2" }, attribute: "status" }).value, "ok",
        "the belief must be queryable under the SAME subject it was stored under (the descriptor-based reading)");
    assert.equal(wm.query({ subject: { entityId: "e1" }, attribute: "status" }).unknown, true,
        "the belief must never also appear keyed under the get-trap's subject -- key and storage must agree");
});

test("WM-repair-70: declareEntity/declareHypothesis reject sparse (hole-bearing) externalRefs/candidateValues arrays, not just explicit null/undefined elements (independent audit AUD40-P2-2)", async () => {
    const wm = await createWorldModel();
    assertThrowsReason(() => wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s", externalRefs: new Array(2) }), "INVALID_RECORD");
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    assertThrowsReason(() => wm.declareHypothesis({ hypothesisId: "h1", subject: { entityId: "e2" }, attribute: "a", candidateValues: new Array(1), expiresAt: new Date(9e12).toISOString() }), "INVALID_RECORD");
});

test("WM-repair-72: subgraph rejects a seeds array with a non-callable Symbol.iterator instead of raw-throwing (independent audit AUD41-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const seeds = ["e1"];
    seeds[Symbol.iterator] = 42;
    assert.doesNotThrow(() => wm.subgraph(seeds), "subgraph must consume seeds by index, never via the iterator protocol");
});

test("WM-repair-73: declareEntity with a revoked-Proxy labels object fails closed with a domain reason instead of raw-throwing (independent audit AUD41-P2-3)", async () => {
    const wm = await createWorldModel();
    const { proxy, revoke } = Proxy.revocable({ a: "x" }, {});
    revoke();
    assertThrowsReason(() => wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s", labels: proxy }), "INVALID_RECORD");
});

test("WM-repair-71: declareEntity's labels values are read via property descriptor, so an accessor label value is never invoked (independent audit AUD40-ADV-2)", async () => {
    const wm = await createWorldModel();
    let called = 0;
    const labels = { a: "x" };
    Object.defineProperty(labels, "b", { enumerable: true, configurable: true, get() { called++; return "y"; } });
    const e = wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s", labels });
    assert.equal(called, 0, "an accessor label value must never be invoked");
    assert.equal(e.labels.a, "x", "a plain label value must still round-trip");
});

test("WM-repair-88: subgraph/neighbors bound a fabricated finite seeds/kinds length -- integer/non-negative was validated, but no ceiling existed, so a length-lying Proxy that never really stores its elements forced an unbounded O(N) descriptor loop (independent audit W7R49-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const N = BOUNDS.MAX_VALUE_ARRAY_LENGTH + 1_000_000;
    function fakeArr(n) {
        const t = [];
        return new Proxy(t, {
            get(o, p) { return p === "length" ? n : o[p]; },
            getOwnPropertyDescriptor(o, p) {
                return (typeof p === "string" && /^\d+$/.test(p))
                    ? { value: "x", writable: true, enumerable: true, configurable: true }
                    : Object.getOwnPropertyDescriptor(o, p);
            },
            has() { return true; }
        });
    }
    assertThrowsReason(() => wm.subgraph(fakeArr(N)), "INVALID_RECORD");
    assertThrowsReason(() => wm.neighbors("e1", fakeArr(N), 1), "INVALID_RECORD");
    // sanity: legitimate small inputs still work
    assert.doesNotThrow(() => wm.subgraph(["e1"], 1));
    assert.doesNotThrow(() => wm.neighbors("e1", ["kind"], 1));
});

test("WM-repair-74: subgraph rejects a seeds array whose .length is negative/NaN/Infinity/fractional instead of skipping or infinite-looping (independent audit W7R42-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    for (const badLen of [-1, NaN, Infinity, 1.5]) {
        assertThrowsReason(() => wm.subgraph(fakeLengthArray(["e1"], badLen)), "INVALID_RECORD");
    }
});

test("WM-repair-75: declareEntity's pre-slice(0,32) on externalRefs bounds a hostile .length (negative/NaN/Infinity/fractional) to a terminating, ToLength-clamped read -- never hangs, never raw-throws (independent audit W7R42-P2-2)", async () => {
    // externalRefs/candidateValues go through `.slice(0, N)` BEFORE
    // buildSafeArray ever sees them, so a hostile `.length` is clamped by
    // the engine's own ToLength + slice(end) semantics, never reaching
    // buildSafeArray's cached-length guard at all. The safety property to
    // prove here is therefore "bounded, deterministic, no raw throw" --
    // not a specific rejection reason (buildSafeArray's own guard is
    // exercised directly by the OTHER lanes' un-sliced callers instead,
    // e.g. GL-repair-61/MC-repair-32).
    for (const badLen of [-1, NaN, Infinity, 1.5]) {
        const wm = await createWorldModel();
        const externalRefs = fakeLengthArray([{ system: "s", id: "1" }], badLen);
        assert.doesNotThrow(() => {
            try {
                wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s", externalRefs });
            } catch (err) {
                assert.equal(err.reason, "INVALID_RECORD", `unexpected reason for badLen=${badLen}: ${err.message}`);
            }
        }, `badLen=${badLen} must terminate without a raw (non-domain) throw`);
    }
});

test("WM-repair-78: neighbors fails closed (not raw-throw) on a revoked-Proxy kinds argument (independent audit W7R43-P2-5)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const r = Proxy.revocable(["device"], {});
    r.revoke();
    assertThrowsReason(() => wm.neighbors("e1", r.proxy, 1), "INVALID_RECORD");
});

test("WM-repair-79: ingestDeclaration fails closed (not raw-throw) on a revoked-Proxy value nested inside a plain object (independent audit W7R43-P2-7)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const nested = Proxy.revocable({ x: 1 }, {});
    nested.revoke();
    assertThrowsReason(() => wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: "a", value: { extra: nested.proxy } }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("WM-repair-77: buildSafeBeliefValue rejects a value array whose .length is negative/NaN/Infinity/fractional instead of skipping or infinite-looping (independent audit W7R42-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    for (const badLen of [-1, NaN, Infinity, 1.5]) {
        const value = fakeLengthArray([1], badLen);
        assertThrowsReason(() => wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: "a", value }), "EXECUTABLE_MATERIAL_REJECTED");
    }
});

test("WM-repair-80: buildSafeBeliefValue's fail-closed catch itself does not raw-throw when the caught value is a hostile object whose own inspection throws (independent audit W7R44-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    assertThrowsReason(() => wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: "a", value: hostileThrowObj() }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("WM-repair-81: declareEntity/declareRelation/ingestObservation/ingestDeclaration/declareHypothesis/query fail closed (not raw-throw) on a revoked-Proxy TOP-LEVEL spec argument (independent audit W7R44-P2-2)", async () => {
    const wm = await createWorldModel();
    const rev = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    assertThrowsReason(() => wm.declareEntity(rev()), "INVALID_RECORD");
    assertThrowsReason(() => wm.declareRelation(rev()), "INVALID_RECORD");
    assertThrowsReason(() => wm.ingestObservation(rev()), "INVALID_RECORD");
    assertThrowsReason(() => wm.ingestDeclaration(rev()), "INVALID_RECORD");
    assertThrowsReason(() => wm.declareHypothesis(rev()), "INVALID_RECORD");
    assert.doesNotThrow(() => {
        const r = wm.query(rev());
        assert.equal(r.unknown, true, "query() must never throw -- a revoked top-level spec must resolve to its established unknown-input contract");
    });
});

test("WM-repair-82: subgraph/neighbors consume seeds/kinds via property descriptor, not the caller's raw [[Get]], so a Proxy whose descriptor trap throws still fails closed (independent audit W7R44-P2-3)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const throwingDescArr = (items) => new Proxy(items.slice(), {
        getOwnPropertyDescriptor(t, p) {
            if (typeof p === "string" && /^[0-9]+$/.test(p)) throw new Error("RAW-desc");
            return Reflect.getOwnPropertyDescriptor(t, p);
        }
    });
    assertThrowsReason(() => wm.subgraph(throwingDescArr(["e1"])), "INVALID_RECORD");
    assertThrowsReason(() => wm.neighbors("e1", throwingDescArr(["device"]), 1), "INVALID_RECORD");
});

test("WM-repair-89: createWorldModel never raw-throws on a revoked/throwing clock or bounds -- normalized once at construction (independent audit AUD53-P2-2)", async () => {
    const rev = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    await assert.doesNotReject(() => createWorldModel({ clock: rev() }));
    await assert.doesNotReject(() => createWorldModel({ bounds: rev() }));
    const wm = await createWorldModel({ clock: { nowMs() { throw new Error("x"); } } });
    assert.doesNotThrow(() => wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" }));
});

test("WM-repair-90: validateLabels never raw-throws when labels' getOwnPropertyDescriptor trap succeeds once (during Object.keys) then throws on the same key inside the copy loop (independent audit round 56, W7R56-P2-2)", async () => {
    const wm = await createWorldModel({});
    let calls = 0;
    const labels = new Proxy({ a: "1" }, {
        getOwnPropertyDescriptor(t, p) {
            if (++calls > 1) throw new Error("hostile descriptor trap");
            return Reflect.getOwnPropertyDescriptor(t, p);
        },
        ownKeys(t) { return Reflect.ownKeys(t); },
        get(t, p, r) { return Reflect.get(t, p, r); }
    });
    assert.throws(() => wm.declareEntity({ entityId: "e1", entityKind: "k", labels, source: "s" }),
        (e) => e && e.reason === "INVALID_RECORD");
});

test("WM-repair-91: declareHypothesis rejects a fabricated negative candidateValues length instead of silently storing an empty array (independent audit round 56, W7R56-P2-3)", async () => {
    const wm = await createWorldModel({});
    wm.declareEntity({ entityId: "e1", entityKind: "k", source: "s" });
    const cand = new Proxy([{ value: "x", weight: 1 }], { get(t, p, r) { if (p === "length") return -1; return Reflect.get(t, p, r); } });
    assert.throws(() => wm.declareHypothesis({
        hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "a",
        candidateValues: cand, expiresAt: "2030-01-01T00:00:00.000Z"
    }), (e) => e && e.reason === "INVALID_RECORD");
});

test("WM-repair-92: ingestObservation never raw-throws when MAX_OPEN_CONTRADICTION_SETS is 0 -- openContradictionSet indexed [oldest] on an empty list (list.length >= 0 is true, but there is no oldest to evict), the same zero-boundary class round 58/59 fixed elsewhere but never swept here (independent audit round 59, OpenCode, W7R59-P2-2)", async () => {
    const wm = await createWorldModel({ bounds: { MAX_OPEN_CONTRADICTION_SETS: 0 } });
    wm.declareEntity({ entityId: "e1", entityKind: "k", source: "s" });
    wm.ingestObservation({ observationId: "o1", subject: { entityId: "e1" }, attribute: "a", value: 1, sensor: { sensorId: "s" }, tier: "T1", observedAt: "2026-01-01T00:00:00.000Z" });
    assert.doesNotThrow(() => wm.ingestObservation({ observationId: "o2", subject: { entityId: "e1" }, attribute: "a", value: 2, sensor: { sensorId: "s" }, tier: "T1", observedAt: "2026-01-02T00:00:00.000Z" }));
});

test("WM-repair-87: the exported subjectKeyOf() never raw-throws on a revoked-Proxy subject -- falls back to the same malformed-subject sentinel as any other unreadable subject, matching its own never-throws contract (independent audit W7R47-P2-2)", async () => {
    const { subjectKeyOf } = require("../../../src/cognition/worldmodel/query");
    const r = Proxy.revocable({}, {});
    r.revoke();
    let key;
    assert.doesNotThrow(() => { key = subjectKeyOf(r.proxy); }, "subjectKeyOf must never raw-throw, by its own established contract");
    assert.equal(key, "invalid:malformed-subject");
});

test("WM-repair-83: declareEntity fails closed (not raw-throw) on a revoked-Proxy ELEMENT inside externalRefs, one level below where round 44's container guard stopped (independent audit W7R45-P2-3)", async () => {
    const wm = await createWorldModel();
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsReason(() => wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s", externalRefs: [r.proxy] }), "INVALID_RECORD");
});

test("WM-repair-84: ingestObservation fails closed (not raw-throw) on a revoked-Proxy nested sensor/frame argument (independent audit W7R45-P2-4)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const iso = new Date(1).toISOString();
    const r1 = Proxy.revocable({ sensorId: "s1" }, {});
    r1.revoke();
    assertThrowsReason(() => wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "a", value: 1, sensor: r1.proxy, tier: "T1", observedAt: iso }), "MISSING_SENSOR_ID");
    const r2 = Proxy.revocable({ kind: "camera" }, {});
    r2.revoke();
    assertThrowsReason(() => wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "a", value: 1, sensor: { sensorId: "s1" }, tier: "T1", observedAt: iso, frame: r2.proxy }), "INVALID_RECORD");
});

test("WM-repair-85: subgraph's budget?.nodes/budget?.bytes reads never raw-throw on a revoked-Proxy budget -- falls back to the default budget exactly like a malformed/null budget already does (independent audit W7R45-P2-5)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const r = Proxy.revocable({ nodes: 10, bytes: 100 }, {});
    r.revoke();
    let result;
    assert.doesNotThrow(() => { result = wm.subgraph(["e1"], 2, r.proxy); }, "a revoked-Proxy budget must not raw-throw out of subgraph");
    assert.ok(result.entities.length >= 1, "subgraph must still traverse using the default budget fallback");
});

test("WM-repair-86: declareHypothesis fails closed (not raw-throw) on a revoked-Proxy ELEMENT inside candidateValues, the exact sibling of externalRefs' element guard (round 45) left unswept (independent audit W7R46-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsReason(() => wm.declareHypothesis({ hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "a", candidateValues: [r.proxy], expiresAt: new Date(1).toISOString() }), "INVALID_RECORD");
});

test("WM-repair-76: subgraph/declareEntity/declareHypothesis fail closed (not raw-throw) on a revoked-Proxy container argument (independent audit W7R42-P2-3)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });

    const seedsProxy = Proxy.revocable(["e1"], {});
    seedsProxy.revoke();
    assertThrowsReason(() => wm.subgraph(seedsProxy.proxy), "INVALID_RECORD");

    const refsProxy = Proxy.revocable([{ system: "s", id: "1" }], {});
    refsProxy.revoke();
    assertThrowsReason(() => wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s", externalRefs: refsProxy.proxy }), "INVALID_RECORD");

    const candProxy = Proxy.revocable([{ value: "x", weight: 1 }], {});
    candProxy.revoke();
    assertThrowsReason(() => wm.declareHypothesis({ hypothesisId: "h2", subject: { entityId: "e1" }, attribute: "a", candidateValues: candProxy.proxy, expiresAt: new Date(9e12).toISOString() }), "INVALID_RECORD");
});

test("WM-repair-67: ingestDeclaration's subject-shape guard validates the SAME sanitized value that gets keyed/stored, so a Proxy whose get/descriptor traps disagree cannot bypass the shape guard (independent audit AUD36-P2-1)", async () => {
    const wm = await createWorldModel();
    const proxy = new Proxy({ entityId: "e1" }, {
        get(t, p, r) { return p === "entityId" ? "e1" : Reflect.get(t, p, r); },
        getOwnPropertyDescriptor(t, p) {
            return p === "entityId"
                ? { value: 42, enumerable: true, configurable: true, writable: true }
                : Reflect.getOwnPropertyDescriptor(t, p);
        },
        ownKeys() { return ["entityId"]; },
        has(t, p) { return p === "entityId"; }
    });
    const before = wm.beliefsSize();
    assertThrowsReason(() => wm.ingestDeclaration({ subject: proxy, attribute: "status", value: "V-A" }), "INVALID_RECORD");
    assert.equal(wm.beliefsSize(), before, "a subject whose canonical (sanitized) form is malformed must never create a belief, sentinel-keyed or otherwise");
});

test("WM-repair-68: two distinct malformed proxy subjects never collapse onto the same sentinel key and report a false CONTEST (independent audit AUD36-P2-1)", async () => {
    const wm = await createWorldModel();
    const makeLyingProxy = (getVal, descVal) => new Proxy({ entityId: getVal }, {
        get(t, p, r) { return p === "entityId" ? getVal : Reflect.get(t, p, r); },
        getOwnPropertyDescriptor(t, p) {
            return p === "entityId"
                ? { value: descVal, enumerable: true, configurable: true, writable: true }
                : Reflect.getOwnPropertyDescriptor(t, p);
        },
        ownKeys() { return ["entityId"]; },
        has(t, p) { return p === "entityId"; }
    });
    assertThrowsReason(() => wm.ingestDeclaration({ subject: makeLyingProxy("e1", 42), attribute: "status", value: "A" }), "INVALID_RECORD");
    assertThrowsReason(() => wm.ingestDeclaration({ subject: makeLyingProxy("e9", null), attribute: "status", value: "B" }), "INVALID_RECORD");
    assert.equal(wm.openContradictions().length, 0, "two independently-rejected malformed subjects must never be treated as the same subject in contest");
});

test("WM-repair-69: subjectKeyOf/targetKey preserve the entityId-first short-circuit -- a valid entityId subject's relationId accessor is never invoked (independent audit AUD36-P2-2)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "d", source: "s" });
    wm.ingestDeclaration({ subject: { entityId: "e1" }, attribute: "x", value: "v" });
    let called = 0;
    const subject = { entityId: "e1" };
    Object.defineProperty(subject, "relationId", { enumerable: true, configurable: true, get() { called++; throw new Error("hostile relationId getter executed"); } });
    let result;
    assert.doesNotThrow(() => { result = wm.query({ subject, attribute: "x" }); });
    assert.equal(result.value, "v");
    assert.equal(called, 0, "relationId must never be read when entityId already resolved the query");
});

test("WM-repair-64: relationId/hypothesisId/observationId are read exactly once end-to-end (guard AND construction), not just guard-vs-store consistent (independent audit AUD35-ADV-2)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "d", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "d", source: "s" });

    let nr = 0;
    const rspec = { kind: "k", from: "e1", to: "e2" };
    Object.defineProperty(rspec, "relationId", { enumerable: true, configurable: true, get() { nr++; return "R1"; } });
    const r = wm.declareRelation(rspec);
    assert.equal(nr, 1, "relationId must be read exactly once, including during construction");
    assert.equal(r.relationId, "R1");

    let nh = 0;
    const hspec = { subject: { entityId: "e1" }, attribute: "a", candidateValues: [{ value: 1, weight: 1 }], expiresAt: new Date(9e12).toISOString() };
    Object.defineProperty(hspec, "hypothesisId", { enumerable: true, configurable: true, get() { nh++; return "H1"; } });
    const h = wm.declareHypothesis(hspec);
    assert.equal(nh, 1, "hypothesisId must be read exactly once, including during construction");
    assert.equal(h.hypothesisId, "H1");

    let no = 0;
    const ospec = { subject: { entityId: "e1" }, attribute: "temp", value: 1, sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() };
    Object.defineProperty(ospec, "observationId", { enumerable: true, configurable: true, get() { no++; return "O1"; } });
    wm.ingestObservation(ospec);
    assert.equal(no, 1, "observationId must be read exactly once, including during construction");
});

test("WM-repair-65: makeObservation's sensor/frame fields are each read exactly once (independent audit AUD35-ADV-5)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "d", source: "s" });
    let n = 0;
    const sensor = { sensorId: "s1" };
    Object.defineProperty(sensor, "modality", { enumerable: true, configurable: true, get() { n++; return n === 1 ? "vision" : Symbol("boom"); } });
    assert.doesNotThrow(() => wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "x", value: 1, sensor, tier: "T1", observedAt: new Date(1).toISOString() }));
    assert.equal(n, 1, "sensor.modality must be read exactly once");
});

test("WM-repair-66: makeHypothesis's subject guard now validates the SAME sanitized value it stores, so the caller's accessor getter is never invoked at all (independent audit AUD35-ADV-6, tightened by AUD36-ADV-1)", async () => {
    const wm = await createWorldModel();
    let called = 0;
    const subject = {};
    Object.defineProperty(subject, "entityId", { enumerable: true, configurable: true, get() { called++; return "e1"; } });
    assertThrowsReason(() => wm.declareHypothesis({ hypothesisId: "H1", subject, attribute: "a", candidateValues: [{ value: 1, weight: 1 }], expiresAt: new Date(9e12).toISOString() }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(called, 0, "buildSafeBeliefValue must reject the accessor via its property descriptor before ever invoking the getter");
});

test("WM-repair-59: subgraph's budget.nodes/budget.bytes are each read exactly once, so a stateful accessor cannot change the effective budget mid-traversal (independent audit AUD34-ADV-5b)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e0", entityKind: "d", source: "s" });
    for (let i = 1; i <= 5; i++) {
        wm.declareEntity({ entityId: `e${i}`, entityKind: "d", source: "s" });
        wm.declareRelation({ relationId: `r${i}`, kind: "k", from: `e${i - 1}`, to: `e${i}` });
    }
    let n = 0;
    const budget = { bytes: 262144 };
    Object.defineProperty(budget, "nodes", { enumerable: true, configurable: true, get() { n++; return n === 1 ? 512 : 1; } });
    const sub = wm.subgraph(["e0"], 5, budget);
    assert.equal(n, 1, "budget.nodes must be read exactly once");
    assert.ok(sub.entities.length > 1, "the value seen on the single read must be honored for the whole traversal, not silently shrunk mid-traversal");
});

test("WM-repair-58: an archived overflow contradiction's resolution is deep-frozen, not just the outer entry -- a caller cannot rewrite the canonical OVERFLOW_ARCHIVE reason (independent audit AUD33-P2-1)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 1 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    const base = { attribute: "status", tier: "T1" };
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "INC-1", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "c2", value: "b", sensor: { sensorId: "s2" }, observedAt: new Date(1001).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "INC-2", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "c3", value: "b", sensor: { sensorId: "s3" }, observedAt: new Date(1001).toISOString() });
    const overflowed = wm.overflowedContradictions()[0];
    assert.equal(Object.isFrozen(overflowed.resolution), true, "the archived entry's resolution must be frozen, not just the outer entry");
    assert.throws(() => { "use strict"; overflowed.resolution.ruleId = "HACKED"; });
    assert.equal(wm.overflowedContradictions()[0].resolution.ruleId, "OVERFLOW_ARCHIVE", "a fresh view must still report the canonical OVERFLOW_ARCHIVE reason");
});

test("WM-repair-28: a rejected ingestObservation must not bump the referenced entity's lastSeenAt (independent audit AUD17-P2-3)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_ENTITIES: 2 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    wm.declareRelation({ relationId: "r1", kind: "connects", from: "e1", to: "e2" });
    const before = wm.entitiesByKind("device").entities.find(e => e.entityId === "e1").lastSeenAt;
    assert.throws(() => wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "a", value: 10n, sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() }));
    const after = wm.entitiesByKind("device").entities.find(e => e.entityId === "e1").lastSeenAt;
    assert.equal(after, before, "a rejected observation must not advance the entity's lastSeenAt (would skew the eviction tie-break)");
});

test("WM-repair-29: declareEntity never evicts the entity it just created, even when it is the isolated lowest-degree candidate (independent audit AUD17-P2-4)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_ENTITIES: 2 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    wm.declareRelation({ relationId: "r1", kind: "connects", from: "e1", to: "e2" });
    const result = wm.declareEntity({ entityId: "e3", entityKind: "device", source: "s" });
    assert.notEqual(result, undefined, "declareEntity must never return undefined for a call it just accepted");
    assert.equal(result.entityId, "e3");
    assert.equal(wm.entitiesByKind("device").entities.some(e => e.entityId === "e3"), true);
});

test("WM-repair-30: overflow-archiving a contradiction set that was already RESOLVED preserves its real resolution, not a fabricated OVERFLOW_ARCHIVE (independent audit AUD17-P2-5)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 2 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e3", entityKind: "device", source: "s" });
    const base = { attribute: "status", tier: "T1" };
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "INC-1", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    const r1 = wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "c1", value: "b", sensor: { sensorId: "s2" }, observedAt: new Date(1001).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "INC-2", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "c2", value: "b", sensor: { sensorId: "s3" }, observedAt: new Date(1001).toISOString() });
    wm.resolveContradiction(r1.contradictionSetId, "RULE-REAL");
    wm.ingestObservation({ ...base, subject: { entityId: "e3" }, observationId: "INC-3", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e3" }, observationId: "c3", value: "b", sensor: { sensorId: "s3" }, observedAt: new Date(1001).toISOString() });
    const overflowed = wm.overflowedContradictions().find(c => c.challengerRecordId === "c1");
    assert.equal(overflowed.status, "RESOLVED", "overflow archival must not overwrite an already-resolved contradiction's status");
    assert.equal(overflowed.resolution.ruleId, "RULE-REAL", "overflow archival must not overwrite an already-resolved contradiction's real resolution");
});

test("WM-repair-32: neighbors() defaults depth to 1 when omitted, instead of silently returning an empty result (independent audit AUD18-A3)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "a", entityKind: "device", source: "t" });
    wm.declareEntity({ entityId: "b", entityKind: "device", source: "t" });
    wm.declareRelation({ relationId: "r1", kind: "near", from: "a", to: "b" });
    const n = wm.neighbors("a");
    assert.deepEqual(n.entities.map(e => e.entityId), ["b"]);
});

test("WM-repair-31: declareRelation never evicts the relation it just created, even when it is the lowest-strength candidate (independent audit AUD18-P2-1)", async () => {
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_RELATIONS: 2 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e3", entityKind: "device", source: "s" });
    wm.declareRelation({ relationId: "r1", kind: "k", from: "e1", to: "e2", strength: 0.9 });
    wm.declareRelation({ relationId: "r2", kind: "k", from: "e2", to: "e3", strength: 0.8 });
    const r3 = wm.declareRelation({ relationId: "r3", kind: "k", from: "e1", to: "e3", strength: 0.1 });
    assert.equal(r3.relationId, "r3");
    const inState = wm.subgraph(["e1", "e2", "e3"], 1).relations.map(r => r.relationId);
    assert.equal(inState.includes("r3"), true, "declareRelation must never evict the relation it just created in the same call");
});

test("WM-repair-33: an overflow-archived contradiction survives a JSON-round-tripping restart (independent audit AUD19-P2-2)", async () => {
    function jsonStore() {
        const kv = new Map();
        return {
            async getKv(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
            async putKv(k, v) { kv.set(k, JSON.stringify(v)); }
        };
    }
    const store = jsonStore();
    let wm = await createWorldModel({ store, bounds: { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 1 } });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    const base = { attribute: "status", tier: "T1" };
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "INC-1", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e1" }, observationId: "c1", value: "b", sensor: { sensorId: "s2" }, observedAt: new Date(1001).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "INC-2", value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1000).toISOString() });
    wm.ingestObservation({ ...base, subject: { entityId: "e2" }, observationId: "c2", value: "b", sensor: { sensorId: "s3" }, observedAt: new Date(1001).toISOString() });
    assert.equal(wm.overflowedContradictions().length, 1);
    await wm.persist();
    wm = await createWorldModel({ store, bounds: { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 1 } });
    const overflowed = wm.overflowedContradictions();
    assert.equal(overflowed.length, 1, "an overflow-archived contradiction must survive a restart");
    assert.equal(overflowed[0].challengerRecordId, "c1");
});

test("WM-repair-34: replaying an already-used relationId is rejected, not silently overwritten (independent audit AUD19-A3)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e3", entityKind: "device", source: "s" });
    wm.declareRelation({ relationId: "r1", kind: "k", from: "e1", to: "e2" });
    assertThrowsReason(() => wm.declareRelation({ relationId: "r1", kind: "k", from: "e2", to: "e3" }), "DUPLICATE_RECORD_ID");
    const inState = wm.subgraph(["e1", "e2", "e3"], 1).relations.find(r => r.relationId === "r1");
    assert.equal(inState.from, "e1");
    assert.equal(inState.to, "e2");
});

test("WM-repair-35: declareHypothesis rejects a null candidateValues element as INVALID_RECORD, not a raw TypeError (independent audit AUD20-P2-2)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const iso = new Date(Date.now() + 60_000).toISOString();
    assertThrowsReason(() => wm.declareHypothesis({
        hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "cfg",
        candidateValues: [{ value: "v1", weight: 0.5 }, null], expiresAt: iso
    }), "INVALID_RECORD");
});

test("WM-repair-36: declareEntity rejects a null externalRefs element as INVALID_RECORD, not a raw TypeError (independent audit AUD20-P2-2)", async () => {
    const wm = await createWorldModel();
    assertThrowsReason(() => wm.declareEntity({
        entityId: "e1", entityKind: "device", source: "s", externalRefs: [null]
    }), "INVALID_RECORD");
});

test("WM-repair-37: subgraph() with an explicit null budget falls back to the default instead of throwing a raw TypeError (independent audit AUD20-P2-2)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const sub = wm.subgraph(["e1"], 2, null);
    assert.ok(sub.entities.some(e => e.entityId === "e1"));
});

test("WM-repair-39: declareEntity rejects a non-array externalRefs container (number/string/object) as INVALID_RECORD, not a raw TypeError (independent audit AUD21-P2-1)", async () => {
    const wm = await createWorldModel();
    assertThrowsReason(() => wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s", externalRefs: 42 }), "INVALID_RECORD");
    assertThrowsReason(() => wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s", externalRefs: "abc" }), "INVALID_RECORD");
    assertThrowsReason(() => wm.declareEntity({ entityId: "e3", entityKind: "device", source: "s", externalRefs: { system: "x" } }), "INVALID_RECORD");
    // null/undefined must still default to [] rather than being rejected
    const ok = wm.declareEntity({ entityId: "e4", entityKind: "device", source: "s", externalRefs: null });
    assert.deepEqual(ok.externalRefs, []);
});

test("WM-repair-40: query() with a null/malformed subject fails safe to unknown NEVER_OBSERVED, not a raw TypeError (independent audit AUD21-ADV-1)", async () => {
    const wm = await createWorldModel();
    const r = wm.query({ subject: null, attribute: "a" });
    assert.equal(r.unknown, true);
    assert.equal(r.reason, "NEVER_OBSERVED");
});

test("WM-repair-41: subgraph()/neighbors() reject malformed seeds/kinds as INVALID_RECORD, not a raw TypeError (independent audit AUD22-F-2)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    assertThrowsReason(() => wm.subgraph(42), "INVALID_RECORD");
    const sub = wm.subgraph(null);
    assert.deepEqual(sub.entities, []); // null defaults to empty seeds, not a throw
    assertThrowsReason(() => wm.neighbors("e1", 42), "INVALID_RECORD");
});

test("WM-repair-42: query(null)/query(undefined) fail safe to unknown NEVER_OBSERVED, not a raw TypeError (independent audit AUD22-F-3)", async () => {
    const wm = await createWorldModel();
    assert.deepEqual(wm.query(null), { unknown: true, reason: "NEVER_OBSERVED", lastKnown: null });
    assert.deepEqual(wm.query(undefined), { unknown: true, reason: "NEVER_OBSERVED", lastKnown: null });
});

test("WM-repair-43: declareEntity/ingestObservation/ingestDeclaration/declareRelation/declareHypothesis(null) are rejected as INVALID_RECORD, not a raw TypeError (independent audit AUD22-F-4)", async () => {
    const wm = await createWorldModel();
    assertThrowsReason(() => wm.declareEntity(null), "INVALID_RECORD");
    assertThrowsReason(() => wm.ingestObservation(null), "INVALID_RECORD");
    assertThrowsReason(() => wm.ingestDeclaration(null), "INVALID_RECORD");
    assertThrowsReason(() => wm.declareRelation(null), "INVALID_RECORD");
    assertThrowsReason(() => wm.declareHypothesis(null), "INVALID_RECORD");
});

test("WM-repair-44: resolving a contradiction clears the belief's contested flag, query() never reports a stale contested=true (independent audit AUD22-A-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const base = { subject: { entityId: "e1" }, attribute: "status", tier: "T1" };
    wm.ingestObservation({ ...base, value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1).toISOString() });
    const contest = wm.ingestObservation({ ...base, value: "b", sensor: { sensorId: "s2" }, observedAt: new Date(2).toISOString() });
    assert.equal(wm.query(base).contested, true);
    wm.resolveContradiction(contest.contradictionSetId, "RULE-1");
    assert.equal(wm.query(base).contested, false, "a resolved contradiction must not leave the belief permanently marked contested");
});

test("WM-repair-45: resolving one of TWO open contradiction sets for the same subject/attribute must not under-report contested=false while the other stays OPEN (independent audit AUD23-P1-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const base = { subject: { entityId: "e1" }, attribute: "status", tier: "T1" };
    wm.ingestObservation({ ...base, value: "a", sensor: { sensorId: "s1" }, observedAt: new Date(1).toISOString() });
    const c1 = wm.ingestObservation({ ...base, value: "b", sensor: { sensorId: "s2" }, observedAt: new Date(2).toISOString() });
    const c2 = wm.ingestObservation({ ...base, value: "c", sensor: { sensorId: "s3" }, observedAt: new Date(3).toISOString() });
    assert.equal(wm.openContradictions().length, 2);
    wm.resolveContradiction(c2.contradictionSetId, "RULE-1"); // resolve only the LATEST set
    assert.equal(wm.openContradictions().length, 1, "c1 must still be OPEN");
    assert.equal(wm.query(base).contested, true, "a belief with another still-OPEN contradiction set must not be reported as uncontested");
});

test("WM-repair-48: an explicit null depth/limit does not silently disable neighbors/subgraph/path/entitiesByKind -- it behaves like the omitted default (independent audit AUD24-P2-5)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "d", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "d", source: "s" });
    wm.declareRelation({ relationId: "r1", kind: "k", from: "e1", to: "e2" });
    assert.equal(wm.neighbors("e1", null, null).entities.length, 1, "neighbors(id, null, null) must still traverse with the default depth");
    assert.ok(wm.subgraph(["e1"], null).entities.some(e => e.entityId === "e2"), "subgraph(seeds, null) must still traverse with the default depth");
    assert.notEqual(wm.path("e1", "e2", null).path, null, "path(from, to, null) must still search with the default maxDepth");
    assert.equal(wm.entitiesByKind("d", null).entities.length, 2, "entitiesByKind(kind, null) must still return with the default limit");
});

test("WM-repair-46: declareHypothesis rejects a malformed subject as INVALID_RECORD, matching makeObservation's sibling guard (independent audit AUD23-ADV-1)", async () => {
    const wm = await createWorldModel();
    assertThrowsReason(() => wm.declareHypothesis({
        hypothesisId: "h1", subject: null, attribute: "a",
        candidateValues: [{ value: "v1", weight: 0.5 }], expiresAt: new Date(Date.now() + 60_000).toISOString()
    }), "INVALID_RECORD");
});

test("WM-repair-47: a belief's contradictionSetId is reconciled when the set it points at is rotated out by overflow eviction (not just by resolveContradiction), so query() never reports an id no collection contains (independent audit AUD24-P2-1)", async () => {
    const bounds = { ...BOUNDS, MAX_OPEN_CONTRADICTION_SETS: 2 };
    const wm = await createWorldModel({ bounds });
    wm.declareEntity({ entityId: "A", entityKind: "d", source: "s" });
    wm.declareEntity({ entityId: "B", entityKind: "d", source: "s" });
    let t = 1;
    const mk = (eid, v) => wm.ingestObservation({
        subject: { entityId: eid }, attribute: "status", value: v,
        sensor: { sensorId: `sensor-${eid}-${v}` }, tier: "T1", observedAt: new Date(t++).toISOString()
    });
    mk("A", "a0"); mk("A", "a1"); mk("A", "a2"); const c3 = mk("A", "a3"); // A's belief points at c3
    mk("B", "b0");
    for (let i = 1; i <= 12; i++) mk("B", "b" + i); // churn B until c3 is rotated out of BOTH contradictions and the bounded overflow archive
    const qA = () => wm.query({ subject: { entityId: "A" }, attribute: "status" });
    const stillReferenced = wm.openContradictions().some(c => c.contradictionSetId === qA().contradictionSetId) ||
        wm.overflowedContradictions().some(c => c.contradictionSetId === qA().contradictionSetId);
    assert.ok(!qA().contested || stillReferenced, "a contested=true belief must reference a contradiction set that actually exists somewhere");
    if (qA().contested) {
        assert.doesNotThrow(() => wm.resolveContradiction(qA().contradictionSetId, "R"), "resolveContradiction must never throw UNKNOWN_ENTITY for an id query() itself just returned");
    }
});

test("WM-repair-49: hostile toString on tier/subjectRef.entityId never executes, and a Symbol tier/attribute is rejected as a domain error, not a raw TypeError (independent audit AUD25-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    let called = 0;
    const evilTier = { toString() { called++; return "T1"; } };
    assertThrowsReason(() => wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "status", value: "v", sensor: { sensorId: "s1" },
        tier: evilTier, observedAt: new Date(1).toISOString()
    }), "INADMISSIBLE_TIER");
    assert.equal(called, 0, "tier's toString must never be invoked before the enum check");
    assert.throws(() => wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "status", value: "v", sensor: { sensorId: "s1" },
        tier: Symbol("t"), observedAt: new Date(1).toISOString()
    }), (err) => { assert.equal(err.reason, "INADMISSIBLE_TIER"); return true; });

    let calledEntityId = 0;
    const evilEntityId = { toString() { calledEntityId++; return "e1"; } };
    const q = wm.query({ subject: { entityId: evilEntityId }, attribute: "status" });
    assert.equal(calledEntityId, 0, "a hostile entityId's toString must never be invoked while building the query key");
    assert.equal(q.unknown, true, "a malformed (non-string) entityId must never resolve to a real belief");
});

test("WM-repair-50: an explicit negative depth/limit does not silently disable or bypass neighbors/subgraph/path/entitiesByKind (independent audit AUD25-P2-3)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    wm.declareRelation({ relationId: "r1", kind: "k", from: "e1", to: "e2" });
    assert.equal(wm.neighbors("e1", null, -1).entities.length, 1, "neighbors with negative depth must still traverse with the default depth");
    assert.ok(wm.subgraph(["e1"], -1).entities.some(e => e.entityId === "e2"), "subgraph with negative depth must still traverse with the default depth");
    assert.notEqual(wm.path("e1", "e2", -1).path, null, "path with negative maxDepth must still search with the default maxDepth");

    // graph.js's traversal bounds (ENTITIES_BY_KIND_LIMIT included) are not
    // wired to createWorldModel's `bounds` override -- a pre-existing,
    // separate limitation, not part of this fix -- so the real default
    // (1024) must be exceeded to exercise the cap.
    const wmMany = await createWorldModel({ bounds: { ...BOUNDS, MAX_ENTITIES_PER_SOURCE: 2000, MAX_ENTITIES: 2000 } });
    const overLimit = BOUNDS.ENTITIES_BY_KIND_LIMIT + 50;
    for (let i = 0; i < overLimit; i++) wmMany.declareEntity({ entityId: `d${i}`, entityKind: "device", source: "s" });
    const r = wmMany.entitiesByKind("device", -1);
    assert.ok(r.entities.length <= BOUNDS.ENTITIES_BY_KIND_LIMIT, `entitiesByKind with a negative limit must never return more than ENTITIES_BY_KIND_LIMIT (got ${r.entities.length})`);
});

test("WM-repair-51: a Symbol strength/weight is rejected as INVALID_RECORD, not a raw TypeError (independent audit AUD28-P2-3)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    assertThrowsReason(() => wm.declareRelation({ relationId: "r1", kind: "k", from: "e1", to: "e2", strength: Symbol("s") }), "INVALID_RECORD");
    assertThrowsReason(() => wm.declareHypothesis({
        hypothesisId: "h1", subject: { entityId: "e1" }, attribute: "cfg",
        candidateValues: [{ value: "v1", weight: Symbol("w") }], expiresAt: new Date(Date.now() + 60_000).toISOString()
    }), "INVALID_RECORD");
});

test("WM-repair-52: a Symbol/hostile-object maxStalenessMs in query() never throws and never invokes caller valueOf (independent audit AUD28-P2-4)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "status", value: "on", sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    assert.doesNotThrow(() => wm.query({ subject: { entityId: "e1" }, attribute: "status", maxStalenessMs: Symbol("m") }));
    let called = 0;
    const evil = { valueOf() { called++; return 1000; } };
    wm.query({ subject: { entityId: "e1" }, attribute: "status", maxStalenessMs: evil });
    assert.equal(called, 0, "maxStalenessMs's valueOf must never be invoked");
});

test("WM-repair-53: hostile toString on entity labels/externalRefs/relation kind/observation sensor/frame fields never executes (independent audit AUD28-P2-7)", async () => {
    const wm = await createWorldModel();
    let called = 0;
    const evil = { toString() { called++; return "x"; } };
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s", labels: { l: evil } });
    assert.equal(called, 0, "a hostile label value's toString must never be invoked");
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    assertThrowsReason(() => wm.declareRelation({ relationId: "r1", kind: evil, from: "e1", to: "e2" }), "INVALID_RECORD");
    assert.equal(called, 0, "a hostile relation kind's toString must never be invoked");
    assertThrowsReason(() => wm.declareEntity({ entityId: "e3", entityKind: "device", source: "s", externalRefs: [{ system: evil, id: "i" }] }), "INVALID_RECORD");
    assert.equal(called, 0, "a hostile externalRefs.system's toString must never be invoked");
});

test("WM-repair-57: ingestObservation's subject is sanitized via buildSafeBeliefValue before the UNKNOWN_ENTITY guard, so an accessor entityId is rejected closed without ever being invoked (independent audit AUD32-P2-3, tightened by AUD38-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    let n = 0;
    const subject = {};
    Object.defineProperty(subject, "entityId", { enumerable: true, configurable: true, get() { n++; return "e1"; } });
    assertThrowsReason(() => wm.ingestObservation({ subject, attribute: "reading", value: 5, sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "buildSafeBeliefValue must reject the accessor via its property descriptor without ever invoking it");

    const r = wm.ingestObservation({ subject: { entityId: "e1" }, attribute: "reading", value: 5, sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString() });
    assert.equal(r.case, "REFRESH", "a plain (non-accessor) subject must still be accepted");
});

test("WM-repair-56: relationId/hypothesisId are each read exactly once, so a stateful getter cannot overwrite an existing relation/hypothesis via inconsistent reads (independent audit AUD30-P2-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    wm.declareEntity({ entityId: "e2", entityKind: "device", source: "s" });
    wm.declareRelation({ relationId: "r1", kind: "ORIGINAL", from: "e1", to: "e2", strength: 0.9 });

    let n = 0;
    const spec = { kind: "REPLAYED", from: "e1", to: "e2", strength: 0.1 };
    Object.defineProperty(spec, "relationId", { enumerable: true, configurable: true, get() { n++; return "r1"; } });
    assertThrowsReason(() => wm.declareRelation(spec), "DUPLICATE_RECORD_ID");
    assert.equal(n, 1, "relationId must be read exactly once");
    assert.equal(wm.subgraph(["e1", "e2"], 1).relations.find(r => r.relationId === "r1").kind, "ORIGINAL");
});

test("WM-repair-55: a non-finite numeric belief value (Infinity/NaN) is rejected, not silently corrupted to null by a JSON-round-tripping store (independent audit AUD30-ADV-1)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    for (const bad of [Infinity, -Infinity, NaN]) {
        assertThrowsReason(() => wm.ingestObservation({
            subject: { entityId: "e1" }, attribute: "reading", value: bad,
            sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1).toISOString()
        }), "EXECUTABLE_MATERIAL_REJECTED");
    }
});

test("WM-repair-54: two observations with the SAME logical object value but different key order are treated as REINFORCE, not a spurious CONTEST (independent audit AUD30-P1-1, BLOCKING)", async () => {
    const wm = await createWorldModel();
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const r1 = wm.ingestObservation({
        observationId: "o1", subject: { entityId: "e1" }, attribute: "reading", value: { unit: "C", v: 5 },
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1000).toISOString()
    });
    const r2 = wm.ingestObservation({
        observationId: "o2", subject: { entityId: "e1" }, attribute: "reading", value: { v: 5, unit: "C" },
        sensor: { sensorId: "s2" }, tier: "T1", observedAt: new Date(1001).toISOString()
    });
    assert.notEqual(r2.case, "CONTEST", "a value that is structurally identical (only key order differs) must not open a contradiction");
    assert.equal(wm.openContradictions().length, 0);
    const q = wm.query({ subject: { entityId: "e1" }, attribute: "reading" });
    assert.equal(q.contested, false);
    assert.deepEqual([...q.supportedBy].sort(), ["o1", "o2"], "the second observation must REINFORCE (corroborate), not overwrite/contest");
});

test("WM-repair-38: entity eviction stays fast at scale -- relationDegree() must not rescan all relations per candidate (independent audit AUD20-P2-3)", async () => {
    const ENTITY_COUNT = 3000;
    const wm = await createWorldModel({ bounds: { ...BOUNDS, MAX_ENTITIES: ENTITY_COUNT, MAX_ENTITIES_PER_SOURCE: ENTITY_COUNT + 500, MAX_RELATIONS: ENTITY_COUNT * 4 } });
    for (let i = 0; i < ENTITY_COUNT; i++) {
        wm.declareEntity({ entityId: `e${i}`, entityKind: "device", source: "s" });
    }
    // ring topology: every entity has degree 2, forcing relationDegree() to
    // do real work for every candidate instead of trivially returning 0.
    for (let i = 0; i < ENTITY_COUNT; i++) {
        wm.declareRelation({ relationId: `r${i}`, kind: "near", from: `e${i}`, to: `e${(i + 1) % ENTITY_COUNT}` });
    }
    const start = process.hrtime.bigint();
    // each call is already at MAX_ENTITIES, so every declareEntity below
    // forces exactly one full eviction scan over ENTITY_COUNT candidates.
    for (let i = 0; i < 300; i++) {
        wm.declareEntity({ entityId: `new${i}`, entityKind: "device", source: "s" });
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    // O(E x R) (the pre-fix behavior) at this scale is minutes, not
    // milliseconds -- a generous budget still catches a real regression.
    assert.ok(elapsedMs < 5000, `300 evictions at E=R=${ENTITY_COUNT} took ${elapsedMs}ms, expected well under 5000ms with O(1) relationDegree()`);
});

test("WM-repair-17: replaying a recordId already consumed by an earlier SUPERSEDE is a no-op, not a fresh CONTEST (independent audit AUD11-P2-7)", async () => {
    const clock = manualClock(0);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "s" });
    const spec = { subject: { entityId: "e1" }, attribute: "status", sensor: { sensorId: "s1" }, tier: "T1" };
    wm.ingestObservation({ ...spec, observationId: "R1", value: "a", observedAt: new Date(0).toISOString() });
    clock.advance(31 * 60_000); // past the 30min TTL -> next differing value SUPERSEDEs, resetting supportedBy
    const superseded = wm.ingestObservation({ ...spec, observationId: "R2", value: "b", observedAt: new Date(31 * 60_000).toISOString() });
    assert.equal(superseded.case, "SUPERSEDE");
    const replay = wm.ingestObservation({ ...spec, observationId: "R1", value: "a", observedAt: new Date(0).toISOString() });
    assert.equal(replay.case, "DUPLICATE", "a recordId already consumed before the SUPERSEDE must stay deduped, not open a fresh CONTEST");
    assert.equal(wm.query({ subject: { entityId: "e1" }, attribute: "status" }).contested, false);
});

test("WM-repair-3: an epoch-dated observation (1970-01-01T00:00:00.000Z) is not falsely treated as the newest evidence (Codex P2 round 9)", async () => {
    const clock = manualClock(1000);
    const wm = await createWorldModel({ clock });
    wm.declareEntity({ entityId: "e1", entityKind: "device", source: "t" });
    wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "status", value: "on",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(1_000_000).toISOString()
    });
    clock.advance(31 * 60_000); // past default 30-minute TTL -> belief is expired, eligible for SUPERSEDE

    // observedAt is epoch (parses to 0ms) -- genuinely OLDER evidence than
    // the existing belief's observedAt (1_000_000ms). If `Date.parse(...) ||
    // now()` had treated the parsed 0 as falsy, this would be silently
    // stamped with the current (much later) clock time, appear "newer",
    // and wrongly SUPERSEDE the existing belief.
    const result = wm.ingestObservation({
        subject: { entityId: "e1" }, attribute: "status", value: "off",
        sensor: { sensorId: "s1" }, tier: "T1", observedAt: new Date(0).toISOString()
    });
    assert.notEqual(result.case, "SUPERSEDE", "bukti epoch yang genuinely lebih lama tidak boleh menang sebagai 'lebih baru'");
    assert.equal(wm.query({ subject: { entityId: "e1" }, attribute: "status" }).value, "on");
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
