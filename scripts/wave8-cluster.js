#!/usr/bin/env node
"use strict";

/**
 * WAVE8 IW1 — CENSUS CLUSTER REPORT.
 *
 * Phase 1 of the canonical execution ownership migration. It consumes the
 * deterministic census (scripts/wave8-census.js) and turns route findings into
 * clusters keyed by the HIGHEST common non-canonical choke point, so ownership
 * can be migrated once per family instead of sink by sink.
 *
 * The insight this relies on: the census marks a sink "governed" when the path
 * from an entrypoint to it traverses canonical ownership. Migrating a module
 * therefore flips its whole subtree, not just the sinks in that file. Ranking by
 * subtree size is ranking by routes removed per migration.
 *
 * Deterministic: derived only from the census output, sorted, no LLM counts.
 *
 * USAGE
 *   node scripts/wave8-cluster.js                 # human report
 *   node scripts/wave8-cluster.js --json          # machine report
 *   node scripts/wave8-cluster.js --min 2         # only clusters >= 2 sinks
 */

const path = require("node:path");
const census = require("./wave8-census.js");

const CONSEQUENCE_WEIGHT = {
    actuator_invocation: 100,
    registry_execution: 90,
    plugin_handler_execution: 90,
    tool_handler_invocation: 80,
    process_shell: 70,
    terminal: 60,
    device_control: 50,
    network_mutation: 30,
    filesystem_mutation: 20
};

function isCanonical(rel, owners) {
    return owners.some(o => rel === o || rel.startsWith(o));
}

function cluster(options = {}) {
    const report = census.analyze({ root: options.root, entrypoints: options.entrypoints });
    const owners = options.canonicalOwners ?? census.DEFAULT_CANONICAL_OWNERS;
    const min = options.min ?? 1;

    // Prefix tree over finding paths: each node is a module on the route.
    // `terminal` collects findings that END at this node (a sink in this module).
    const nodes = new Map();

    const nodeFor = (id) => {
        if (!nodes.has(id)) {
            nodes.set(id, {
                id,
                parent: null,
                children: new Set(),
                ownFindings: [],
                subtreeFindings: [],
                entrypoints: new Set(),
                kinds: new Map()
            });
        }
        return nodes.get(id);
    };

    for (const finding of report.findings) {
        const route = finding.path;
        let parent = null;
        route.forEach((id, index) => {
            const node = nodeFor(id);
            if (index === 0) node.entrypoints.add(finding.entrypoint);
            if (parent !== null) {
                node.parent = parent;
                nodes.get(parent).children.add(id);
            }
            parent = id;
        });
        const leaf = nodeFor(route[route.length - 1]);
        leaf.ownFindings.push(finding);
    }

    // Subtree aggregation, deepest-first (children are always longer prefixes).
    const idsByDepth = [...nodes.keys()].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const id of idsByDepth) {
        const node = nodes.get(id);
        const collected = [...node.ownFindings];
        for (const childId of node.children) collected.push(...nodes.get(childId).subtreeFindings);
        node.subtreeFindings = collected;
        for (const finding of collected) {
            node.kinds.set(finding.kind, (node.kinds.get(finding.kind) ?? 0) + 1);
        }
    }

    const entrypointSet = new Set(report.entrypoints);

    const clusters = [];
    for (const node of nodes.values()) {
        const actionCapable = node.subtreeFindings.filter(f => f.actionCapable).length;
        if (actionCapable === 0 && node.subtreeFindings.length < min) continue;
        if (isCanonical(node.id, owners)) continue;          // owned by an existing canonical owner
        // An entrypoint is a real choke point (shared CLI/HTTP ingress owns its
        // own sinks); it is reported, not dropped, so every finding lands in
        // exactly one cluster.
        if (node.children.size === 0 && node.ownFindings.length === 0) continue;

        const kinds = [...node.kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const consequence = kinds.reduce(
            (acc, [kind, count]) => acc + (CONSEQUENCE_WEIGHT[kind] ?? 10) * count, 0);

        clusters.push({
            id: "C-" + node.id.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, ""),
            ownerModule: node.id,
            parent: node.parent,
            isEntrypoint: entrypointSet.has(node.id),
            actionCapableSinks: actionCapable,
            totalSinks: node.subtreeFindings.length,
            directSinks: node.ownFindings.length,
            childModules: [...node.children].sort(),
            kinds: Object.fromEntries(kinds),
            consequenceScore: consequence,
            entrypoints: [...node.entrypoints].sort(),
            estimatedRouteReduction: node.subtreeFindings.length,
            representativePaths: node.subtreeFindings
                .slice()
                .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
                .slice(0, 3)
                .map(f => ({ file: f.file, line: f.line, kind: f.kind, path: f.path })),
            hasCanonicalOwnerNearby: node.subtreeFindings.some(f => f.path.some(p => isCanonical(p, owners))),
            census: {
                LEGACY_SECOND_PATH: report.counters.LEGACY_SECOND_PATH,
                ACTION_CAPABLE_UNGOVERNED: report.counters.ACTION_CAPABLE_UNGOVERNED,
                UNCLASSIFIED_LEGACY_REACHABILITY: report.counters.UNCLASSIFIED_LEGACY_REACHABILITY
            }
        });
    }

    clusters.sort((a, b) =>
        b.consequenceScore - a.consequenceScore ||
        b.actionCapableSinks - a.actionCapableSinks ||
        b.totalSinks - a.totalSinks ||
        a.ownerModule.localeCompare(b.ownerModule));

    return {
        schemaVersion: 1,
        sha: report.sha,
        tree: options.tree ?? null,
        counters: report.counters,
        entrypoints: report.entrypoints,
        canonicalOwners: owners,
        unclassified: report.unclassified,
        clusters
    };
}

