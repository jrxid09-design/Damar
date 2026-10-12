"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("PluginManager old direct actuator path is unreachable", async () => {
    const pluginManager = require("../../src/plugins/pluginManager");
    await assert.rejects(
        () => pluginManager.execute("repair-canary", {}, {}),
        /PLUGIN_DIRECT_EXECUTION_DISABLED/
    );
});

test("ToolRegistry ToolGuard cannot independently authorize consequential execution", async () => {
    const { ToolRegistry } = require("../../src/core/tools");
    const id = `repair.consequential.${Date.now()}`;
    let invoked = false;
    ToolRegistry.register("repair", {
        name: id,
        sideEffects: true,
        execute: async () => { invoked = true; return { ok: true }; }
    });

    await assert.rejects(
        () => ToolRegistry.execute(`repair.${id}`, {}),
        /CANONICAL_AUTHORITY_REQUIRED/
    );
    assert.equal(invoked, false);
});

test("read-only ToolRegistry flows retain defense-in-depth without actuation semantics", async () => {
    const { ToolRegistry } = require("../../src/core/tools");
    const id = `repair.readonly.${Date.now()}`;
    ToolRegistry.register("repair", {
        name: id,
        readOnly: true,
        execute: async () => ({ value: 1 })
    });

    const result = await ToolRegistry.execute(`repair.${id}`, {});
    assert.equal(result.value, 1);
    assert.equal(result.verification.state, "skipped");
});

test("PlanExecutor submits plan material to canonical action client", async () => {
    const source = require("node:fs").readFileSync(
        require("node:path").join(__dirname, "../../src/agent/executor/planExecutor.js"),
        "utf8"
    );
    assert.match(source, /executeCanonicalAction/);
    assert.doesNotMatch(source, /pluginManager\.execute/);
});

test("PlanExecutor denied canonical action cannot produce a successful observation", async () => {
    const PlanExecutor = require("../../src/agent/executor/planExecutor");
    const executor = new PlanExecutor();
    const result = await executor.execute({
        steps: [{ tool: "unregistered.repair", arguments: {} }]
    }, {});
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].success, false);
});
