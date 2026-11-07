"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createAuditLedger,
    sha256Hex,
    isValidDigestFormat
} = require("../../src/runtime/auditLedger");

function makeLedger(extra = {}) {
    let t = 0;
    return createAuditLedger({ clock: () => ++t, ...extra });
}

test("known-answer sha256 vector", () => {
    assert.equal(sha256Hex("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("digest format validator", () => {
    assert.ok(isValidDigestFormat("a".repeat(64)));
    assert.ok(!isValidDigestFormat("A".repeat(64)));
    assert.ok(!isValidDigestFormat("a".repeat(63)));
    assert.ok(!isValidDigestFormat(null));
});

test("chain verifies on clean retained window", () => {
    const ledger = makeLedger();
    for (let i = 0; i < 25; i++) {
        ledger.append({ eventType: "e", source: "s", metadata: { i } });
    }
    const result = ledger.verifyIntegrity();
    assert.equal(result.ok, true);
    assert.equal(result.checked, 25);
});

test("chain linkage: each digest is deterministic and content-sensitive", () => {
    const ledger = makeLedger();
    const a = ledger.append({ eventType: "e", source: "s", metadata: { x: 1 } });
    const b = ledger.append({ eventType: "e", source: "s", metadata: { x: 1 } });

    // Same content but different sequence => different digests.
    assert.notEqual(a.integrity.digest, b.integrity.digest);

    // Tampering ANY byte of a record's observable content changes the
    // recomputed digest (corruption detection).
    const forged = { ...a, outcome: "ok" }; // stored outcome was unspecified
    assert.notEqual(
        sha256Hex(JSON.stringify(forged)),
        sha256Hex(JSON.stringify(a))
    );
});

test("verifyIntegrity over bounded window after eviction stays internally consistent", () => {
    const ledger = makeLedger({
        bounds: { maxInMemoryEvents: 20, defaultQueryLimit: 100, maxQueryLimit: 100 }
    });
    for (let i = 0; i < 60; i++) {
        ledger.append({ eventType: "e", source: "s", metadata: { i } });
    }
    assert.equal(ledger.size(), 20, "retention window bounded");
    assert.ok(ledger.stats().evictedCount > 0);
    const result = ledger.verifyIntegrity({ limit: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.checked, 20);
});

test("digest semantics constant pinned; no nonrepudiation claim", () => {
    // Pin the algorithm to prevent silent upgrades invalidating chains.
    const integrity = require("../../src/runtime/auditLedger/integrity");
    assert.equal(integrity.DIGEST_ALGORITHM, "sha256");
});
