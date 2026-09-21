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

// ---------------------------------------------------------------------------
// C0-REPAIR-1 (W8-IW1) — the CONSERVATIVE direction must survive every call
// shape. The invariant is READ vs CALL, not known-member vs unknown-member:
//   READ (any syntax)                → classified, no sink, not UNCLASSIFIED
//   KNOWN EXECUTION SURFACE          → sink / action-capable
//   UNMODELLED CALL SHAPE FROM ROOT  → UNCLASSIFIED
// The oracle must never turn "I do not understand this call shape" into "clean".
// ---------------------------------------------------------------------------

const ROOT_REQUIRE = 'const root = require("./plugins/pluginLoader.js");\n';
const loaderFixture = (body) => ({
    "src/server.js": 'require("./m.js");\n',
    "src/m.js": body,
    "src/plugins/pluginLoader.js": PLUGIN_LOADER,
    "src/ToolRegistry.js": REGISTRY
});
const neverClean = (report) =>
    report.counters.LEGACY_SECOND_PATH + report.counters.UNCLASSIFIED_LEGACY_REACHABILITY >= 1;

test("census: an unmodelled CALL shape derived from a root is never clean (P1)", () => {
    const shapes = {
        "alias chain": 'const a = require("./plugins/pluginLoader.js");\nconst b = a;\nb.load(p);\n',
        "nested member": ROOT_REQUIRE + "root.plugins.load(p);\n",
        "assignment destructuring": 'let b;\n({ load: b } = require("./plugins/pluginLoader.js"));\nb(p);\n',
        "member to field": ROOT_REQUIRE + "const o = {};\no.load = root.load;\no.load(p);\n",
        "parenthesised call": ROOT_REQUIRE + "(root.load)(p);\n",
        "sequence-comma call": ROOT_REQUIRE + "(0, root.load)(p);\n",
        "bound function not invoked": ROOT_REQUIRE + "const f = root.load.bind(x);\n"
    };
    for (const [label, body] of Object.entries(shapes)) {
        const report = run(loaderFixture(body));
        assert.ok(neverClean(report),
            `${label}: a call shape the oracle does not model must be a sink or UNCLASSIFIED, never clean`);
    }
});

test("census: a READ of a root in any syntax stays classified (P1 control)", () => {
    const reads = {
        "plain property": ROOT_REQUIRE + 'const u = root.userRoot ?? "";\nmodule.exports = u;\n',
        "optional property": ROOT_REQUIRE + 'const u = root?.userRoot ?? "";\nmodule.exports = u;\n',
        "whole object member": ROOT_REQUIRE + "const l = root.loaded;\nmodule.exports = l;\n",
        "passed as an argument": ROOT_REQUIRE + "const u = root.userRoot;\nfs.mkdirSync(u, { recursive: true });\n",
        "computed read": ROOT_REQUIRE + 'const v = root["load"];\nmodule.exports = v;\n',
        "inline require read": 'const u = require("./plugins/pluginLoader.js").userRoot;\nmodule.exports = u;\n'
    };
    for (const [label, body] of Object.entries(reads)) {
        const report = run(loaderFixture(body));
        assert.equal(report.counters.UNCLASSIFIED_LEGACY_REACHABILITY, 0,
            `${label}: a data read is a form the oracle CAN classify`);
        assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 0,
            `${label}: a data read is not an action-capable sink`);
    }
});

test("census: a KNOWN execution surface is a sink in every call syntax (P1 control + P2)", () => {
    const calls = {
        "plain": "root.loadOne(p);\n",
        "family member": "root.load(p);\n",
        "optional on the receiver": "root?.load(p);\n",
        "optional call": "root.load?.(p);\n",
        "optional on both": "root?.load?.(p);\n",
        "computed member": ["root", "[", '"loadOne"', "]", "(p);\n"].join(""),
        "computed optional call": ["root", "[", '"loadOne"', "]", "?.(p);\n"].join(""),
        "explicit .call": "root.loadOne.call(root, p);\n",
        "explicit .apply": "root.loadOne.apply(root, [p]);\n"
    };
    for (const [label, body] of Object.entries(calls)) {
        const report = run(loaderFixture(ROOT_REQUIRE + body));
        assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 1,
            `${label}: a declared execution surface must be reported as a sink`);
        assert.deepEqual(kinds(report), ["plugin_handler_execution"], label);
        assert.equal(report.counters.UNCLASSIFIED_LEGACY_REACHABILITY, 0,
            `${label}: a recognised surface is not an unknown form`);
    }
});

