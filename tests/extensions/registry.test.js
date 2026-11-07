"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeRegistry, manifest, manualClock } = require("./helpers");

test("registry: duplicate canonical ids rejected deterministically; case variants rejected outright", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({ extensionId: "dup.ext" }));
    assert.throws(() => registry.register(manifest({ extensionId: "dup.ext" })),
        (e) => e.reasonCode === "DUPLICATE_EXTENSION");
    // uppercase variants never even canonicalize -> case collisions impossible
    assert.throws(() => registry.register(manifest({ extensionId: "DUP.EXT", name: "Other", version: "2.0.0" })),
        (e) => e.reasonCode === "INVALID_EXTENSION_ID");
});

test("registry: registry bound prevents dependency bombs / unbounded growth", () => {
    const { registry } = makeRegistry({ maxExtensions: 8 });
    for (let i = 0; i < 8; i++) registry.register(manifest({ extensionId: `x${i}.ext` }));
    assert.throws(() => registry.register(manifest({ extensionId: "overflow.ext" })),
        (e) => e.reasonCode === "REGISTRY_FULL");
    assert.equal(registry.size, 8);
});

test("registry: returned objects cannot mutate internal state (hostile callers)", () => {
    const { c, registry } = makeRegistry();
    registry.register(manifest({
        extensionId: "hard.target",
        capabilities: ["cap.one"],
        dependencies: [{ id: "dep.one" }]
    }), { install: true });

    const desc = registry.getDescriptor("hard.target");
    assert.throws(() => { desc.capabilities.push("cap.injected"); });
    assert.throws(() => { desc.dependencies[0].optional = true; });
    assert.deepEqual(registry.getCapabilities("hard.target"), ["cap.one"]);

    const states = registry.listStates();
    try { states["hard.target"] = "FAILED"; } catch { /* frozen */ }
    if (states["hard.target"] === "FAILED") {
        assert.fail("listStates must be frozen");
    }
    assert.equal(registry.getState("hard.target"), "INSTALLED");

    const caps = registry.getCapabilities("hard.target");
    try { caps.push("cap.two"); } catch { /* frozen */ }
    assert.deepEqual(registry.getCapabilities("hard.target"), ["cap.one"]);
    void c;
});

test("registry: unknown extensions fail closed with reason", () => {
    const { registry } = makeRegistry();
    for (const op of ["install", "enable", "disable"]) {
        assert.throws(() => registry[op]("ghost.ext"), (e) => e.reasonCode === "UNKNOWN_EXTENSION");
    }
    assert.equal(registry.has("ghost.ext"), false);
});

test("registry: enable failure is atomic — no partial state on unsatisfied deps", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({
        extensionId: "needs.dep",
        dependencies: [{ id: "missing.base" }]
    }), { install: true });
    assert.throws(() => registry.enable("needs.dep"), (e) => e.reasonCode === "DEPENDENCY_UNSATISFIED");
    assert.equal(registry.getState("needs.dep"), "INSTALLED");
    assert.deepEqual(registry.listActiveProjects("needs.dep"), []);
    assert.equal(registry.getLastTransition("needs.dep").to, "INSTALLED");
});

test("registry: deterministic serialization of canonical state only", () => {
    const clock = manualClock(5000);
    const a = makeRegistry({ clock }).registry;
    const b = makeRegistry({ clock }).registry;
    for (const reg of [a, b]) {
        reg.register(manifest({ extensionId: "ser.one", capabilities: ["c.b", "c.a"] }), { install: true });
        reg.register(manifest({ extensionId: "ser.two" }), { install: true });
        reg.enable("ser.one");
        reg.reportHealth("ser.one", "DEGRADED", [{ code: "X", message: "m" }]);
        reg.activateForProject("ser.one", "proj-1");
        reg.setConfigurationValues("ser.one", { z: 1, a: [true, "two"] });
    }
    assert.deepEqual(a.serializeState(), b.serializeState(), "same ops -> identical snapshot");
    // no live objects leak into snapshot
    const snap = a.serializeState();
    assert.ok(Object.isFrozen(snap));
    for (const e of snap.extensions) {
        assert.ok(typeof e.id === "string");
        assert.ok(!("descriptor" in e), "no manifest blobs in snapshot");
        assert.ok(!("healthReport" in e), "no live report objects in snapshot");
    }
});

test("registry: getStats is bounded and truthful", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({ extensionId: "s.one" }), { install: true });
    registry.register(manifest({ extensionId: "s.two" }), { install: true });
    registry.enable("s.two");
    const stats = registry.getStats();
    assert.equal(stats.extensions, 2);
    assert.equal(stats.byState.INSTALLED, 1);
    assert.equal(stats.byState.ENABLED, 1);
});
