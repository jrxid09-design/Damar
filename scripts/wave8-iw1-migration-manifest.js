#!/usr/bin/env node
"use strict";

/**
 * W8-IW1 PRODUCTION CENSUS — MIGRATION MANIFEST GENERATOR.
 *
 * Deterministic: derived ONLY from scripts/wave8-census.js output (plus git HEAD),
 * so the manifest is regenerable and never drifts from the counter oracle.
 *
 * `sha` is the git HEAD that the census MEASURED (the census reports the HEAD of
 * the tree it read). Because the manifest is itself committed, this field names the
 * measured baseline commit and deliberately trails the commit that carries the
 * manifest by one: re-running the generator at a later HEAD rewrites it. Compare a
 * manifest against a census run by the counters, not by re-reading `sha`.
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
const { execFileSync } = require("node:child_process");
const { analyze } = require("./wave8-census.js");

const CLUSTER_BY_PREFIX = [
    ["src/runtime/terminal/", "C2-TERMINAL"],
    ["src/voice/", "C3-VOICE-IO"],
    // src/app.js is the production bootstrap that drives the plugin loader, so it
    // is clustered with the plugin subsystem it owns rather than left unclustered.
    ["src/app.js", "C7-MCP-EGRESS"],
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
 * Explicit resolution of the four entries the pre-C0 census reported as
 * UNCLASSIFIED_LEGACY_REACHABILITY. Kept in the manifest as the provenance of the
 * rule repair: the census now derives these classifications itself (see
 * `scripts/wave8-census.js`), so this table is evidence, not an input.
 */
