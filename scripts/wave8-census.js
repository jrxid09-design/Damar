#!/usr/bin/env node
"use strict";

/**
 * WAVE8 DETERMINISTIC LEGACY CENSUS — the canonical counter oracle.
 *
 * WHY THIS EXISTS
 * The wave's exit conditions (LEGACY_SECOND_PATH = 0,
 * ACTION_CAPABLE_UNGOVERNED = 0, UNCLASSIFIED_LEGACY_REACHABILITY = 0) were
 * previously reported by an LLM auditor, whose counts drifted round to round on
 * the same class of code. A number that cannot be reproduced is not evidence.
 * This script is the deterministic counter; the external auditor is only the
 * independent cross-check.
 *
 * WHAT IT MEASURES (exactly)
 * Starting from defined production entrypoints, walk the CommonJS require()
 * graph (plus dynamic import()) and, for every reachable module, detect
 * executable sinks. Then apply the property the wave actually requires:
 *
 *   there must be ZERO reachable path from a production entrypoint to an
 *   executable sink module that does not first traverse canonical ownership.
 *
 * A sink site reached from an entrypoint WITHOUT canonical ownership on the path
 * is an ungoverned route. Every finding carries its full path, so every count is
 * auditable and reproducible.
 *
 * PRECISION LIMITS (stated, not hidden)
 * - Analysis is module/path-level, not call-site dataflow: a module reached both
 *   ways is classified by the path that reaches it without ownership. This is
 *   deliberately conservative (it may over-report, never under-report).
 * - String literals cannot trigger a call sink (their contents are blanked
 *   before call matching), so metadata, docs and this file's own patterns
 *   cannot self-trigger. Module-name sinks (e.g. require("child_process")) are
 *   matched on the SPECIFIER, not on bare text.
 * - Regex literals are not parsed; a regex containing a sink-shaped call can
 *   over-report. Documented limit, chosen over a heuristic that under-reports.
 * - Only relative ("./", "../") specifiers are resolved and walked. Bare and
 *   package specifiers are recorded as external.
 *
 * USAGE
 *   node scripts/wave8-census.js
 *   node scripts/wave8-census.js --json
 *   node scripts/wave8-census.js --root <dir> --entrypoints a.js,b.js
 *   node scripts/wave8-census.js --strict-all      # gate on advisory kinds too
 *
 * Exit code: 0 when no ungoverned route is found, 1 otherwise (or on usage
 * error). Output is stable for the same input: modules are visited in sorted
 * order and findings are sorted by file/line/kind.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Sink kinds. `actionCapable` marks the kinds that gate the exit conditions;
// advisory kinds (filesystem/network/device) are always reported and only gate
// under --strict-all.
// ---------------------------------------------------------------------------

const SINK_KINDS = {
    registry_execution: { actionCapable: true, description: "a tool registry executes a handler" },
    plugin_handler_execution: { actionCapable: true, description: "the plugin manager/loader executes or loads a handler" },
    tool_handler_invocation: { actionCapable: true, description: "a tool/handler reference is invoked directly" },
    process_shell: { actionCapable: true, description: "a shell/process is spawned" },
    terminal: { actionCapable: true, description: "a terminal/pty surface is driven" },
    actuator_invocation: { actionCapable: true, description: "an actuator/effector binding is invoked" },
    filesystem_mutation: { actionCapable: false, description: "the filesystem is mutated" },
    network_mutation: { actionCapable: false, description: "an outbound request mutates remote state" },
    device_control: { actionCapable: false, description: "a device surface is driven" }
};

// Modules whose job IS canonical ownership: the Lane-3 dispatcher/facades, the
// manager ingress, and the canonical actuation lane. A path that traverses one
// of these has passed through ActionIntent/Authority/Capability ownership.
const DEFAULT_CANONICAL_OWNERS = [
    "src/action/bootstrap.js",
    "src/manager/bootstrap.js",
    "src/manager/internal/managerBootstrap.js",
    "src/embodiment/effectors/"
];

// Registry/plugin/executor module basenames: a binding to one of these makes
// `<binding>.execute(...)` a registry/handler sink.
const DEFAULT_REGISTRY_MODULES = ["ToolRegistry.js", "pluginManager.js", "pluginLoader.js"];

const DEFAULT_ENTRYPOINTS = ["src/server.js", "src/cli/index.js"];

// Operator bootstrap launchers. Their job IS to start processes, they take no
// caller input, and they are not reachable from a model/agent/legacy path, so
// their sinks are reported separately instead of gating the counters.
const DEFAULT_LAUNCHERS = ["scripts/launch.js"];

// ---------------------------------------------------------------------------
// Source views
// ---------------------------------------------------------------------------

/**
 * Blank out comments, preserving every newline and offset so line numbers stay
 * correct. Returns TWO views of the same text:
 *   code    — string literal CONTENT also blanked (call sinks cannot be hidden
 *             in, or faked by, a string).
 *   raw     — comments removed, string content kept (specifiers and
 *             module-name literals are matched here).
 */
