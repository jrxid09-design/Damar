"use strict";

/**
 * CAPABILITY REGISTRY V1 — structural security audit.
 *
 * Proves structurally that the registry imports no shell/process execution,
 * filesystem mutation, network, device actuation, browser actuation, or
 * Authority mutation APIs. Pure data/crypto/utils are acceptable.
 *
 * Also proves the public surface exposes no execution verbs and no authority
 * verbs.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("structural: registry source imports no executors, authority mutators, fs/network/actuation", () => {
    const dir = path.join(__dirname, "../../src/capability/registry");
    const files = [];
    (function walk(d) {
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (p.endsWith(".js")) files.push(p);
        }
    })(dir);

    const FORBIDDEN = [
        /require\(\s*["'][^"']*authority/i,
        /require\(\s*["'][^"']*resourceGovernor/i,
        /require\(\s*["'][^"']*governor/i,
        /require\(\s*["'][^"']*ToolBus/i,
        /require\(\s*["'][^"']*plugins\//i,
        /child_process/,
        /node:child_process/,
        /node:net\b/,
        /node:http/,
        /node:https/,
        /node:dns/,
        /node:fetch/,
        /axios|undici|node-pty/,
        /\beval\s*\(/,
        /new\s+Function\s*\(/,
        /execSync|spawnSync|execFile|spawn\s*\(/,
        /node:fs\b/,
        /require\(\s*["']fs["']\s*\)/,
        /writeFile|readFile|appendFile|mkdir|rmdir|unlink|chmod|chown/
    ];
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        for (const rx of FORBIDDEN) {
            assert.ok(!rx.test(text), `${path.relative(process.cwd(), file)} matches forbidden pattern ${rx}`);
        }
    }

    // only intra-domain requires plus node:crypto (if any) are permitted
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        for (const m of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
            const target = m[1];
            const ok = target.startsWith("./") || target === "node:crypto";
            assert.ok(ok, `${file}: unexpected external require '${target}'`);
        }
    }
});

test("surface: no execution verbs in public API", () => {
    const api = require("../../src/capability/registry");
    const registry = new api.CapabilityRegistry();
    const names = Object.getOwnPropertyNames(api.CapabilityRegistry.prototype);
    const EXECUTION_VERBS = /execute|invoke|run\b|dispatch|actuate|spawn|shell|callTool|performAction/i;
    for (const m of names) {
        assert.ok(!EXECUTION_VERBS.test(m), `registry must not expose execution verb: ${m}`);
    }
    // also assert the specific forbidden names are absent
    for (const v of ["execute", "invoke", "run", "dispatch", "actuate", "spawn", "shell", "callTool", "performAction"]) {
        assert.equal(typeof registry[v], "undefined", `no method '${v}'`);
    }
});

test("surface: no authority verbs in public API", () => {
    const api = require("../../src/capability/registry");
    const registry = new api.CapabilityRegistry();
    const names = Object.getOwnPropertyNames(api.CapabilityRegistry.prototype);
    const AUTHORITY_VERBS = /grant|authorize|approve|ratify|delegate|elevate|trustAsAuthority|mint|issue|permit/i;
    for (const m of names) {
        assert.ok(!AUTHORITY_VERBS.test(m), `registry must not expose authority verb: ${m}`);
    }
    for (const v of ["grant", "authorize", "approve", "ratify", "delegate", "elevate", "trustAsAuthority"]) {
        assert.equal(typeof registry[v], "undefined", `no method '${v}'`);
    }
});

test("surface: descriptors cannot express authority decision fields", () => {
    const api = require("../../src/capability/registry");
    // The descriptor schema is closed; authority-shaped fields are unknown,
    // and `provenance` is NOT a descriptor field (it originates from the
    // registrar). A descriptor literally named shell.execute is inert.
    const descriptor = api.parseCapabilityDescriptor({
        schemaVersion: 1,
        id: "shell.execute",
        kind: "tool",
        provider: "core",
        source: "core/runtime",
        operations: ["execute"]
    });
    assert.equal(descriptor.id, "shell.execute");
    assert.equal(typeof descriptor.authorized, "undefined");
    assert.equal(typeof descriptor.owner, "undefined");
    assert.equal(typeof descriptor.approved, "undefined");
    assert.equal(typeof descriptor.provenance, "undefined");
});

test("surface: descriptor must not define authoritative provenance", () => {
    const api = require("../../src/capability/registry");
    assert.throws(
        () => api.parseCapabilityDescriptor({
            schemaVersion: 1,
            id: "shell.execute",
            kind: "tool",
            provider: "core",
            operations: ["execute"],
            provenance: "core/runtime"
        }),
        (e) => e.reasonCode === "FORBIDDEN_PROVENANCE");
});
