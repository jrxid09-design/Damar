"use strict";

const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { assert } = require("./helpers");

const SRC_DIR = path.join(__dirname, "..", "..", "src", "runtime", "resourceGovernor");

function listSources(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listSources(p));
        else if (entry.name.endsWith(".js")) out.push(p);
    }
    return out;
}

function stripComments(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function readAll() {
    return listSources(SRC_DIR).map(f => ({
        file: path.relative(SRC_DIR, f),
        code: stripComments(fs.readFileSync(f, "utf8"))
    }));
}

test("structural guard: zero authority — no grants, no privileged roles, no ToolBus execution", () => {
    const forbidden = [
        [/CapabilityGrant/, "CapabilityGrant construction"],
        [/granted\s*:\s*true/, "authority.granted=true literal"],
        [/granted\s*=\s*true/, "authority.granted=true assignment"],
        [/\brole\s*[:=]\s*["'`](system|superadmin|admin)["'`]/i, "privileged role fabrication"],
        [/require\([^)]*(ToolBus|Authorization)[^)]*\)/, "authority module import"],
        [/toolBus\.(execute|run|invoke)/, "ToolBus execution"],
        [/executeTool\s*\(/, "direct tool execution"]
    ];
    for (const { file, code } of readAll()) {
        for (const [re, label] of forbidden) {
            assert.equal(re.test(code), false,
                `${file} must not contain ${label}`);
        }
    }
});

test("structural guard: zero actuation — no process kill, no child_process, no device/fs control", () => {
    const forbidden = [
        [/require\(\s*["'`]child_process["'`]\s*\)/, "child_process import"],
        [/process\.kill\b/, "process.kill"],
        [/\.kill\s*\(/, "kill invocation"],
        [/\bexecSync\b|\bspawnSync\b|\bfork\s*\(/, "subprocess actuation"],
        [/robotjs|nut-js|robot_js/, "keyboard/mouse control"],
        [/fs\.(writeFile|appendFile|mkdir|rmdir|unlink|rm)\b/, "filesystem mutation"],
        [/\bwriteFileSync\b/, "filesystem mutation"],
        [/require\(\s*["'`]node:fs["'`]\s*\)/, "fs import (observation-only substrate)"],
        [/home.assistant|homeAssistant|hass\.services/i, "Home Assistant action"],
        [/\badb\s*\.\s*(shell|push|install)/i, "Android control"],
        [/AbortController/, "foreign abort control"],
        [/new\s+Worker\s*\(/, "worker thread spawning"]
    ];
    for (const { file, code } of readAll()) {
        for (const [re, label] of forbidden) {
            assert.equal(re.test(code), false,
                `${file} must not contain ${label} — V0 is observation/admission only`);
        }
    }
});

test("structural guard: every source file imports only node built-ins and sibling modules", () => {
    const allowedBuiltins = new Set(["node:os", "node:perf_hooks", "node:v8"]);
    for (const { file, code } of readAll()) {
        const requires = [...code.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map(m => m[1]);
        for (const req of requires) {
            const isBuiltin = allowedBuiltins.has(req);
            const isRelative = req.startsWith("./") || req.startsWith("../");
            assert.ok(isBuiltin || isRelative,
                `${file} imports "${req}" — governor must stay isolated (builtins + siblings only)`);
        }
    }
});