function stripComments(source) {
    let code = "";
    let raw = "";
    let i = 0;
    const n = source.length;
    let state = "code";

    const blank = (c) => (c === "\n" ? "\n" : " ");

    while (i < n) {
        const c = source[i];
        const c2 = i + 1 < n ? source[i + 1] : "";

        if (state === "code") {
            if (c === "/" && c2 === "/") { state = "line_comment"; code += "  "; raw += "  "; i += 2; continue; }
            if (c === "/" && c2 === "*") { state = "block_comment"; code += "  "; raw += "  "; i += 2; continue; }
            if (c === '"' || c === "'" || c === "`") { state = c; code += " "; raw += c; i += 1; continue; }
            code += c; raw += c; i += 1; continue;
        }

        if (state === "line_comment") {
            if (c === "\n") { state = "code"; code += "\n"; raw += "\n"; i += 1; continue; }
            code += " "; raw += " "; i += 1; continue;
        }

        if (state === "block_comment") {
            if (c === "*" && c2 === "/") { state = "code"; code += "  "; raw += "  "; i += 2; continue; }
            code += blank(c); raw += blank(c); i += 1; continue;
        }

        // Inside a quoted literal: `raw` keeps the content, `code` blanks it.
        if (c === "\\") {
            const nxt = i + 1 < n ? source[i + 1] : "";
            code += "  ";
            raw += c + nxt;
            i += 2;
            continue;
        }
        if (c === state) { state = "code"; code += " "; raw += c; i += 1; continue; }
        code += blank(c);
        raw += c;
        i += 1;
        continue;
    }

    return { code, raw };
}

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i += 1) {
        if (text[i] === "\n") line += 1;
    }
    return line;
}

/** Relative require()/import() specifiers from the raw (string-keeping) view. */
function extractSpecifiers(raw) {
    const found = [];
    const patterns = [
        /require\s*\(\s*"([^"\n]+)"\s*\)/g,
        /require\s*\(\s*'([^'\n]+)'\s*\)/g,
        /import\s*\(\s*"([^"\n]+)"\s*\)/g,
        /import\s*\(\s*'([^'\n]+)'\s*\)/g
    ];
    for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(raw)) !== null) found.push({ spec: m[1], index: m.index });
    }
    return found.sort((a, b) => a.index - b.index);
}

/**
 * Bindings to required modules, with the FORM of the binding:
 *   namespace — `const X = require("./ToolRegistry.js")` / `const { ToolRegistry: TR } = ...`
 *               → sinks are `X.execute(...)`, `X["..."] (...)`, `X.invoke(...)`
 *   callable  — `const { execute } = require("./ToolRegistry.js")`
 *               → the bound name IS the function: sinks are `execute(...)`
 */
