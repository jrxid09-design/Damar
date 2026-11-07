"use strict";

/**
 * CAPABILITY REGISTRY V1 — adversarial hardening tests (part 1: private state,
 * detached snapshots, generation/incarnation ABA, provenance forgery).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { CapabilityRegistry, CapabilityRegistryError } = require("../../src/capability/registry");
const { descriptor, makeRegistry } = require("./helpers");

// ---------------------------------------------------------------------------
// Blocker 1 — private state escape / detached snapshots
// ---------------------------------------------------------------------------

test("adversarial: no mutable internal Map/Set exposed on the instance", () => {
    const { registry } = makeRegistry();
    for (const n of Object.getOwnPropertyNames(registry)) {
        assert.ok(!/record|edge|reverse|byKind|byProvenance|index|incarnation/i.test(n),
            `must not expose mutable internal '${n}'`);
        assert.equal(registry[n] instanceof Map, false, `'${n}' must not be a Map`);
        assert.equal(registry[n] instanceof Set, false, `'${n}' must not be a Set`);
    }
    assert.equal(registry._records, undefined);
    assert.equal(registry._edges, undefined);
    assert.equal(registry._reverseEdges, undefined);
    assert.equal(registry._byKind, undefined);
    assert.equal(registry._byProvenance, undefined);
});

test("adversarial: mutating every returned view never reaches canonical state", () => {
    const { register, registry } = makeRegistry();
    register(descriptor({
        id: "a.one",
        operations: ["read"],
        dependencies: ["a.two"],
        metadata: { nested: { x: 1 }, arr: [1, 2, 3] }
    }));
    register(descriptor({ id: "a.two" }));

    const digest0 = JSON.stringify(registry.serialize());

    // Attempt to mutate every returned object. Frozen views throw in strict
    // mode; either way canonical state must be untouched.
    const tryMutate = (fn) => { try { fn(); } catch { /* frozen: ok */ } };

    const got = registry.get("a.one");
    tryMutate(() => { got.id = "hacked"; });
    tryMutate(() => { got.provenance = "authority"; });
    tryMutate(() => { got.operations.push("EXECUTE"); });
    tryMutate(() => { got.metadata.nested.x = 999; });
    tryMutate(() => { got.metadata.arr.push(42); });
    tryMutate(() => { got.dependencies.push("evil.dep"); });

    const listed = registry.list();
    tryMutate(() => { listed[0].id = "listed-hack"; });

    const byKind = registry.listByKind("system");
    tryMutate(() => { byKind[0].kind = "device"; });

    const deps = registry.getDependencies("a.one");
    tryMutate(() => { deps.push("injected.dep"); });

    const dependents = registry.getDependents("a.two");
    tryMutate(() => { dependents.push("injected.dependent"); });

    const avail = registry.getAvailability("a.one");
    tryMutate(() => { avail.availability = "AUTHORIZED"; });
    tryMutate(() => { avail.generation = 999999; });

    const transitive = registry.transitiveDependencies("a.one");
    tryMutate(() => { transitive.push("ghost.id"); });

    const digest1 = JSON.stringify(registry.serialize());
    assert.equal(digest1, digest0, "canonical digest must be unchanged after view mutation");
    assert.equal(registry.get("a.one").id, "a.one");
    assert.deepEqual(registry.get("a.one").operations, ["read"]);
});

test("adversarial: AVAILABLE != AUTHORIZED cannot be bypassed via mutation", () => {
    const { register, registry } = makeRegistry();
    const { incarnationId } = register(descriptor({ id: "a.one" }));
    registry.observeAvailability("a.one", "AVAILABLE", { generation: 1, incarnationId });
    const view = registry.get("a.one");
    try { view.availability = "AUTHORIZED"; } catch { /* frozen: ok */ }
    try { view.generation = 999; } catch { /* frozen: ok */ }
    assert.equal(registry.getAvailability("a.one").availability, "AVAILABLE");
    assert.equal(registry.get("a.one").availability, "AVAILABLE");
});

// ---------------------------------------------------------------------------
// Blocker 2 — generation / incarnation (ABA) lifetime
// ---------------------------------------------------------------------------

