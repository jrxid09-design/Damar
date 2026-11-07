"use strict";

/**
 * CAPABILITY REGISTRY V1 — clock function capture regression.
 *
 * The registry must capture the clock's `nowMs` FUNCTION IDENTITY once at
 * construction and never re-read `clock.nowMs` afterward. Replacing
 * `clock.nowMs` after construction must not change which function the registry
 * invokes.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCapabilityRuntime } = require("../../src/capability/registry");

const { descriptor } = require("./helpers");

test("clock: replacing clock.nowMs after construction does not affect timestamps", () => {
    const clock = { nowMs: () => 100 };
    const { registry, registrars } = createCapabilityRuntime({
        clock,
        registrars: { core: true }
    });

    registrars.core.registerCanonical(descriptor({ id: "a.one" }));
    assert.equal(registry.get("a.one").observedAtMs, 100);

    clock.nowMs = () => 999999;

    registrars.core.registerCanonical(descriptor({ id: "a.two" }));
    assert.equal(registry.get("a.two").observedAtMs, 100);
});

test("clock: captured function identity is the original function", () => {
    let value = 100;
    const original = function () { return value; };

    const clock = { nowMs: original };
    const { registry, registrars } = createCapabilityRuntime({
        clock,
        registrars: { core: true }
    });

    registrars.core.registerCanonical(descriptor({ id: "b.one" }));
    assert.equal(registry.get("b.one").observedAtMs, 100);

    // Replace the clock's method — the registry must still invoke `original`
    clock.nowMs = () => 999999;

    registrars.core.registerCanonical(descriptor({ id: "b.two" }));
    assert.equal(registry.get("b.two").observedAtMs, 100);

    // `original` is still the invoked identity (it reads `value`, not a lookup)
    value = 777;
    registrars.core.registerCanonical(descriptor({ id: "b.three" }));
    assert.equal(registry.get("b.three").observedAtMs, 777);
});

test("clock: non-function clock.nowMs is typed-rejected at construction", () => {
    assert.throws(
        () => createCapabilityRuntime({ clock: { nowMs: 123 }, registrars: { core: true } }),
        (e) => e.reasonCode === "MALFORMED_INPUT");
    assert.throws(
        () => createCapabilityRuntime({ clock: { nowMs: "x" }, registrars: { core: true } }),
        (e) => e.reasonCode === "MALFORMED_INPUT");
});

test("clock: this-binding is preserved for methods reading this", () => {
    const clock = {
        base: 50,
        nowMs() { return this.base; }
    };
    const { registry, registrars } = createCapabilityRuntime({
        clock,
        registrars: { core: true }
    });
    registrars.core.registerCanonical(descriptor({ id: "c.one" }));
    assert.equal(registry.get("c.one").observedAtMs, 50);

    // mutating the object's field does not change captured behavior of nowMs
    // unless the captured function itself reads it via bound this.
    clock.base = 999;
    registrars.core.registerCanonical(descriptor({ id: "c.two" }));
    // bound `this` is the original clock object; its `base` field was mutated,
    // which is caller-provided clock semantics (separate from nowMs identity).
    assert.equal(registry.get("c.two").observedAtMs, 999);
});