const UNCLASSIFIED_RESOLUTION = {
    "src/app.js": {
        census_category: "LEGACY_SECOND_PATH",
        source_file: "src/app.js",
        symbol: "pluginLoader.load(  @ src/app.js:7",
        reachable_from_production: "YES",
        consequential_for_stated_interaction: "YES",
        scope: "src/app.js IS a production execution path (module-level claim)",
        cluster: "C7-MCP-EGRESS",
        authority_path: "NONE on this path (no canonical owner traversed)",
        execution_path: "src/server.js -> src/app.js -> plugins/pluginLoader.load(...)",
        classification: "A_REAL_PRODUCTION_CONSEQUENTIAL_PATH",
        rule_finding: "CENSUS_RULE_GAP_UNDER_REPORT",
        census_status: "REPORTED_AS_SINK_BY_CORRECTED_CENSUS",
        resolved_by:
            "C0: the execution surfaces of a registry/plugin root are declared per kind " +
            "(EXECUTION_SURFACES) instead of only matching `.execute(`/`.loadOne(` literally, so " +
            "`pluginLoader.load(...)` — the plugin loader's artifact-loading entrypoint, which " +
            "require()s plugin modules (pluginLoader.load -> loadRoot -> loadOne -> loadTools/loadPlugin) — " +
            "is a plugin_handler_execution sink. This ADDS a finding; it was never a false positive.",
        evidence:
            "src/app.js:4 `const pluginLoader = require(\"./plugins/pluginLoader\")` (module binding of a " +
            "DEFAULT_REGISTRY_MODULE), then src/app.js:7 `pluginLoader.load(`. Reachable from the production " +
            "entrypoint src/server.js:18.",
        migration_status: "PENDING_MIGRATION"
    },
    "src/autonomy/CapabilityRegistry.js": {
        census_category: "NON_CONSEQUENTIAL_READ",
        source_file: "src/autonomy/CapabilityRegistry.js",
        symbol: "pluginLoader.userRoot  @ src/autonomy/CapabilityRegistry.js:75-76",
        reachable_from_production: "YES",
        consequential_for_stated_interaction: "NO",
        scope: "the pluginLoader.userRoot GETTER READ only — NOT a module safety judgement",
        unmodelled_effects:
            "The census models execution/file/network/device sinks, not DATABASE writes. This module also runs " +
            "`upsert` / `recordUsage` INSERT+UPDATE statements against the capability table (metadata and trust " +
            "telemetry) on the same ungoverned path. That is outside the plugin-execution question this entry " +
            "answers and is NOT covered by any census counter.",
        cluster: "C5-AUTONOMY-DAEMONS",
        authority_path: "N/A (no execution surface)",
        execution_path: "src/server.js -> src/autonomy/index.js -> CapabilityRegistry",
        classification: "B_NON_CONSEQUENTIAL_READ",
        rule_finding: "CENSUS_RULE_GAP_OVER_REPORT",
        census_status: "CLASSIFIED_NON_EXECUTING",
        resolved_by:
            "C0: `userRoot` is a pure getter returning a module constant (pluginLoader.js:40) — no proxy, no " +
            "side effect, no implicit execution — so the read is not a sink; and a module that only READS a " +
            "root's data never invokes its execution surface, so it is a known form rather than an unknown one.",
        evidence:
            "The only registry-module require is line 75 `require(\"../plugins/pluginLoader\")`, used at line 76 for " +
            "the data property `pluginLoader.userRoot`. There is no invocation of the registry surface. Every other " +
            "call in the file is `database.run(...)` against `../memory/db` (persistence, not a registry execution " +
            "form).",
        migration_status: "NO_MIGRATION_REQUIRED"
    },
    "src/autonomy/SkillFactory.js": {
        census_category: "NON_CONSEQUENTIAL_READ",
        source_file: "src/autonomy/SkillFactory.js",
        symbol: "require(\"../plugins/pluginLoader\").userRoot  @ src/autonomy/SkillFactory.js:33",
        reachable_from_production: "YES",
        consequential_for_stated_interaction: "NO",
        scope: "the inline pluginLoader.userRoot GETTER READ, and the generated-source strings — NOT a module safety judgement",
        unmodelled_effects:
            "This module GENERATES plugin source text (and can write it through ../services/toolForge, censused " +
            "separately as filesystem_mutation) and calls `capabilities.upsert(...)`. Neither is a registry " +
            "execution surface; the generated code is never executed in this module.",
        cluster: "C5-AUTONOMY-DAEMONS",
        authority_path: "N/A (no execution surface)",
        execution_path: "src/server.js -> src/autonomy/index.js -> SkillFactory",
        classification: "E_COMPATIBILITY_ADAPTER",
        rule_finding: "CENSUS_RULE_GAP_OVER_REPORT",
        census_status: "CLASSIFIED_NON_EXECUTING",
        resolved_by:
            "C0: the module's only root interaction is an inline `require(\"../plugins/pluginLoader\").userRoot` " +
            "read (a getter). `ToolRegistry.describe()` is a metadata read, and the `execute(` occurrences at lines " +
            "311/335/341 are inside STRING literals written to a generated plugin file — never executed here.",
        evidence:
            "Same trigger as CapabilityRegistry. The generated-source occurrences are string data: the census's " +
            "string-blanked view finds no call sink in this module (detectSinks == []) both before and after C0.",
        migration_status: "NO_MIGRATION_REQUIRED"
    },
    "src/core/tools/index.js": {
        census_category: "REEXPORT_FACADE",
        source_file: "src/core/tools/index.js",
        symbol: "module.exports = { ToolRegistry: require(\"./ToolRegistry.js\"), ... }",
        reachable_from_production: "YES",
        consequential_for_stated_interaction: "NO",
        scope: "a pure re-export barrel has no execution of its own — NOT a statement about the roots it re-exports",
        cluster: "C9-AI-TOOL-DISPATCH",
        authority_path: "N/A (no execution surface)",
        execution_path: "src/server.js -> ... -> src/core/tools/index.js",
        classification: "F_REEXPORT_BARREL",
        rule_finding: "CENSUS_RULE_GAP_OVER_REPORT",
        census_status: "CLASSIFIED_REEXPORT_FACADE",
        resolved_by:
            "C0: extractReexports recognises the object-literal barrel form `{ K: require(\"./X\") }` (plus named " +
            "CommonJS and ESM re-exports), so the 17-line barrel IS a façade of ToolRegistry.js and is classified " +
            "by moduleKind instead of falling through to the unknown bucket. A mixed barrel is not itself the root, " +
            "but a caller that destructures its named member still resolves through that member.",
        evidence:
            "The whole module body is `module.exports = { X: require(\"./X\") }`. It has no sink of its own. " +
            "Duplicate detection of ToolRegistry.js, which callers reach through `require(\"../core/tools\")`.",
        migration_status: "NO_MIGRATION_REQUIRED"
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
            // Unique per CALL SITE: file + line + byte column + kind. A column is
            // required because one minified line can hold several sinks of the same
            // kind, and a manifest keyed by file:line:kind would collide on them.
            id: `${f.file}:${f.line}:${f.column}:${f.kind}`,
            census_category: "LEGACY_SECOND_PATH",
            source_file: f.file,
            line: f.line,
            column: f.column,
            kind: f.kind,
            snippet: f.snippet,
            action_capable: actionCapable,
            consequential: actionCapable ? "YES" : "NO",
            entrypoint: f.entrypoint,
            ingresses: f.ingresses ?? [f.entrypoint],
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

    const censusIds = new Set(rows.map(r => r.id));
    const unclassifiedNow = rep.unclassified.map((file) => UNCLASSIFIED_RESOLUTION[file] ?? {
        census_category: "UNCLASSIFIED_LEGACY_REACHABILITY",
        source_file: file,
        symbol: "RECON_REQUIRED",
        reachable_from_production: "RECON_REQUIRED",
        consequential_for_stated_interaction: "RECON_REQUIRED",
        authority_path: "RECON_REQUIRED",
        execution_path: "RECON_REQUIRED",
        classification: "H_UNKNOWN_REQUIRES_RECON",
        census_status: "STILL_UNCLASSIFIED",
        evidence: "RECON_REQUIRED"
    });

    // The manifest may not claim more than the census measured, nor drop a sink it
    // measured: both directions are counted here so a divergence is visible.
    //
    // Ingress metrics are measured per entrypoint by the census (one traversal per
    // production ingress), NOT inferred from the `entrypoint` field, which is only
    // the FIRST path that reached a module in the walker's own order.
    const reconciliation = {
        raw_sink_count: rep.findings.length,
        manifest_row_count: rows.length,
        unique_module_count: new Set(rows.map(r => r.source_file)).size,
        unique_row_id_count: new Set(rows.map(r => r.id)).size,
        production_ingresses_analyzed: rep.counters.PRODUCTION_INGRESSES_ANALYZED,
        ungoverned_findings_by_ingress: rep.ingress ? rep.ingress.ungovernedByIngress : {},
        action_capable_count: rows.filter(r => r.action_capable).length,
        advisory_count: rows.filter(r => !r.action_capable).length,
        unclassified_count: rep.unclassified.length,
        census_findings_without_manifest_row: rep.findings
            .filter(f => !censusIds.has(`${f.file}:${f.line}:${f.column}:${f.kind}`)).length,
        manifest_rows_without_census_evidence: rows.filter(r => !censusIds.has(r.id)).length
    };

    // Distinct fields, so a JSON-only consumer never has to infer the meaning of
    // the SHA from a generator comment:
    //   measured_source_sha — the git HEAD the census MEASURED (the tree that was read);
    //   generator_head_sha  — the git HEAD the generator RAN IN. The generator always
    //                         writes its output, so the commit that carries this file is
    //                         normally the NEXT one; this field deliberately does NOT
    //                         claim to be the carrying commit.
    const measured = rep.sha;
    let generatorHead = measured;
    try {
        generatorHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    }
    catch { /* not a git checkout */ }

    return {
        schemaVersion: 1,
        sha: measured,
        measured_source_sha: measured,
        generator_head_sha: generatorHead,
        sha_meaning: "measured_source_sha = the git HEAD the census read (the tree these counters describe). generator_head_sha = the HEAD the generator ran in; because the generator always writes its output, the commit carrying this file is normally the NEXT commit. `sha` is kept as an alias of measured_source_sha for older consumers.",
        generatedFrom: "scripts/wave8-census.js",
        counters: rep.counters,
        reconciliation,
        ingress: rep.ingress ?? null,
        unclassified: unclassifiedNow,
        unclassified_resolutions: Object.values(UNCLASSIFIED_RESOLUTION),
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

    const r = manifest.reconciliation;
    process.stdout.write(`W8-IW1 MIGRATION MANIFEST  measured_source_sha=${manifest.measured_source_sha}\n`);
    process.stdout.write(`  hits=${manifest.findings.length} clusters=${manifest.clusters.length} unclassified=${manifest.unclassified.length}\n\n`);
    process.stdout.write(`  RAW_SINK_COUNT=${r.raw_sink_count} MANIFEST_ROW_COUNT=${r.manifest_row_count}\n`);
    process.stdout.write(`  UNIQUE_MODULE_COUNT=${r.unique_module_count} UNIQUE_ROW_ID_COUNT=${r.unique_row_id_count}\n`);
    process.stdout.write(`  ACTION_CAPABLE_COUNT=${r.action_capable_count} ADVISORY_COUNT=${r.advisory_count} UNCLASSIFIED_COUNT=${r.unclassified_count}\n`);
    process.stdout.write(`  PRODUCTION_INGRESSES_ANALYZED=${r.production_ingresses_analyzed}\n`);
    process.stdout.write(`  UNGOVERNED_FINDINGS_BY_INGRESS=${JSON.stringify(r.ungoverned_findings_by_ingress)}\n`);
    process.stdout.write(`  evidence gaps: census->manifest=${r.census_findings_without_manifest_row} manifest->census=${r.manifest_rows_without_census_evidence}\n\n`);
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
