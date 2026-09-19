"use strict";

/**
 * Regression tests for the WAVE8 DETERMINISTIC LEGACY CENSUS
 * (scripts/wave8-census.js) — the canonical counter oracle.
 *
 * The census is what makes LEGACY_SECOND_PATH = 0,
 * ACTION_CAPABLE_UNGOVERNED = 0 and UNCLASSIFIED_LEGACY_REACHABILITY = 0
 * reproducible claims instead of LLM-derived numbers, so the oracle itself
 * needs adversarial coverage: each case below is a detection form the owner
 * requires, plus a false-positive guard and a determinism guard.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const census = require("../../../scripts/wave8-census.js");

const SCRIPT = path.join(__dirname, "..", "..", "..", "scripts", "wave8-census.js");

const REGISTRY = "module.exports = { execute(id) { return id; } };\n";
const PLUGIN_MGR = "module.exports = { execute(name) { return name; } };\n";

/** Build a throwaway module tree and return its root. */
function fixture(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "w8-census-"));
    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
    }
    return root;
}

function run(files, options = {}) {
    const root = fixture(files);
    try {
        return census.analyze({ root, entrypoints: ["src/server.js"], ...options });
    }
    finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const kinds = (report) => report.findings.map(f => f.kind);

test("census: a known safe canonical path yields zero ungoverned routes", () => {
    const report = run({
        "src/server.js": 'require("./action/bootstrap.js");\n',
        "src/action/bootstrap.js": 'require("./dispatcher.js");\n',
        "src/action/dispatcher.js": 'const R = require("./ToolRegistry.js");\nR.execute("probe");\n',
        "src/action/ToolRegistry.js": REGISTRY
    });
    assert.equal(report.counters.LEGACY_SECOND_PATH, 0);
    assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 0);
    assert.equal(report.counters.UNCLASSIFIED_LEGACY_REACHABILITY, 0);
    assert.ok(report.counters.GOVERNED_SINK_SITES >= 1, "the sink is still SEEN, just governed");
    assert.equal(report.ok, true);
});

test("census: a synthetic ungoverned path is detected with its full path", () => {
    const report = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'const R = require("./ToolRegistry.js");\nR.execute("probe");\n',
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 1);
    assert.equal(report.counters.LEGACY_SECOND_PATH, 1);
    assert.equal(report.ok, false);
    assert.deepEqual(kinds(report), ["registry_execution"]);
    assert.equal(report.findings[0].file, "src/legacy.js");
    assert.deepEqual(report.findings[0].path, ["src/server.js", "src/legacy.js"]);
});

test("census: alias imports are resolved (plain, destructured and renamed)", () => {
    for (const line of [
        'const R = require("./ToolRegistry.js");\nR.execute("x");\n',
        'const { execute } = require("./ToolRegistry.js");\nexecute("x");\n',
        'const { ToolRegistry: TR } = require("./ToolRegistry.js");\nTR.execute("x");\n'
    ]) {
        const report = run({ "src/server.js": 'require("./legacy.js");\n', "src/legacy.js": line, "src/ToolRegistry.js": REGISTRY });
        // The renamed/destructured binding must not be silently excused.
        assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 1,
            `expected a detection for: ${line.split("\n")[0]}`);
        assert.equal(report.ok, false);
    }
});

test("census: computed access and re-export chains cannot hide a registry sink", () => {
    // Brackets are built from char codes so this fixture cannot be mangled by
    // any editor/tool escaping layer: the oracle must see a real computed call.
    const ob = String.fromCharCode(91);
    const cb = String.fromCharCode(93);
    const computedSource = 'const R = require("./ToolRegistry.js");\n' +
        'const p = "exec" + "ute";\n' +
        'R' + ob + 'p' + cb + '("x");\n';
    const computed = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": computedSource,
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(computed.counters.ACTION_CAPABLE_UNGOVERNED, 1, "a computed call on a registry binding is a sink");

    const reexported = run({
        "src/server.js": 'require("./user.js");\n',
        "src/user.js": 'const W = require("./wrapper.js");\nW.execute("x");\n',
        "src/wrapper.js": 'module.exports = require("./ToolRegistry.js");\n',
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(reexported.counters.ACTION_CAPABLE_UNGOVERNED, 1);
    assert.deepEqual(kinds(reexported), ["registry_execution"], "the kind survives the re-export chain");
});

test("census: a wrapper function around a registry call is still a sink", () => {
    const report = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'const R = require("./ToolRegistry.js");\nfunction callIt(a) { return R.execute(a); }\nmodule.exports = { callIt };\n',
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 1);
});

test("census: prototype/member and literal plugin invocations are detected", () => {
    const member = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'exports.go = (obj) => obj.tool.execute("x");\n'
    });
    assert.deepEqual(kinds(member), ["tool_handler_invocation"]);

    const literal = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'pluginManager.execute("probe");\n'
    });
    assert.deepEqual(kinds(literal), ["plugin_handler_execution"]);
});

