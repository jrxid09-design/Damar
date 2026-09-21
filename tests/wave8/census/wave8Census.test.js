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

// ---------------------------------------------------------------------------
// C0 (W8-IW1) — oracle repair. Every case below pins a SEMANTIC (how a form is
// classified), never a historical counter total.
// ---------------------------------------------------------------------------

/** A stand-in plugin loader with the real root's shape: getter data + load family. */
const PLUGIN_LOADER = [
    "class PluginLoader {",
    '    get userRoot() { return "/tmp/userPlugins"; }',
    '    load(root) { this.loadRoot(root, "builtin"); }',
    '    loadRoot(root, source) { this.loadOne(root, source); }',
    "    loadOne(pluginPath, source) { return require(pluginPath); }",
    "    unloadPlugin(id) { return id; }",
    "    isForgeGenerated(pluginPath) { return false; }",
    "}",
    "module.exports = new PluginLoader();",
    ""
].join("\n");

const ROOT = { "src/plugins/pluginLoader.js": PLUGIN_LOADER };

test("census: pluginLoader.load is a plugin-handler sink (C0 under-report)", () => {
    const report = run({
        "src/server.js": 'require("./app.js");\n',
        "src/app.js": 'const pluginLoader = require("./plugins/pluginLoader.js");\npluginLoader.load(__dirname + "/plugins");\n',
        ...ROOT
    });
    assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 1);
    assert.equal(report.counters.LEGACY_SECOND_PATH, 1);
    assert.deepEqual(kinds(report), ["plugin_handler_execution"]);
    assert.equal(report.findings[0].file, "src/app.js");
    assert.equal(report.findings[0].line, 2);
    assert.deepEqual(report.findings[0].path, ["src/server.js", "src/app.js"]);
    assert.equal(report.ok, false);
});

test("census: the whole plugin load family is detected, bound and unbound", () => {
    for (const line of [
        'const pl = require("./plugins/pluginLoader.js");\npl.loadOne(p);\n',
        'const pl = require("./plugins/pluginLoader.js");\npl.loadRoot(dir, "user");\n',
        'const { loadOne } = require("./plugins/pluginLoader.js");\nloadOne(p);\n',
        'const { load: boot } = require("./plugins/pluginLoader.js");\nboot(dir);\n',
        'require("./plugins/pluginLoader.js").loadOne(p);\n',
        "pluginLoader.load(p);\n",
        "pluginLoader.loadOne(p);\n"
    ]) {
        const report = run({
            "src/server.js": 'require("./legacy.js");\n',
            "src/legacy.js": line,
            ...ROOT
        });
        assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 1,
            `expected plugin_handler_execution for: ${line.split("\n")[1]}`);
        assert.deepEqual(kinds(report), ["plugin_handler_execution"]);
    }
});

test("census: a root's data property is a read, not a sink and not an unknown form", () => {
    const report = run({
        "src/server.js": 'require("./reader.js");\n',
        "src/reader.js": [
            'const pluginLoader = require("./plugins/pluginLoader.js");',
            'const root = pluginLoader.userRoot ?? "";',
            'const legacy = require("./plugins/pluginLoader.js").userRoot;',
            "module.exports = { root, legacy };"
        ].join("\n"),
        ...ROOT
    });
    assert.equal(report.counters.LEGACY_SECOND_PATH, 0);
    assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 0);
    assert.equal(report.counters.UNCLASSIFIED_LEGACY_REACHABILITY, 0);
    assert.equal(report.ok, true);
});

