"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createSpatialModel, BOUNDS } = require("../../../src/cognition/spatial");

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