test("census: direct registry execution and direct plugin execution are detected", () => {
    const direct = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'ToolRegistry.execute("probe");\n'
    });
    assert.deepEqual(kinds(direct), ["registry_execution"]);

    const plugin = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'const PM = require("./pluginManager.js");\nPM.execute("probe");\n',
        "src/pluginManager.js": PLUGIN_MGR
    });
    assert.deepEqual(kinds(plugin), ["plugin_handler_execution"]);
});

test("census: terminal/process sinks are detected and classified", () => {
    const process_ = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'const cp = require("node:child_process");\ncp.execSync("whoami");\n'
    });
    assert.ok(kinds(process_).includes("process_shell"));

    const terminal = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'const pty = require("node-pty");\npty.spawn("bash", []);\nterminal_run("ls");\n'
    });
    assert.ok(kinds(terminal).includes("terminal"));
});

test("census: inert metadata, declarations and strings are NOT sinks", () => {
    const report = run({
        "src/server.js": 'require("./inert.js");\n',
        "src/inert.js": [
            "// ToolRegistry.execute(\"documented, not called\")",
            "/* another doc mention: pm.execute() */",
            'const meta = { execute: "docs", handler: "n/a", name: "probe" };',
            'const text = "R.execute(1)";',
            "function handler(a) { return a; }",
            "const obj = { handler(a) { return a; } };",
            "if (typeof meta.execute === \"function\") { meta.name.trim(); }",
            "module.exports = { meta, text, handler, obj };"
        ].join("\n")
    });
    assert.equal(report.counters.LEGACY_SECOND_PATH, 0);
    assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 0);
    assert.equal(report.ok, true);
});

test("census: output is deterministic for the same input", () => {
    const files = {
        "src/server.js": 'require("./legacy.js");\nrequire("./action/bootstrap.js");\n',
        "src/legacy.js": 'const R = require("./ToolRegistry.js");\nR.execute("a");\nR.execute("b");\n',
        "src/action/bootstrap.js": 'require("./dispatcher.js");\n',
        "src/action/dispatcher.js": 'const R = require("./ToolRegistry.js");\nR.execute("ok");\n',
        "src/ToolRegistry.js": REGISTRY
    };
    const root = fixture(files);
    try {
        const a = JSON.stringify(census.analyze({ root, entrypoints: ["src/server.js"] }));
        const b = JSON.stringify(census.analyze({ root, entrypoints: ["src/server.js"] }));
        assert.equal(a, b);
    }
    finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("census CLI: exit code is non-zero on an ungoverned route and zero when clean", () => {
    const bad = fixture({
        "src/server.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'ToolRegistry.execute("x");\n'
    });
    const good = fixture({
        "src/server.js": 'require("./action/bootstrap.js");\n',
        "src/action/bootstrap.js": 'require("./dispatcher.js");\n',
        "src/action/dispatcher.js": 'const R = require("./ToolRegistry.js");\nR.execute("x");\n',
        "src/action/ToolRegistry.js": REGISTRY
    });
    try {
        const badRun = spawnSync(process.execPath, [SCRIPT, "--root", bad, "--json"], { encoding: "utf8" });
        assert.equal(badRun.status, 1, "an ungoverned route must fail the gate");
        const parsed = JSON.parse(badRun.stdout);
        assert.equal(parsed.counters.ACTION_CAPABLE_UNGOVERNED, 1);

        const goodRun = spawnSync(process.execPath, [SCRIPT, "--root", good, "--json"], { encoding: "utf8" });
        assert.equal(goodRun.status, 0, "a clean tree must pass the gate");
        assert.equal(JSON.parse(goodRun.stdout).counters.ACTION_CAPABLE_UNGOVERNED, 0);
    }
    finally {
        fs.rmSync(bad, { recursive: true, force: true });
        fs.rmSync(good, { recursive: true, force: true });
    }
});
