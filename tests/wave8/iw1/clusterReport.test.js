"use strict";

/**
 * Regression test for the IW1 Phase-1 cluster report (scripts/wave8-cluster.js).
 *
 * The cluster report is what turns the census counters into a migration plan, so
 * its invariants matter: it must be deterministic, it must derive everything from
 * the census (no invented counts), and it must never propose a canonical module
 * as a migration target. It is the oracle for "which families collapse together".
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { cluster } = require("../../../scripts/wave8-cluster.js");
const census = require("../../../scripts/wave8-census.js");

test("cluster report: deterministic for the same input", () => {
    const a = JSON.stringify(cluster({}));
    const b = JSON.stringify(cluster({}));
    assert.equal(a, b);
});

test("cluster report: counters are the census counters, not recomputed", () => {
    const report = cluster({});
    const censusReport = census.analyze({});
    assert.deepEqual(report.counters, censusReport.counters);
    assert.equal(report.counters.LEGACY_SECOND_PATH, censusReport.findings.length);
});

test("cluster report: every finding is counted exactly once as a direct sink", () => {
    const report = cluster({});
    const censusReport = census.analyze({});
    const directTotal = report.clusters.reduce((sum, c) => sum + c.directSinks, 0);
    assert.equal(directTotal, censusReport.findings.length,
        "each ungoverned finding must be attributed to exactly one owner module");
});

test("cluster report: never proposes canonical ownership as a migration target", () => {
    const report = cluster({});
    for (const c of report.clusters) {
        for (const owner of report.canonicalOwners) {
            assert.ok(!(c.ownerModule === owner || c.ownerModule.startsWith(owner)),
                `${c.ownerModule} is canonical ownership and must not be a cluster target`);
        }
    }
});

test("cluster report: estimated reduction equals the subtree it would flip", () => {
    const report = cluster({});
    for (const c of report.clusters) {
        assert.equal(c.estimatedRouteReduction, c.totalSinks);
        assert.ok(c.totalSinks >= c.directSinks);
        assert.ok(c.actionCapableSinks <= c.totalSinks);
    }
    const owners = new Set(report.clusters.map(c => c.ownerModule));
    assert.equal(owners.size, report.clusters.length, "cluster owners are unique");
});

test("cluster report: shared ingress (entrypoints) is a reported choke point, not dropped", () => {
    const report = cluster({});
    const ingress = report.clusters.filter(c => c.isEntrypoint);
    assert.ok(ingress.length > 0, "entrypoint families must appear as clusters");
    for (const c of ingress) {
        assert.ok(c.totalSinks >= c.directSinks);
    }
});

test("cluster report: a facade with no direct sinks is still reported as a choke point", () => {
    const report = cluster({});
    const facades = report.clusters.filter(c => c.directSinks === 0 && c.totalSinks > 0);
    for (const f of facades) {
        assert.ok(f.childModules.length > 0, "a sink-free cluster must be a fan-out node");
        assert.ok(f.estimatedRouteReduction === f.totalSinks);
    }
});