test("census: an unrecognised INVOCATION of a directly required root stays UNCLASSIFIED (C0)", () => {
    const report = run({
        "src/server.js": 'require("./mystery.js");\n',
        "src/mystery.js": 'const R = require("./ToolRegistry.js");\nexports.go = (x) => R.performUnrecognisedOperation(x);\n',
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 0);
    assert.equal(report.counters.UNCLASSIFIED_LEGACY_REACHABILITY, 1);
    assert.deepEqual(report.unclassified, ["src/mystery.js"]);
    assert.equal(report.ok, false);
});

test("census: root calls hidden in strings and comments are inert (C0)", () => {
    const report = run({
        "src/server.js": 'require("./docs.js");\n',
        "src/docs.js": [
            '// pluginLoader.load("/plugins")',
            '/* require("./plugins/pluginLoader.js").loadOne(p) */',
            'const example = "pluginLoader.load(\'/plugins\')";',
            'const inline = "require(\'./plugins/pluginLoader.js\').loadOne(p)";',
            'const docs = "call require(\'node:child_process\') to shell out";',
            "module.exports = { example, inline, docs };"
        ].join("\n"),
        ...ROOT
    });
    assert.equal(report.counters.LEGACY_SECOND_PATH, 0);
    assert.equal(report.ok, true);
});

test("census: template text is data, a template interpolation is live code (C0)", () => {
    const inert = run({
        "src/server.js": 'require("./gen.js");\n',
        "src/gen.js": 'const src = `module.exports = { execute() {} };\npluginLoader.load("/x");`;\nmodule.exports = src;\n',
        ...ROOT
    });
    assert.equal(inert.counters.LEGACY_SECOND_PATH, 0, "template TEXT must not be executed");

    const live = run({
        "src/server.js": 'require("./live.js");\n',
        "src/live.js": 'const pl = require("./plugins/pluginLoader.js");\nconst out = `loading ${pl.load("/plugins")}`;\nmodule.exports = out;\n',
        ...ROOT
    });
    assert.equal(live.counters.ACTION_CAPABLE_UNGOVERNED, 1, "a template INTERPOLATION is live code");
});

test("census: an object-literal barrel re-exporting a root keeps the root's kind (C0)", () => {
    const pure = run({
        "src/server.js": 'require("./user.js");\n',
        "src/user.js": 'const { ToolRegistry: TR } = require("./core/tools/index.js");\nTR.execute("x");\n',
        "src/core/tools/index.js": 'module.exports = {\n    Base: require("./Base.js"),\n    ToolRegistry: require("./ToolRegistry.js")\n};\n',
        "src/core/tools/Base.js": "module.exports = {};\n",
        "src/core/tools/ToolRegistry.js": REGISTRY
    });
    assert.equal(pure.counters.ACTION_CAPABLE_UNGOVERNED, 1, "a barrel must not hide the registry binding");
    assert.deepEqual(kinds(pure), ["registry_execution"]);
    assert.equal(pure.counters.UNCLASSIFIED_LEGACY_REACHABILITY, 0, "a barrel of a root is classified");

    // A MIXED barrel is not itself the root, but a member destructured out of it is.
    const mixed = run({
        "src/server.js": 'require("./user.js");\n',
        "src/user.js": 'const { ToolRegistry: TR } = require("./barrel.js");\nTR.execute("x");\n',
        "src/barrel.js": 'module.exports = { version: 1, ToolRegistry: require("./ToolRegistry.js") };\n',
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(mixed.counters.ACTION_CAPABLE_UNGOVERNED, 1,
        "a data member beside the re-export must not launder the root");
});

test("census: ESM and named-CommonJS re-exports carry the root's kind (C0)", () => {
    const esm = run({
        "src/server.js": 'require("./user.js");\n',
        "src/user.js": 'const R = require("./esmBarrel.js");\nR.execute("x");\n',
        "src/esmBarrel.js": 'export { ToolRegistry } from "./ToolRegistry.js";\n',
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(esm.counters.ACTION_CAPABLE_UNGOVERNED, 1);

    const cjs = run({
        "src/server.js": 'require("./user.js");\n',
        "src/user.js": 'const R = require("./barrel.js");\nR.execute("x");\n',
        "src/barrel.js": 'exports.ToolRegistry = require("./ToolRegistry.js");\n',
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(cjs.counters.ACTION_CAPABLE_UNGOVERNED, 1);
});

test("census: one call site is counted once however many scans recognise it (C0)", () => {
    const report = run({
        "src/server.js": 'require("./app.js");\nrequire("./app.js");\n',
        "src/app.js": 'const pluginLoader = require("./plugins/pluginLoader.js");\npluginLoader.load("plugins");\n',
        ...ROOT
    });
    assert.equal(report.findings.length, 1, "the alias scan and the literal scan must not double-count");
    assert.equal(report.counters.LEGACY_SECOND_PATH, 1);
});

test("census: the same sink site reached from two entrypoints is counted once (C0)", () => {
    const report = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/cli/index.js": 'require("./legacy.js");\n',
        "src/legacy.js": 'const R = require("./ToolRegistry.js");\nR.execute("x");\n',
        "src/ToolRegistry.js": REGISTRY
    }, { entrypoints: ["src/server.js", "src/cli/index.js"] });
    assert.equal(report.counters.LEGACY_SECOND_PATH, 1);
});

test("census: an unreachable root call is not a production path (C0)", () => {
    const report = run({
        "src/server.js": 'require("./live.js");\n',
        "src/live.js": "module.exports = {};\n",
        "src/dead.js": 'const R = require("./ToolRegistry.js");\nR.execute("x");\n',
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(report.counters.LEGACY_SECOND_PATH, 0);
    assert.ok(!report.reachableModules.includes("src/dead.js"));

    // …and the same file, once required, is reported with evidence.
    const wired = run({
        "src/server.js": 'require("./dead.js");\n',
        "src/dead.js": 'const R = require("./ToolRegistry.js");\nR.execute("x");\n',
        "src/ToolRegistry.js": REGISTRY
    });
    assert.equal(wired.counters.LEGACY_SECOND_PATH, 1);
});

test("census: only relative specifiers are walked, and nothing is excluded by path (C0)", () => {
    const external = run({
        "src/server.js": 'require("some-package");\nrequire("./local.js");\n',
        "src/local.js": "module.exports = {};\n",
        "node_modules/some-package/index.js": 'ToolRegistry.execute("vendored");\n'
    });
    assert.equal(external.counters.LEGACY_SECOND_PATH, 0);
    assert.deepEqual(external.reachableModules, ["src/local.js", "src/server.js"],
        "a package specifier is external; the vendored copy is reached only through the package");

    const relative = run({
        "src/server.js": 'require("./vendor/gen.js");\n',
        "src/vendor/gen.js": 'ToolRegistry.execute("generated");\n'
    });
    assert.equal(relative.counters.LEGACY_SECOND_PATH, 1,
        "a relative require into a vendor/generated dir is walked like any other module");
});

test("census: declared plugin-root surfaces still exist in the real root source (C0 pin)", () => {
    const real = path.join(__dirname, "..", "..", "..", "src", "plugins", "pluginLoader.js");
    const source = fs.readFileSync(real, "utf8");
    for (const surface of census.EXECUTION_SURFACES.plugin_handler_execution) {
        if (surface === "execute" || surface === "invoke") continue;  // dispatch alias names
        assert.match(source, new RegExp("\\n\\s*(?:async\\s+)?" + surface + "\\s*\\("),
            `declared execution surface ${surface}() must exist in src/plugins/pluginLoader.js`);
    }
    // The members the census treats as DATA must stay data (a getter, not a call).
    assert.match(source, /get userRoot\s*\(\s*\)/);
    assert.match(source, /get forgeQuarantineRoot\s*\(\s*\)/);
});

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
