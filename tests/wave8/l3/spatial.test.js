"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createSpatialModel, BOUNDS } = require("../../../src/cognition/spatial");
const { buildSafeSpatialValue, makeSceneNode } = require("../../../src/cognition/spatial/records");
const { deserialize } = require("../../../src/cognition/spatial/store");

function assertThrowsReason(fn, reason) {
    assert.throws(fn, (err) => {
        assert.equal(err.reason, reason, `expected reason '${reason}', got '${err.reason}': ${err.message}`);
        return true;
    });
}

function jsonStore() {
    const kv = new Map();
    return {
        async getKv(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
        async putKv(k, v) { kv.set(k, JSON.stringify(v)); }
    };
}

function manualClock(startMs) {
    let t = startMs;
    return { nowMs: () => t, advance: (ms) => { t += ms; } };
}

test("L3-24: spatial sanitizers reject proxy length and accessor-backed observation references without invoking them", () => {
    let lengthReads = 0;
    const proxy = new Proxy([], { get(target, key, receiver) { if (key === "length") lengthReads++; return Reflect.get(target, key, receiver); } });
    assert.deepEqual(buildSafeSpatialValue(proxy), []);
    assert.equal(lengthReads, 0);
    let reads = 0;
    const refs = [];
    Object.defineProperty(refs, 0, { enumerable: true, get() { reads++; return "o1"; } });
    assert.throws(() => makeSceneNode({ nodeId: "f::{}", frameId: "f", region: {}, state: "KNOWN", observationRefs: refs, updatedAtMs: 0 }));
    assert.equal(reads, 0);
});

test("L3-1: registerFrame accepts valid frame, rejects unknown kind", async () => {
    const sm = await createSpatialModel();
    const f = sm.registerFrame({ frameId: "f1", kind: "ROOM", ref: { name: "kitchen" }, source: "s" });
    assert.equal(f.frameId, "f1");
    assertThrowsReason(() => sm.registerFrame({ frameId: "f2", kind: "BOGUS", ref: {}, source: "s" }), "INVALID_RECORD");
});

test("L3-2: registerTransform rejects unknown frame refs", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    assertThrowsReason(() => sm.registerTransform({ transformId: "t1", fromFrameId: "a", toFrameId: "missing", data: {} }), "UNKNOWN_FRAME");
});

test("L3-3: registerTransform rejects a cycle (A->B->C->A)", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.registerFrame({ frameId: "b", kind: "ROOM", ref: {}, source: "s" });
    sm.registerFrame({ frameId: "c", kind: "ROOM", ref: {}, source: "s" });
    sm.registerTransform({ transformId: "t1", fromFrameId: "a", toFrameId: "b", data: {} });
    sm.registerTransform({ transformId: "t2", fromFrameId: "b", toFrameId: "c", data: {} });
    assertThrowsReason(() => sm.registerTransform({ transformId: "t3", fromFrameId: "c", toFrameId: "a", data: {} }), "TRANSFORM_CYCLE_REJECTED");
});

test("L3-4: queryOccupancy on a never-reported region returns UNKNOWN and blocked -- unknown never means clear", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    const r = sm.queryOccupancy({ frameId: "a", region: { cell: "1,1" } });
    assert.equal(r.state, "UNKNOWN");
    assert.equal(r.blocked, true);
});

test("L3-5: two sources disagreeing on the same region become CONTESTED (blocks), never arbitrarily picked", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.reportOccupancy({ frameId: "a", region: { cell: "1,1" }, state: "KNOWN", observationRef: "o1" });
    const r1 = sm.queryOccupancy({ frameId: "a", region: { cell: "1,1" } });
    assert.equal(r1.state, "KNOWN");
    assert.equal(r1.blocked, false);
    sm.reportOccupancy({ frameId: "a", region: { cell: "1,1" }, state: "UNKNOWN", observationRef: "o2" });
    const r2 = sm.queryOccupancy({ frameId: "a", region: { cell: "1,1" } });
    assert.equal(r2.state, "CONTESTED");
    assert.equal(r2.blocked, true);
});

test("L3-6: queryReachability blocks at the first unknown/contested hop", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.reportOccupancy({ frameId: "a", region: { cell: "1" }, state: "KNOWN", observationRef: "o1" });
    const r = sm.queryReachability({ frameId: "a", path: [{ cell: "1" }, { cell: "2" }] });
    assert.equal(r.reachable, false);
    assert.equal(r.blockedAtIndex, 1);
});

