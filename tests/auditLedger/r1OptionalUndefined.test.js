"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createAuditLedger,
    LedgerError,
    LEDGER_ERROR_CODES
} = require("../../src/runtime/auditLedger");

/**
 * R1 — TOP-LEVEL OPTIONAL undefined == ABSENT.
 *
 * Only eventType and source are required; every other AuditEvent field is
 * optional. At the snapshot boundary, an own DATA property whose value is
 * `undefined` must be treated exactly as if the property were absent, so
 * ordinary JS producer code (appendSafe({ eventType, source, actor: maybeActor }))
 * keeps working when maybeActor === undefined.
 *
 * Bounds contract (unchanged): accessor descriptors remain rejected WITHOUT
 * invocation; nested `undefined` (e.g. metadata.nested) stays fail-closed.
 */

const BOUNDS = {
    maxInMemoryEvents: 100,
    maxQueryLimit: 50,
    defaultQueryLimit: 10,
    maxMetadataBytes: 2048,
    maxMetadataStringLength: 512,
    maxMetadataDepth: 6,
    maxMetadataNodes: 4096,
    maxMetadataKeysPerLevel: 64,
    maxMetadataArrayItems: 32,
    maxEvidenceRefs: 16,
    maxEventTypeLength: 96,
    maxRefLength: 128
};

const OPTIONAL_FIELDS = [
    "actor", "subject", "metadata", "operation", "outcome",
    "generation", "correlation", "evidenceRefs", "authorityRef",
    "eventId", "causalParentId"
];

function makeLedger(extra = {}) {
    let t = 0;
    let id = 0;
    return createAuditLedger({
        clock: () => ++t,
        idFactory: () => `ae-${String(++id).padStart(32, "0")}`,
        bounds: BOUNDS,
        ...extra
    });
}

test("R1: omitted vs explicit undefined produce byte-identical records", () => {
    for (const field of OPTIONAL_FIELDS) {
        const omitted = makeLedger().append({ eventType: "e", source: "s" });

        const input = { eventType: "e", source: "s" };
        input[field] = undefined;
        const explicit = makeLedger().append(input);

        // Deterministic idFactory + clock => both ledgers are identical
        // byte-for-byte, including eventId/sequence/integrity.
        assert.deepEqual(explicit, omitted,
            `field "${field}": undefined must be equivalent to absent`);
    }
});

test("R1: append succeeds for every optional field omitted and undefined", () => {
    for (const field of OPTIONAL_FIELDS) {
        const ledger = makeLedger();
        assert.doesNotThrow(() => ledger.append({ eventType: "e", source: "s" }),
            `append must accept omitted "${field}"`);
        const input = { eventType: "e", source: "s" };
        input[field] = undefined;
        assert.doesNotThrow(() => ledger.append(input),
            `append must accept undefined "${field}"`);
        assert.equal(ledger.size(), 2);
    }
});

test("R1: appendSafe succeeds for every optional field omitted and undefined", () => {
    for (const field of OPTIONAL_FIELDS) {
        const ledger = makeLedger();
        assert.equal(ledger.appendSafe({ eventType: "e", source: "s" }).ok, true,
            `appendSafe must accept omitted "${field}"`);
        const input = { eventType: "e", source: "s" };
        input[field] = undefined;
        const result = ledger.appendSafe(input);
        assert.equal(result.ok, true,
            `appendSafe must accept undefined "${field}"`);
        assert.equal(ledger.size(), 2);
    }
});

test("R1: sequence increments exactly once per accepted undefined-field append", () => {
    const ledger = makeLedger();
    for (const field of OPTIONAL_FIELDS) {
        const input = { eventType: "e", source: "s" };
        input[field] = undefined;
        const r = ledger.append(input);
        assert.equal(r.sequence, ledger.stats().logicalSequence,
            `sequence advances monotonically for "${field}"`);
    }
    assert.equal(ledger.stats().logicalSequence, OPTIONAL_FIELDS.length);
});

test("R1: no undefined value is stored in any optional field", () => {
    const ledger = makeLedger();
    const input = { eventType: "e", source: "s" };
    for (const field of OPTIONAL_FIELDS) input[field] = undefined;

    const r = ledger.append(input);
    // The canonical record never contains a literal undefined:
    // undefined optional fields resolve to null (or their default).
    for (const key of Object.keys(r)) {
        assert.notEqual(r[key], undefined, `field "${key}" must not be undefined`);
    }
    assert.equal(r.actor, null);
    assert.equal(r.subject, null);
    assert.equal(r.metadata, null);
    assert.equal(r.operation, null);
    assert.equal(r.outcome, "unspecified");
    assert.equal(r.generation, null);
    assert.equal(r.correlation, null);
    assert.equal(r.evidenceRefs, null);
    assert.equal(r.authorityRef, null);
    assert.equal(r.causalParentId, null);
    assert.equal(typeof r.eventId, "string");
});

test("R1: integrity remains valid after undefined-field appends", () => {
    const ledger = makeLedger();
    for (const field of OPTIONAL_FIELDS) {
        const input = { eventType: "e", source: "s" };
        input[field] = undefined;
        ledger.append(input);
    }
    assert.equal(ledger.verifyIntegrity({ limit: 100 }).ok, true);
});

test("R1: top-level accessor returning undefined is REJECTED without invocation", () => {
    const ledger = makeLedger();
    let reads = 0;
    const input = { eventType: "e", source: "s" };
    Object.defineProperty(input, "actor", {
        enumerable: true,
        get() { reads += 1; return undefined; }
    });

    const result = ledger.appendSafe(input);
    assert.equal(result.ok, false, "accessor must be rejected");
    assert.equal(result.error.code, LEDGER_ERROR_CODES.INVALID_EVENT);
    assert.equal(reads, 0, "getter must never be invoked");

    // append() throws a typed LedgerError too (never a native error).
    assert.throws(() => ledger.append(input),
        (err) => err instanceof LedgerError &&
            err.code === LEDGER_ERROR_CODES.INVALID_EVENT);
    assert.equal(reads, 0, "getter still never invoked");
});

test("R1: nested metadata undefined remains fail-closed", () => {
    const ledger = makeLedger();
    assert.throws(
        () => ledger.append({ eventType: "e", source: "s", metadata: { nested: undefined } }),
        /unsupported value type/);

    const safe = ledger.appendSafe({ eventType: "e", source: "s", metadata: { nested: undefined } });
    assert.equal(safe.ok, false);
    assert.equal(ledger.size(), 0);

    // Top-level metadata:undefined is still accepted (absent), distinct from nested.
    const ok = makeLedger().appendSafe({ eventType: "e", source: "s", metadata: undefined });
    assert.equal(ok.ok, true);
});

test("R1: ordinary producer pattern with maybe-undefined values works end-to-end", () => {
    const ledger = makeLedger();
    const maybeActor = undefined;
    const maybeMetadata = undefined;
    const maybeOperation = "write";

    const r = ledger.appendSafe({
        eventType: "tool.written",
        source: "runtime.tools",
        actor: maybeActor,
        metadata: maybeMetadata,
        operation: maybeOperation
    });

    assert.equal(r.ok, true);
    assert.equal(r.event.actor, null);
    assert.equal(r.event.metadata, null);
    assert.equal(r.event.operation, "write");
    assert.equal(ledger.size(), 1);
    assert.equal(ledger.verifyIntegrity().ok, true);
});
