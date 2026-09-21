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
 *   package specifiers are recorded as external. A DYNAMIC specifier
 *   (require(variable), import(expr)) is not resolvable statically and is not
 *   walked; such a call is still reported as a sink when it is reached through a
 *   root's execution surface (e.g. pluginLoader.loadOne()), which is the place
 *   the oracle can see.
 * - A root's execution surfaces are declared (EXECUTION_SURFACES) rather than
 *   inferred, and a regression test pins them to the roots' real source: a
 *   renamed or removed surface fails the test instead of silently weakening the
 *   census.
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

// Registry/plugin ROOTS — the modules whose job is to install and dispatch
// handlers — mapped to the sink kind a call on them produces. A binding to one of
// these (directly, through a barrel, or through a pure re-export chain) carries
// the root's kind.
const REGISTRY_ROOT_KINDS = {
    "ToolRegistry.js": "registry_execution",
    "pluginManager.js": "plugin_handler_execution",
    "pluginLoader.js": "plugin_handler_execution"
};

const DEFAULT_REGISTRY_MODULES = Object.keys(REGISTRY_ROOT_KINDS);

/**
 * EXECUTION SURFACES: the members of a root that can reach executable behaviour.
 * Every other member a root exposes is data access or bookkeeping, and calling it
 * is not an execution form.
 *
 *   registry_execution
 *     execute()  — dispatches a registered handler (ToolRegistry.js:82).
 *     invoke()   — the alternative dispatch name.
 *     get/has/entries/describe/clear are data or bookkeeping.
 *   plugin_handler_execution
 *     execute()/invoke()  — dispatch a plugin handler (pluginManager.js:8).
 *     load()/loadRoot()/loadOne() — require() plugin artifact modules
 *                           (pluginLoader.js:48/62/289 -> loadTools():598), so the
 *                           artifact body runs and its tools are registered.
 *     userRoot/forgeQuarantineRoot are pure getters, isForgeGenerated/loadManifest
 *     read metadata, unloadPlugin unregisters — none of them runs artifact code.
 */
const EXECUTION_SURFACES = {
    registry_execution: ["execute", "invoke"],
    plugin_handler_execution: ["execute", "invoke", "load", "loadRoot", "loadOne"]
};

// The identifiers literal source names a root by (derived from the root filenames,
// so there is one source of truth): `ToolRegistry.execute(...)` reached through a
// destructuring require, or an unbound/global root name.
const ROOT_IDENTIFIERS = Object.fromEntries(
    Object.entries(REGISTRY_ROOT_KINDS).map(([file, kind]) => [file.replace(/\.js$/, ""), kind])
);

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
 *   code    — comment and string-literal CONTENT blanked (call sinks cannot be
 *             hidden in, or faked by, a string).
 *   raw     — comments removed, string content kept (specifiers are READ from
 *             here, but only at offsets the `code` view proves are real code).
 * Template literal TEXT is data like any other literal, but `${...}` is live
 * code, so the interpolation body stays in `code`.
 */