test("L3-7: queryReachability succeeds when every hop is KNOWN", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.reportOccupancy({ frameId: "a", region: { cell: "1" }, state: "KNOWN", observationRef: "o1" });
    sm.reportOccupancy({ frameId: "a", region: { cell: "2" }, state: "KNOWN", observationRef: "o1" });
    const r = sm.queryReachability({ frameId: "a", path: [{ cell: "1" }, { cell: "2" }] });
    assert.equal(r.reachable, true);
});

test("L3-8: resolveFrame finds a composed transform chain via BFS", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.registerFrame({ frameId: "b", kind: "ROOM", ref: {}, source: "s" });
    sm.registerFrame({ frameId: "c", kind: "ROOM", ref: {}, source: "s" });
    sm.registerTransform({ transformId: "t1", fromFrameId: "a", toFrameId: "b", data: {} });
    sm.registerTransform({ transformId: "t2", fromFrameId: "b", toFrameId: "c", data: {} });
    const res = sm.resolveFrame("a", "c");
    assert.deepEqual(res.path, ["t1", "t2"]);
});

test("L3-9: resolveFrame returns null when no path exists", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.registerFrame({ frameId: "b", kind: "ROOM", ref: {}, source: "s" });
    assert.equal(sm.resolveFrame("a", "b"), null);
});

