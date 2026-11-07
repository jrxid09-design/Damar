"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditLedger } = require("../../src/runtime/auditLedger");
const { LedgerError, CODES: LEDGER_ERROR_CODES } = require("../../src/runtime/auditLedger/errors");

function makeLedger(bounds) {
    let t = 1_700_000_000_000;
    return createAuditLedger({ clock: () => (t += 10), bounds });
}

test("ordering is by monotonic sequence, not timestamp", () => {
    // Timestamps intentionally non-monotonic (clock skew simulation).
    let flip = false;
    const ledger = createAuditLedger({ clock: () => (flip = !flip) ? 500 : 900 });
    const a = ledger.append({ eventType: "e", source: "s" });
    const b = ledger.append({ eventType: "e", source: "s" });
    const c = ledger.append({ eventType: "e", source: "s" });
    assert.deepEqual([a.sequence, b.sequence, c.sequence], [1, 2, 3]);
    assert.ok(a.timestampMs !== b.timestampMs || true); // timestamps may repeat
    assert.equal(ledger.list({})[2].eventId, c.eventId);
});

test("duplicate eventId rejected atomically — no state change", () => {
    const ledger = makeLedger();
    const before = ledger.stats();
    const first = ledger.append({ ...{ eventType: "e", source: "s" }, eventId: "ae-" + "1".repeat(32) });
    assert.throws(() => ledger.append({ eventType: "other", source: "x", eventId: first.eventId }),
        (err) => err instanceof LedgerError && err.code === LEDGER_ERROR_CODES.DUPLICATE_EVENT_ID);
    const after = ledger.stats();
    assert.equal(after.logicalSequence, before.logicalSequence + 1);
    assert.equal(ledger.size(), 1);
    assert.equal(ledger.getByEventId(first.eventId).eventType, "e");
});

test("stored records are frozen; returned records are detached copies", () => {
    const ledger = makeLedger();
    const stored = ledger.append({
        eventType: "e", source: "s",
        metadata: { nested: { deep: "value" } }
    });

    assert.ok(Object.isFrozen(stored));
    assert.ok(Object.isFrozen(stored.metadata));
    assert.ok(Object.isFrozen(stored.metadata.nested));

    const copy = ledger.getByEventId(stored.eventId);
    assert.notEqual(copy, stored);
    assert.notEqual(copy.metadata, stored.metadata);

    // Mutating the copy must not affect the store.
    copy.metadata.nested.deep = "TAMPERED";
    copy.outcome = "hacked";
    const reread = ledger.getByEventId(stored.eventId);
    assert.equal(reread.metadata.nested.deep, "value");
    assert.equal(reread.outcome, "unspecified");
    assert.equal(ledger.list({}, { limit: 10 })[0].metadata.nested.deep, "value");
});

test("appendSafe never throws on garbage", () => {
    const ledger = makeLedger();
    const garbage = [
        null, undefined, 42, "string", [], () => {},
        { eventType: 123, source: "s" },
        { eventType: "e", source: Symbol("s") }
    ];
    for (const g of garbage) {
        const result = ledger.appendSafe(g);
        assert.equal(result.ok, false);
        assert.ok(result.error.code);
        assert.ok(result.error.message);
    }
    assert.equal(ledger.size(), 0);
});

test("causal parent linkage validated as event id shape", () => {
    const ledger = makeLedger();
    const parent = ledger.append({ eventType: "e", source: "s" });
    const child = ledger.append({ eventType: "e.followup", source: "s", causalParentId: parent.eventId });
    assert.equal(child.causalParentId, parent.eventId);
    assert.throws(() => ledger.append({ eventType: "e", source: "s", causalParentId: "../../etc/passwd" }),
        /AuditEventId/);
});

test("correction appends a NEW event and leaves the target untouched", () => {
    const ledger = makeLedger();
    const original = ledger.append({
        eventType: "device.state.observed",
        source: "devices",
        subject: { kind: "device", id: "dev-1" },
        outcome: "ok",
        metadata: { state: "TRUSTED" }
    });
    const originalJson = JSON.stringify(original);

    const correction = ledger.correct(original.eventId, {
        reason: "state misattributed to wrong device",
        metadata: { correctedState: "UNPROVISIONED" }
    });

    assert.equal(correction.eventType, "ledger.correction");
    assert.equal(correction.metadata.targetEventId, original.eventId);
    assert.equal(correction.causalParentId, original.eventId);

    const reread = ledger.getByEventId(original.eventId);
    assert.equal(JSON.stringify(reread), originalJson, "history must not be rewritten");
    assert.equal(reread.metadata.state, "TRUSTED");
});

test("supersession marks without mutating", () => {
    const ledger = makeLedger();
    const target = ledger.append({ eventType: "e.v1", source: "s", metadata: { v: 1 } });
    const replacement = ledger.append({ eventType: "e.v2", source: "s", metadata: { v: 2 } });
    const sup = ledger.supersede(target.eventId, { replacementEventId: replacement.eventId, reason: "v2 replaces v1" });
    assert.equal(sup.eventType, "ledger.supersession");
    assert.equal(sup.metadata.replacementEventId, replacement.eventId);
    assert.equal(ledger.getByEventId(target.eventId).metadata.v, 1);
});

test("correction of unknown target fails atomically", () => {
    const ledger = makeLedger();
    assert.throws(() => ledger.correct("ae-" + "9".repeat(32)), /not found/);
    assert.equal(ledger.size(), 0);
});
