#!/usr/bin/env node
"use strict";

/**
 * W8-IW1 PRODUCTION CENSUS — MIGRATION MANIFEST GENERATOR.
 *
 * Deterministic: derived ONLY from scripts/wave8-census.js output (plus git HEAD),
 * so the manifest is regenerable and never drifts from the counter oracle.
 *
 *   node scripts/wave8-iw1-migration-manifest.js
 *   node scripts/wave8-iw1-migration-manifest.js --json
 *
 * Fields that require call-site dataflow (symbol, authority source, verification,
 * audit, replay) are marked RECON_REQUIRED in the first pass and filled per
 * cluster during migration; they are never guessed.
 */

const fs = require("node:fs");
const path = require("node:path");
const { analyze } = require("./wave8-census.js");

const CLUSTER_BY_PREFIX = [
    ["src/runtime/terminal/", "C2-TERMINAL"],
    ["src/voice/", "C3-VOICE-IO"],
    ["src/services/", "C4-SERVICES-ACTUATION"],
    ["src/autonomy/", "C5-AUTONOMY-DAEMONS"],
    ["src/lab/", "C6-LAB-TIMEMACHINE"],
    ["src/mcp/", "C7-MCP-EGRESS"],
    ["src/android/", "C8-DEVICE-BRIDGES"],
    ["src/kali/", "C8-DEVICE-BRIDGES"],
    ["src/ml/", "C8-DEVICE-BRIDGES"],
    ["src/security/", "C8-DEVICE-BRIDGES"],
    ["src/ai/", "C9-AI-TOOL-DISPATCH"],
    ["src/core/tools/", "C9-AI-TOOL-DISPATCH"],
    ["src/core/verify/", "C10-VERIFICATION"],
    ["src/cognition/", "C11-COGNITION-TOOLS"],
    ["src/controllers/", "C12-HTTP-CONTROLLERS"],
    ["src/authority/", "C1-AUTHORITY-STORE"],
    ["src/agent/", "C13-AGENT-PERSIST"],
    ["src/database/", "C13-AGENT-PERSIST"],
    ["src/memory/", "C13-AGENT-PERSIST"],
    ["src/core/config/", "C13-AGENT-PERSIST"],
    ["src/core/safety/", "C13-AGENT-PERSIST"],
    ["src/channels/", "C13-AGENT-PERSIST"],
    ["src/companion/", "C4-SERVICES-ACTUATION"],
    ["src/mataDewa/", "C13-AGENT-PERSIST"],
    ["src/mcp/configStore.js", "C7-MCP-EGRESS"],
    ["src/plugins/", "C7-MCP-EGRESS"]
];

/**
 * Explicit resolution of the 4 UNCLASSIFIED_LEGACY_REACHABILITY entries.
 * Each entry records what the module actually does, so the count can only reach
 * 0 by migration or by an evidence-backed correction of the census rule — never
 * by suppression.
 */
