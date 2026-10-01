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