test("census: optional call syntax on a root reached by alias and inline require (P2)", () => {
    const forms = {
        "registry alias": 'const R = require("./ToolRegistry.js");\nR.execute?.(x);\n',
        "literal root name": "pluginLoader.load?.(p);\n",
        "inline require": 'const p = "x";\nrequire("./plugins/pluginLoader.js").loadOne?.(p);\n'
    };
    for (const [label, body] of Object.entries(forms)) {
        const report = run(loaderFixture(body));
        assert.equal(report.counters.ACTION_CAPABLE_UNGOVERNED, 1, `${label}: optional call must not hide the sink`);
    }
});

test("census: regex literal text is not executable code, live code after it still is (P2 hardening)", () => {
    const inert = run({
        "src/server.js": 'require("./m.js");\n',
        "src/m.js": 'const re = /require("child_process")/;\nmodule.exports = re;\n'
    });
    assert.equal(inert.counters.LEGACY_SECOND_PATH, 0, "a regex literal is data, not a module load");

    const division = run({
        "src/server.js": 'require("./m.js");\n',
        "src/m.js": 'const a = 4, b = 2;\nconst q = a / b;\nconst cp = require("node:child_process");\nmodule.exports = { q, cp };\n'
    });
    assert.equal(division.counters.LEGACY_SECOND_PATH, 1,
        "a division slash must not swallow the require that follows it");

    const afterRegex = run(loaderFixture('const re = /x/;\n' + ROOT_REQUIRE + "root.load(p);\n"));
    assert.equal(afterRegex.counters.ACTION_CAPABLE_UNGOVERNED, 1,
        "a real surface call after a regex literal must still be detected");
});

test("census: per-ingress reachability is measured, not inferred from the walk order", () => {
    const report = run({
        "src/server.js": 'require("./legacy.js");\n',
        "src/cli/index.js": 'require("../legacy.js");\n',
        "src/legacy.js": 'const R = require("./ToolRegistry.js");\nR.execute("x");\n',
        "src/ToolRegistry.js": REGISTRY
    }, { entrypoints: ["src/cli/index.js", "src/server.js"] });

    assert.deepEqual(report.ingress.analyzed, ["src/cli/index.js", "src/server.js"]);
    assert.equal(report.counters.PRODUCTION_INGRESSES_ANALYZED, 2);
    assert.equal(report.counters.INGRESSES_WITH_UNGOVERNED_FINDINGS, 2,
        "both entrypoints root the same ungoverned sink and both must be counted");
    assert.deepEqual(report.ingress.ungovernedByIngress, { "src/cli/index.js": 1, "src/server.js": 1 });
    assert.deepEqual(report.findings[0].ingresses, ["src/cli/index.js", "src/server.js"]);
});

test("census: every finding carries the byte column that makes its identity unique", () => {
    const report = run({
        "src/server.js": 'require("./m.js");\n',
        "src/m.js": "fs.writeFileSync(a); fs.writeFileSync(b); fs.writeFileSync(c);\n"
    });
    assert.equal(report.findings.length, 3, "three sites on one line are three findings");
    assert.equal(new Set(report.findings.map(f => f.column)).size, 3, "each site has its own column");
});

// ---------------------------------------------------------------------------
// C0-REPAIR-2 (W8-IW1) — the conservative net is DEPTH-INDEPENDENT, covers a root's
// literal identifier without a local binding, keeps a facade-extracted root member's
// identity, and regex literal text is data in every scanner. Read-only forms must be
// FULLY clean (no sink, no action, no UNCLASSIFIED) — not merely "not action-capable".
// ---------------------------------------------------------------------------

const RICH_REGISTRY = "module.exports = { execute(id) { return id; }, has(id) { return !!id; }, " +
    "count() { return 0; }, get(id) { return id; }, describe() { return []; }, someUnknown(id) { return id; } };\n";