test("L3-10: a hostile accessor on frame.ref is rejected without ever being invoked", async () => {
    const sm = await createSpatialModel();
    let n = 0;
    const ref = {};
    Object.defineProperty(ref, "x", { enumerable: true, configurable: true, get() { n++; return 1; } });
    assertThrowsReason(() => sm.registerFrame({ frameId: "f1", kind: "ROOM", ref, source: "s" }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "ref.x's getter must never be invoked");
});

test("L3-11: an enumerable data '__proto__' key on transform.data is rejected, not silently dropped", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.registerFrame({ frameId: "b", kind: "ROOM", ref: {}, source: "s" });
    const data = {};
    Object.defineProperty(data, "__proto__", { enumerable: true, configurable: true, value: { forged: true } });
    assertThrowsReason(() => sm.registerTransform({ transformId: "t1", fromFrameId: "a", toFrameId: "b", data }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("L3-12: frame retention is enforced at cap 0 -- no frame stored, not a raw throw", async () => {
    const sm = await createSpatialModel({ bounds: { ...BOUNDS, MAX_FRAMES: 0 } });
    sm.registerFrame({ frameId: "f1", kind: "ROOM", ref: {}, source: "s" });
    assert.equal(sm.framesSize(), 0);
});

test("L3-13: a reloaded snapshot's frames/transforms/sceneNodes are compacted to the ACTIVE bound at construction", async () => {
    const store = jsonStore();
    const sm1 = await createSpatialModel({ store, bounds: { ...BOUNDS, MAX_FRAMES: 100, MAX_TRANSFORMS: 100, MAX_SCENE_NODES: 100 } });
    sm1.registerFrame({ frameId: "f1", kind: "ROOM", ref: {}, source: "s" });
    sm1.registerFrame({ frameId: "f2", kind: "ROOM", ref: {}, source: "s" });
    sm1.registerFrame({ frameId: "f3", kind: "ROOM", ref: {}, source: "s" });
    sm1.reportOccupancy({ frameId: "f1", region: { c: 1 }, state: "KNOWN", observationRef: "o1" });
    sm1.reportOccupancy({ frameId: "f1", region: { c: 2 }, state: "KNOWN", observationRef: "o1" });
    sm1.reportOccupancy({ frameId: "f1", region: { c: 3 }, state: "KNOWN", observationRef: "o1" });
    await sm1.persist();

    const sm2 = await createSpatialModel({ store, bounds: { ...BOUNDS, MAX_FRAMES: 1, MAX_TRANSFORMS: 1, MAX_SCENE_NODES: 1 } });
    assert.ok(sm2.framesSize() <= 1);
    assert.ok(sm2.sceneNodesSize() <= 1);
});

test("L3-14: getScene returns frozen snapshots that cannot be mutated by the caller", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    const scene = sm.getScene();
    assert.throws(() => { scene.frames.push({}); });
});

test("L3-15: a revoked-Proxy spec fails closed as INVALID_RECORD, not a raw TypeError", async () => {
    const sm = await createSpatialModel();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assertThrowsReason(() => sm.registerFrame(proxy), "INVALID_RECORD");
});

test("L3-16: a KNOWN region whose freshness has decayed to 'stale' blocks too -- stale never means clear either (independent audit round 1, Codex, AUDL3-P1-1)", async () => {
    const clock = manualClock(0);
    const sm = await createSpatialModel({ clock });
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.reportOccupancy({ frameId: "a", region: { c: 1 }, state: "KNOWN", observationRef: "o1" });
    clock.advance(31 * 60 * 1000);
    const r = sm.queryOccupancy({ frameId: "a", region: { c: 1 } });
    assert.equal(r.band, "stale");
    assert.equal(r.blocked, true, "a stale KNOWN region must block, not silently report clear");
});

test("L3-17: reload compaction fully compacts BOTH frames and transforms when frames are only evictable after their referencing transform is gone (independent audit round 1, Codex, AUDL3-P1-2)", async () => {
    const store = jsonStore();
    const sm1 = await createSpatialModel({ store, bounds: { ...BOUNDS, MAX_FRAMES: 10, MAX_TRANSFORMS: 10 } });
    sm1.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm1.registerFrame({ frameId: "b", kind: "ROOM", ref: {}, source: "s" });
    sm1.registerTransform({ transformId: "t1", fromFrameId: "a", toFrameId: "b", data: {} });
    await sm1.persist();

    const sm2 = await createSpatialModel({ store, bounds: { ...BOUNDS, MAX_FRAMES: 1, MAX_TRANSFORMS: 0 } });
    assert.equal(sm2.transformsSize(), 0, "transforms must compact to 0 first");
    assert.ok(sm2.framesSize() <= 1, "frames must then compact to the active bound, now that no transform references them");
});

test("L3-18: two logically-identical regions with different key order are the SAME region for contest detection, not silently split into two nodes (independent audit round 1, Codex, AUDL3-P1-3)", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.reportOccupancy({ frameId: "a", region: { x: 1, y: 2 }, state: "KNOWN", observationRef: "o1" });
    sm.reportOccupancy({ frameId: "a", region: { y: 2, x: 1 }, state: "UNKNOWN", observationRef: "o2" });
    const r = sm.queryOccupancy({ frameId: "a", region: { x: 1, y: 2 } });
    assert.equal(r.state, "CONTESTED", "reordered-key regions must resolve to the SAME scene node so disagreement is detected");
    assert.equal(r.blocked, true);
});

test("L3-19: a hostile accessor on ANY registerFrame spec field is rejected with zero getter invocations, not executed during destructuring (independent audit round 1, Codex, AUDL3-P1-4)", async () => {
    const sm = await createSpatialModel();
    let n = 0;
    const spec = { kind: "ROOM", ref: {}, source: "s" };
    Object.defineProperty(spec, "frameId", { enumerable: true, configurable: true, get() { n++; return "f1"; } });
    assertThrowsReason(() => sm.registerFrame(spec), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "spec.frameId's getter must never be invoked");
});

test("L3-20: a Symbol frameId to queryOccupancy fails closed as INVALID_RECORD, not a raw TypeError from template-literal interpolation (independent audit round 1, Codex, AUDL3-P1-4)", async () => {
    const sm = await createSpatialModel();
    assertThrowsReason(() => sm.queryOccupancy({ frameId: Symbol("x"), region: null }), "INVALID_RECORD");
});

test("L3-21: evicting a frame at cap also evicts every scene node it owns -- orphaned geometry must never remain queryable as KNOWN (independent audit round 2, Codex, AUDL3-P1-1)", async () => {
    const sm = await createSpatialModel({ bounds: { ...BOUNDS, MAX_FRAMES: 1 } });
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    sm.reportOccupancy({ frameId: "a", region: { c: 1 }, state: "KNOWN", observationRef: "o1" });
    sm.registerFrame({ frameId: "b", kind: "ROOM", ref: {}, source: "s" }); // evicts "a" at cap 1
    const scene = sm.getScene();
    assert.ok(!scene.sceneNodes.some(n => n.frameId === "a"), "no scene node may reference the evicted frame");
});

test("L3-22: a hostile accessor on a queryReachability path element is rejected without ever being invoked (independent audit round 2, Codex, AUDL3-P2-1)", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    let n = 0;
    const path = [{}];
    Object.defineProperty(path, 0, { enumerable: true, configurable: true, get() { n++; return { c: 1 }; } });
    assertThrowsReason(() => sm.queryReachability({ frameId: "a", path }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "path[0]'s getter must never be invoked");
});

test("L3-23: an array region with an enumerable non-index 'toJSON' function is rejected outright, not silently ignored and collapsed with a semantically-different region (independent audit round 2, Codex, AUDL3-P2-2)", async () => {
    const sm = await createSpatialModel();
    sm.registerFrame({ frameId: "a", kind: "ROOM", ref: {}, source: "s" });
    const region = [];
    Object.defineProperty(region, "toJSON", { enumerable: true, configurable: true, value: () => [] });
    assertThrowsReason(() => sm.reportOccupancy({ frameId: "a", region, state: "KNOWN", observationRef: "o1" }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("L3-repair-24: persisted orphan/future geometry is quarantined before query", async () => {
    const key = 'ghost::{"c":1}';
    const store = { getKv: async () => ({ frames: {}, transforms: {}, sceneNodes: {
        [key]: { nodeId: key, frameId: "ghost", region: { c: 1 }, state: "KNOWN", observationRefs: ["forged"], updatedAtMs: 9999999999999 }
    } }), putKv: async () => {} };
    const sm = await createSpatialModel({ store, clock: { nowMs: () => 1000 } });
    const result = sm.queryOccupancy({ frameId: "ghost", region: { c: 1 } });
    assert.equal(result.state, "UNKNOWN");
    assert.equal(result.blocked, true);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 3fdc20e — repaired classes                        */
/* ---------------------------------------------------------------------- */

test("L3-audit-1: a persisted accessor is rejected at deserialize and NEVER executed", () => {
    let calls = 0;
    const hostileFrame = {};
    Object.defineProperty(hostileFrame, "frameId", {
        enumerable: true, configurable: true,
        get() { calls += 1; return "forged"; }
    });
    assert.throws(() => deserialize({ frames: { f1: hostileFrame }, transforms: {}, sceneNodes: {} }));
    assert.equal(calls, 0, "a persisted getter must never run during deserialization");
});

test("L3-audit-2: a hostile store read degrades to an audited cold start, never a silent empty scene", async () => {
    const events = [];
    const hostileFrame = {};
    Object.defineProperty(hostileFrame, "occupancy", {
        enumerable: true, configurable: true, get() { return "KNOWN"; }
    });
    const store = {
        async getKv() { return { frames: { f1: hostileFrame }, transforms: {}, sceneNodes: {} }; },
        async putKv() {}
    };
    const sm = await createSpatialModel({ store, auditLedger: { append: (e) => events.push(e.eventType) } });
    assert.equal(sm.spatialColdStart, true);
    assert.equal(sm.framesSize(), 0);
    assert.ok(events.includes("cognition.spatial.store_unreadable"),
        `an unreadable/hostile snapshot must be audited, saw: ${events.join(",")}`);
});

test("L3-audit-3: frame registration, transform changes, and occupancy contradictions are audited", async () => {
    const events = [];
    const sm = await createSpatialModel({
        clock: { nowMs: () => 1000 },
        auditLedger: { append: (e) => events.push(e.eventType) }
    });
    sm.registerFrame({ frameId: "f1", kind: "SCREEN", ref: "r", source: "s" });
    sm.registerFrame({ frameId: "f2", kind: "SCREEN", ref: "r", source: "s" });
    sm.registerTransform({ transformId: "t1", fromFrameId: "f1", toFrameId: "f2", data: {} });
    sm.registerTransform({ transformId: "t1", fromFrameId: "f1", toFrameId: "f2", data: { x: 1 } });
    // Two DIFFERENT sources disagreeing.
    sm.reportOccupancy({ frameId: "f1", region: { x: 1, y: 1 }, state: "KNOWN", observationRef: "obs-1" });
    sm.reportOccupancy({ frameId: "f1", region: { x: 1, y: 1 }, state: "UNKNOWN", observationRef: "obs-2" });

    for (const expected of [
        "cognition.spatial.frame_registered",
        "cognition.spatial.transform_registered",
        "cognition.spatial.transform_changed",
        "cognition.spatial.occupancy_contradiction"
    ]) {
        assert.ok(events.includes(expected), `${expected} must be audited, saw: ${events.join(",")}`);
    }
});

test("L3-audit-4: one source revising its OWN reading is a revision, not a contradiction (it must not lock the region)", async () => {
    const events = [];
    const sm = await createSpatialModel({
        clock: { nowMs: () => 1000 },
        auditLedger: { append: (e) => events.push(e.eventType) }
    });
    sm.registerFrame({ frameId: "f1", kind: "SCREEN", ref: "r", source: "s" });
    sm.reportOccupancy({ frameId: "f1", region: { x: 2, y: 2 }, state: "KNOWN", observationRef: "obs-1" });
    const revised = sm.reportOccupancy({ frameId: "f1", region: { x: 2, y: 2 }, state: "UNKNOWN", observationRef: "obs-1" });
    assert.notEqual(revised.state, "CONTESTED",
        "a single source correcting itself must not permanently contest the region");
    assert.equal(events.filter(e => e === "cognition.spatial.occupancy_contradiction").length, 0,
        "no contradiction may be recorded for a single-source revision");
});

