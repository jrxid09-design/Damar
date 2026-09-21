"use strict";

/**
 * W8-IW1 MIGRATION MANIFEST invariants (scripts/wave8-iw1-migration-manifest.js).
 *
 * The manifest is the artifact a migration wave is planned and audited from, so its
 * reconciliation with the counter oracle must be checkable WITHOUT trusting the
 * JSON: every census finding is represented exactly once, every row id is unique,
 * every cluster total is the sum of its own rows, and the ingress numbers are
 * measured per entrypoint rather than inferred from the walk order.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const census = require(path.join(ROOT, "scripts", "wave8-census.js"));
const { build, clusterFor, riskFor } = require(path.join(ROOT, "scripts", "wave8-iw1-migration-manifest.js"));

test("manifest: every census finding is represented exactly once, and no row is stale", () => {
    const rep = census.analyze({ root: ROOT });
    const manifest = build(ROOT);

    const censusIds = rep.findings.map(f => `${f.file}:${f.line}:${f.column}:${f.kind}`);
    const rowIds = manifest.findings.map(r => r.id);

    assert.deepEqual(rowIds.slice().sort(), censusIds.slice().sort(),
        "manifest rows must be exactly the census findings, one row each");
    assert.equal(new Set(rowIds).size, rowIds.length, "every row id must be unique");
    assert.equal(manifest.findings.length, rep.counters.LEGACY_SECOND_PATH);
});

test("manifest: row fields are derived from the census finding they name", () => {
    const rep = census.analyze({ root: ROOT });
    const manifest = build(ROOT);
    const byId = new Map(rep.findings.map(f => [`${f.file}:${f.line}:${f.column}:${f.kind}`, f]));

    for (const row of manifest.findings) {
        const f = byId.get(row.id);
        assert.ok(f, `${row.id} has no census finding`);
        assert.equal(row.source_file, f.file);
        assert.equal(row.line, f.line);
        assert.equal(row.column, f.column);
        assert.equal(row.kind, f.kind);
        assert.equal(row.snippet, f.snippet);
        assert.equal(row.action_capable, f.actionCapable === true);
        assert.equal(row.execution_path, f.path.join(" -> "));
        assert.equal(row.entrypoint, f.path[0]);
        assert.deepEqual(row.ingresses, f.ingresses);
        assert.equal(row.hops, f.path.length - 1);
        assert.equal(row.cluster, clusterFor(f.file, f.actionCapable === true));
        assert.equal(row.risk, riskFor(f));
        assert.equal(row.production_reachability, "REACHABLE_FROM_ENTRYPOINT");
    }
});

test("manifest: cluster totals are the sum of their own rows", () => {
    const manifest = build(ROOT);
    const recomputed = new Map();
    for (const row of manifest.findings) {
        const c = recomputed.get(row.cluster) ?? { hits: 0, action_capable: 0, files: new Set(), max_risk: "P2" };
        c.hits += 1;
        if (row.action_capable) c.action_capable += 1;
        c.files.add(row.source_file);
        if (row.risk < c.max_risk) c.max_risk = row.risk;
        recomputed.set(row.cluster, c);
    }
    assert.equal(manifest.clusters.length, recomputed.size);
    for (const c of manifest.clusters) {
        const m = recomputed.get(c.id);
        assert.ok(m, `cluster ${c.id} has no rows`);
        assert.deepEqual(
            { hits: c.hits, action_capable: c.action_capable, files: c.files, max_risk: c.max_risk },
            { hits: m.hits, action_capable: m.action_capable, files: m.files.size, max_risk: m.max_risk },
            `cluster ${c.id} does not match its rows`);
    }
    assert.equal(manifest.clusters.reduce((s, c) => s + c.hits, 0), manifest.findings.length);
});

test("manifest: the reconciliation block is the census, not a claim about it", () => {
    const rep = census.analyze({ root: ROOT });
    const manifest = build(ROOT);
    const r = manifest.reconciliation;

    assert.equal(r.raw_sink_count, rep.findings.length);
    assert.equal(r.manifest_row_count, manifest.findings.length);
    assert.equal(r.unique_module_count, new Set(manifest.findings.map(x => x.source_file)).size);
    assert.equal(r.unique_row_id_count, new Set(manifest.findings.map(x => x.id)).size);
    assert.equal(r.action_capable_count, manifest.findings.filter(x => x.action_capable).length);
    assert.equal(r.advisory_count, manifest.findings.filter(x => !x.action_capable).length);
    assert.equal(r.unclassified_count, rep.unclassified.length);
    assert.equal(r.census_findings_without_manifest_row, 0);
    assert.equal(r.manifest_rows_without_census_evidence, 0);
    assert.equal(manifest.counters.LEGACY_SECOND_PATH, manifest.findings.length);
});

test("manifest: ingress metrics are measured per production entrypoint", () => {
    const rep = census.analyze({ root: ROOT });
    const manifest = build(ROOT);

    assert.deepEqual(manifest.reconciliation.production_ingresses_analyzed, rep.ingress.analyzed.length);
    assert.deepEqual(manifest.reconciliation.ungoverned_findings_by_ingress, rep.ingress.ungovernedByIngress);
    assert.deepEqual(Object.keys(rep.ingress.ungovernedByIngress).sort(), rep.ingress.analyzed);
    for (const row of manifest.findings) {
        assert.ok(row.ingresses.length >= 1, `${row.id} reached from no ingress`);
        for (const ingress of row.ingresses) {
            assert.ok(rep.ingress.analyzed.includes(ingress), `${ingress} is not an analysed ingress`);
            assert.ok(rep.ingress.ungovernedByIngress[ingress] > 0,
                `${ingress} is claimed for ${row.id} but the per-ingress census found nothing there`);
        }
        assert.ok(row.ingresses.includes(row.entrypoint));
    }
});

test("manifest: the sha fields say what they mean without reading the generator", () => {
    const manifest = build(ROOT);
    assert.equal(manifest.measured_source_sha, census.analyze({ root: ROOT }).sha);
    assert.equal(manifest.sha, manifest.measured_source_sha, "`sha` is the documented alias");
    assert.match(manifest.generator_head_sha, /^[0-9a-f]{40}$/);
    assert.equal(manifest.sha_meaning.includes("artifact_commit_sha"), false,
        "the misleading field name must be gone");
    assert.match(manifest.sha_meaning, /measured_source_sha/);
    assert.match(manifest.sha_meaning, /generator_head_sha/);
    assert.match(manifest.sha_meaning, /NEXT commit/,
        "a consumer must be told that the carrying commit trails the generator HEAD");
});

test("manifest: an unclassified path is never resolved by assertion", () => {
    const rep = census.analyze({ root: ROOT });
    const manifest = build(ROOT);

    const resolved = new Set(manifest.unclassified_resolutions.map(r => r.source_file));
    for (const file of rep.unclassified) {
        const entry = manifest.unclassified.find(u => u.source_file === file);
        assert.ok(entry, `${file} is unclassified but has no manifest entry`);
        if (entry.census_status === "STILL_UNCLASSIFIED") continue;
        assert.ok(resolved.has(file), `${file} claims resolution without evidence`);
    }
    for (const entry of manifest.unclassified_resolutions) {
        assert.ok(entry.evidence && entry.evidence !== "RECON_REQUIRED", `${entry.source_file} lacks evidence`);
        assert.ok(entry.resolved_by, `${entry.source_file} lacks a rule finding`);
        assert.ok(entry.scope, `${entry.source_file} must scope its classification to what was actually checked`);
        assert.ok(entry.consequential_for_stated_interaction,
            `${entry.source_file} must state consequence per interaction, not per module`);
    }
    assert.equal(manifest.unclassified_resolutions.length, 4);
});