function extractBindings(raw, specifiers) {
    const bindings = new Map();     // identifier -> { spec, form }
    const seen = new Set();
    for (const { spec } of specifiers) {
        if (seen.has(spec)) continue;
        seen.add(spec);
        const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const call = "require\\s*\\(\\s*[\"']" + esc + "[\"']\\s*\\)";

        const rePlain = new RegExp("(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" + call, "g");
        let m;
        while ((m = rePlain.exec(raw)) !== null) bindings.set(m[1], { spec, form: "namespace" });

        const reDestructured = new RegExp("(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*" + call, "g");
        while ((m = reDestructured.exec(raw)) !== null) {
            for (const part of m[1].split(",")) {
                const pieces = part.split(":");
                const renamed = pieces.length > 1;
                const alias = (renamed ? pieces[1] : pieces[0]).trim();
                if (alias && /^[A-Za-z_$][\w$]*$/.test(alias)) {
                    // `{ X: Y }` binds the module object; `{ X }` binds the member
                    // itself, which is invoked directly.
                    bindings.set(alias, { spec, form: renamed ? "namespace" : "callable" });
                }
            }
        }
    }
    return bindings;
}

// ---------------------------------------------------------------------------
// Sink detection (runs on the string-blanked `code` view)
// ---------------------------------------------------------------------------

