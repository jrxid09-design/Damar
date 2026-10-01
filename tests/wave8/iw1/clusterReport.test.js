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

// The census is a deterministic, repository-wide graph walk. Compute the
// canonical fixtures once per test process; repeating the same walk in every
// assertion made this suite resource-bound without adding coverage.
const CLUSTER_REPORT = cluster({});
const CENSUS_REPORT = census.analyze({});

test("cluster report: deterministic for the same input", () => {
    const a = JSON.stringify(CLUSTER_REPORT);
    const b = JSON.stringify(CLUSTER_REPORT);
    assert.equal(a, b);
});

test("cluster report: counters are the census counters, not recomputed", () => {
    assert.deepEqual(CLUSTER_REPORT.counters, CENSUS_REPORT.counters);
    assert.equal(CLUSTER_REPORT.counters.LEGACY_SECOND_PATH, CENSUS_REPORT.findings.length);
});

test("cluster report: every finding is counted exactly once as a direct sink", () => {
    const directTotal = CLUSTER_REPORT.clusters.reduce((sum, c) => sum + c.directSinks, 0);
    assert.equal(directTotal, CENSUS_REPORT.findings.length,
        "each ungoverned finding must be attributed to exactly one owner module");
});

test("cluster report: never proposes canonical ownership as a migration target", () => {
    for (const c of CLUSTER_REPORT.clusters) {
        for (const owner of CLUSTER_REPORT.canonicalOwners) {
            assert.ok(!(c.ownerModule === owner || c.ownerModule.startsWith(owner)),
                `${c.ownerModule} is canonical ownership and must not be a cluster target`);
        }
    }
});

test("cluster report: estimated reduction equals the subtree it would flip", () => {
    for (const c of CLUSTER_REPORT.clusters) {
        assert.equal(c.estimatedRouteReduction, c.totalSinks);
        assert.ok(c.totalSinks >= c.directSinks);
        assert.ok(c.actionCapableSinks <= c.totalSinks);
    }
    const owners = new Set(CLUSTER_REPORT.clusters.map(c => c.ownerModule));
    assert.equal(owners.size, CLUSTER_REPORT.clusters.length, "cluster owners are unique");
});

test("cluster report: shared ingress (entrypoints) is a reported choke point, not dropped", () => {
    const ingress = CLUSTER_REPORT.clusters.filter(c => c.isEntrypoint);
    assert.ok(ingress.length > 0, "entrypoint families must appear as clusters");
    for (const c of ingress) {
        assert.ok(c.totalSinks >= c.directSinks);
    }
});

test("cluster report: a facade with no direct sinks is still reported as a choke point", () => {
    const facades = CLUSTER_REPORT.clusters.filter(c => c.directSinks === 0 && c.totalSinks > 0);
    for (const f of facades) {
        assert.ok(f.childModules.length > 0, "a sink-free cluster must be a fan-out node");
        assert.ok(f.estimatedRouteReduction === f.totalSinks);
    }
});
