"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditLedger } = require("../../src/runtime/auditLedger");
const { LedgerError, CODES: LEDGER_ERROR_CODES } = require("../../src/runtime/auditLedger/errors");

function seed(ledger) {
    const ids = [];
    for (let i = 0; i < 12; i++) {
        const event = ledger.append({
            eventType: i % 2 === 0 ? "tool.executed" : "device.state.observed",
            source: i % 3 === 0 ? "runtime.tools" : "devices",
            actor: { kind: "agent", id: `agent-${i % 2}` },
            subject: { kind: "device", id: `dev-${i % 4}` },
            outcome: i % 5 === 0 ? "error" : "ok",
            generation: `rtg-${String(i % 2).repeat(32)}`,
            correlation: { sessionId: `ses_${i % 3}`, deviceId: `dev-${i % 4}` },
            timestampMs: 1000 + (11 - i) // timestamps DESCEND while sequence ASCENDS
        });
        ids.push(event.eventId);
    }
    return ids;
}

function makeLedger() {
    let t = 0;
    return createAuditLedger({
        clock: () => ++t,
        bounds: {
            maxInMemoryEvents: 100,
            maxQueryLimit: 50,
            defaultQueryLimit: 10
        }
    });
}

test("getByEventId returns copy or null", () => {
    const ledger = makeLedger();
    const [id] = seed(ledger);
    assert.ok(ledger.getByEventId(id));
    assert.equal(ledger.getByEventId("ae-" + "f".repeat(32)), null);
});

test("default query bounded; hard cap enforced", () => {
    const ledger = makeLedger();
    seed(ledger);
    assert.equal(ledger.list({}).length, 10); // defaultQueryLimit
    assert.equal(ledger.list({}, { limit: 1000 }).length, 12);
    assert.throws(() => ledger.list({}, { limit: -1 }), LedgerError);
    assert.throws(() => ledger.list({}, { limit: 1.5 }), LedgerError);
});

test("deterministic ascending order even with descending timestamps", () => {
    const ledger = makeLedger();
    seed(ledger);
    const all = ledger.list({}, { limit: 100 });
    for (let i = 1; i < all.length; i++) {
        assert.ok(all[i].sequence > all[i - 1].sequence);
    }
});

test("desc order supported explicitly", () => {
    const ledger = makeLedger();
    seed(ledger);
    const desc = ledger.list({}, { limit: 100, order: "desc" });
    for (let i = 1; i < desc.length; i++) {
        assert.ok(desc[i].sequence < desc[i - 1].sequence);
    }
});

test("filters: type list, source, actor, subject, generation, outcome, causal", () => {
    const ledger = makeLedger();
    seed(ledger);

    assert.equal(ledger.list({ types: ["tool.executed"] }, { limit: 100 }).length, 6);
    assert.equal(ledger.list({ source: "runtime.tools" }, { limit: 100 }).length, 4);
    assert.equal(ledger.list({ actorId: "agent-0" }, { limit: 100 }).length, 6);
    assert.equal(ledger.list({ subjectId: "dev-1" }, { limit: 100 }).length, 3);
    assert.equal(ledger.list({ outcome: "error" }, { limit: 100 }).length, 3);
    assert.equal(
        ledger.list({ generation: `rtg-${"0".repeat(32)}` }, { limit: 100 }).length, 6);
    assert.throws(() => ledger.list({ evilPredicate: () => true }), /unknown query filter/);
});

test("correlation map filter", () => {
    const ledger = makeLedger();
    seed(ledger);
    const hits = ledger.list({ correlation: { sessionId: "ses_0" } }, { limit: 100 });
    assert.equal(hits.length, 4);
    const none = ledger.list({ correlation: { sessionId: "ses_99" } }, { limit: 100 });
    assert.equal(none.length, 0);
    assert.throws(() => ledger.list({ correlation: "not-an-object" }), LedgerError);
});

test("time-range filter uses recorded timestamps", () => {
    const ledger = makeLedger();
    seed(ledger);
    // seeded timestamps are 1000..1011 descending by sequence
    const window = ledger.list({ fromMs: 1008, toMs: 1011 }, { limit: 100 });
    assert.equal(window.length, 4);
    for (const event of window) {
        assert.ok(event.timestampMs >= 1008 && event.timestampMs <= 1011);
    }
});

test("query results are detached copies — no cross-record mutation", () => {
    const ledger = makeLedger();
    seed(ledger);
    const first = ledger.list({}, { limit: 100 })[0];
    first.correlation.sessionId = "MUTATED";
    first.metadata = { forged: true };
    const reread = ledger.getByEventId(first.eventId);
    assert.notEqual(reread.correlation.sessionId, "MUTATED");
    assert.equal(reread.metadata, null);
});