function detectSinks(source, registryAliases) {
    const { code, raw } = stripComments(source);
    const sinks = [];

    const push = (kind, index, snippet) => {
        sinks.push({
            kind,
            line: lineOf(code, index),
            snippet: String(snippet).replace(/\s+/g, " ").trim().slice(0, 120),
            actionCapable: SINK_KINDS[kind].actionCapable
        });
    };

    const scan = (re, kind, haystack = code) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(haystack)) !== null) push(kind, m.index, m[0]);
    };

    for (const alias of registryAliases) {
        const a = alias.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (alias.form === "callable") {
            // The bound name IS the execution function.
            scan(new RegExp("(?:^|[;=(\[,]|\\breturn\\b|\\bawait\\b)\\s*" + a + "\\s*\\(", "g"), alias.kind);
            continue;
        }
        scan(new RegExp("\\b" + a + "\\s*\\.\\s*execute\\s*\\(", "g"), alias.kind);
        scan(new RegExp("\\b" + a + "\\s*\\[\\s*[^\\]]+\\]\\s*\\(", "g"), alias.kind);
        scan(new RegExp("\\b" + a + "\\s*\\.\\s*invoke\\s*\\(", "g"), "tool_handler_invocation");
    }

    // Literal registry/plugin surfaces, independent of aliasing.
    scan(/\bToolRegistry\s*\.\s*execute\s*\(/g, "registry_execution");
    scan(/\bpluginManager\s*\.\s*execute\s*\(/g, "plugin_handler_execution");
    scan(/\bpluginLoader\s*\.\s*loadOne\s*\(/g, "plugin_handler_execution");

    // Direct handler/tool invocation shapes.
    scan(/\b(?:tool|handler|toolInstance|instance|registered)\s*\.\s*execute\s*\(/g, "tool_handler_invocation");
    // Bare handler( call forms only: a prefix that implies invocation, minus a
    // definition body (`handler(a) { ... }`), so declarations and object-literal
    // methods are not false positives.
    scan(/(?:^|[;=(\[,]|\breturn\b|\bawait\b)\s*handler\s*\((?![^()]*\)\s*\{)/g, "tool_handler_invocation");

    // Process / shell: specifier-based (so documentation strings cannot match)
    // plus the classic driver calls. Q is the quote class, built from escapes so
    // the pattern cannot be mangled by an editor layer.
    const Q = "[\\u0022\\u0027]";
    scan(new RegExp("require\\s*\\(\\s*" + Q + "(?:node:)?child_process" + Q + "\\s*\\)", "g"), "process_shell", raw);
    scan(/\b(?:execSync|spawnSync|execFileSync|spawn|fork)\s*\(/g, "process_shell");

    // Terminal / pty.
    scan(new RegExp("require\\s*\\(\\s*" + Q + "(?:node-pty|pty)" + Q + "\\s*\\)", "g"), "terminal", raw);
    scan(/\b(?:terminal_run|TerminalRuntime|terminalService)\b/g, "terminal");
    scan(/\bpty\s*\.\s*spawn\s*\(/g, "terminal");

    // Actuator / effector invocation.
    scan(/\bbinding\s*\.\s*invoke\s*\(/g, "actuator_invocation");
    scan(/\bactuator\s*\.\s*(?:invoke|execute|apply)\s*\(/g, "actuator_invocation");

    // Advisory kinds.
    scan(/\bfs\s*\.\s*(?:writeFileSync|writeFile|appendFileSync|rmSync|rm|unlinkSync|renameSync|mkdirSync)\s*\(/g, "filesystem_mutation");
    scan(/\b(?:axios|http)\s*\.\s*(?:post|put|patch|delete)\s*\(/g, "network_mutation");
    scan(/\bdevice\s*\.\s*(?:send|write|command)\s*\(/g, "device_control");

    return sinks.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Module graph
// ---------------------------------------------------------------------------

function resolveRelative(fromFile, spec) {
    if (typeof spec !== "string" || !spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base, base + ".js", base + ".json", path.join(base, "index.js")];
    for (const c of candidates) {
        try {
            if (fs.statSync(c).isFile()) return path.resolve(c);
        }
        catch { /* try next */ }
    }
    return null;
}

function readIfFile(file) {
    try {
        return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : null;
    }
    catch {
        return null;
    }
}

function isRegistryModule(file, registryModuleNames) {
    return registryModuleNames.includes(path.basename(file));
}

function canonicalOwnerOnPath(relFile, owners) {
    return owners.some(o => relFile === o || relFile.startsWith(o));
}

/**
 * Specifiers a module RE-EXPORTS wholesale:
 * `module.exports = require("./ToolRegistry.js")`. Only a pure re-export keeps
 * a caller's binding a registry/plugin binding — a façade that merely requires
 * a registry internally is its own module, not the registry.
 */
function extractReexports(raw) {
    const found = [];
    const Q = "[\\u0022\\u0027]";
    const re = new RegExp("module\\.exports\\s*=\\s*require\\s*\\(\\s*" + Q + "([^\\u0022\\u0027\\n]+)" + Q + "\\s*\\)", "g");
    let m;
    while ((m = re.exec(raw)) !== null) found.push(m[1]);
    return found;
}

/**
 * Which kind of execution surface this module IS (directly, or through a chain
 * of PURE re-exports): "registry_execution" | "plugin_handler_execution" | null.
 */
function moduleKind(file, cache, registryModuleNames, depth = 0) {
    if (depth > 4) return null;
    const key = "kind:" + file;
    if (cache.has(key)) return cache.get(key);
    cache.set(key, null);

    const base = path.basename(file);
    let kind = null;
    if (base === "ToolRegistry.js") kind = "registry_execution";
    else if (base === "pluginManager.js" || base === "pluginLoader.js") kind = "plugin_handler_execution";
    else {
        const source = readIfFile(file);
        if (source !== null) {
            const { raw } = stripComments(source);
            for (const spec of extractReexports(raw)) {
                const target = resolveRelative(file, spec);
                if (!target) continue;
                const found = moduleKind(target, cache, registryModuleNames, depth + 1);
                if (found) { kind = found; break; }
            }
        }
    }

    cache.set(key, kind);
    return kind;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyze(options = {}) {
    const root = path.resolve(options.root ?? process.cwd());
    const owners = options.canonicalOwners ?? DEFAULT_CANONICAL_OWNERS;
    const registryModuleNames = options.registryModuleNames ?? DEFAULT_REGISTRY_MODULES;
    const rel = (f) => path.relative(root, f).split(path.sep).join("/");

    const entrypoints = (options.entrypoints ?? DEFAULT_ENTRYPOINTS)
        .map(e => path.resolve(root, e))
        .filter(f => fs.existsSync(f));

    const reexportCache = new Map();
    const modules = new Map();          // file -> { sinks }
    const visited = new Set();
    const seenState = new Set();
    const ungoverned = [];
    const governed = [];

    // BFS over (file, governed) states. `governed` becomes true once a canonical
    // owner module has been traversed on that path and stays true downstream.
    let queue = entrypoints.slice()
        .sort((a, b) => a.localeCompare(b))
        .map(file => ({ file, governed: canonicalOwnerOnPath(rel(file), owners), path: [rel(file)] }));

    while (queue.length > 0) {
        const node = queue.shift();
        const stateKey = node.file + "|" + (node.governed ? "G" : "U");
        if (seenState.has(stateKey)) continue;
        seenState.add(stateKey);
        visited.add(node.file);

        const source = readIfFile(node.file);
        if (source === null) continue;

        const { raw } = stripComments(source);
        const specifiers = extractSpecifiers(raw);
        const bindings = extractBindings(raw, specifiers);
        const registryAliases = [];
        for (const [identifier, info] of bindings) {
            const target = resolveRelative(node.file, info.spec);
            if (!target) continue;
            const kind = moduleKind(target, reexportCache, registryModuleNames);
            if (!kind) continue;
            registryAliases.push({ name: identifier, kind, form: info.form });
        }

        const sinks = detectSinks(source, registryAliases);
        modules.set(node.file, { sinks, specifiers });

        for (const sink of sinks) {
            const row = {
                file: rel(node.file),
                kind: sink.kind,
                actionCapable: sink.actionCapable,
                line: sink.line,
                snippet: sink.snippet,
                entrypoint: node.path[0],
                path: node.path.slice(0, 12)
            };
            (node.governed ? governed : ungoverned).push(row);
        }

        for (const { spec } of specifiers) {
            const target = resolveRelative(node.file, spec);
            if (!target) continue;
            queue.push({
                file: target,
                governed: node.governed || canonicalOwnerOnPath(rel(target), owners),
                path: node.path.concat(rel(target))
            });
        }
        queue.sort((a, b) => a.file.localeCompare(b.file));
    }

    const sortRows = (rows) => rows.slice().sort((a, b) =>
        a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));

    // Operator launchers: reported, never gated (see DEFAULT_LAUNCHERS).
    const launcherFiles = (options.launchers ?? DEFAULT_LAUNCHERS)
        .map(l => path.resolve(root, l))
        .filter(f => fs.existsSync(f))
        .sort();
    const launcherSinks = [];
    for (const file of launcherFiles) {
        const source = readIfFile(file);
        if (source === null) continue;
        for (const sink of detectSinks(source, [])) {
            launcherSinks.push({
                file: rel(file),
                kind: sink.kind,
                actionCapable: sink.actionCapable,
                line: sink.line,
                snippet: sink.snippet
            });
        }
    }

    const findings = sortRows(ungoverned);
    const actionCapableFindings = findings.filter(r => r.actionCapable);

    // UNCLASSIFIED_LEGACY_REACHABILITY: a reachable module that requires a
    // registry module DIRECTLY yet shows no recognized sink at all — its
    // execution form is not classified. Reported rather than silently excused.
    // (A transitive re-export chain is a wrapper/facade, not an unknown form.)
    const unclassified = [];
    for (const [file, info] of modules) {
        if (info.sinks.length > 0) continue;
        // A pure re-export of a registry IS classified (moduleKind), so it is
        // not an unknown execution form.
        if (moduleKind(file, reexportCache, registryModuleNames)) continue;
        for (const { spec } of info.specifiers) {
            const target = resolveRelative(file, spec);
            if (!target) continue;
            if (isRegistryModule(target, registryModuleNames)) {
                unclassified.push(rel(file));
                break;
            }
        }
    }

    let sha = null;
    try {
        sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    }
    catch { /* not a git checkout */ }

    const report = {
        schemaVersion: SCHEMA_VERSION,
        sha,
        root: rel(root) === "" ? "." : rel(root),
        entrypoints: entrypoints.map(rel).sort(),
        counters: {
            LEGACY_SECOND_PATH: findings.length,
            ACTION_CAPABLE_UNGOVERNED: actionCapableFindings.length,
            UNCLASSIFIED_LEGACY_REACHABILITY: unclassified.length,
            GOVERNED_SINK_SITES: governed.length,
            REACHABLE_MODULES: visited.size,
            LAUNCHER_SINK_SITES: launcherSinks.length
        },
        launchers: launcherFiles.map(rel).sort(),
        launcherSinks: sortRows(launcherSinks),
        findings,
        governed: sortRows(governed),
        unclassified: unclassified.sort(),
        reachableModules: [...visited].map(rel).sort()
    };

    report.ok = options.strictAll
        ? findings.length === 0 && unclassified.length === 0
        : actionCapableFindings.length === 0 && unclassified.length === 0;

    return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const out = { json: false, strictAll: false, root: process.cwd(), entrypoints: undefined };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--json") out.json = true;
        else if (a === "--strict-all") out.strictAll = true;
        else if (a === "--root") out.root = argv[++i];
        else if (a === "--entrypoints") out.entrypoints = String(argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
        else if (a === "--help" || a === "-h") out.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    return out;
}

function main(argv) {
    const args = parseArgs(argv);
    if (args.help) {
        process.stdout.write("usage: node scripts/wave8-census.js [--json] [--strict-all] [--root DIR] [--entrypoints a.js,b.js]\n");
        return 0;
    }

    const report = analyze({ root: args.root, entrypoints: args.entrypoints, strictAll: args.strictAll });

    if (args.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return report.ok ? 0 : 1;
    }

    const c = report.counters;
    process.stdout.write(`WAVE8 LEGACY CENSUS  sha=${report.sha ?? "(not a git checkout)"}\n`);
    process.stdout.write(`entrypoints: ${report.entrypoints.join(", ") || "(none found)"}\n\n`);
    process.stdout.write(`LEGACY_SECOND_PATH                = ${c.LEGACY_SECOND_PATH}\n`);
    process.stdout.write(`ACTION_CAPABLE_UNGOVERNED         = ${c.ACTION_CAPABLE_UNGOVERNED}\n`);
    process.stdout.write(`UNCLASSIFIED_LEGACY_REACHABILITY  = ${c.UNCLASSIFIED_LEGACY_REACHABILITY}\n`);
    process.stdout.write(`governed sink sites               = ${c.GOVERNED_SINK_SITES}\n`);
    process.stdout.write(`reachable modules                 = ${c.REACHABLE_MODULES}\n`);
    process.stdout.write(`launcher sink sites (not gated)   = ${c.LAUNCHER_SINK_SITES}\n`);

    if (report.findings.length > 0) {
        process.stdout.write("\nungoverned sink sites:\n");
        for (const f of report.findings) {
            process.stdout.write(`  [${f.kind}] ${f.file}:${f.line}  (via ${f.entrypoint})\n`);
            process.stdout.write(`      ${f.snippet}\n`);
            process.stdout.write(`      path: ${f.path.join(" -> ")}\n`);
        }
    }
    if (report.unclassified.length > 0) {
        process.stdout.write("\nunclassified reachable modules (registry required, no recognized sink):\n");
        for (const u of report.unclassified) process.stdout.write(`  ${u}\n`);
    }

    process.stdout.write(report.ok ? "\nRESULT: no ungoverned route found\n" : "\nRESULT: UNGOVERNED ROUTE(S) FOUND\n");
    return report.ok ? 0 : 1;
}

module.exports = {
    analyze, stripComments, detectSinks, resolveRelative,
    SINK_KINDS, DEFAULT_CANONICAL_OWNERS, DEFAULT_ENTRYPOINTS, DEFAULT_LAUNCHERS, DEFAULT_REGISTRY_MODULES,
    main
};

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    }
    catch (error) {
        process.stderr.write(`census failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
