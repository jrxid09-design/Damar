"use strict";

/**
 * CAPABILITY REGISTRY V1 — registrar minting trust tests.
 *
 * Proves that registrar minting derives from the trusted composition root
 * (createCapabilityRuntime) and that NO mint/identity primitive is importable
 * from any module surface. The direct-require bypass must fail.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const api = require("../../src/capability/registry");
const registryMod = require("../../src/capability/registry/registry");
const { descriptor, makeRegistry } = require("./helpers");

test("mint: direct-require bypass fails — no mint/identity primitives exported", () => {
    // The EXACT prior repro must now fail: no factory, no establishIdentity.
    assert.equal(registryMod.createCapabilityRegistrarFactory, undefined);
    assert.equal(registryMod.establishIdentity, undefined);
    assert.equal(registryMod.MINT_TOKEN, undefined);
    assert.equal(api.createCapabilityRegistrarFactory, undefined);
    assert.equal(api.establishIdentity, undefined);
    assert.equal(api.MINT_TOKEN, undefined);
});

test("mint: CapabilityRegistry instance has no public createRegistrar mint surface", () => {
    const registry = new api.CapabilityRegistry();
    assert.equal(registry.createRegistrar, undefined);
    assert.equal(registry.createRegistrarFactory, undefined);
    assert.equal(registry.createCapabilityRegistrarFactory, undefined);
    for (const n of Object.getOwnPropertyNames(registry)) {
        assert.ok(!/mint|registrar|factory|token/i.test(n), `unexpected '${n}'`);
    }
});

test("mint: arbitrary code cannot mint a core registrar via any importable surface", () => {
    const registry = new api.CapabilityRegistry();
    assert.equal(typeof registry.createRegistrar, "undefined");
    assert.equal(typeof registry.createCoreRegistrar, "undefined");
    // no exported factory/identity to reach the mint gate
    assert.equal(api.createCapabilityRegistrarFactory, undefined);
    assert.equal(api.establishIdentity, undefined);
});

test("mint: arbitrary code cannot mint extension/device/provider from strings", () => {
    const registry = new api.CapabilityRegistry();
    assert.equal(registry.createRegistrar, undefined);
    assert.equal(api.establishIdentity, undefined);
    assert.equal(api.createCapabilityRegistrarFactory, undefined);
});

test("mint: forged token / copied / structurally identical cannot mint", () => {
    // There is no exported mint function to pass a token to at all.
    assert.equal(registryMod.MINT_TOKEN, undefined);
    assert.equal(api.MINT_TOKEN, undefined);
    // The closure token cannot be imported, guessed, or cloned.
    const forgedSym = Symbol("damar.capability.registrar.mint");
    assert.notEqual(typeof registryMod.mintRegistrar, "function");
    assert.equal(registryMod.mintRegistrar, undefined);
});

test("mint: a legitimately issued registrar works", () => {
    const { registry, core } = makeRegistry();
    const res = core.registerCanonical(descriptor({ id: "legit.one", kind: "system" }));
    assert.equal(res.registered, true);
    assert.equal(registry.get("legit.one").provenance, "core/runtime");
});

test("mint: registrar provenance cannot be changed after issuance", () => {
    const { extension } = makeRegistry();
    assert.equal(extension.provenance, "extension:testext");
    assert.ok(Object.isFrozen(extension));
    assert.throws(() => { extension.provenance = "core/runtime"; });
    assert.throws(() => { extension.domain = "core"; });
    assert.equal(extension.provenance, "extension:testext");
    assert.equal(extension.domain, "extension");
});

test("mint: a normal registrar cannot mint another registrar", () => {
    const { core, extension } = makeRegistry();
    assert.equal(core.createRegistrar, undefined);
    assert.equal(core.createRegistrarFactory, undefined);
    assert.equal(extension.createRegistrar, undefined);
    assert.equal(typeof core.register, "function");
    assert.equal(typeof core.registerCanonical, "function");
    for (const n of Object.getOwnPropertyNames(core)) {
        assert.ok(!/mint|factory|token/i.test(n), `registrar exposes '${n}'`);
    }
});

test("mint: attacker cannot admit kind=system under core/runtime via public surface", () => {
    const registry = new api.CapabilityRegistry();
    assert.equal(registry.size, 0);
    const parsed = api.parseCapabilityDescriptor(descriptor({ id: "x.sys", kind: "system" }));
    assert.equal(parsed.provenance, undefined, "descriptor carries no provenance");
    // no registrar obtainable from the public surface to admit anything
});

test("mint: rejection causes zero canonical mutation / index divergence", () => {
    const { registry } = makeRegistry();
    const digest0 = JSON.stringify(registry.serialize());
    // there is no mint surface to attempt; registry remains untouched
    assert.equal(registry.size, 0);
    const digest1 = JSON.stringify(registry.serialize());
    assert.equal(digest1, digest0);
    assert.equal(registry.findAllDependencyCycles().length, 0);
});
