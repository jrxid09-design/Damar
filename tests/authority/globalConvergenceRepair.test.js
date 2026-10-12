"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../../src");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("F1 OpenCode legacy launcher cannot spawn without canonical admission", async () => {
    const { runOpenCode } = require("../../src/services/opencodeTools");
    const result = await runOpenCode({ instruction: "write a canary", purpose: "repair" });
    assert.notEqual(result.outcome, "COMPLETED");
    assert.equal(result.effectInvoked, false);
});

test("F2 Home/MQTT controller uses canonical boundary and never direct service mutation", () => {
    const source = read("controllers/homeController.js");
    assert.match(source, /submitGovernedService/);
    assert.doesNotMatch(source, /await\s+home\.control\(/);
    assert.doesNotMatch(source, /await\s+mqtt\.control\(/);
    assert.doesNotMatch(source, /await\s+mqtt\.publish\(/);
});

test("F3/F4 background and plugin side effects use canonical boundary", () => {
    for (const file of [
        "services/automationService.js",
        "services/cryptoMonitorService.js",
        "services/cryptoBotService.js",
        "plugins/damarSkills/tools.js",
        "services/homeTools.js",
        "services/whatsappTools.js"
    ]) {
        assert.match(read(file), /governedServiceBoundary|submitGovernedService/);
    }
    assert.doesNotMatch(read("plugins/damarSkills/tools.js"), /whatsapp\.(send|broadcast|sendPhoto|sendDocument)\(/);
    assert.doesNotMatch(read("plugins/damarSkills/tools.js"), /home\.control\(/);
});

test("canonical boundary denies missing context before any service effect", async () => {
    const { submitGovernedService } = require("../../src/services/governedServiceBoundary");
    const result = await submitGovernedService({ capabilityId: "home.assistant", operation: "control", arguments: { entityId: "light.canary", action: "on" } });
    assert.equal(result.effectInvoked, false);
    assert.equal(result.outcome, "AUTHENTICATION_REQUIRED");
});

test("HTTP read path remains available while every mutation method is fail-closed", async () => {
    const { ToolRegistry } = require("../../src/core/tools");
    const { classifyEffect } = require("../../src/core/safety/effectClassification");
    for (const method of ["get", "head", "options"]) {
        assert.equal(classifyEffect(`http.${method}`).consequential, false);
    }
    for (const method of ["post", "put", "patch", "delete"]) {
        let invoked = false;
        ToolRegistry.register("http", { name: method, execute: async () => { invoked = true; } });
        await assert.rejects(() => ToolRegistry.execute(`http.${method}`, { url: "http://canary.invalid" }), /CANONICAL_AUTHORITY_REQUIRED/);
        assert.equal(invoked, false, `${method} handler must not run before canonical authority`);
    }
});

test("neutral plugin names cannot hide effects; proven reads remain usable", async () => {
    const { ToolRegistry } = require("../../src/core/tools");
    let wrote = false;
    ToolRegistry.register("user-neutral", {
        name: "helper",
        execute: async () => { wrote = true; require("node:fs").writeFileSync("ignored", "x"); }
    });
    await assert.rejects(() => ToolRegistry.execute("user-neutral.helper", {}), /CANONICAL_AUTHORITY_REQUIRED/);
    assert.equal(wrote, false);

    ToolRegistry.register("user-neutral", {
        name: "formatter",
        effectClass: "READ_LOCAL_STATE",
        execute: async () => ({ value: 1 })
    });
    const read = await ToolRegistry.execute("user-neutral.formatter", {});
    assert.equal(read.value, 1);
});

test("safe labels and skipped verification never authorize a consequential handler", async () => {
    const { ToolRegistry } = require("../../src/core/tools");
    let invoked = false;
    ToolRegistry.register("neutral", {
        name: "reader",
        risk: "safe",
        verification: "skipped",
        execute: async () => { invoked = true; return { ok: true }; }
    });
    await assert.rejects(() => ToolRegistry.execute("neutral.reader", {}), /CANONICAL_AUTHORITY_REQUIRED/);
    assert.equal(invoked, false);
});
