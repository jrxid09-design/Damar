"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeRegistry, manifest, manualClock } = require("./helpers");

function enabled(registry, id) {
    registry.register(manifest({ extensionId: id }), { install: true });
    registry.enable(id);
    return id;
}

test("health: independent from enablement; UNKNOWN until first report", () => {
    const { registry } = makeRegistry();
    enabled(registry, "h.one");
    assert.equal(registry.getState("h.one"), "ENABLED");
    assert.deepEqual(registry.serializeState().extensions[0].health,
        { status: "UNKNOWN", lastReportAtMs: null, diagnosticCount: 0 });
});

test("health: transitions ENABLED->DEGRADED->HEALTHY and ->FAILED", () => {
    const c = manualClock(100);
    const { registry } = makeRegistry({ clock: c });
    enabled(registry, "h.two");

    registry.reportHealth("h.two", "DEGRADED", [{ code: "SLOW", message: "latency high" }]);
    assert.equal(registry.getState("h.two"), "DEGRADED"); // still functional
    registry.reportHealth("h.two", "HEALTHY");
    assert.equal(registry.getState("h.two"), "HEALTHY");
    c.tick();
    registry.reportHealth("h.two", "FAILED", [{ code: "CRASH", message: "x" }]);
    assert.equal(registry.getState("h.two"), "FAILED");

    // FAILED extension can be disabled deterministically
    assert.equal(registry.disable("h.two").changed, true);
});

test("health: diagnostics are bounded and hostile payloads sanitized", () => {
    const { registry } = makeRegistry();
    enabled(registry, "h.three");

    const hostile = Array.from({ length: 500 }, (_, i) => ({
        code: `CODE_${i}`,
        message: "y".repeat(10_000),
        evil: { nested: () => { throw new Error("nope"); } }
    }));
    const res = registry.reportHealth("h.three", "DEGRADED", hostile);
    assert.equal(res.health.diagnostics.length, 32); // bounded
    assert.equal(res.health.droppedDiagnostics, 468);
    for (const d of res.health.diagnostics) {
        assert.ok(d.message.length <= 256);
        assert.ok(Object.isFrozen(d));
        assert.equal(typeof d.code, "string");
    }

    // unprintable objects don't crash the trusted path
    const weird = [{ code: Symbol("s"), message: { toString() { throw new Error("boom"); } } }];
    const r2 = registry.reportHealth("h.three", "HEALTHY", weird);
    assert.equal(r2.health.diagnostics[0].message, "[unprintable]");

    // invalid status fails closed without mutating anything
    const stateBefore = registry.getState("h.three");
    assert.throws(() => registry.reportHealth("h.three", "GOLDEN"),
        (e) => e.reasonCode === "INVALID_HEALTH_STATUS");
    assert.equal(registry.getState("h.three"), stateBefore);
});

test("health: one failing health report does not corrupt unrelated extensions", () => {
    const { registry } = makeRegistry();
    enabled(registry, "h.good");
    enabled(registry, "h.other");

    assert.throws(() => registry.reportHealth("h.other", "NOT_A_STATUS"));
    assert.equal(registry.getState("h.good"), "ENABLED");
    assert.equal(registry.getState("h.other"), "ENABLED");
    // valid report still accepted afterwards
    assert.equal(registry.reportHealth("h.other", "HEALTHY").changed, true);
});