test("adversarial: equal-generation conflicting availability is rejected", () => {
    const { register, registry } = makeRegistry();
    const { incarnationId } = register(descriptor({ id: "a.one" }));
    registry.observeAvailability("a.one", "AVAILABLE", { generation: 7, incarnationId });
    assert.throws(
        () => registry.observeAvailability("a.one", "UNAVAILABLE", { generation: 7, incarnationId }),
        (e) => e.reasonCode === "CONFLICTING_OBSERVATION");
    assert.equal(registry.getAvailability("a.one").availability, "AVAILABLE");
});

test("adversarial: equal-generation exact idempotence is a no-op", () => {
    const { register, registry } = makeRegistry();
    const { incarnationId } = register(descriptor({ id: "a.one" }));
    registry.observeAvailability("a.one", "AVAILABLE", { generation: 7, incarnationId, metadata: { source: "probe" } });
    const r2 = registry.observeAvailability("a.one", "AVAILABLE", { generation: 7, incarnationId, metadata: { source: "probe" } });
    assert.equal(r2.changed, false);
});

test("adversarial: malformed generations are rejected before mutation", () => {
    const { register, registry } = makeRegistry();
    const { incarnationId } = register(descriptor({ id: "a.one" }));
    const bad = [undefined, null, -1, 1.5, NaN, Infinity, -Infinity,
        Number.MAX_SAFE_INTEGER + 1, "7", "7.0", {}, [], true];
    for (const g of bad) {
        assert.throws(
            () => registry.observeAvailability("a.one", "AVAILABLE", { generation: g, incarnationId }),
            (e) => e.reasonCode === "INVALID_GENERATION",
            `generation ${String(g)} must be rejected`);
    }
    assert.equal(registry.getAvailability("a.one").generation, 0);
});

test("adversarial: remove/re-register mints a new incarnation (ABA)", () => {
    const { register, registry } = makeRegistry();
    const a = register(descriptor({ id: "aba.one" }));
    registry.observeAvailability("aba.one", "AVAILABLE", { generation: 100, incarnationId: a.incarnationId });
    registry.remove("aba.one");
    const b = register(descriptor({ id: "aba.one" }));
    assert.notEqual(b.incarnationId, a.incarnationId, "re-register must mint a different incarnationId");
    assert.throws(
        () => registry.observeAvailability("aba.one", "UNAVAILABLE", { generation: 101, incarnationId: a.incarnationId }),
        (e) => e.reasonCode === "INVALID_INCARNATION");
    assert.throws(
        () => registry.observeAvailability("aba.one", "UNAVAILABLE", { generation: 999999, incarnationId: a.incarnationId }),
        (e) => e.reasonCode === "INVALID_INCARNATION");
    assert.equal(registry.getAvailability("aba.one").availability, "UNKNOWN");
    assert.equal(registry.getAvailability("aba.one").generation, 0);
    assert.equal(registry.getAvailability("aba.one").incarnationId, b.incarnationId);
});

test("adversarial: observation with unknown/forged incarnation always rejects", () => {
    const { register, registry } = makeRegistry();
    register(descriptor({ id: "a.one" }));
    assert.throws(
        () => registry.observeAvailability("a.one", "AVAILABLE", { generation: 1, incarnationId: "inc-" + "0".repeat(32) }),
        (e) => e.reasonCode === "INVALID_INCARNATION");
    assert.throws(
        () => registry.observeAvailability("a.one", "AVAILABLE", { generation: 1, incarnationId: "not-an-incarnation" }),
        (e) => e.reasonCode === "INVALID_INCARNATION");
    assert.throws(
        () => registry.observeAvailability("a.one", "AVAILABLE", { generation: 1 }),
        (e) => e.reasonCode === "INVALID_INCARNATION");
});

// ---------------------------------------------------------------------------
// Blocker 3 — provenance forgery / registrar trust model
// ---------------------------------------------------------------------------

