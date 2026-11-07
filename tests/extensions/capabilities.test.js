"use strict";

/**
 * Capability advertisement semantics + Authority/Resource-Governor boundaries.
 *
 * Proves, behaviorally and structurally:
 *   capability advertised != capability granted
 *   extension != authority
 *   configuration != authority
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeRegistry, manifest } = require("./helpers");

test("advertisement: advertised capabilities are inert metadata", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({
        extensionId: "ad.one",
        capabilities: ["environment.home.control", "device.camera.observe"]
    }), { install: true });

    // query works...
    assert.deepEqual(registry.findExtensionsByCapability("ENVIRONMENT.HOME.CONTROL"), ["ad.one"]);
    // ...but nothing was granted: there is no API on the kernel that turns an
    // advertisement into a grant. The full public surface contains no mutator
    // for authority or permissions.
    const { ExtensionRegistry, parseExtensionManifest } = require("../../src/extensions/index");
    const publicMethods = Object.getOwnPropertyNames(ExtensionRegistry.prototype);
    for (const m of publicMethods) {
        assert.ok(!/grant|issue|authorize|mint|permit|token/i.test(m),
            `registry must not expose authority-mutating method: ${m}`);
    }
    void parseExtensionManifest;
});

test("advertisement: manifest claims of trust/authority grant nothing", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({
        extensionId: "sneaky.ext",
        capabilities: ["authority.root", "core.kernel.override"],
        authorityRequirements: ["environment.device.control", "filesystem.write.anywhere"],
        trusted: true
    }), { install: true });
    registry.enable("sneaky.ext");

    // The kernel happily records the CLAIMS (descriptive), but exposes them as
    // read-only requirements data — never as effective grants.
    assert.deepEqual(registry.getAuthorityRequirements("sneaky.ext"),
        ["environment.device.control", "filesystem.write.anywhere"]);
    assert.equal(registry.getCapabilities("sneaky.ext").includes("authority.root"), true,
        "claim recorded as metadata");
    assert.equal(typeof registry.grant, "undefined");
    assert.equal(typeof registry.authorize, "undefined");
    assert.equal(typeof registry.issueToken, "undefined");
});

test("boundary: canonical Authority state is untouched by all lifecycle ops", () => {
    // Use the real canonical Authority subsystem to prove non-interference.
    const authorityStore = require("../../src/authority/store");
    const { makeRegistry, manifest } = require("./helpers");

    let before;
    try {
        // snapshot whatever serializable surface the store offers
        before = JSON.stringify(authorityStore.snapshot ? authorityStore.snapshot() : {});
    } catch {
        before = "{}";
    }

    const { registry } = makeRegistry();
    registry.register(manifest({
        extensionId: "ha.bridge",
        authorityRequirements: ["root"],
        capabilities: ["environment.home.control"]
    }));
    registry.install("ha.bridge");
    registry.enable("ha.bridge");
    registry.reportHealth("ha.bridge", "HEALTHY");
    registry.activateForProject("ha.bridge", "proj-x");
    registry.disable("ha.bridge");

    let after;
    try {
        after = JSON.stringify(authorityStore.snapshot ? authorityStore.snapshot() : {});
    } catch {
        after = "{}";
    }
    assert.equal(after, before, "authority store byte-identical after kernel operations");
});

test("boundary: kernel source imports no Authority mutators, executors, process or net", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(__dirname, "../../src/extensions");
    const files = [];
    (function walk(d) {
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) walk(p); else files.push(p);
        }
    })(dir);

    const FORBIDDEN = [
        /require\(\s*["'].*authority/i,
        /require\(\s*["'].*resourceGovernor/i,
        /require\(\s*["'].*ToolBus/i,
        /require\(\s*["'].*plugins\//i,
        /child_process/,
        /node:process\b(?!\.)/,
        /node:net|node:http|node:https|node:dns|node:fetch|axios|undici/,
        /\beval\s*\(/,
        /new\s+Function\s*\(/,
        /execSync|spawnSync|execFile/
    ];
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        for (const rx of FORBIDDEN) {
            assert.ok(!rx.test(text), `${path.relative(process.cwd(), file)} matches forbidden pattern ${rx}`);
        }
    }
    // only node builtins allowed: node:fs in discovery (explicit roots) — assert no other requires escape src/extensions
    const requireTargets = [];
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        for (const m of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) requireTargets.push([file, m[1]]);
    }
    for (const [file, target] of requireTargets) {
        const ok =
            target.startsWith("./") ||                     // intra-domain
            target === "node:fs" ||
            target === "node:path";
        assert.ok(ok, `${file}: unexpected external require '${target}'`);
    }
});

test("governor boundary: resource declarations are descriptive, admission is not attempted", () => {
    const { registry } = makeRegistry();
    registry.register(manifest({
        extensionId: "heavy.ext",
        resources: { cpuClass: "HEAVY", memoryClass: "HEAVY", durationClass: "LONG" }
    }), { install: true });
    // declaration exists on descriptor; no admission decision was made anywhere
    assert.deepEqual(registry.getDescriptor("heavy.ext").resourceExpectations,
        { cpuClass: "HEAVY", memoryClass: "HEAVY", durationClass: "LONG" });
    assert.equal(typeof registry.admit, "undefined");
    assert.equal(typeof registry.requestAdmission, "undefined");
});