const PLUGIN_ROOT = { "src/plugins/pluginLoader.js": PLUGIN_LOADER, "src/ToolRegistry.js": RICH_REGISTRY };
const BARREL_PURE = { "src/barrel-pure.js": 'module.exports = require("./ToolRegistry.js");\n' };
const BARREL_MIXED = { "src/barrel-mixed.js": 'module.exports = { version: 1, ToolRegistry: require("./ToolRegistry.js") };\n' };
const OB = String.fromCharCode(91);
const CB = String.fromCharCode(93);
const tree = (body, extra = {}) => Object.assign(
    { "src/server.js": 'require("./m.js");\n', "src/m.js": body }, PLUGIN_ROOT, extra);

const totals = (report) => ({
    sink: report.counters.LEGACY_SECOND_PATH,
    action: report.counters.ACTION_CAPABLE_UNGOVERNED,
    unclass: report.counters.UNCLASSIFIED_LEGACY_REACHABILITY
});
const assertClean = (report, label) => assert.deepEqual(totals(report), { sink: 0, action: 0, unclass: 0 },
    `${label}: a read-only form must be fully clean`);
const assertNeverClean = (report, label) => assert.ok(
    report.counters.LEGACY_SECOND_PATH + report.counters.UNCLASSIFIED_LEGACY_REACHABILITY >= 1,
    `${label}: an unmodelled call shape must never be clean`);
const assertUnclassified = (report, label) => {
    assert.equal(report.counters.UNCLASSIFIED_LEGACY_REACHABILITY, 1, `${label}: must be UNCLASSIFIED`);
    assert.equal(report.counters.LEGACY_SECOND_PATH, 0, `${label}: is not a declared-surface sink`);
};

test("census: a call at ANY member depth from a root-derived value is never clean", () => {
    const shapes = {
        "depth 0": "root.zz(x);\n",
        "depth 1": "root.a.zz(x);\n",
        "depth 2": "root.a.b.zz(x);\n",
        "depth 3": "root.a.b.c.zz(x);\n",
        "depth 4": "root.a.b.c.d.zz(x);\n",
        "computed at depth 2": "var q = 1;\nroot.a" + OB + "q" + CB + ".zz(x);\n",
        "computed mid-chain": "var q = 'b';\nroot" + OB + "q" + CB + ".c.zz(x);\n",
        "optional chain": "root?.a?.b.zz?.(x);\n",
        "parenthesised": "(root.a.b.zz)(x);\n",
        "sequence-comma": "(0, root.a.b.zz)(x);\n",
        "member of member": "root.plugins.loaded.has(x);\n"
    };
    for (const [label, body] of Object.entries(shapes)) {
        const report = run(tree(ROOT_REQUIRE + body));
        assertUnclassified(report, label);
    }
});

test("census: a deep chain onto a declared SURFACE name is UNCLASSIFIED, not a canonical sink", () => {
    for (const body of ["root.a.load(x);\n", "root.a.b.load(x);\n", "root.a.b.c.loadOne(x);\n"]) {
        const report = run(tree(ROOT_REQUIRE + body));
        assert.equal(report.counters.UNCLASSIFIED_LEGACY_REACHABILITY, 1,
            "a chain the oracle cannot prove means pluginLoader.load must be UNCLASSIFIED");
        assert.deepEqual(kinds(report), [], "and must NOT be reported as a canonical sink");
        assertNeverClean(report, "deep surface chain");
    }
});

test("census: a root's literal identifier is covered even without a local binding", () => {
    assertUnclassified(run(tree("pluginLoader.someUnknownThing(x);\n")), "unbound unknown member");
    assertUnclassified(run(tree("pluginLoader.plugins.load(x);\n")), "unbound deep chain");
    assertUnclassified(run(tree("ToolRegistry.someUnknownThing(x);\n")), "unbound registry member");

    const surface = run(tree("pluginLoader.load(x);\n"));
    assert.equal(surface.counters.ACTION_CAPABLE_UNGOVERNED, 1, "an unbound surface call is still a sink");
    assert.deepEqual(kinds(surface), ["plugin_handler_execution"]);

    const registry = run(tree("ToolRegistry.execute(x);\n"));
    assert.deepEqual(totals(registry), { sink: 1, action: 1, unclass: 0 });
});

