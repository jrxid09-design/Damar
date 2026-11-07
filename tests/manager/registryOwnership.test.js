"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const AIToolRegistry = require("../../src/ai/tools/AIToolRegistry");
const AIBuilder = require("../../src/ai/builder/AIBuilder");
const AIRuntime = require("../../src/ai/runtime/AIRuntime");

test("registry snapshots refresh atomically without exposing handlers", () => {
    const registry = new AIToolRegistry();
    registry.register({ name: "tool-A", description: "A", execute() {} });
    const runtime = new AIRuntime({}, { timeout: 1000 });
    runtime.setToolRegistry(registry);
    assert.equal(typeof runtime.getToolRegistry, "undefined");
    assert.equal(runtime.listTools()[0].name, "tool-A");
    assert.equal(Object.prototype.hasOwnProperty.call(runtime.listTools()[0], "execute"), false);

    const refreshed = new AIToolRegistry();
    refreshed.register({ name: "tool-B", description: "B", execute() {} });
    runtime.setToolRegistry(refreshed);
    assert.deepEqual(runtime.listTools().map(t => t.name), ["tool-B"]);
    assert.equal(runtime.executor.toolRegistry, undefined);
});

test("registry wrappers are not canonical production registry references", () => {
    const registry = new AIToolRegistry();
    const wrapper = { get: registry.get.bind(registry) };
    assert.notEqual(wrapper, registry);
    assert.equal(Object.create(registry) === registry, false);
});

test("owner snapshot validates complete records and publishes atomically", () => {
    const owned = AIToolRegistry.createOwnedAIToolRegistry();
    const valid = { name: "tool-A", description: "A", parameters: {}, execute() {} };
    owned.owner.replaceSnapshot([valid]);
    assert.equal(owned.registry.get("tool-A").name, "tool-A");
    assert.throws(() => owned.owner.replaceSnapshot([valid, { name: "tool-B" }]), /invalid tool contract/);
    assert.deepEqual(owned.registry.all().map(t => t.name), ["tool-A"]);
    valid.execute = () => "changed";
    assert.equal(Object.isFrozen(owned.registry.get("tool-A")), true);
});

test("builder-created runtime has no public canonical registry mutator", () => {
    const owned = AIToolRegistry.createOwnedAIToolRegistry();
    const runtime = new AIRuntime({}, { timeout: 1000, toolRegistry: owned.registry });
    assert.equal(typeof runtime.setToolRegistry, "undefined");
    assert.throws(() => AIRuntime.prototype.setToolRegistry.call(runtime, owned.registry), /owner-controlled/);
});

test("compatibility replacement rejects invalid batch without partial mutation", () => {
    const runtime = new AIRuntime({}, { timeout: 1000 });
    const a = { name: "A", execute() {} };
    const b = { name: "B", execute() {} };
    runtime.setToolRegistry({ all: () => [a] });
    assert.throws(() => runtime.setToolRegistry({ all: () => [b, { name: "C" }] }), /invalid tool contract/);
    assert.deepEqual(runtime.listTools().map(t => t.name), ["A"]);
});

test("compatibility replacements are repeatable atomic transitions", () => {
    const runtime = new AIRuntime({}, { timeout: 1000 });
    const tool = name => ({ name, execute() {} });
    for (const names of [["A"], ["B"], ["C", "D"], ["A", "D"]]) {
        runtime.setToolRegistry({ all: () => names.map(tool) });
        assert.deepEqual(runtime.listTools().map(t => t.name), names);
    }
});

test("owner publication rejects Proxies and accessors before publication", () => {
    const owned = AIToolRegistry.createOwnedAIToolRegistry();
    const good = { name: "A", execute() {} };
    owned.owner.replaceSnapshot([good]);
    let getter = 0;
    const accessor = {};
    Object.defineProperty(accessor, "name", { get() { getter++; return "B"; } });
    Object.defineProperty(accessor, "execute", { value() {} });
    assert.throws(() => owned.owner.replaceSnapshot([accessor]), /invalid tool contract|invalid tool accessor/);
    assert.equal(getter, 0);
    assert.throws(() => owned.owner.replaceSnapshot([new Proxy(good, { get() { throw new Error("trap"); } })]), /invalid tool/);
    assert.deepEqual(owned.registry.all().map(t => t.name), ["A"]);
});

test("published records detach source collection and handler mutation", () => {
    const owned = AIToolRegistry.createOwnedAIToolRegistry();
    let v1 = 0;
    let v2 = 0;
    const tool = { name: "A", execute() { v1++; } };
    const source = [tool];
    owned.owner.replaceSnapshot(source);
    source.push({ name: "B", execute() {} });
    tool.execute = () => { v2++; };
    const published = owned.registry.get("A");
    assert.equal(Object.isFrozen(published), true);
    assert.notEqual(published.execute, tool.execute);
    assert.equal(owned.registry.has("B"), false);
    published.execute();
    assert.equal(v1, 1);
    assert.equal(v2, 0);
});

test("canonical runtime rejects compatibility mutation even through prototype", () => {
    const owned = AIToolRegistry.createOwnedAIToolRegistry();
    const runtime = new AIRuntime({}, { timeout: 1000, toolRegistry: owned.registry });
    assert.equal(runtime.setToolRegistry, undefined);
    assert.throws(() => AIRuntime.prototype.setToolRegistry.call(runtime, { all: () => [] }), /owner-controlled/);
});

test("metadata inspection never exposes executable handlers", () => {
    const owned = AIToolRegistry.createOwnedAIToolRegistry();
    owned.owner.replaceSnapshot([{ name: "A", description: "safe", execute() {} }]);
    const runtime = new AIRuntime({}, { timeout: 1000, toolRegistry: owned.registry });
    const metadata = runtime.listTools();
    assert.equal(Object.prototype.hasOwnProperty.call(metadata[0], "execute"), false);
    assert.equal(Object.keys(runtime).includes("registryOwner"), false);
});

test("builder stages and atomically publishes the canonical initial snapshot", () => {
    const build = () => new AIBuilder().provider("openai", { apiKey: "test", baseUrl: "http://127.0.0.1" });
    const valid = name => ({ name, description: name, parameters: {}, execute() {} });
    const b = build();
    const source = valid("A");
    b.registerTool(source);
    b.registerTools([valid("B")]);
    const engine = b.build();
    assert.deepEqual(engine.runtime.listTools().map(t => t.name), ["A", "B"]);
    source.name = "mutated";
    source.execute = () => "new";
    assert.deepEqual(engine.runtime.listTools().map(t => t.name), ["A", "B"]);
    for (const bad of [
        { name: "missing" },
        { name: "noncallable", execute: 1 },
        { name: "", execute() {} },
        Object.create({ name: "inherited", execute() {} }),
        (() => { const x = { execute() {} }; Object.defineProperty(x, "name", { get() { throw new Error("getter"); } }); return x; })(),
        (() => { const x = { name: "accessor" }; Object.defineProperty(x, "execute", { get() { throw new Error("getter"); } }); return x; })(),
        new Proxy(valid("proxy"), { get() { throw new Error("trap"); } })
    ]) {
        const invalid = build();
        invalid.registerTool(bad);
        assert.throws(() => invalid.build());
    }
    const atomic = build();
    atomic.registerTools([valid("A"), { name: "bad" }, valid("C")]);
    assert.throws(() => atomic.build());
});
