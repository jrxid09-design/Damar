"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeRegistry, manifest } = require("./helpers");

function enabled(registry, id) {
    registry.register(manifest({ extensionId: id }), { install: true });
    registry.enable(id);
}

test("projects: enabled globally != activated for project", () => {
    const { registry } = makeRegistry();
    enabled(registry, "p.one");
    assert.equal(registry.isActiveForProject("p.one", "lab-1"), false,
        "global enablement alone implies no project activation");
    registry.activateForProject("p.one", "lab-1");
    assert.equal(registry.isActiveForProject("p.one", "lab-1"), true);
    assert.equal(registry.isActiveForProject("p.one", "lab-2"), false,
        "activation for X does not leak to Y");
    assert.deepEqual(registry.listActiveProjects("p.one"), ["lab-1"]);
});

test("projects: activation requires global enablement and grants nothing else", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({ extensionId: "p.disabled" }), { install: true });
    assert.throws(() => registry.activateForProject("p.disabled", "lab-1"),
        (e) => e.reasonCode === "ACTIVATION_REJECTED");
    // activation never escalates state or authority
    assert.equal(registry.getState("p.disabled"), "INSTALLED");
});

test("projects: double activate/deactivate are idempotent", () => {
    const { registry } = makeRegistry();
    enabled(registry, "p.two");
    assert.equal(registry.activateForProject("p.two", "lab-a").changed, true);
    assert.equal(registry.activateForProject("p.two", "lab-a").changed, false);
    assert.equal(registry.deactivateForProject("p.two", "lab-a").changed, true);
    assert.equal(registry.deactivateForProject("p.two", "lab-a").changed, false,
        "deactivating an inactive project is safe");
});

test("projects: disabling globally leaves activations recorded but ineffective", () => {
    const { registry } = makeRegistry();
    enabled(registry, "p.three");
    registry.activateForProject("p.three", "lab-x");
    registry.disable("p.three");
    assert.equal(registry.isActiveForProject("p.three", "lab-x"), false,
        "effective state requires BOTH enabled and activated");
    assert.deepEqual(registry.listActiveProjects("p.three"), ["lab-x"],
        "activation records persist; re-enable restores effective state");
    registry.enable("p.three");
    assert.equal(registry.isActiveForProject("p.three", "lab-x"), true);
});

test("projects: hostile project identifiers rejected", () => {
    const { registry } = makeRegistry();
    enabled(registry, "p.four");
    for (const bad of ["../escape", "__proto__", "", "UPPER", "a/b", null, 7]) {
        assert.throws(() => registry.activateForProject("p.four", bad),
            (e) => e instanceof Error && e.name === "ExtensionKernelError", String(bad));
    }
});

test("projects: activation bound prevents unbounded accumulation", () => {
    const { registry } = makeRegistry({ maxProjectActivationsPerExtension: 4 });
    enabled(registry, "p.five");
    for (let i = 0; i < 4; i++) registry.activateForProject("p.five", `proj-${i}`);
    assert.throws(() => registry.activateForProject("p.five", "proj-over"),
        (e) => e.reasonCode === "BOUND_EXCEEDED");
});
