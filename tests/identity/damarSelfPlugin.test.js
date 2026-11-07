"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

test("production damar-self plugin uses the canonical DamarSelf store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "damar-self-plugin-"));
    const canonicalDir = path.join(root, "DamarSelf");
    const legacyState = path.join(root, "DAMAR_STATE.json");
    const legacySelf = path.join(root, "DAMAR_SELF.md");
    const oldEnv = {
        DAMARSELF_DIR: process.env.DAMARSELF_DIR,
        DAMAR_USER_PLUGINS: process.env.DAMAR_USER_PLUGINS
    };

    try {
        process.env.DAMARSELF_DIR = canonicalDir;
        process.env.DAMAR_USER_PLUGINS = path.join(ROOT, "userPlugins");

        const pluginLoader = require("../../src/plugins/pluginLoader");
        const { ToolRegistry } = require("../../src/core/tools");
        pluginLoader.load(path.join(ROOT, "src", "plugins"));

        const descriptor = ToolRegistry.describe().find(d => d.pluginId === "damar-self");
        assert.ok(descriptor, "normal production loader must load damar-self");

        const canonical = require("../../src/services/damarSelfService")
            .createDamarSelfService({ canonicalDir });
        canonical.writeRuntimeState({ canonical: true });
        fs.writeFileSync(path.join(canonicalDir, "identity.md"), "# Damar\n");

        const first = await ToolRegistry.execute(descriptor.id, { action: "state" });
        assert.equal(first.ok, true);
        const stateFile = path.join(canonicalDir, "self-model", "runtime-state.json");
        assert.equal(fs.existsSync(stateFile), true);
        assert.equal(fs.existsSync(path.join(canonicalDir, "identity.md")), true);
        assert.equal(fs.existsSync(legacyState), false);
        assert.equal(fs.existsSync(legacySelf), false);

        fs.writeFileSync(legacyState, JSON.stringify({ legacy: true }));
        fs.writeFileSync(legacySelf, "legacy root self\n");
        assert.equal(fs.existsSync(legacyState), true);
        assert.equal(fs.existsSync(legacySelf), true);

        const second = await ToolRegistry.execute(descriptor.id, { action: "update" });
        assert.equal(second.ok, true);
        assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).canonical, true,
            "repeated plugin reads must retain canonical state");

        assert.equal(canonical.readRuntimeState().legacy, undefined,
            "canonical state must win over legacy root state");
        assert.equal(fs.existsSync(path.join(root, "AETHER_STATE.json")), false);
    }
    finally {
        if (oldEnv.DAMARSELF_DIR === undefined) delete process.env.DAMARSELF_DIR;
        else process.env.DAMARSELF_DIR = oldEnv.DAMARSELF_DIR;
        if (oldEnv.DAMAR_USER_PLUGINS === undefined) delete process.env.DAMAR_USER_PLUGINS;
        else process.env.DAMAR_USER_PLUGINS = oldEnv.DAMAR_USER_PLUGINS;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
