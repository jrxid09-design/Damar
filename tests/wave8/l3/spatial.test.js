"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createSpatialModel, BOUNDS } = require("../../../src/cognition/spatial");
const { buildSafeSpatialValue, makeSceneNode } = require("../../../src/cognition/spatial/records");
const { deserialize } = require("../../../src/cognition/spatial/store");
const { canonicalRegionKey } = require("../../../src/cognition/spatial/records");

/** Kunci scene node yang sama dengan yang dipakai lane (`frameId::region`). */
function sceneNodeKey(frameId, region) {
    return `${frameId}::${canonicalRegionKey(region)}`;
}

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
    // A Proxy is now refused OUTRIGHT, before any reflective read: descriptor
    // reads and Reflect.ownKeys themselves run the proxy's traps, so simply
    // reading `length` safely (the earlier contract) still executed caller code
    // for nested proxies and other keys (audit Wave8 L3/L5).
    assertThrowsReason(() => buildSafeSpatialValue(proxy), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(lengthReads, 0, "no proxy trap may run during sanitization");
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

test("L3-audit-5: an async-rejecting audit sink is contained and never blocks the lane", async () => {
    let unhandled = 0;
    const listener = () => { unhandled += 1; };
    process.on("unhandledRejection", listener);
    try {
        const sm = await createSpatialModel({
            clock: { nowMs: () => 1000 },
            auditLedger: { append: () => Promise.reject(new Error("audit down")) }
        });
        sm.registerFrame({ frameId: "f1", kind: "SCREEN", ref: "r", source: "s" });
        sm.registerFrame({ frameId: "f2", kind: "SCREEN", ref: "r", source: "s" });
        sm.registerTransform({ transformId: "t1", fromFrameId: "f1", toFrameId: "f2", data: {} });
        assert.equal(sm.framesSize(), 2, "audit failure must never block the lane");
        await new Promise(r => setImmediate(r));
        await new Promise(r => setTimeout(r, 30));
    } finally {
        process.removeListener("unhandledRejection", listener);
    }
    assert.equal(unhandled, 0, "an async-rejecting audit hook must not produce unhandled rejections");
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 49859df — repaired classes                        */
/* ---------------------------------------------------------------------- */

test("L3-audit-6: a persisted Proxy value is rejected without running any trap", () => {
    let traps = 0;
    const inner = new Proxy({ x: 1 }, {
        ownKeys(t) { traps += 1; return Reflect.ownKeys(t); },
        getOwnPropertyDescriptor(t, k) { traps += 1; return Reflect.getOwnPropertyDescriptor(t, k); },
        getPrototypeOf(t) { traps += 1; return Reflect.getPrototypeOf(t); }
    });
    assert.throws(() => deserialize({ frames: { f1: { frameId: "f1", ref: inner } }, transforms: {}, sceneNodes: {} }));
    assert.equal(traps, 0, "no proxy trap may run during sanitization");
});

test("L3-audit-7: restart-time stale-first compaction uses the INJECTED clock and is audited", async () => {
    const events = [];
    const nowMs = 1_000_000;
    // A durable snapshot holding more scene nodes than the active bound, all
    // last updated long before "now" so every one of them is stale.
    const sceneNodes = {};
    for (let i = 0; i < 8; i++) {
        const frameId = `f${i}`;
        const region = { r: i };
        sceneNodes[sceneNodeKey(frameId, region)] = {
            nodeId: sceneNodeKey(frameId, region),
            frameId,
            region,
            state: "KNOWN",
            observationRefs: ["obs-1"],
            updatedAtMs: nowMs - 10_000_000
        };
    }
    const frames = {};
    for (let i = 0; i < 8; i++) frames[`f${i}`] = { frameId: `f${i}`, kind: "SCREEN", ref: {}, source: "s", registeredAt: nowMs - 10_000_000 };

    const store = {
        async getKv() { return { frames, transforms: {}, sceneNodes }; },
        async putKv() {}
    };
    const sm = await createSpatialModel({
        store,
        clock: { nowMs: () => nowMs },
        bounds: { ...BOUNDS, MAX_SCENE_NODES: 3 },
        auditLedger: { append: (e) => events.push(e.eventType) }
    });
    assert.ok(sm.sceneNodesSize() <= 3, "restart compaction must enforce the active bound");
    assert.ok(events.includes("cognition.spatial.scene_node_evicted"),
        `restart-time eviction must be audited, saw: ${events.join(",")}`);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of fdda055 -- repaired classes                        */
/* ---------------------------------------------------------------------- */

test("L3-audit-8: an accessor-backed or Proxy KV on the spatial store executes no caller code", async () => {
    // `typeof store.getKv === "function"` was a raw [[Get]].
    let getterCalls = 0;
    const hostile = {};
    Object.defineProperty(hostile, "getKv", {
        enumerable: true, configurable: true,
        get() { getterCalls += 1; return async () => null; }
    });
    const fromAccessor = await createSpatialModel({ store: hostile, clock: { nowMs: () => 1000 } });
    assert.equal(getterCalls, 0, "the store accessor must never run");
    assert.equal(fromAccessor.spatialColdStart, true);

    let traps = 0;
    const proxyStore = new Proxy({}, {
        getOwnPropertyDescriptor() { traps += 1; return undefined; },
        getPrototypeOf(t) { traps += 1; return Object.getPrototypeOf(t); },
        ownKeys(t) { traps += 1; return Reflect.ownKeys(t); }
    });
    const fromProxy = await createSpatialModel({ store: proxyStore, clock: { nowMs: () => 1000 } });
    assert.equal(traps, 0, "no Proxy trap may run while probing the store");
    assert.equal(fromProxy.spatialColdStart, true);
});

test("L3-audit-9: a lying Proxy persisted as a collection is rejected, not silently read as empty", () => {
    // `Object.keys` ran before any Proxy rejection, and a Proxy that reports no
    // keys looked like a legitimately empty collection -- state silently lost
    // with no degradation (audit of fdda055).
    let traps = 0;
    const lying = new Proxy({}, {
        ownKeys(t) { traps += 1; return []; },
        getOwnPropertyDescriptor(t, k) { traps += 1; return undefined; },
        getPrototypeOf(t) { traps += 1; return Reflect.getPrototypeOf(t); }
    });
    assert.throws(() => deserialize({ frames: lying, transforms: {}, sceneNodes: {} }));
    assert.equal(traps, 0, "no proxy trap may run during deserialization");
});

test("L3-audit-10: a persisted transform CYCLE is rejected at restart, and malformed entries cannot displace valid state", async () => {
    const nowMs = 1_000_000;
    const frames = {
        A: { frameId: "A", kind: "SCREEN", ref: {}, source: "s", registeredAt: nowMs - 10 },
        B: { frameId: "B", kind: "SCREEN", ref: {}, source: "s", registeredAt: nowMs - 10 }
    };
    const transforms = {
        t1: { transformId: "t1", fromFrameId: "A", toFrameId: "B", data: { x: 1 }, registeredAt: nowMs - 10 },
        t2: { transformId: "t2", fromFrameId: "B", toFrameId: "A", data: { x: -1 }, registeredAt: nowMs - 10 }
    };
    const cycled = await createSpatialModel({
        store: { async getKv() { return { frames, transforms, sceneNodes: {} }; }, async putKv() {} },
        clock: { nowMs: () => nowMs }
    });
    assert.ok(cycled.transformsSize() < 2,
        "a persisted cycle must not survive restart as queryable geometry");

    // Validation now runs BEFORE compaction, so a malformed entry is dropped
    // without occupying capacity and evicting a valid one.
    const validNodes = {};
    const validFrames = {};
    for (let i = 0; i < 3; i += 1) {
        const frameId = `f${i}`;
        validFrames[frameId] = { frameId, kind: "SCREEN", ref: {}, source: "s", registeredAt: nowMs - 10 };
        validNodes[sceneNodeKey(frameId, { r: i })] = {
            nodeId: sceneNodeKey(frameId, { r: i }), frameId, region: { r: i }, state: "KNOWN",
            observationRefs: ["o"], updatedAtMs: nowMs - 10
        };
    }
    // One malformed frame whose id does not match its own key.
    validFrames.bad = { frameId: "MISMATCH", kind: "SCREEN", ref: {}, source: "s", registeredAt: nowMs - 10 };

    const sm = await createSpatialModel({
        store: { async getKv() { return { frames: validFrames, transforms: {}, sceneNodes: validNodes }; }, async putKv() {} },
        clock: { nowMs: () => nowMs },
        bounds: { ...BOUNDS, MAX_FRAMES: 3, MAX_SCENE_NODES: 3 }
    });
    assert.equal(sm.framesSize(), 3, "the malformed frame must be dropped, leaving the valid three");
    assert.equal(sm.sceneNodesSize(), 3, "no valid scene node may be displaced by a malformed entry");
});

test("L3-audit-11: an accessor-backed audit ledger executes no caller code, and a normal one still receives events", async () => {
    // `typeof auditLedger.append === "function"` was a raw [[Get]] that ran a
    // getter BEFORE the audit hook could contain the failure (audit of
    // 97a1990).
    let getterCalls = 0;
    const hostile = {};
    Object.defineProperty(hostile, "append", {
        enumerable: true, configurable: true,
        get() { getterCalls += 1; return () => ({ ok: true }); }
    });
    const sm = await createSpatialModel({
        clock: { nowMs: () => 1_000_000 }, auditLedger: hostile
    });
    sm.registerFrame({ frameId: "f1", kind: "ROOM", ref: { name: "kitchen" }, source: "s" });
    assert.equal(getterCalls, 0, "the audit ledger accessor must never run");

    // A well-formed ledger still receives the lane's contract events.
    const seen = [];
    const good = { append(e) { seen.push(e.eventType); return true; } };
    const sm2 = await createSpatialModel({
        clock: { nowMs: () => 1_000_000 }, auditLedger: good
    });
    sm2.registerFrame({ frameId: "f1", kind: "ROOM", ref: { name: "kitchen" }, source: "s" });
    assert.ok(seen.includes("cognition.spatial.frame_registered"), `saw: ${seen.join(",")}`);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of ba68903 -- full-record validation + `then` once    */
/* ---------------------------------------------------------------------- */

test("L3-audit-12: a frame with invalid kind/source is rejected by FULL validation, not just id/time", async () => {
    // Checking only id/registeredAt let a frame with an unknown `kind` and an
    // empty `source` survive reconciliation, take capacity, and displace a valid
    // older frame (audit of ba68903). Validation now runs every field through
    // the lane's own `makeFrame` -- the record's actual shape contract.
    const nowMs = 1_000_000;
    const malformedFrames = [
        { frameId: "bad", kind: "NOT_A_KIND", ref: {}, source: "", registeredAt: nowMs - 1000 },
        { frameId: "bad", kind: "ROOM", ref: {}, source: "", registeredAt: nowMs - 1000 },
        { frameId: "bad", kind: "NOT_A_KIND", ref: {}, source: "s", registeredAt: nowMs - 1000 },
        { frameId: "bad", kind: "ROOM", ref: {}, source: "s", registeredAt: nowMs + 999999 }
    ];

    for (const malformed of malformedFrames) {
        const sm = await createSpatialModel({
            store: {
                async getKv() {
                    return {
                        frames: {
                            good: {
                                frameId: "good", kind: "ROOM", ref: { name: "k" },
                                source: "s", registeredAt: nowMs - 5000
                            },
                            bad: malformed
                        },
                        transforms: {},
                        sceneNodes: {}
                    };
                },
                async putKv() {}
            },
            clock: { nowMs: () => nowMs },
            bounds: { ...BOUNDS, MAX_FRAMES: 1 }
        });
        assert.equal(sm.framesSize(), 1, "only the valid frame may survive");
        const retained = (sm.getScene().frames || []).map(f => f.frameId);
        assert.deepEqual(retained, ["good"],
            `the valid frame must survive a ${malformed.kind}/${JSON.stringify(malformed.source)} sibling`);
    }
});

test("L3-audit-13: an accessor-backed `then` on an audit result NEVER runs", async () => {
    // Two earlier defects are closed here. `Promise.resolve` read `then`
    // repeatedly (~2 getter calls per event, audit of ba68903), and the fix for
    // that still invoked the result through `then.call` / `.catch` -- property
    // lookups on a caller-controlled object (audit of 472b6e0). Handling is now
    // entirely descriptor-based, so an accessor `then` is never executed at all.
    let thenCalls = 0;
    const payload = {};
    Object.defineProperty(payload, "then", {
        enumerable: true, configurable: true,
        get() { thenCalls += 1; return undefined; }   // non-function `then`
    });
    const sm = await createSpatialModel({
        clock: { nowMs: () => 1_000_000 },
        auditLedger: { append() { return payload; } }
    });
    sm.registerFrame({ frameId: "f1", kind: "ROOM", ref: { name: "kitchen" }, source: "s" });
    assert.equal(thenCalls, 0, "an accessor `then` must never be executed");
});

/* ---------------------------------------------------------------------- */
/* Independent audit of de9553c -- future dates, hostile thenables, source */
/* ---------------------------------------------------------------------- */

test("L3-audit-14: a future-dated persisted transform cannot displace a valid one, and hostile thenables leak nothing", async () => {
    const nowMs = 1_000_000;
    const goodFrame = (id) => ({ frameId: id, kind: "ROOM", ref: { name: "k" }, source: "s", registeredAt: nowMs - 5000 });
    // `registeredAt` was checked for FINITENESS only, so a future-dated
    // transform survived and evicted the valid older transform at retention 1
    // (audit of de9553c).
    const sm = await createSpatialModel({
        store: {
            async getKv() {
                return {
                    frames: { A: goodFrame("A"), B: goodFrame("B"), C: goodFrame("C") },
                    transforms: {
                        good: { transformId: "good", fromFrameId: "A", toFrameId: "B", data: { x: 1 }, registeredAt: nowMs - 5000 },
                        bad: { transformId: "bad", fromFrameId: "B", toFrameId: "C", data: { x: 2 }, registeredAt: nowMs + 999999 }
                    },
                    sceneNodes: {}
                };
            },
            async putKv() {}
        },
        clock: { nowMs: () => nowMs },
        bounds: { ...BOUNDS, MAX_TRANSFORMS: 1 }
    });
    assert.equal(sm.transformsSize(), 1, "only the valid transform may survive");

    // A custom async `then` that rejects: the value RETURNED by `then` must be
    // absorbed too, or the rejection becomes unhandled and can kill the process.
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    try {
        const hostile = Object.freeze({ then() { return Promise.reject(new Error("hostile thenable")); } });
        const smT = await createSpatialModel({
            clock: { nowMs: () => nowMs },
            auditLedger: { append() { return hostile; } }
        });
        smT.registerFrame({ frameId: "f1", kind: "ROOM", ref: { name: "k" }, source: "s" });
        await new Promise(r => setTimeout(r, 50));
        assert.equal(unhandled, 0, "a hostile thenable must not produce an unhandled rejection");
    } finally {
        process.removeListener("unhandledRejection", onUnhandled);
    }
});

test("L3-audit-15: a caller-asserted `source` cannot weaken contest detection", async () => {
    const nowMs = 1_000_000;
    const sm = await createSpatialModel({ clock: { nowMs: () => nowMs } });
    sm.registerFrame({ frameId: "f1", kind: "ROOM", ref: { name: "k" }, source: "s" });
    const region = { r: 1 };

    // A source-aware rule was tried and then WITHDRAWN. This lane cannot
    // authenticate a source identity: `source` is only a caller-supplied label,
    // exactly like `observationRef`. Had a matching label downgraded a contest to
    // a "revision", two independent reporters could have shared one string to
    // unlock a region that should stay locked -- and a contested region blocks
    // motion preconditions (audit of 472b6e0). The conservative rule is therefore
    // kept: only the SAME observation slot is a revision.
    sm.reportOccupancy({ frameId: "f1", region, state: "KNOWN", observationRef: "obs-1", source: "sensor-a" });
    sm.reportOccupancy({ frameId: "f1", region, state: "UNKNOWN", observationRef: "obs-2", source: "sensor-a" });
    assert.equal(sm.queryOccupancy({ frameId: "f1", region }).state, "CONTESTED",
        "a NEW observation ref is a potential second source, even under one asserted label");

    // Two reporters sharing a label cannot suppress the contest: the second
    // one arrives with its own observation ref.
    const sm2 = await createSpatialModel({ clock: { nowMs: () => nowMs } });
    sm2.registerFrame({ frameId: "f1", kind: "ROOM", ref: { name: "k" }, source: "s" });
    sm2.reportOccupancy({ frameId: "f1", region, state: "UNKNOWN", observationRef: "shared-1", source: "shared-label" });
    sm2.reportOccupancy({ frameId: "f1", region, state: "KNOWN", observationRef: "shared-2", source: "shared-label" });
    const after = sm2.queryOccupancy({ frameId: "f1", region });
    assert.equal(after.state, "CONTESTED",
        "a shared label must not let a conflicting report unblock the region");
    assert.equal(after.blocked, true, "and the region stays blocked");

    // Re-reporting the SAME observation slot is a revision, not a contest.
    const sm3 = await createSpatialModel({ clock: { nowMs: () => nowMs } });
    sm3.registerFrame({ frameId: "f1", kind: "ROOM", ref: { name: "k" }, source: "s" });
    sm3.reportOccupancy({ frameId: "f1", region, state: "KNOWN", observationRef: "obs-1" });
    sm3.reportOccupancy({ frameId: "f1", region, state: "UNKNOWN", observationRef: "obs-1" });
    assert.equal(sm3.queryOccupancy({ frameId: "f1", region }).state, "UNKNOWN",
        "the same observation ref updating itself is a revision");

    // `source` is still RETAINED as provenance, as the contract requires.
    const node = sm3.getScene().sceneNodes.find(n => n.region && n.region.r === 1);
    assert.ok(node && Array.isArray(node.sources), "the source is retained as provenance");
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 472b6e0 -- canonical equality + property lookups   */
/* ---------------------------------------------------------------------- */

test("L3-audit-16: a persisted record the builder would NORMALIZE is rejected, not silently stored", async () => {
    // The builder normalizes a non-array `observationRefs` to `[]`, so "passes
    // the builder" let the MALFORMED ORIGINAL stay stored: `getScene()` exposed
    // the object, `queryOccupancy()` returned it as provenance, and a legitimate
    // later update threw a raw TypeError (audit of 472b6e0). Validation now
    // requires the stored record to EQUAL the builder's canonical output.
    const nowMs = 1_000_000;
    const frame = { frameId: "f1", kind: "ROOM", ref: { name: "k" }, source: "s", registeredAt: nowMs - 5000 };

    const malformedNodes = [
        { nodeId: "f1::{\"r\":1}", frameId: "f1", region: { r: 1 }, state: "KNOWN", observationRefs: [{ evil: true }], updatedAtMs: nowMs - 1000 },
        { nodeId: "f1::{\"r\":1}", frameId: "f1", region: { r: 1 }, state: "KNOWN", observationRefs: "not-an-array", updatedAtMs: nowMs - 1000 },
        { nodeId: "f1::{\"r\":1}", frameId: "f1", region: { r: 1 }, state: "KNOWN", observationRefs: ["ok", 5], updatedAtMs: nowMs - 1000 },
        { nodeId: "f1::{\"r\":1}", frameId: "f1", region: { r: 1 }, state: "KNOWN", observationRefs: ["ok"], sources: [{ bad: true }], updatedAtMs: nowMs - 1000 }
    ];

    for (const node of malformedNodes) {
        const sm = await createSpatialModel({
            store: {
                async getKv() {
                    return { frames: { f1: frame }, transforms: {}, sceneNodes: { [node.nodeId]: node } };
                },
                async putKv() {}
            },
            clock: { nowMs: () => nowMs }
        });
        assert.equal(sm.sceneNodesSize(), 0, "a normalized record must not be retained");
        assert.equal(sm.getScene().sceneNodes.length, 0, "and must not be exposed");
    }

    // A genuine update after loading a clean snapshot must not throw.
    const sm = await createSpatialModel({
        store: {
            async getKv() { return { frames: { f1: frame }, transforms: {}, sceneNodes: {} }; },
            async putKv() {}
        },
        clock: { nowMs: () => nowMs }
    });
    const node = sm.reportOccupancy({ frameId: "f1", region: { r: 1 }, state: "KNOWN", observationRef: "o1" });
    assert.equal(node.state, "KNOWN");
});