const UNCLASSIFIED_RESOLUTION = {
    "src/app.js": {
        census_category: "UNCLASSIFIED_LEGACY_REACHABILITY",
        source_file: "src/app.js",
        symbol: "pluginLoader.load(  @ src/app.js:7",
        reachable_from_production: "YES",
        consequential: "YES",
        authority_path: "NONE on this path (no canonical owner traversed)",
        execution_path: "src/server.js -> src/app.js -> plugins/pluginLoader.load(...)",
        classification: "A_REAL_PRODUCTION_CONSEQUENTIAL_PATH",
        rule_finding: "CENSUS_RULE_GAP_UNDER_REPORT",
        evidence:
            "src/app.js:4 `const pluginLoader = require(\"./plugins/pluginLoader\")` (namespace binding of a " +
            "DEFAULT_REGISTRY_MODULE), then src/app.js:7 `pluginLoader.load(`. detectSinks only recognises the " +
            "literal form `pluginLoader.loadOne(` (line 256), so a real plugin-load invocation is unclassified " +
            "instead of being reported as plugin_handler_execution (actionCapable: true). Fixing the rule ADDS a " +
            "finding (counter increases) — it is a real ungoverned action-capable path, not a false positive.",
        migration_status: "PENDING_RULE_FIX_THEN_MIGRATE"
    },
    "src/autonomy/CapabilityRegistry.js": {
        census_category: "UNCLASSIFIED_LEGACY_REACHABILITY",
        source_file: "src/autonomy/CapabilityRegistry.js",
        symbol: "pluginLoader.userRoot  @ src/autonomy/CapabilityRegistry.js:75-76",
        reachable_from_production: "YES",
        consequential: "NO",
        authority_path: "N/A (no execution surface)",
        execution_path: "src/server.js -> src/autonomy/index.js -> CapabilityRegistry",
        classification: "B_NON_CONSEQUENTIAL_READ",
        rule_finding: "CENSUS_RULE_GAP_OVER_REPORT",
        evidence:
            "The only registry-module require is line 75 `require(\"../plugins/pluginLoader\")`, used at line 76 for " +
            "the data property `pluginLoader.userRoot`. There is no invocation of the registry surface. Every other " +
            "call in the file is `database.run(...)` against `../memory/db` (persistence, not a registry execution " +
            "form). Requiring a registry module for a data property is not an unknown execution form.",
        migration_status: "RESOLVED_BY_CLASSIFICATION"
    },
    "src/autonomy/SkillFactory.js": {
        census_category: "UNCLASSIFIED_LEGACY_REACHABILITY",
        source_file: "src/autonomy/SkillFactory.js",
        symbol: "require(\"../plugins/pluginLoader\").userRoot  @ src/autonomy/SkillFactory.js:33",
        reachable_from_production: "YES",
        consequential: "NO",
        authority_path: "N/A (no execution surface)",
        execution_path: "src/server.js -> src/autonomy/index.js -> SkillFactory",
        classification: "E_COMPATIBILITY_ADAPTER",
        rule_finding: "CENSUS_RULE_GAP_OVER_REPORT",
        evidence:
            "Same trigger as CapabilityRegistry: line 33 reads `require(\"../plugins/pluginLoader\").userRoot`. " +
            "Line 134 `ToolRegistry.describe()` is a metadata READ. The `execute(` occurrences at lines 311/335/341 " +
            "and `module.exports = [new Tool()];` at line 344 are inside STRING literals written to a generated " +
            "plugin file, not executed in this module. Its only persistence goes through `../services/toolForge` " +
            "(censused separately as filesystem_mutation).",
        migration_status: "RESOLVED_BY_CLASSIFICATION"
    },
    "src/core/tools/index.js": {
        census_category: "UNCLASSIFIED_LEGACY_REACHABILITY",
        source_file: "src/core/tools/index.js",
        symbol: "module.exports = { ToolRegistry: require(\"./ToolRegistry\"), ... }",
        reachable_from_production: "YES",
        consequential: "NO",
        authority_path: "N/A (no execution surface)",
        execution_path: "src/server.js -> ... -> src/core/tools/index.js",
        classification: "F_DUPLICATE_CENSUS_DETECTION",
        rule_finding: "CENSUS_RULE_GAP_OVER_REPORT",
        evidence:
            "A 17-line barrel whose entire body is `module.exports = { X: require(\"./X\") }`. It has no sink of its " +
            "own and IS a façade, but moduleKind's extractReexports only matches the wholesale form " +
            "`module.exports = require(\"...\")` (line 332), so an object-literal barrel is not recognised as a " +
            "re-export chain and falls through to the unclassified bucket. The census's own comment (line 474) says " +
            "a façade is not an unknown execution form. Duplicate detection of ToolRegistry.js.",
        migration_status: "RESOLVED_BY_CLASSIFICATION"
    }
};


/** Consequential = the census actionCapable kinds; advisory kinds are mutating but
 *  not gated by the exit condition, and are clustered separately. */
function clusterFor(file, actionCapable) {
    for (const [prefix, id] of CLUSTER_BY_PREFIX) if (file.startsWith(prefix)) return id;
    return actionCapable ? "C0-UNCLUSTERED-ACTION" : "C14-UNCLUSTERED-ADVISORY";
}

/** Risk: consequence severity x how directly the sink can reach a physical effect. */
function riskFor(finding) {
    if (finding.kind === "terminal" || finding.kind === "actuator_invocation") return "P0";
    if (finding.kind === "tool_handler_invocation" || finding.kind === "registry_execution") return "P0";
    if (finding.kind === "process_shell") return finding.path.length <= 4 ? "P0" : "P1";
    if (finding.kind === "network_mutation" || finding.kind === "device_control") return "P1";
    return "P2";
}