test("census: a root member extracted from a facade keeps its identity", () => {
    const extracted = {
        "named, pure barrel": { extra: BARREL_PURE, pre: 'const barrel = require("./barrel-pure.js");\n', t: "barrel.ToolRegistry" },
        "named, mixed barrel": { extra: BARREL_MIXED, pre: 'const barrel = require("./barrel-mixed.js");\n', t: "barrel.ToolRegistry" }
    };
    for (const [label, c] of Object.entries(extracted)) {
        const sink = run(tree(c.pre + "const T = " + c.t + ";\nT.execute(x);\n", c.extra));
        assert.deepEqual(totals(sink), { sink: 1, action: 1, unclass: 0 }, `${label}: T.execute is a registry sink`);
        assert.deepEqual(kinds(sink), ["registry_execution"], label);

        const unknown = run(tree(c.pre + "const T = " + c.t + ";\nT.someUnknown(x);\n", c.extra));
        assertUnclassified(unknown, `${label}: T.someUnknown`);
    }

    const inline = run(tree('const T = require("./barrel-mixed.js").ToolRegistry;\nT.execute(x);\n', BARREL_MIXED));
    assert.deepEqual(totals(inline), { sink: 1, action: 1, unclass: 0 }, "inline-extracted member is a registry sink");

    const destructured = run(tree('const { ToolRegistry: T } = require("./barrel-mixed.js");\nT.execute(x);\n', BARREL_MIXED));
    assert.deepEqual(totals(destructured), { sink: 1, action: 1, unclass: 0 }, "renamed destructured member is a sink");

    const destructuredUnknown = run(tree('const { ToolRegistry: T } = require("./barrel-mixed.js");\nT.someUnknown(x);\n', BARREL_MIXED));
    assertUnclassified(destructuredUnknown, "renamed destructured member, unknown method");
});

test("census: known metadata methods on a facade-extracted root stay clean, unknown ones do not", () => {
    const reads = ["T.describe()", "T.has(x)", "T.count()", "T.get(x)"];
    for (const call of reads) {
        const report = run(tree('const barrel = require("./barrel-mixed.js");\nconst T = barrel.ToolRegistry;\nconst v = ' + call + ';\nmodule.exports = v;\n', BARREL_MIXED));
        assertClean(report, `T = barrel.ToolRegistry; ${call}`);
    }
    assertUnclassified(run(tree('const barrel = require("./barrel-mixed.js");\nconst T = barrel.ToolRegistry;\nT.someUnknown(x);\n', BARREL_MIXED)),
        "an unknown method on a facade-extracted root");
});

test("census: the RESULT of a read call is data, not the root", () => {
    const report = run(tree('const { ToolRegistry } = require("./barrel-mixed.js");\n' +
        "const names = ToolRegistry.describe();\n" +
        "const visible = names.filter(n => n);\n" +
        "module.exports = visible.length;\n", BARREL_MIXED));
    assertClean(report, "describe() result used as data");
});

test("census: every read-only form is FULLY clean (sink = action = unclassified = 0)", () => {
    const reads = {
        "root property": ROOT_REQUIRE + 'const u = root.userRoot ?? "";\nmodule.exports = u;\n',
        "root property, optional": ROOT_REQUIRE + "const u = root?.userRoot;\nmodule.exports = u;\n",
        "root member object": ROOT_REQUIRE + "const l = root.loaded;\nmodule.exports = l;\n",
        "computed root read": ROOT_REQUIRE + "const v = root" + OB + '"load"' + CB + ";\nmodule.exports = v;\n",
        "read passed as an argument": ROOT_REQUIRE + "consume(root.userRoot);\n",
        "inline require read": 'const u = require("./plugins/pluginLoader.js").userRoot;\nmodule.exports = u;\n',
        "unbound literal read": "const u = pluginLoader.userRoot;\nmodule.exports = u;\n",
        "unbound registry metadata read": "const d = ToolRegistry.describe();\nmodule.exports = d;\n",
        "facade metadata read": 'const { ToolRegistry } = require("./barrel-mixed.js");\nconst d = ToolRegistry.describe();\nmodule.exports = d;\n',
        "destructured member read": 'const { userRoot } = require("./plugins/pluginLoader.js");\nmodule.exports = userRoot;\n'
    };
    for (const [label, body] of Object.entries(reads)) {
        assertClean(run(tree(body, BARREL_MIXED)), label);
    }
});

