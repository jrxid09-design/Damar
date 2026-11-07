"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STATES, EVENTS, TRANSITIONS, nextTarget } = require("../../src/extensions/lifecycle");
const { makeRegistry, manifest } = require("./helpers");

function setup() {
    const { c, registry } = makeRegistry();
    registry.register(manifest(), { source: "test" });
    return { c, registry };
}

test("lifecycle: closed transition table is total over states and events", () => {
    for (const state of Object.values(STATES)) {
        assert.ok(TRANSITIONS[state], `row missing for ${state}`);
        for (const event of Object.values(EVENTS)) {
            const target = TRANSITIONS[state][event];
            if (target !== undefined) {
                assert.ok(Object.values(STATES).includes(target),
                    `${state} --${event}--> unknown ${target}`);
                assert.equal(nextTarget(state, event), target);
            }
        }
    }
});

test("lifecycle: happy path DISCOVERED->INSTALLED->ENABLED->HEALTHY->DISABLED", () => {
    const { c, registry } = setup();
    assert.equal(registry.getState("test.alpha"), STATES.DISCOVERED);
    assert.equal(registry.install("test.alpha").state, STATES.INSTALLED);
    assert.equal(registry.enable("test.alpha").state, STATES.ENABLED);
    c.tick(5);
    assert.equal(registry.reportHealth("test.alpha", "HEALTHY", []).state, STATES.HEALTHY);
    assert.equal(registry.disable("test.alpha").state, STATES.DISABLED);
    const t = registry.getLastTransition("test.alpha");
    assert.deepEqual([t.from, t.to, t.event], [STATES.HEALTHY, STATES.DISABLED, "DISABLE"]);
    assert.equal(t.atMs, CLOCK_SAFE(c));
});

function CLOCK_SAFE(c) { return c.nowMs; }

test("lifecycle: invalid transitions fail without partial mutation", () => {
    const { registry } = setup();
    // enable from DISCOVERED is invalid
    assert.throws(() => registry.enable("test.alpha"), (e) => e.reasonCode === "INVALID_TRANSITION");
    assert.equal(registry.getState("test.alpha"), STATES.DISCOVERED);
    // stop path only valid from ENABLED-family states
    registry.install("test.alpha");
    assert.throws(() => registry.beginStop("test.alpha"));
    assert.equal(registry.getState("test.alpha"), STATES.INSTALLED);
});

test("lifecycle: double enable/disable are deterministic safe no-ops", () => {
    const { registry } = setup();
    registry.install("test.alpha");
    assert.deepEqual(registry.enable("test.alpha"), { changed: true, id: "test.alpha", state: STATES.ENABLED });
    const again = registry.enable("test.alpha");
    assert.equal(again.changed, false);
    assert.equal(again.alreadyEnabled, true);
    assert.equal(registry.getState("test.alpha"), STATES.ENABLED);

    assert.equal(registry.disable("test.alpha").changed, true);
    const twice = registry.disable("test.alpha");
    assert.equal(twice.changed, false);
    assert.equal(twice.alreadyDisabled, true);
});

test("lifecycle: start/stop sub-path for future execution drivers", () => {
    const { registry } = setup();
    registry.register(manifest({ extensionId: "test.beta" }), { install: true });
    assert.equal(registry.start("test.beta").state, STATES.STARTING);
    assert.equal(registry.completeStart("test.beta").state, STATES.ENABLED);
    assert.equal(registry.beginStop("test.beta").state, STATES.STOPPING);
    assert.equal(registry.completeStop("test.beta").state, STATES.DISABLED);
});

test("lifecycle: FAILED can retry enable but UNAVAILABLE is terminal in V1", () => {
    const { c, registry } = setup();
    registry.install("test.alpha");
    registry.enable("test.alpha");
    c.tick(1);
    registry.reportHealth("test.alpha", "FAILED", [{ code: "BOOT", message: "boom" }]);
    assert.equal(registry.getState("test.alpha"), STATES.FAILED);
    assert.equal(registry.enable("test.alpha").changed, true, "explicit retry allowed");

    registry.markUnavailable("test.alpha");
    assert.equal(registry.getState("test.alpha"), STATES.UNAVAILABLE);
    assert.throws(() => registry.enable("test.alpha"), (e) => e.reasonCode === "INVALID_TRANSITION");
});

test("lifecycle: health reports rejected outside reportable states", () => {
    const { registry } = setup();
    assert.throws(() => registry.reportHealth("test.alpha", "HEALTHY"),
        (e) => e.reasonCode === "INVALID_TRANSITION");
    registry.install("test.alpha"); // INSTALLED not reportable
    assert.throws(() => registry.reportHealth("test.alpha", "HEALTHY"),
        (e) => e.reasonCode === "INVALID_TRANSITION");
    registry.enable("test.alpha");
    assert.doesNotThrow(() => registry.reportHealth("test.alpha", "HEALTHY"));
});
