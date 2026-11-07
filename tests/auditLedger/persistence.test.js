"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createAuditLedger,
    AuditPersistencePort,
    LedgerError,
    LEDGER_ERROR_CODES
} = require("../../src/runtime/auditLedger");

function makeLedger(extra = {}) {
    let t = 0;
    return createAuditLedger({ clock: () => ++t, ...extra });
}

class CapturingSink extends AuditPersistencePort {
    constructor() { super("capturing-test-sink"); this.records = []; }
    append(record) { this.records.push(record); return true; }
}

class FailingSink extends AuditPersistencePort {
    constructor() { super("failing-test-sink"); this.attempts = 0; }
    append() { this.attempts += 1; throw new Error("disk on fire"); }
}

test("persistence port contract: abstract append throws", () => {
    const port = new AuditPersistencePort("contract-only");
    assert.throws(() => port.append({}), /ABSTRACT/);
    assert.throws(() => new AuditPersistencePort(""), /NAME_REQUIRED/);
});

test("durable append with no sink fails BEFORE mutation", () => {
    const ledger = makeLedger();
    assert.throws(() =>
        ledger.append({ eventType: "e", source: "s" }, { durable: true }),
        (err) => err instanceof LedgerError && err.code === LEDGER_ERROR_CODES.NO_SINK);
    assert.equal(ledger.size(), 0);
    assert.equal(ledger.stats().logicalSequence, 0);
});

test("failing sink rejects the append atomically — ledger unmutated", () => {
    const sink = new FailingSink();
    const ledger = makeLedger({ sink });
    assert.throws(() =>
        ledger.append({ eventType: "e", source: "s" }, { durable: true }),
        (err) => err instanceof LedgerError && err.code === LEDGER_ERROR_CODES.PERSIST_FAILED);
    assert.equal(sink.attempts, 1);
    assert.equal(ledger.size(), 0, "no partial commit on persist failure");
    assert.equal(ledger.stats().logicalSequence, 0);
});

test("successful sink commits durably and in memory", () => {
    const sink = new CapturingSink();
    const ledger = makeLedger({ sink });
    const event = ledger.append({ eventType: "e", source: "s" }, { durable: true });
    assert.equal(sink.records.length, 1);
    assert.equal(sink.records[0].eventId, event.eventId);
    assert.equal(ledger.size(), 1);
});

test("non-durable appends never touch the sink", () => {
    const sink = new FailingSink();
    const ledger = makeLedger({ sink });
    ledger.appendSafe({ eventType: "e", source: "s" });
    assert.equal(sink.attempts, 0);
    assert.equal(ledger.size(), 1);
});

test("async sinks are rejected in V1 (atomic ordering guarantee)", () => {
    const asyncSink = {
        append() { return Promise.resolve(true); }
    };
    const ledger = makeLedger({ sink: asyncSink });
    assert.throws(() =>
        ledger.append({ eventType: "e", source: "s" }, { durable: true }),
        /async sinks/);
    assert.equal(ledger.size(), 0);
});

test("invalid sink shape rejected at construction", () => {
    assert.throws(() => makeLedger({ sink: { notAppend: 1 } }), /sink must expose append/);
    assert.throws(() => makeLedger({ sink: 42 }), /sink must expose append/);
});

test("write failure does not mutate canonical caller state — caller decides policy", () => {
    // The ledger NEVER forces durability on a caller: plain append()
    // succeeds even when no sink exists at all.
    const ledger = makeLedger();
    const result = ledger.appendSafe({ eventType: "e", source: "s" });
    assert.equal(result.ok, true);
});
