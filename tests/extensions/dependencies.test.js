"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeRegistry, manifest } = require("./helpers");
const { buildDependencyReport, findCycles } = require("../../src/extensions/dependencies");

test("dependencies: missing required dependency blocks enable, optional does not", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({
        extensionId: "needs.req",
        dependencies: [{ id: "absent.base" }, { id: "absent.opt", optional: true }]
    }), { install: true });
    const rep = registry.getDependencyReport("needs.req");
    assert.equal(rep.ok, false);
    assert.deepEqual(rep.missing.map((m) => m.id), ["absent.base"]);
    assert.throws(() => registry.enable("needs.req"), (e) => e.reasonCode === "DEPENDENCY_UNSATISFIED");
});

test("dependencies: disabled dependency blocks enable until enabled", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({ extensionId: "dep.lib" }), { install: true }); // INSTALLED, not enabled
    registry.register(manifest({
        extensionId: "dep.consumer",
        dependencies: [{ id: "dep.lib" }]
    }), { install: true });

    assert.throws(() => registry.enable("dep.consumer"), (e) => e.reasonCode === "DEPENDENCY_UNSATISFIED");
    const rep = registry.getDependencyReport("dep.consumer");
    assert.deepEqual(rep.disabled, [{ id: "dep.lib", state: "INSTALLED" }]);

    registry.enable("dep.lib");
    assert.ok(registry.getDependencyReport("dep.consumer").ok);
    assert.equal(registry.enable("dep.consumer").changed, true);
});

test("dependencies: version ranges gate enablement", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({ extensionId: "v.lib", version: "2.1.0" }), { install: true });
    registry.enable("v.lib"); // ACTIVE so version gate is what's under test
    registry.register(manifest({
        extensionId: "v.old",
        dependencies: [{ id: "v.lib", versionRange: "^1.0.0" }]
    }), { install: true });
    registry.register(manifest({
        extensionId: "v.new",
        dependencies: [{ id: "v.lib", versionRange: "^2.0.0" }]
    }), { install: true });

    assert.throws(() => registry.enable("v.old"));
    assert.equal(registry.enable("v.new").changed, true);
});

test("dependencies: cycles are detected deterministically and never wedge lifecycle", () => {
    const a = manifest({ extensionId: "cyc.a", dependencies: [{ id: "cyc.b" }] });
    const b = manifest({ extensionId: "cyc.b", dependencies: [{ id: "cyc.c" }] });
    const c = manifest({ extensionId: "cyc.c", dependencies: [{ id: "cyc.a" }] });
    for (const m of [a, b, c]) {
        const rep = findCycles(m);
        // each single-manifest view has dangling edges -> no closed cycle per-view
        void rep;
    }
    const { registry } = makeRegistry();
    for (const m of [a, b, c]) {
        registry.register(m); // registration must not wedge or hang
    }
    const all = registry.findAllDependencyCycles();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], ["cyc.a", "cyc.b", "cyc.c"],
        "cycle normalized to lexicographically smallest start");

    // lifecycle remains responsive: disable/enable still deterministic
    registry.install("cyc.a");
    assert.equal(registry.getState("cyc.a"), "INSTALLED");
    assert.throws(() => registry.enable("cyc.a"), (e) => e.reasonCode === "DEPENDENCY_UNSATISFIED");
    assert.equal(registry.getState("cyc.a"), "INSTALLED");
});

test("dependencies: self-cycle detected", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({ extensionId: "self.dep", dependencies: [{ id: "self.dep" }] }));
    const all = registry.findAllDependencyCycles();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], ["self.dep"]);
});

test("dependencies: report is frozen and pure (no mutation of registry)", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({ extensionId: "pure.one", dependencies: [{ id: "ghost.x" }] }),
        { install: true });
    const r1 = registry.getDependencyReport("pure.one");
    assert.ok(Object.isFrozen(r1));
    assert.deepEqual(r1.missing, [{ id: "ghost.x", versionRange: null }]);
    // repeated calls are deterministic; registry state untouched
    assert.deepEqual(JSON.stringify(registry.getDependencyReport("pure.one")), JSON.stringify(r1));
    assert.equal(registry.getState("pure.one"), "INSTALLED");
});

test("dependencies: deep chain resolves without recursion blowups", () => {
    const { registry } = makeRegistry();
    const N = 100;
    for (let i = 0; i < N; i++) {
        const deps = i + 1 < N ? [{ id: `chain.${i + 1}` }] : [];
        registry.register(manifest({ extensionId: `chain.${i}`, dependencies: deps }), { install: true });
    }
    // enabling in reverse order works; forward order fails cleanly
    assert.throws(() => registry.enable("chain.0"), (e) => e.reasonCode === "DEPENDENCY_UNSATISFIED");
    for (let i = N - 1; i >= 0; i--) registry.enable(`chain.${i}`);
    assert.equal(registry.getState("chain.0"), "ENABLED");
});