function main(argv) {
    const options = { root: process.cwd(), json: false, min: 1 };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--json") options.json = true;
        else if (a === "--min") options.min = Number(argv[++i]);
        else if (a === "--root") options.root = argv[++i];
        else if (a === "--help" || a === "-h") {
            process.stdout.write("usage: node scripts/wave8-cluster.js [--json] [--min N] [--root DIR]\n");
            return 0;
        }
        else throw new Error(`unknown argument: ${a}`);
    }

    const result = cluster(options);

    if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return 0;
    }

    const c = result.counters;
    process.stdout.write(`WAVE8 IW1 CLUSTER REPORT  sha=${result.sha ?? "(unknown)"}\n`);
    process.stdout.write(`LEGACY_SECOND_PATH=${c.LEGACY_SECOND_PATH}  ` +
        `ACTION_CAPABLE_UNGOVERNED=${c.ACTION_CAPABLE_UNGOVERNED}  ` +
        `UNCLASSIFIED=${c.UNCLASSIFIED_LEGACY_REACHABILITY}\n\n`);

    process.stdout.write(`clusters: ${result.clusters.length}\n\n`);
    for (const cl of result.clusters) {
        process.stdout.write(`${cl.id}\n`);
        process.stdout.write(`  owner            ${cl.ownerModule}\n`);
        process.stdout.write(`  sinks            action-capable=${cl.actionCapableSinks} total=${cl.totalSinks} direct=${cl.directSinks}\n`);
        process.stdout.write(`  kinds            ${Object.entries(cl.kinds).map(([k, v]) => `${k}:${v}`).join(" ")}\n`);
        process.stdout.write(`  consequence      ${cl.consequenceScore}\n`);
        process.stdout.write(`  est. reduction   ${cl.estimatedRouteReduction}\n`);
        process.stdout.write(`  entrypoints      ${cl.entrypoints.join(", ")}\n`);
        process.stdout.write(`  canonical nearby ${cl.hasCanonicalOwnerNearby}\n`);
        for (const p of cl.representativePaths) {
            process.stdout.write(`    - ${p.kind} ${p.file}:${p.line}\n`);
        }
        process.stdout.write("\n");
    }

    return 0;
}

module.exports = { cluster, CONSEQUENCE_WEIGHT };

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    }
    catch (error) {
        process.stderr.write(`cluster report failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