function stripComments(source) {
    let code = "";
    let raw = "";
    let i = 0;
    const n = source.length;

    // One frame per open construct, so `code` can be re-entered from a template
    // interpolation without losing what it restores to:
    //   line_comment | block_comment | string{quote} | template | interp{brace}
    const stack = [];

    const blank = (c) => (c === "\n" ? "\n" : " ");

    while (i < n) {
        const c = source[i];
        const c2 = i + 1 < n ? source[i + 1] : "";
        const frame = stack.length > 0 ? stack[stack.length - 1] : null;
        const kind = frame === null ? "code" : frame.kind;

        if (kind === "code" || kind === "interp") {
            if (kind === "interp") {
                if (c === "}") {
                    if (frame.brace === 0) { stack.pop(); code += "}"; raw += "}"; i += 1; continue; }
                    frame.brace -= 1; code += c; raw += c; i += 1; continue;
                }
                if (c === "{") { frame.brace += 1; code += c; raw += c; i += 1; continue; }
            }
            if (c === "/" && c2 === "/") { stack.push({ kind: "line_comment" }); code += "  "; raw += "  "; i += 2; continue; }
            if (c === "/" && c2 === "*") { stack.push({ kind: "block_comment" }); code += "  "; raw += "  "; i += 2; continue; }
            if (c === "`") { stack.push({ kind: "template" }); code += " "; raw += c; i += 1; continue; }
            if (c === '"' || c === "'") { stack.push({ kind: "string", quote: c }); code += " "; raw += c; i += 1; continue; }
            code += c; raw += c; i += 1; continue;
        }

        if (kind === "line_comment") {
            if (c === "\n") { stack.pop(); code += "\n"; raw += "\n"; i += 1; continue; }
            code += " "; raw += " "; i += 1; continue;
        }

        if (kind === "block_comment") {
            if (c === "*" && c2 === "/") { stack.pop(); code += "  "; raw += "  "; i += 2; continue; }
            code += blank(c); raw += blank(c); i += 1; continue;
        }

        if (kind === "string") {
            if (c === "\\") { code += "  "; raw += c + c2; i += 2; continue; }
            if (c === frame.quote) { stack.pop(); code += " "; raw += c; i += 1; continue; }
            code += blank(c); raw += c; i += 1; continue;
        }

        // kind === "template": text is DATA (blanked in `code`); `${` is CODE.
        if (c === "\\") { code += "  "; raw += c + c2; i += 2; continue; }
        if (c === "`") { stack.pop(); code += " "; raw += c; i += 1; continue; }
        if (c === "$" && c2 === "{") { stack.push({ kind: "interp", brace: 0 }); code += "${"; raw += "${"; i += 2; continue; }
        code += blank(c); raw += c; i += 1; continue;
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

/** The string literal at or after `index` of `raw`, or null if there is none. */
function quotedAt(raw, index) {
    let i = index;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    const q = raw[i];
    if (q !== '"' && q !== "'") return null;
    let out = "";
    for (i += 1; i < raw.length; i += 1) {
        if (raw[i] === "\\") { out += raw[i + 1] ?? ""; i += 1; continue; }
        if (raw[i] === q) return out;
        if (raw[i] === "\n") return null;
        out += raw[i];
    }
    return null;
}

/** The literal specifier right after `index`, through an optional `(`. */
function specAt(raw, index) {
    let i = index;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (raw[i] === "(") i += 1;
    return quotedAt(raw, i);
}

/**
 * Literal `require("x")` / `import("x")` arguments that are REAL CODE.
 *
 * The call head is matched on the string-blanked `code` view — so a mention
 * inside a string or comment cannot masquerade as a dependency — and the
 * argument is read out of `raw` at the same offset (the views share offsets).
 * A computed/dynamic argument yields no literal and is reported as null spec.
 */
function moduleCalls(code, raw) {
    const out = [];
    const re = /\b(require|import)\b/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        out.push({ keyword: m[1], index: m.index, spec: specAt(raw, re.lastIndex) });
    }
    return out;
}

/** Relative require()/import() specifiers, in source order. */
function extractSpecifiers(code, raw) {
    const found = [];
    for (const call of moduleCalls(code, raw)) {
        if (call.spec !== null) found.push({ spec: call.spec, index: call.index });
    }
    return found.sort((a, b) => a.index - b.index);
}

/**
 * Bindings to required modules, with the FORM of the binding:
 *   module — `const X = require("./ToolRegistry.js")`: the bound name IS the
 *            module, so its execution surfaces are called on the binding
 *            (`X.execute(...)`, `X.load(...)`, `X"..."`).
 *   member — anything destructured: the bound name may be the module (`{ ToolRegistry }`),
 *            the member itself (`{ execute }`) or a renamed member (`{ load: boot }`),
 *            so BOTH a direct call and the module's execution surfaces are scanned.
 */
function extractBindings(code, raw) {
    const bindings = new Map();     // identifier -> { spec, member?, form }
    const HEAD = 200;               // enough for `const { a, b: c } = `
    for (const call of moduleCalls(code, raw)) {
        if (call.spec === null) continue;
        const before = code.slice(Math.max(0, call.index - HEAD), call.index);
        let m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
        if (m) { bindings.set(m[1], { spec: call.spec, form: "module" }); continue; }

        m = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*$/.exec(before);
        if (m) {
            for (const part of m[1].split(",")) {
                const pieces = part.split(":");
                const alias = (pieces.length > 1 ? pieces[1] : pieces[0]).trim();
                if (alias && /^[A-Za-z_$][\w$]*$/.test(alias)) {
                    bindings.set(alias, {
                        spec: call.spec,
                        member: (pieces[0] ?? "").trim(),
                        form: "member"
                    });
                }
            }
        }
    }
    return bindings;
}

// ---------------------------------------------------------------------------
// Sink detection (runs on the string-blanked `code` view)
// ---------------------------------------------------------------------------

// `x.m(` and `x.m (` and `x?.m(` are the same call site — the oracle must not be
// bypassable by an optional chain or by whitespace around the dot.
const CALL = "\\s*(?:\\?\\.|\\.)\\s*";

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Sink kind produced by calling `surface` on a root of `kind`. */
function surfaceKind(kind, surface) {
    return surface === "invoke" ? "tool_handler_invocation" : kind;
}

/**
 * @param rootRequires {spec, kind}[] — roots THIS module requires inline
 *        (`require("./pluginLoader").loadOne(p)`), which no binding covers.
 */
function detectSinks(source, registryAliases, rootRequires = []) {
    const { code, raw } = stripComments(source);
    const sinks = [];
    const seen = new Set();

    const push = (kind, index, snippet) => {
        // One call site, one row: the alias scan, the literal-identifier scan and
        // the inline-require scan may all see the same text, and a site must never
        // be counted twice.
        const key = index + "|" + kind;
        if (seen.has(key)) return;
        seen.add(key);
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

    const Q = "[\\u0022\\u0027]";

    for (const alias of registryAliases) {
        const a = "\\b" + escapeRe(alias.name);
        for (const surface of EXECUTION_SURFACES[alias.kind] ?? []) {
            scan(new RegExp(a + CALL + surface + "\\s*\\(", "g"), surfaceKind(alias.kind, surface));
        }
        // A destructured name may be invoked directly (`{ execute }`, `{ load: boot }`),
        // while a module binding never is — the module is not the function.
        if (alias.form === "member") {
            scan(new RegExp("(?:^|[;=(\\[,]|\\breturn\\b|\\bawait\\b)\\s*" + escapeRe(alias.name) + "\\s*\\(", "g"), alias.kind);
        }
        scan(new RegExp(a + "\\s*\\[\\s*[^\\]]+\\]\\s*\\(", "g"), alias.kind);
    }

    // Roots named literally, independent of aliasing: `ToolRegistry.execute(...)`
    // after a destructuring require, or through generated/indirect code.
    for (const [identifier, kind] of Object.entries(ROOT_IDENTIFIERS)) {
        for (const surface of EXECUTION_SURFACES[kind]) {
            scan(new RegExp("\\b" + identifier + CALL + surface + "\\s*\\(", "g"), surfaceKind(kind, surface));
        }
        scan(new RegExp("\\b" + identifier + "\\s*\\[\\s*[^\\]]+\\]\\s*\\(", "g"), kind);
    }

    // Inline requires of a root in this same module — `require("./pluginLoader").loadOne(p)`.
    // Matched on `raw` (where the specifier is intact) and accepted ONLY where the
    // blanked view proves the `require` keyword is real code, so a mention inside a
    // string literal cannot fake an inline call.
    for (const { spec, kind } of rootRequires) {
        const call = "require\\s*\\(\\s*" + Q + escapeRe(spec) + Q + "\\s*\\)";
        const accept = (re, sinkKind) => {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(raw)) !== null) {
                if (code.startsWith("require", m.index)) push(sinkKind, m.index, m[0]);
            }
        };
        for (const surface of EXECUTION_SURFACES[kind] ?? []) {
            accept(new RegExp(call + CALL + surface + "\\s*\\(", "g"), surfaceKind(kind, surface));
        }
        accept(new RegExp(call + "\\s*\\[\\s*[^\\]]+\\]\\s*\\(", "g"), kind);
    }

    // Direct handler/tool invocation shapes.
    scan(new RegExp("\\b(?:tool|handler|toolInstance|instance|registered)" + CALL + "execute\\s*\\(", "g"), "tool_handler_invocation");
    // Bare handler( call forms only: a prefix that implies invocation, minus a
    // definition body (`handler(a) { ... }`), so declarations and object-literal
    // methods are not false positives.
    scan(/(?:^|[;=(\[,]|\breturn\b|\bawait\b)\s*handler\s*\((?![^()]*\)\s*\{)/g, "tool_handler_invocation");

    // Process / shell: specifier-based (so documentation strings cannot match)
    // plus the classic driver calls.
    const requires = moduleCalls(code, raw);
    const scanSpec = (specRe, kind) => {
        for (const call of requires) {
            if (call.spec !== null && specRe.test(call.spec)) push(kind, call.index, `require("${call.spec}")`);
        }
    };
    scanSpec(/^(?:node:)?child_process$/, "process_shell");
    scan(/\b(?:execSync|spawnSync|execFileSync|spawn|fork)\s*\(/g, "process_shell");

    // Terminal / pty.
    scanSpec(/^(?:node-pty|pty)$/, "terminal");
    scan(/\b(?:terminal_run|TerminalRuntime|terminalService)\b/g, "terminal");
    scan(new RegExp("\\bpty" + CALL + "spawn\\s*\\(", "g"), "terminal");

    // Actuator / effector invocation.
    scan(new RegExp("\\bbinding" + CALL + "invoke\\s*\\(", "g"), "actuator_invocation");
    scan(new RegExp("\\bactuator" + CALL + "(?:invoke|execute|apply)\\s*\\(", "g"), "actuator_invocation");

    // Advisory kinds.
    scan(new RegExp("\\bfs" + CALL + "(?:writeFileSync|writeFile|appendFileSync|rmSync|rm|unlinkSync|renameSync|mkdirSync)\\s*\\(", "g"), "filesystem_mutation");
    scan(new RegExp("\\b(?:axios|http)" + CALL + "(?:post|put|patch|delete)\\s*\\(", "g"), "network_mutation");
    scan(new RegExp("\\bdevice" + CALL + "(?:send|write|command)\\s*\\(", "g"), "device_control");

    return sinks.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

/**
 * Calls on a DIRECTLY required root whose member the oracle does not recognise.
 * Reading a root's data property (`pluginLoader.userRoot`) or re-exporting it is a
 * form the oracle can classify; calling a member it cannot name is an execution
 * form it cannot classify, which is what UNCLASSIFIED_LEGACY_REACHABILITY reports.
 *
 * Only module bindings and inline requires are inspected: a destructured binding may
 * be a member rather than the module, and `X.member(` on it is a call on an object
 * the oracle has not identified, not a call on the root.
 */
function unknownRootCalls(source, registryAliases, directRootSpecs) {
    const { code } = stripComments(source);
    const unknown = [];
    const CALLM = CALL + "([A-Za-z_$][\\w$]*)\\s*\\(";
    const known = (kind, member) => (EXECUTION_SURFACES[kind] ?? []).includes(member);

    const probe = (prefixRe, kind) => {
        const re = new RegExp(prefixRe + CALLM, "g");
        let m;
        while ((m = re.exec(code)) !== null) if (!known(kind, m[1])) unknown.push(m[1]);
    };

    for (const alias of registryAliases) {
        if (alias.form !== "module") continue;
        probe("\\b" + escapeRe(alias.name), alias.kind);
    }
    const Q = "[\\u0022\\u0027]";
    for (const { spec, kind } of directRootSpecs) {
        probe("require\\s*\\(\\s*" + Q + escapeRe(spec) + Q + "\\s*\\)", kind);
    }
    return unknown;
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

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchingBrace(code, open) {
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
        if (code[i] === "{") depth += 1;
        else if (code[i] === "}") {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** [start, end) ranges of an object-literal body's top-level members. */
function memberRanges(body) {
    const ranges = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < body.length; i += 1) {
        const c = body[i];
        if (c === "(" || c === "[" || c === "{") depth += 1;
        else if (c === ")" || c === "]" || c === "}") depth -= 1;
        else if (c === "," && depth === 0) { ranges.push([start, i]); start = i + 1; }
    }
    ranges.push([start, body.length]);
    return ranges;
}

// A member of a PURE barrel. Matched on the string-blanked view, where a quoted
// key's text is blank and a quoted specifier is blank inside require( ).
const BARREL_NAMED = /^\s*[^:()]*:\s*require\s*\([^)]*\)\s*$/;
const BARREL_SPREAD = /^\s*\.\.\.\s*require\s*\([^)]*\)\s*$/;

/**
 * Specifiers a module RE-EXPORTS wholesale, in either module syntax:
 *   module.exports = require("./ToolRegistry.js")
 *   module.exports = { ToolRegistry: require("./ToolRegistry.js"), ... }   (pure barrel)
 *   exports.ToolRegistry = require("./ToolRegistry.js")
 *   export { ToolRegistry } from "./ToolRegistry.js"
 * Only a PURE re-export keeps a caller's binding a registry/plugin binding — a
 * façade that merely requires a registry internally is its own module, not the
 * registry.
 */
function extractReexports(source) {
    const { code, raw } = stripComments(source);
    const found = [];

    // Every pattern is matched on the blanked `code` view (so a mention inside a
    // string or comment cannot fake a re-export) and its specifier is read from
    // `raw` at the same offset. Each pattern ends at the `require` keyword / `from`.
    const scan = (re) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(code)) !== null) {
            const spec = specAt(raw, re.lastIndex);
            if (spec !== null) found.push(spec);
        }
    };

    // 1. Wholesale: `module.exports = require("./X")`.
    scan(/module\.exports\s*=\s*require/g);

    // 2. Object-literal barrel: `module.exports = { K: require("./X"), ... }`.
    //    Only a PURE barrel counts as BEING the re-exported module — every
    //    top-level member is a named or spread re-export. A module that merely
    //    mentions a root inside a mixed object literal is its own module, not the
    //    root; its NAMED members are still re-exports, and a caller that
    //    destructures one resolves through extractMemberReexports().
    const barrel = /module\.exports\s*=\s*\{/g;
    let m;
    while ((m = barrel.exec(code)) !== null) {
        const open = code.indexOf("{", m.index);
        const close = matchingBrace(code, open);
        if (close === -1) continue;
        const base = open + 1;
        const ranges = memberRanges(code.slice(base, close));
        let pure = true;
        for (const [s, e] of ranges) {
            const member = code.slice(base + s, base + e);
            if (member.trim() === "") continue;
            if (!BARREL_NAMED.test(member) && !BARREL_SPREAD.test(member)) { pure = false; break; }
        }
        if (!pure) continue;
        for (const [s, e] of ranges) {
            const member = code.slice(base + s, base + e);
            const inner = /\brequire\b/g;
            let r;
            while ((r = inner.exec(member)) !== null) {
                const spec = specAt(raw, base + s + inner.lastIndex);
                if (spec !== null) found.push(spec);
            }
        }
    }

    // 3. Named CommonJS: `exports.X = require("./X")` / `module.exports.X = ...`.
    scan(/(?:module\.)?exports\s*\.\s*[A-Za-z_$][\w$]*\s*=\s*require/g);

    // 4. ESM re-export: `export ... from "./X"`.
    scan(/export\s+(?:\*|\{[^}]*\})\s*from/g);

    return found;
}

/**
 * NAMED re-exports of a module export, as `member -> specifier`:
 *   module.exports = { ToolRegistry: require("./ToolRegistry.js"), version: 1 }
 *   exports.ToolRegistry = require("./ToolRegistry.js")
 *   export { ToolRegistry } from "./ToolRegistry.js"
 *
 * A caller that DESTRUCTURES one of these members binds the re-exported module
 * itself, so the kind must resolve through the member — a barrel that carries
 * extra data members is not the root, but its named member still is. Spread
 * re-exports carry no member name and are deliberately absent.
 */
function extractMemberReexports(source) {
    const { code, raw } = stripComments(source);
    const out = new Map();
    let m;

    const barrel = /module\.exports\s*=\s*\{/g;
    while ((m = barrel.exec(code)) !== null) {
        const open = code.indexOf("{", m.index);
        const close = matchingBrace(code, open);
        if (close === -1) continue;
        const base = open + 1;
        for (const [s, e] of memberRanges(code.slice(base, close))) {
            const member = code.slice(base + s, base + e);
            const key = /^\s*([A-Za-z_$][\w$]*)\s*:\s*require\b/.exec(member);
            if (!key) continue;
            const spec = specAt(raw, base + s + member.indexOf("require") + "require".length);
            if (spec !== null) out.set(key[1], spec);
        }
    }

    const named = /(?:module\.)?exports\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*require/g;
    while ((m = named.exec(code)) !== null) {
        const spec = specAt(raw, named.lastIndex);
        if (spec !== null) out.set(m[1], spec);
    }

    const esm = /export\s*\{([^}]*)\}\s*from/g;
    while ((m = esm.exec(code)) !== null) {
        const spec = specAt(raw, esm.lastIndex);
        if (spec === null) continue;
        for (const part of m[1].split(",")) {
            const pieces = part.split(/\s+as\s+/);
            const name = (pieces[1] ?? pieces[0] ?? "").trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) out.set(name, spec);
        }
    }

    return out;
}

/**
 * Which kind of execution surface this module IS (directly, or through a chain
 * of PURE re-exports): "registry_execution" | "plugin_handler_execution" | null.
 */
function moduleKind(file, cache, depth = 0) {
    if (depth > 4) return null;
    const key = "kind:" + file;
    if (cache.has(key)) return cache.get(key);
    cache.set(key, null);

    const base = path.basename(file);
    let kind = REGISTRY_ROOT_KINDS[base] ?? null;
    if (!kind) {
        const source = readIfFile(file);
        if (source !== null) {
            for (const spec of extractReexports(source)) {
                const target = resolveRelative(file, spec);
                if (!target) continue;
                const found = moduleKind(target, cache, depth + 1);
                if (found) { kind = found; break; }
            }
        }
    }

    cache.set(key, kind);
    return kind;
}

/** Named re-exports of `file`, cached. */
function memberReexportsOf(file, cache) {
    const key = "members:" + file;
    if (cache.has(key)) return cache.get(key);
    const source = readIfFile(file);
    const map = source === null ? new Map() : extractMemberReexports(source);
    cache.set(key, map);
    return map;
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

        const { code, raw } = stripComments(source);
        const specifiers = extractSpecifiers(code, raw);
        const bindings = extractBindings(code, raw);

        // Roots this module reaches by name, split by how they are reached.
        const rootRequires = [];      // any root (incl. barrels) — inline call support
        const directRootSpecs = [];   // the root module itself — the UNCLASSIFIED trigger
        for (const { spec } of specifiers) {
            const target = resolveRelative(node.file, spec);
            if (!target) continue;
            const kind = moduleKind(target, reexportCache);
            if (kind) rootRequires.push({ spec, kind });
            if (isRegistryModule(target, registryModuleNames)) directRootSpecs.push({ spec, kind });
        }

        const registryAliases = [];
        for (const [identifier, info] of bindings) {
            const target = resolveRelative(node.file, info.spec);
            if (!target) continue;
            let kind = moduleKind(target, reexportCache);
            if (!kind && info.member) {
                // A member destructured out of a module that re-exports it by name
                // (and is not itself a pure barrel of the root).
                const viaMember = memberReexportsOf(target, reexportCache).get(info.member);
                const memberTarget = viaMember ? resolveRelative(target, viaMember) : null;
                if (memberTarget) kind = moduleKind(memberTarget, reexportCache);
            }
            if (!kind) continue;
            registryAliases.push({
                name: identifier,
                kind,
                form: info.form,
                direct: isRegistryModule(target, registryModuleNames)
            });
        }

        const sinks = detectSinks(source, registryAliases, rootRequires);
        const unknownRoot = unknownRootCalls(
            source,
            registryAliases.filter(a => a.direct),
            directRootSpecs
        );
        modules.set(node.file, { sinks, specifiers, directRootSpecs, unknownRoot });

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
    // registry/plugin root DIRECTLY, shows no recognized sink, and CALLS a member
    // of that root the oracle cannot name — its execution form is not classified.
    // Reported rather than silently excused. Excluded by evidence, not by name:
    //   - a pure re-export chain / barrel IS the root (moduleKind), not an unknown form;
    //   - a module that only READS root data (`pluginLoader.userRoot`) or re-exports
    //     it never invokes the execution surface, so it has no unknown form to report;
    //   - a module that invokes a root at all without a recognized sink still is.
    const unclassified = [];
    for (const [file, info] of modules) {
        if (info.sinks.length > 0) continue;
        if (moduleKind(file, reexportCache)) continue;
        if (info.directRootSpecs.length === 0) continue;
        if (info.unknownRoot.length === 0) continue;
        unclassified.push(rel(file));
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
    analyze, stripComments, detectSinks, unknownRootCalls, resolveRelative,
    extractSpecifiers, extractBindings, extractReexports, extractMemberReexports, moduleCalls,
    SINK_KINDS, DEFAULT_CANONICAL_OWNERS, DEFAULT_ENTRYPOINTS, DEFAULT_LAUNCHERS, DEFAULT_REGISTRY_MODULES,
    REGISTRY_ROOT_KINDS, EXECUTION_SURFACES,
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