test("adversarial: descriptor cannot self-select core provenance", () => {
    const { register } = makeRegistry();
    assert.throws(
        () => register(descriptor({ provenance: "core/runtime" })),
        (e) => e.reasonCode === "FORBIDDEN_PROVENANCE");
});

test("adversarial: extension registrar cannot claim core/system/runtime provenance", () => {
    const { extension } = makeRegistry();
    assert.throws(
        () => extension.registerCanonical(descriptor({ id: "ext.fake", kind: "system" })),
        (e) => e.reasonCode === "KIND_PROVENANCE_MISMATCH");
    assert.throws(
        () => extension.registerCanonical(descriptor({ id: "ext.fake2", kind: "runtime" })),
        (e) => e.reasonCode === "KIND_PROVENANCE_MISMATCH");
});

test("adversarial: device registrar cannot claim extension/core provenance", () => {
    const { device } = makeRegistry();
    assert.throws(
        () => device.registerCanonical(descriptor({ id: "dev.fake", kind: "extension" })),
        (e) => e.reasonCode === "KIND_PROVENANCE_MISMATCH");
    assert.throws(
        () => device.registerCanonical(descriptor({ id: "dev.fake2", kind: "system" })),
        (e) => e.reasonCode === "KIND_PROVENANCE_MISMATCH");
});

test("adversarial: kind/provenance correspondence is enforced", () => {
    const { core } = makeRegistry();
    assert.throws(
        () => core.registerCanonical(descriptor({ id: "k.ext", kind: "extension" })),
        (e) => e.reasonCode === "KIND_PROVENANCE_MISMATCH");
    assert.throws(
        () => core.registerCanonical(descriptor({ id: "k.dev", kind: "device" })),
        (e) => e.reasonCode === "KIND_PROVENANCE_MISMATCH");
    assert.throws(
        () => core.registerCanonical(descriptor({ id: "k.prov", kind: "provider" })),
        (e) => e.reasonCode === "KIND_PROVENANCE_MISMATCH");
});

test("adversarial: authority-shaped registrar ids reject at mint time", () => {
    const { createCapabilityRuntime } = require("../../src/capability/registry");
    // authority-shaped registrarId in the composition spec is rejected at mint time
    assert.throws(() => createCapabilityRuntime({ registrars: { extension: "authority" } }),
        (e) => e.reasonCode === "FORBIDDEN_PROVENANCE");
    assert.throws(() => createCapabilityRuntime({ registrars: { provider: "root" } }),
        (e) => e.reasonCode === "FORBIDDEN_PROVENANCE");
    assert.throws(() => createCapabilityRuntime({ registrars: { device: "owner" } }),
        (e) => e.reasonCode === "FORBIDDEN_PROVENANCE");
    assert.throws(() => createCapabilityRuntime({ registrars: { provider: "admin" } }),
        (e) => e.reasonCode === "FORBIDDEN_PROVENANCE");
});

test("adversarial: provenance identity is immutable on the registrar", () => {
    const { extension } = makeRegistry();
    const r = extension;
    assert.equal(r.provenance, "extension:testext");
    assert.ok(Object.isFrozen(r));
    assert.throws(() => { r.provenance = "core/runtime"; });
    assert.equal(r.provenance, "extension:testext");
});

test("adversarial: cannot reserve a legitimate capability under forged provenance", () => {
    const { registry, core, provider } = makeRegistry();
    core.registerCanonical(descriptor({ id: "shared.id", kind: "tool" }));
    assert.throws(
        () => provider.registerCanonical(descriptor({ id: "shared.id", kind: "tool" })),
        (e) => e.reasonCode === "DUPLICATE_CONFLICT");
    assert.equal(registry.get("shared.id").provenance, "core/runtime");
});

test("adversarial: untrusted registrar boundary rejects plain objects", () => {
    const { core, registry } = makeRegistry();
    assert.throws(
        () => core.register(descriptor()),
        (e) => e.reasonCode === "OBJECT_INPUT_NOT_ALLOWED");
    const res = core.register(JSON.stringify(descriptor({ id: "serialized.one" })));
    assert.equal(res.registered, true);
    assert.equal(registry.get("serialized.one").provenance, "core/runtime");
});
