"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * STRUCTURAL AUDIT — prove by source inspection that the Vault core
 * contains NO edges it must never have:
 *   Vault -> Authority mutator
 *   Vault -> Tool execution
 *   Vault -> actuator
 *   Vault -> network access
 *   Vault -> Console/Electron dependency
 *   Vault -> arbitrary shell/process spawn
 *   custom crypto primitives (beyond sha256 digests for integrity)
 */

const VAULT_DIR = path.join(__dirname, "..", "..", "src", "runtime", "vault");

const FORBIDDEN_PATTERNS = [
    { re: /require\(\s*["'][^"']*authority/g, why: "Vault must not depend on Authority" },
    { re: /require\(\s*["'](\.\.\/)+\/(authority|tools|tools_old|plugins|integrations)/g, why: "no tool/actuator/plugin edges" },
    { re: /require\(\s*["'](http|https|net|dgram|tls|dns|undici|axios|node-fetch)["']/g, why: "no network access" },
    { re: /require\(\s*["'](child_process|node:child_process|node-pty|spawn|exec)["']/g, why: "no shell/process spawn" },
    { re: /require\(\s*["'][^"']*electron[^"']*["']/g, why: "no Electron dependency" },
    { re: /require\(\s*["'][^"']*console(?!ut)[^"']*["']/g, why: "no Console app dependency" },
    { re: /\b(console\.log|console\.error|console\.warn|console\.info)\b/g, why: "no direct console output from vault" },
    { re: /createCipheriv|createDecipheriv|publicEncrypt|privateDecrypt|generateKeyPair|scrypt|pbkdf2|hkdf/g, why: "no invented cryptography" },
    { re: /process\.env\b/g, why: "vault reads no environment variables directly" },
    { re: /process\.exit\b/g, why: "vault never exits the process" },
    { re: /fetch\s*\(|XMLHttpRequest|WebSocket/g, why: "no network calls" },
    { re: /eval\s*\(|new Function\s*\(/g, why: "no dynamic code execution" },
    { re: /getAllSecrets|revealAll|dumpValues/g, why: "no bulk raw-value getters" }
];

function vaultSources() {
    const out = [];
    for (const name of fs.readdirSync(VAULT_DIR)) {
        if (name.endsWith(".js")) {
            out.push({
                name,
                text: fs.readFileSync(path.join(VAULT_DIR, name), "utf8")
            });
        }
    }
    return out;
}

test("structural audit: vault sources contain no forbidden edges", () => {
    const violations = [];
    for (const file of vaultSources()) {
        for (const { re, why } of FORBIDDEN_PATTERNS) {
            const m = file.text.match(new RegExp(re.source, "g"));
            if (m) {
                violations.push(`${file.name}: ${why} -> ${m.join(", ")}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test("structural audit: vault imports only node builtins + its own modules", () => {
    const allowed = new Set([
        "node:crypto", // digests + random id entropy ONLY (see usage audit below)
        "node:util",   // inspect symbol for redacted rendering
        "node:fs",     // file store atomic persistence
        "node:path",   // file store paths
        "./errors", "./ids", "./scope", "./ref", "./value", "./digest",
        "./metadata", "./record", "./bounds", "./cipher", "./store",
        "./redact", "./diagnostics", "./vault"
    ]);
    const violations = [];
    for (const file of vaultSources()) {
        const requires = [...file.text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
        for (const req of requires) {
            if (!allowed.has(req)) {
                violations.push(`${file.name} requires ${req}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test("structural audit: node:crypto used for digests/entropy only", () => {
    for (const file of vaultSources()) {
        if (!file.text.includes("node:crypto")) continue;
        const uses = [...file.text.matchAll(/crypto\.[a-zA-Z]+/g)].map((m) => m[0]);
        for (const u of uses) {
            assert.ok(
                ["crypto.createHash", "crypto.randomBytes"].includes(u),
                `${file.name}: unexpected crypto use ${u}`
            );
        }
    }
});

test("structural audit: public surface exposes no bulk value accessor", () => {
    const mod = require("../../src/runtime/vault");
    const facadeKeys = Object.keys(mod);
    for (const key of facadeKeys) {
        assert.ok(!/revealall|dumpvalues|getallsecrets/i.test(key));
    }
});