/** Signed distance from a production entrypoint to the sink module. */
function hops(finding) {
    return finding.path.length - 1;
}

function build(root = process.cwd()) {
    const rep = analyze({ root });

    const rows = rep.findings.map((f) => {
        const actionCapable = f.actionCapable === true;
        return {
            id: `${f.file}:${f.line}:${f.kind}`,
            census_category: "LEGACY_SECOND_PATH",
            source_file: f.file,
            line: f.line,
            kind: f.kind,
            snippet: f.snippet,
            action_capable: actionCapable,
            consequential: actionCapable ? "YES" : "NO",
            entrypoint: f.entrypoint,
            execution_path: f.path.join(" -> "),
            hops: hops(f),
            cluster: clusterFor(f.file, actionCapable),
            risk: riskFor(f),
            symbol: "RECON_REQUIRED",
            production_reachability: "REACHABLE_FROM_ENTRYPOINT",
            capability_family: "RECON_REQUIRED",
            operation_type: "RECON_REQUIRED",
            authority_source: "RECON_REQUIRED",
            verification_mechanism: "RECON_REQUIRED",
            audit_mechanism: "RECON_REQUIRED",
            replay_durability: "RECON_REQUIRED",
            canonical_migration_destination: "RECON_REQUIRED",
            required_tests: "RECON_REQUIRED",
            classification: "H_UNKNOWN_REQUIRES_RECON",
            migration_status: "PENDING"
        };
    });

    const clusters = {};
    for (const r of rows) {
        const c = (clusters[r.cluster] = clusters[r.cluster] || { id: r.cluster, hits: 0, action_capable: 0, files: new Set(), max_risk: "P2" });
        c.hits += 1;
        if (r.action_capable) c.action_capable += 1;
        c.files.add(r.source_file);
        if (r.risk < c.max_risk) c.max_risk = r.risk;
    }

    const clusterList = Object.values(clusters)
        .map((c) => ({
            id: c.id,
            hits: c.hits,
            action_capable: c.action_capable,
            files: c.files.size,
            max_risk: c.max_risk,
            priority: (c.action_capable > 0 ? 0 : 1) * 1000 + c.hits
        }))
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    return {
        schemaVersion: 1,
        sha: rep.sha,
        generatedFrom: "scripts/wave8-census.js",
        counters: rep.counters,
        unclassified: rep.unclassified.map((file) => UNCLASSIFIED_RESOLUTION[file] ?? {
            census_category: "UNCLASSIFIED_LEGACY_REACHABILITY",
            source_file: file,
            symbol: "RECON_REQUIRED",
            reachable_from_production: "RECON_REQUIRED",
            consequential: "RECON_REQUIRED",
            authority_path: "RECON_REQUIRED",
            execution_path: "RECON_REQUIRED",
            classification: "H_UNKNOWN_REQUIRES_RECON",
            evidence: "RECON_REQUIRED"
        }),
        clusters: clusterList,
        findings: rows
    };
}

function main(argv) {
    const json = argv.includes("--json");
    const manifest = build(process.cwd());
    const out = path.join(process.cwd(), "wave8-iw1-migration-manifest.json");
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");

    if (json) { process.stdout.write(JSON.stringify(manifest, null, 2) + "\n"); return 0; }

    process.stdout.write(`W8-IW1 MIGRATION MANIFEST  sha=${manifest.sha}\n`);
    process.stdout.write(`  hits=${manifest.findings.length} clusters=${manifest.clusters.length} unclassified=${manifest.unclassified.length}\n\n`);
    for (const c of manifest.clusters) {
        process.stdout.write(`  ${c.id.padEnd(28)} hits=${String(c.hits).padStart(3)} action_capable=${String(c.action_capable).padStart(2)} files=${String(c.files).padStart(2)} max_risk=${c.max_risk}\n`);
    }
    process.stdout.write(`\nwrote ${path.relative(process.cwd(), out)}\n`);
    return 0;
}

module.exports = { build, clusterFor, riskFor };

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (error) { process.stderr.write(`manifest failed: ${error.message}\n`); process.exitCode = 1; }
}
