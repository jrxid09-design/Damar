"use strict";

/**
 * CAPABILITY REGISTRY V1 — adversarial hardening tests (part 2: hostile input,
 * live callables, proxies, oversized arrays, authority-shaped metadata,
 * atomic rejection / zero partial mutation).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { CapabilityRegistry, CapabilityRegistryError } = require("../../src/capability/registry");
const { descriptor, makeRegistry } = require("./helpers");

// ---------------------------------------------------------------------------
// Blocker 4 — hostile input / live callables / proxies / oversized arrays
// ---------------------------------------------------------------------------

test("hostile: callable option values are rejected", () => {
    const { register, registry } = makeRegistry();
    const { incarnationId } = register(descriptor({ id: "a.one" }));
    assert.throws(
        () => registry.observeAvailability("a.one", "AVAILABLE", { generation: 1, incarnationId, observedAtMs: () => "live" }),
        (e) => e instanceof CapabilityRegistryError);
    assert.equal(registry.getAvailability("a.one").generation, 0);
});

test("hostile: callable observation values are rejected", () => {
    const { register, registry } = makeRegistry();
    const { incarnationId } = register(descriptor({ id: "a.one" }));
    assert.throws(
        () => registry.observeAvailability("a.one", "AVAILABLE", { generation: 1, incarnationId, metadata: { fn: () => "live" } }),
        (e) => e.reasonCode === "FUNCTION_VALUE");
    assert.equal(registry.getAvailability("a.one").generation, 0);
});

test("hostile: accessor-bearing observation metadata rejected", () => {
    const { register, registry } = makeRegistry();
    const { incarnationId } = register(descriptor({ id: "a.one" }));
    const meta = {};
    Object.defineProperty(meta, "v", { get() { return 1; }, enumerable: true, configurable: true });
    assert.throws(
        () => registry.observeAvailability("a.one", "AVAILABLE", { generation: 1, incarnationId, metadata: meta }),
        (e) => e.reasonCode === "ACCESSOR_PROPERTY");
});

test("hostile: hostile Proxy at the untrusted boundary is rejected", () => {
    const { core } = makeRegistry();
    let trapRuns = 0;
    const proxy = new Proxy(descriptor(), {
        get() { trapRuns++; throw new Error("get trap"); },
        ownKeys() { trapRuns++; throw new Error("ownKeys trap"); },
        getOwnPropertyDescriptor() { trapRuns++; throw new Error("descriptor trap"); }
    });
    // plain object (even a Proxy) is rejected as object input before traversal
    assert.throws(
        () => core.register(proxy),
        (e) => e.reasonCode === "OBJECT_INPUT_NOT_ALLOWED");
    assert.equal(trapRuns, 0, "no Proxy trap may execute at the untrusted boundary");
});

test("hostile: no callable/accessor/symbol retained in canonical state", () => {
    const { register, registry } = makeRegistry();
    register(descriptor({ id: "a.one", metadata: { s: "x", n: 1, b: true, a: [1, 2] } }));
    const snap = registry.serialize();
    const walk = (v) => {
        if (v === null) return;
        const t = typeof v;
        assert.ok(t !== "function" && t !== "symbol", "no function/symbol retained");
        if (t === "object") {
            const descs = Object.getOwnPropertyDescriptors(v);
            for (const k of Object.keys(descs)) {
                assert.equal(descs[k].get, undefined, "no accessor retained");
                assert.equal(descs[k].set, undefined, "no accessor retained");
                walk(v[k]);
            }
        }
    };
    walk(snap);
});

test("hostile: oversized array rejected before copying (length bound first)", () => {
    const { register, registry } = makeRegistry();
    const huge = new Array(1_000_000).fill("x");
    assert.throws(
        () => register(descriptor({ id: "huge.ops", operations: huge })),
        (e) => e.reasonCode === "BOUND_EXCEEDED");
    assert.equal(registry.size, 0);
});

test("hostile: rejected input causes zero partial mutation", () => {
    const { register, registry } = makeRegistry();
    register(descriptor({ id: "keep.one", dependencies: ["keep.two"] }));
    register(descriptor({ id: "keep.two" }));
    const digest0 = JSON.stringify(registry.serialize());

    // each of these must reject and leave state byte-identical
    assert.throws(() => register(descriptor({ id: "new.bad", metadata: { fn: () => {} } })));
    assert.throws(() => register(descriptor({ id: "new.bad2", dependencies: Array.from({ length: 100 }, (_, i) => `d.${i}`) })));
    assert.throws(() => register(descriptor({ id: "new.bad3", authorized: true })));
    assert.throws(() => register(descriptor({ id: "new.bad4", metadata: { nested: { OWNER: "root" } } })));

    const digest1 = JSON.stringify(registry.serialize());
    assert.equal(digest1, digest0);
    assert.equal(registry.size, 2);
});

// ---------------------------------------------------------------------------
// Blocker 5 — authority-shaped metadata (recursive, case-insensitive)
// ---------------------------------------------------------------------------

test("authority-metadata: nested case-insensitive authority keys reject", () => {
    const { register } = makeRegistry();
    const cases = [
        { authorized: true },
        { nested: { AUTHORIZED: true } },
        { nested: { deep: { grant: "x" } } },
        { arr: [{ Owner: "root" }] },
        { metadata: { Permissions: ["read"] } },
        { a: { b: { c: { trusted: 1 } } } },
        { role: "admin" },
        { approved: false },
        { privileges: [] }
    ];
    for (const meta of cases) {
        assert.throws(
            () => register(descriptor({ id: "meta.bad", metadata: meta })),
            (e) => e.reasonCode === "AUTHORITY_METADATA",
            `metadata ${JSON.stringify(meta)} must be rejected`);
    }
});

test("authority-metadata: observation metadata also rejects authority keys", () => {
    const { register, registry } = makeRegistry();
    const { incarnationId } = register(descriptor({ id: "a.one" }));
    assert.throws(
        () => registry.observeAvailability("a.one", "AVAILABLE", { generation: 1, incarnationId, metadata: { authorized: true } }),
        (e) => e.reasonCode === "AUTHORITY_METADATA");
    assert.equal(registry.getAvailability("a.one").generation, 0);
});

test("authority-metadata: benign metadata still accepted", () => {
    const { register, registry } = makeRegistry();
    register(descriptor({ id: "a.one", metadata: { label: "hello", version: 2, tags: ["a", "b"] } }));
    assert.deepEqual(registry.get("a.one").metadata, { label: "hello", version: 2, tags: ["a", "b"] });
});

test("authority-metadata: full authority vocabulary is rejected at any depth", () => {
    const api = require("../../src/capability/registry");
    const { register } = makeRegistry();
    for (const word of api.AUTHORITY_VOCABULARY) {
        assert.throws(
            () => register(descriptor({ id: "vocab.bad", metadata: { [word]: 1 } })),
            (e) => e.reasonCode === "AUTHORITY_METADATA",
            `word '${word}' must be rejected`);
        // mixed-case variant too
        assert.throws(
            () => register(descriptor({ id: "vocab.bad", metadata: { [word.toUpperCase()]: 1 } })),
            (e) => e.reasonCode === "AUTHORITY_METADATA");
    }
});
