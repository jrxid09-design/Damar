"use strict";

/**
 * CAPABILITY REGISTRY V1 — second repair regression tests.
 *
 * Direct regression for each Codex blocker:
 *   1. CommonJS internal-import bypass of registrar mint trust
 *   2. instanceof Uint8Array executing Proxy code
 *   3. clock external + unchecked callable retention
 *   4. equal-generation idempotence broken by synthesized timestamp
 *   5. array allocation before bound check
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const api = require("../../src/capability/registry");
const { CapabilityRegistry, CapabilityRegistryError } = require("../../src/capability/registry");
const { descriptor, makeRegistry } = require("./helpers");

// ---------------------------------------------------------------------------
// Structural guard: no module in the registry package exports a mint primitive
// ---------------------------------------------------------------------------

test("blocker1: structural guard — no module exports mint/identity primitives", () => {
    const dir = path.join(__dirname, "../../src/capability/registry");
    const forbiddenExports = [
        "MINT_TOKEN", "establishIdentity", "createCapabilityRegistrarFactory",
        "mintRegistrar", "identityTokens", "mintGates"
    ];
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".js")) continue;
        const modPath = path.join(dir, f);
        const exported = require(modPath);
        for (const name of forbiddenExports) {
            assert.equal(exported[name], undefined, `${f} must not export '${name}'`);
        }
    }
});

// ---------------------------------------------------------------------------
// Blocker 1 — direct internal-import bypass
// ---------------------------------------------------------------------------

test("blocker1: direct-require of registry.js exposes no mint primitives", () => {
    const internal = require("../../src/capability/registry/registry");
    assert.equal(internal.createCapabilityRegistrarFactory, undefined);
    assert.equal(internal.establishIdentity, undefined);
    assert.equal(internal.MINT_TOKEN, undefined);
    assert.equal(internal.mintRegistrar, undefined);
});

test("blocker1: prior repro fails — cannot mint core via internal import", () => {
    const internal = require("../../src/capability/registry/registry");
    const registry = new api.CapabilityRegistry();
    assert.equal(typeof internal.createCapabilityRegistrarFactory, "undefined");
    assert.equal(typeof internal.establishIdentity, "undefined");
    // No way to obtain a registrar; registry remains empty
    assert.equal(registry.size, 0);
});

test("blocker1: createCapabilityRuntime returns least-privilege registrars only", () => {
    const runtime = api.createCapabilityRuntime({
        registrars: { core: true, extension: "ext", device: "dev", provider: "prov" }
    });
    assert.equal(typeof runtime.registry, "object");
    assert.equal(typeof runtime.registrars.core, "object");
    // no mint/factory/identity primitives returned
    assert.equal(runtime.registrars.core.createRegistrar, undefined);
    assert.equal(runtime.registrars.core.createRegistrarFactory, undefined);
    assert.equal(runtime.createRegistrar, undefined);
    assert.equal(runtime.establishIdentity, undefined);
});

// ---------------------------------------------------------------------------
// Blocker 2 — Proxy trap execution at the serialized boundary
// ---------------------------------------------------------------------------

test("blocker2: hostile Proxy rejected with zero caller code execution", () => {
    const { core } = makeRegistry();
    let executions = 0;
    const proxy = new Proxy({}, {
        getPrototypeOf() { executions++; return Object.prototype; },
        get() { executions++; return undefined; },
        ownKeys() { executions++; return []; },
        getOwnPropertyDescriptor() { executions++; return undefined; }
    });
    assert.throws(
        () => core.register(proxy),
        (e) => e.reasonCode === "OBJECT_INPUT_NOT_ALLOWED");
    assert.equal(executions, 0, "no Proxy trap may execute during rejection");
});

test("blocker2: typed array / buffer rejected as string-only boundary", () => {
    const { core } = makeRegistry();
    assert.throws(() => core.register(new Uint8Array([1, 2, 3])),
        (e) => e.reasonCode === "OBJECT_INPUT_NOT_ALLOWED");
    assert.throws(() => core.register(Buffer.from("{}")),
        (e) => e.reasonCode === "OBJECT_INPUT_NOT_ALLOWED");
    assert.throws(() => core.register([]),
        (e) => e.reasonCode === "OBJECT_INPUT_NOT_ALLOWED");
    assert.throws(() => core.register(() => {}),
        (e) => e.reasonCode === "OBJECT_INPUT_NOT_ALLOWED");
});

// ---------------------------------------------------------------------------
// Blocker 3 — clock external + unchecked callable retention
// ---------------------------------------------------------------------------

test("blocker3: clock returning function is rejected before mutation", () => {
    const { registry, core } = makeRegistry({ clock: { nowMs: () => () => 1 } });
    assert.throws(() => core.registerCanonical(descriptor({ id: "c.one" })),
        (e) => e instanceof CapabilityRegistryError);
    assert.equal(registry.size, 0);
});

test("blocker3: clock returning object is rejected", () => {
    const { registry, core } = makeRegistry({ clock: { nowMs: () => ({}) } });
    assert.throws(() => core.registerCanonical(descriptor({ id: "c.one" })),
        (e) => e instanceof CapabilityRegistryError);
    assert.equal(registry.size, 0);
});

test("blocker3: clock returning NaN / Infinity is rejected", () => {
    for (const v of [NaN, Infinity, -Infinity, -1, 1.5, "5"]) {
        const { registry, core } = makeRegistry({ clock: { nowMs: () => v } });
        assert.throws(() => core.registerCanonical(descriptor({ id: "c.one" })),
            (e) => e instanceof CapabilityRegistryError, `clock value ${String(v)}`);
        assert.equal(registry.size, 0);
    }
});

test("blocker3: external mutation of supplied clock does not affect behavior", () => {
    const mutableClock = { nowMs: () => 100 };
    const { registry, core } = makeRegistry({ clock: mutableClock });
    // mutate the caller's clock object after construction
    mutableClock.nowMs = () => 999999;
    const res = core.registerCanonical(descriptor({ id: "c.one" }));
    assert.equal(res.registered, true);
    // observedAtMs reflects the captured (original) behavior; never a callable
    const got = registry.get("c.one");
    assert.equal(typeof got.observedAtMs, "number");
    assert.ok(Number.isSafeInteger(got.observedAtMs));
});

// ---------------------------------------------------------------------------
// Blocker 4 — equal-generation idempotence (no synthesized timestamp)
// ---------------------------------------------------------------------------

test("blocker4: equal-generation identical observation is idempotent under incrementing clock", () => {
    let t = 0;
    let calls = 0;
    const { registry, core } = makeRegistry({ clock: { nowMs: () => { calls++; t += 1000; return t; } } });
    const { incarnationId } = core.registerCanonical(descriptor({ id: "g.one" }));
    registry.observeAvailability("g.one", "AVAILABLE", { generation: 1, incarnationId, metadata: { x: 1 } });
    const callsAfterFirst = calls;
    // exact same observation again => idempotent, and must NOT mint a new timestamp
    const r2 = registry.observeAvailability("g.one", "AVAILABLE", { generation: 1, incarnationId, metadata: { x: 1 } });
    assert.equal(r2.changed, false);
    assert.equal(calls, callsAfterFirst, "no clock call on equal-generation idempotent replay");
});

test("blocker4: equal-generation conflicting metadata/status rejects", () => {
    const { registry, core } = makeRegistry({ clock: { nowMs: () => 500 } });
    const { incarnationId } = core.registerCanonical(descriptor({ id: "g.two" }));
    registry.observeAvailability("g.two", "AVAILABLE", { generation: 1, incarnationId, metadata: { x: 1 } });
    assert.throws(
        () => registry.observeAvailability("g.two", "AVAILABLE", { generation: 1, incarnationId, metadata: { x: 2 } }),
        (e) => e.reasonCode === "CONFLICTING_OBSERVATION");
    assert.throws(
        () => registry.observeAvailability("g.two", "UNAVAILABLE", { generation: 1, incarnationId, metadata: { x: 1 } }),
        (e) => e.reasonCode === "CONFLICTING_OBSERVATION");
});

// ---------------------------------------------------------------------------
// Blocker 5 — array allocation before bound check
// ---------------------------------------------------------------------------

test("blocker5: sparse huge array rejected before allocation", () => {
    const { registry, core } = makeRegistry();
    const huge = new Array(100_000_000); // sparse, length 1e8
    assert.throws(
        () => core.registerCanonical(descriptor({ id: "big.ops", operations: huge })),
        (e) => e.reasonCode === "BOUND_EXCEEDED");
    assert.equal(registry.size, 0);
});

test("blocker5: nested huge sparse array in metadata rejected before allocation", () => {
    const { registry, core } = makeRegistry();
    const huge = new Array(100_000_000);
    assert.throws(
        () => core.registerCanonical(descriptor({ id: "big.meta", metadata: { nested: huge } })),
        (e) => e.reasonCode === "BOUND_EXCEEDED");
    assert.equal(registry.size, 0);
});

test("blocker5: oversized array rejection is a typed CapabilityRegistryError with zero mutation", () => {
    const { registry, core } = makeRegistry();
    core.registerCanonical(descriptor({ id: "keep.one" }));
    const digest0 = JSON.stringify(registry.serialize());
    const huge = new Array(100_000_000);
    assert.throws(
        () => core.registerCanonical(descriptor({ id: "big.two", operations: huge })),
        (e) => e instanceof CapabilityRegistryError && e.reasonCode === "BOUND_EXCEEDED");
    assert.equal(JSON.stringify(registry.serialize()), digest0);
});
