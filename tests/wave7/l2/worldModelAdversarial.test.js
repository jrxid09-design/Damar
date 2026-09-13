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
    const wm = await createWorldModel();
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