test("census: regex literal text is data in every scanner, live code after it is not", () => {
    const inert = {
        "surface text in a regex": "const re = /pluginLoader.load(/;\nmodule.exports = re;\n",
        "registry text in a regex": "const re = /ToolRegistry.execute(/;\nmodule.exports = re;\n",
        "process text in a regex": "const re = /execSync(/;\nmodule.exports = re;\n",
        'require text in a regex': 'const re = /require("child_process")/;\nmodule.exports = re;\n'
    };
    for (const [label, body] of Object.entries(inert)) assertClean(run(tree(body)), label);

    const liveCall = run(tree("const re = /x/;\n" + ROOT_REQUIRE + "root.load(p);\n"));
    assert.deepEqual(totals(liveCall), { sink: 1, action: 1, unclass: 0 }, "a real surface call after a regex is a sink");

    const liveRequire = run(tree("const re = /x/;\nconst cp = require('node:child_process');\nmodule.exports = cp;\n"));
    assert.equal(liveRequire.counters.LEGACY_SECOND_PATH, 1, "a real require after a regex is still a sink");

    const division = run(tree("const a = 4, b = 2;\nconst q = a / b;\nrequire('node:child_process').exec('x');\nmodule.exports = q;\n"));
    assert.equal(division.counters.LEGACY_SECOND_PATH, 1,
        "a division slash must not swallow the require that follows it");

    const interp = run(tree("const s = `${pluginLoader.load(p)}`;\nmodule.exports = s;\n"));
    assert.equal(interp.counters.ACTION_CAPABLE_UNGOVERNED, 1, "a live template interpolation is code");
});

// ---------------------------------------------------------------------------
// C0-REPAIR-3 (W8-IW1) — a call-shaped tail the scanner cannot parse is NEVER a read,
// root identity survives guarded/parenthesised aliases but never spreads through values
// that merely CONSUME the root, and a tagged template is an invocation like any other.
// ---------------------------------------------------------------------------

const RS_REQUIRE = 'const RS = require("./ToolRegistry.js");\n';
const tag = String.fromCharCode(96);

test("census: a call reached through parentheses or a sequence is never read", () => {
    const shapes = {
        "parenthesised receiver": ROOT_REQUIRE + "(root).load(x);\n",
        "parenthesised receiver, unknown": ROOT_REQUIRE + "(root).someUnknown(x);\n",
        "double parentheses": ROOT_REQUIRE + "((root)).load(x);\n",
        "paren run around a member": ROOT_REQUIRE + "(((root.load)))(x);\n",
        "sequence with the value last": ROOT_REQUIRE + "(0, root).load(x);\n",
        "sequence with the value first": ROOT_REQUIRE + "(root.load, 0)(x);\n",
        "computed across lines, then a member": ROOT_REQUIRE + "root" + OB + "\n  'load'\n" + CB + ".something(x);\n"
    };
    for (const [label, body] of Object.entries(shapes)) {
        assertNeverClean(run(tree(body)), label);
    }

    // ...while the same receiver used as a value stays classified.
    const computedCall = run(tree(ROOT_REQUIRE + "root" + OB + "\n  'load'\n" + CB + "(x);\n"));
    assert.deepEqual(totals(computedCall), { sink: 1, action: 1, unclass: 0 },
        "a multi-line computed surface call is still a sink");
});

test("census: reading a root value keeps staying clean", () => {
    const reads = {
        "member assigned to a name": ROOT_REQUIRE + "const u = root.userRoot;\nmodule.exports = u;\n",
        "member passed as an argument": ROOT_REQUIRE + "consume(root.userRoot, { recursive: true });\n",
        "multi-line argument list": ROOT_REQUIRE + "consume(\n    root.userRoot,\n    { recursive: true }\n);\n",
        "computed read": ROOT_REQUIRE + "const v = root" + OB + "0" + CB + ";\nmodule.exports = v;\n",
        "sequence read": ROOT_REQUIRE + "const a = 1;\nconst v = (a, root.userRoot);\nmodule.exports = v;\n"
    };
    for (const [label, body] of Object.entries(reads)) assertClean(run(tree(body)), label);
});

