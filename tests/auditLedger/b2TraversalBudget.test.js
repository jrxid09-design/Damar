"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditLedger } = require("../../src/runtime/auditLedger");

function makeLedger(extra = {}) {
    let t = 0;
    return createAuditLedger({ clock: () => ++t, ...extra });
}

/**
 * Shared-reference DAG amplification: N distinct objects, but the
 * traversal OCCURRENCES explode as branching^depth. Construction is
 * O(N); unbounded traversal would be exponential/OOM.
 */
function branchingDag(depth, branch) {
    let node = { leaf: "x" };
    for (let level = 0; level < depth; level++) {
        const parent = {};
        for (let k = 0; k < branch; k++) parent[`k${k}`] = node; // SAME ref
        node = parent;
    }
    return node;
}

test("B2: 64-branch shared DAG hits deterministic BOUNDS_EXCEEDED (no OOM)", () => {
    const ledger = makeLedger();
    const dag = branchingDag(5, 64); // occurrences ~64^5 if unbounded

    const started = Date.now();
    for (let i = 0; i < 200; i++) {
        const result = ledger.appendSafe({
            eventType: "probe.dag", source: "t", metadata: dag
        });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "E_BOUNDS_EXCEEDED",
            `iteration ${i}: ${result.error.message}`);
        assert.match(result.error.message, /node budget/);
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `amplification must be bounded, took ${elapsed}ms`);
    assert.equal(ledger.size(), 0, "no partial append");
});

test("B2: 16-branch shared DAG also bounded deterministically", () => {
    const ledger = makeLedger();
    const dag = branchingDag(6, 16);
    for (let i = 0; i < 50; i++) {
        const result = ledger.appendSafe({ eventType: "e", source: "s", metadata: dag });
        assert.equal(result.error.code, "E_BOUNDS_EXCEEDED");
    }
});

test("B2: arrays sharing one nested object are bounded", () => {
    const ledger = makeLedger();
    const shared = branchingDag(4, 8);
    const metadata = { items: Array.from({ length: 32 }, () => shared) };
    const result = ledger.appendSafe({ eventType: "e", source: "s", metadata });
    // 32 shares x 8^3-ish occurrences exceeds the 4096 budget.
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "E_BOUNDS_EXCEEDED");
    assert.equal(ledger.size(), 0);
});

test("B2: deep legal shape still accepted", () => {
    const ledger = makeLedger();
    const result = ledger.appendSafe({
        eventType: "probe.legal.deep", source: "t",
        metadata: { a: { b: { c: { d: { e: "leaf" } } } } }
    });
    assert.equal(result.ok, true);
});

test("B2: wide legal shape still accepted", () => {
    const ledger = makeLedger();
    const metadata = {};
    for (let i = 0; i < 60; i++) metadata[`field_${i}`] = `value-${i}`;
    const result = ledger.appendSafe({ eventType: "probe.legal.wide", source: "t", metadata });
    assert.equal(result.ok, true);
});

test("B2: ordinary small metadata unaffected", () => {
    const ledger = makeLedger();
    const result = ledger.appendSafe({
        eventType: "probe.small", source: "t", metadata: { note: "hello", n: 1 }
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.event.metadata, { note: "hello", n: 1 });
});

test("B2: cycles remain separately detected with their own failure", () => {
    const ledger = makeLedger();
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    const result = ledger.appendSafe({ eventType: "e", source: "s", metadata: cyclic });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /cyclic|node budget/);
});

test("B2: repeated hostile appends leave ledger byte-identical between rejections", () => {
    const ledger = makeLedger();
    ledger.append({ eventType: "anchor", source: "t", metadata: { i: 1 } });

    const baseline = JSON.stringify(ledger.exportWindow({ limit: 100 }));
    const baselineStats = ledger.stats();

    const dag = branchingDag(5, 64);
    for (let i = 0; i < 300; i++) {
        const before = JSON.stringify(ledger.exportWindow({ limit: 100 }));
        const beforeSeq = ledger.stats().logicalSequence;

        const result = ledger.appendSafe({ eventType: "e", source: "s", metadata: dag });
        assert.equal(result.ok, false);

        assert.equal(JSON.stringify(ledger.exportWindow({ limit: 100 })), before,
            "retained events must be byte-identical after rejection");
        assert.equal(ledger.stats().logicalSequence, beforeSeq,
            "rejected append must not burn sequence numbers");
    }

    assert.equal(ledger.stats().acceptedCount, baselineStats.acceptedCount + 0);
    assert.ok(ledger.stats().rejectedCount >= 300);
    assert.equal(JSON.stringify(ledger.exportWindow({ limit: 100 })), baseline);
    assert.equal(ledger.verifyIntegrity({ limit: 100 }).ok, true,
        "integrity verification must remain usable after hostile pressure");
});
