"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createAuditLedger,
    AuditPersistencePort,
    LedgerError
} = require("../../src/runtime/auditLedger");
const eventsModule = require("../../src/runtime/auditLedger/events");

function makeLedger(extra = {}) {
    let t = 0;
    return createAuditLedger({ clock: () => ++t, ...extra });
}

class FailingSink extends AuditPersistencePort {
    constructor() { super("b3-failing-sink"); this.attempts = 0; }
    append() { this.attempts += 1; throw new Error("io failure"); }
}

test("B3: canonicalization failures are typed LedgerError, not internal leaks", () => {
    // Direct probe of the digest-core boundary with a non-serializable
    // record (non-finite number is rejected by the canonical serializer).
    assert.throws(
        () => eventsModule.digestCore({ metadata: { x: NaN } }),
        (err) => err instanceof LedgerError && err.code === "E_INVALID_EVENT" &&
            /canonical serialization/.test(err.message)
    );
});

test("B3: failed hostile append does not burn sequence — next valid is seq 2", () => {
    const ledger = makeLedger();

    const first = ledger.append({ eventType: "e", source: "s" });
    assert.equal(first.sequence, 1);

    const hostiles = [
        { eventType: "e", source: "s", metadata: { cb: () => {} } },          // function
        { eventType: "e", source: "s", metadata: { b: BigInt(1) } },          // bigint
        { eventType: "e", source: "s", metadata: { u: undefined } },          // undefined
        { eventType: "", source: "s" },                                       // invalid type
        { eventType: "e", source: "s", outcome: "GRANTED" },                  // forged outcome
        { eventType: "e", source: "s", unknownField: true }                   // unknown field
    ];
    for (const hostile of hostiles) {
        const result = ledger.appendSafe(hostile);
        assert.equal(result.ok, false);
        assert.match(result.error.code, /^E_/);
    }

    const second = ledger.append({ eventType: "e", source: "s" });
    assert.equal(second.sequence, 2, "sequence must be exactly +1 after rejections");
    assert.equal(ledger.stats().logicalSequence, 2);
});

test("B3: durable failure does not burn sequence", () => {
    const sink = new FailingSink();
    const ledger = makeLedger({ sink });

    ledger.append({ eventType: "e", source: "s" });                 // seq 1
    for (let i = 0; i < 5; i++) {
        assert.throws(() =>
            ledger.append({ eventType: `e${i}`, source: "s" }, { durable: true }),
            (err) => err.code === "E_PERSIST_FAILED");
    }
    assert.equal(sink.attempts, 5);

    const next = ledger.append({ eventType: "after", source: "s" }); // must be seq 2
    assert.equal(next.sequence, 2);
    assert.equal(ledger.verifyIntegrity({ limit: 100 }).ok, true);
});

test("B3: duplicate ID and bounds rejection do not burn sequence", () => {
    const ledger = makeLedger();
    const id = "ae-" + "3".repeat(32);
    ledger.append({ eventType: "e", source: "s", eventId: id });     // seq 1

    assert.throws(() =>
        ledger.append({ eventType: "other", source: "s", eventId: id }), /already recorded/);

    // Bounds rejection via metadata byte budget (spaced strings survive
    // redaction heuristics but overflow maxMetadataBytes).
    const big = {};
    for (let i = 0; i < 10; i++) big[`f${i}`] = "lorem ipsum dolor ".repeat(25);
    assert.throws(() => ledger.append({ eventType: "e", source: "s", metadata: big }),
        /exceeds .* bytes/);

    const next = ledger.append({ eventType: "next", source: "s" });
    assert.equal(next.sequence, 2);
});

test("B3: full canonical state byte-identical across a rejection", () => {
    const ledger = makeLedger();

    const snapshotState = () => JSON.stringify({
        window: ledger.exportWindow({ limit: 100 }),
        stats: {
            ...ledger.stats(),
            // rejectedCount is an observational counter by design; it
            // MUST change on rejection. Canonical state must not.
            rejectedCount: 0,
            bounds: undefined
        },
        integrity: ledger.verifyIntegrity({ limit: 100 })
    });

    ledger.append({ eventType: "a", source: "s", metadata: { v: 1 } });
    ledger.append({ eventType: "b", source: "s", metadata: { v: 2 } });
    const before = snapshotState();

    const dag = {};
    let cursor = dag;
    for (let i = 0; i < 100; i++) { cursor.child = {}; cursor = cursor.child; }
    ledger.appendSafe({ eventType: "deep", source: "s", metadata: dag });
    ledger.appendSafe({ eventType: "fn", source: "s", metadata: { f: () => {} } });
    try { ledger.append({ eventType: "x", source: "s", eventId: "bad-id" }); } catch { /* expected */ }

    assert.equal(snapshotState(), before);
    assert.equal(ledger.verifyIntegrity({ limit: 100 }).ok, true);
});