test("census: a guarded or parenthesised alias of a root is still root-derived", () => {
    const aliases = {
        "parenthesised": ROOT_REQUIRE + "const c = (root);\nc.load(x);\n",
        "nested parentheses": ROOT_REQUIRE + "const c = ((root));\nc.load(x);\n",
        "nullish guard": ROOT_REQUIRE + "const c = root ?? null;\nc.load(x);\n",
        "OR guard": ROOT_REQUIRE + "const c = root || null;\nc.load(x);\n",
        "ternary": ROOT_REQUIRE + "const c = 1 ? root : {};\nc.load(x);\n",
        "reassignment": ROOT_REQUIRE + "let c;\nc = root ?? null;\nc.load(x);\n",
        "plain alias regression": ROOT_REQUIRE + "const c = root;\nc.load(x);\n"
    };
    for (const [label, body] of Object.entries(aliases)) assertNeverClean(run(tree(body)), label);

    const guardedDestructuring = run(tree(ROOT_REQUIRE + "const { load } = root ?? {};\nload(x);\n"));
    assertUnclassified(guardedDestructuring, "a surface destructured out of a guarded root");
});

test("census: root identity does not spread through values that merely consume it", () => {
    // `path.join(root.userRoot, ...)` CONSUMES the value; the result is a path, not the
    // root, and method calls on it must stay clean (the documented interprocedural limit).
    const consumed = run(tree(ROOT_REQUIRE + "const dir = path.join(root.userRoot, 'plugins');\n" +
        "const names = fs.readdirSync(dir);\n" +
        "const hit = names.filter(n => n.includes('x'));\n" +
        "module.exports = hit.length;\n"));
    assertClean(consumed, "a value computed FROM a root read");

    const passed = run(tree(ROOT_REQUIRE + "fn(root);\nconst v = fn(root).someUnknown(x);\nmodule.exports = v;\n"));
    assertClean(passed, "the result of passing a root into a helper");
});

test("census: a call RESULT never becomes root identity", () => {
    const asData = {
        "describe() result": "const desc = ToolRegistry.describe();\nconst v = desc.find(x);\nmodule.exports = v;\n",
        "count() result": "const n = ToolRegistry.count();\nconst v = n.someMethod();\nmodule.exports = v;\n",
        "guarded describe() result": 'const { ToolRegistry } = require("./barrel-mixed.js");\n' +
            "const names = ToolRegistry.describe();\nconst v = names.filter(n => n);\nmodule.exports = v.length;\n"
    };
    for (const [label, body] of Object.entries(asData)) assertClean(run(tree(body, BARREL_MIXED)), label);

    const readThenCall = run(tree(ROOT_REQUIRE + "const g = root.loaded.get(id);\nmodule.exports = g;\n"));
    assertNeverClean(readThenCall, "a call made on the result of a root member read");
});

test("census: a tagged template invokes the surface it is attached to", () => {
    const surfaces = {
        "unbound literal root": "pluginLoader.load" + tag + "x" + tag + ";\n",
        "literal registry": "ToolRegistry.execute" + tag + "x" + tag + ";\n",
        "module-bound root": ROOT_REQUIRE + "root.load" + tag + "x" + tag + ";\n",
        "registry alias": RS_REQUIRE + "RS.execute" + tag + "x" + tag + ";\n",
        "optional member": ROOT_REQUIRE + "root?.load" + tag + "x" + tag + ";\n"
    };
    for (const [label, body] of Object.entries(surfaces)) {
        const report = run(tree(body));
        assert.deepEqual(totals(report), { sink: 1, action: 1, unclass: 0 }, `${label}: tagged surface call`);
    }

    const unknownTag = run(tree(ROOT_REQUIRE + "root.someUnknown" + tag + "x" + tag + ";\n"));
    assertUnclassified(unknownTag, "an unknown tagged call on a root");
    const deepTag = run(tree(ROOT_REQUIRE + "root.a.b" + tag + "x" + tag + ";\n"));
    assertUnclassified(deepTag, "a deep tagged call on a root");

    const controls = {
        "plain template text": "const s = " + tag + "pluginLoader.load(x)" + tag + ";\nmodule.exports = s;\n",
        "tag on an ordinary local": "const f = (s) => s;\nmodule.exports = f" + tag + "x" + tag + ";\n",
        "literal control": "const s = " + tag + "no surfaces here" + tag + ";\nmodule.exports = s;\n"
    };
    for (const [label, body] of Object.entries(controls)) assertClean(run(tree(body)), label);

    const interpolation = run(tree("const s = " + tag + "x ${pluginLoader.load(x)}" + tag + ";\nmodule.exports = s;\n"));
    assert.equal(interpolation.counters.ACTION_CAPABLE_UNGOVERNED, 1, "an interpolated call is still live");
});

// ---------------------------------------------------------------------------
// W8-IW1-C0 CLUSTER C11-COGNITION-TOOLS — a bare `handler(...)` is a tool/handler
// REFERENCE invocation only when `handler` can be something other than a proven local:
// `const handler = HANDLERS[env.type]` is a pure reducer table ("no IO here",
// src/cognition/continuity/reducers.js), so calling it is a name coincidence, not an
// execution surface. Every ambiguous form — parameter, root-bound, destructured,
// undeclared — stays visible.
// ---------------------------------------------------------------------------

const LOCAL_TABLE = "const HANDLERS = { A: (s) => s, B: (s) => s };\n";

test("census: a handler dispatched from a proven-local table is not an execution surface", () => {
    const proven = {
        "table lookup": LOCAL_TABLE + "const handler = HANDLERS[env.type];\nhandler(x);\n",
        "the real ContinuityCore shape": LOCAL_TABLE +
            "function reduceFrom(base, env) {\n    const handler = HANDLERS[env.type];\n" +
            "    if (!handler) return base;\n    const next = handler(base, env, { config: 1 });\n    return next;\n}\nreduceFrom(1, { type: 'A' });\n",
        "local factory result": "const make = () => (x) => x;\nconst handler = make();\nhandler(1);\n",
        "local map lookup (meshRouter shape)": "const _handlers = new Map();\nconst handler = _handlers.get('t');\nhandler(1);\n"
    };
    for (const [label, body] of Object.entries(proven)) assertClean(run(tree(body)), label);
});

test("census: an ambiguous handler reference stays visible", () => {
    const fromRoot = {
        "registry surface result": "const handler = ToolRegistry.get(id);\nhandler(x);\n",
        "registry alias result": RS_REQUIRE + "let handler;\nhandler = RS.get(id);\nhandler(x);\n",
        "root aliased to a local name": "const reg = ToolRegistry;\nconst handler = reg.get(id);\nhandler(x);\n"
    };
    for (const [label, body] of Object.entries(fromRoot)) {
        assert.deepEqual(totals(run(tree(body))), { sink: 1, action: 1, unclass: 0 }, label);
    }

    // `root.loadOne(id)` is itself a plugin execution surface, so this tree carries two
    // findings: the surface call AND the direct invocation of the handler it returned.
    const pluginBound = run(tree(ROOT_REQUIRE + "const handler = root.loadOne(id);\nhandler(x);\n"));
    assert.ok(pluginBound.findings.some(f => f.kind === "tool_handler_invocation"),
        "a handler bound from a plugin surface and invoked directly stays visible");

    const parameters = {
        "parameter at the head of a block": "function f(handler) {\n    handler(x);\n}\nf(1);\n",
        "parameter after a statement": "function f(handler) {\n    const a = 1;\n    handler(a);\n}\nf(1);\n",
        "block-bodied arrow parameter": "const f = (handler) => { handler(x); };\nf(1);\n",
        "parameter of a method": "const o = { on(type, handler) { handler(type); } };\no.on('t', 1);\n"
    };
    for (const [label, body] of Object.entries(parameters)) {
        assert.deepEqual(totals(run(tree(body))), { sink: 1, action: 1, unclass: 0 }, label);
    }

    const other = {
        "destructured from another module": 'const { handler } = require("./h.js");\nhandler(x);\n',
        "never declared at all": "handler(x);\n"
    };
    for (const [label, body] of Object.entries(other)) {
        assert.deepEqual(totals(run(tree(body, { "src/h.js": "module.exports = { handler: (x) => x };\n" }))),
            { sink: 1, action: 1, unclass: 0 }, label);
    }
});

test("census: a control-flow test on a local handler does not make it a parameter", () => {
    const guarded = run(tree(LOCAL_TABLE + "const handler = HANDLERS[env.type];\n" +
        "if (!handler) { throw new Error('unknown event'); }\n" +
        "handler(x);\n"));
    assertClean(guarded, "if (!handler) { ... } is a condition, not a parameter list");
});
