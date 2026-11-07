"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditLedger } = require("../../src/runtime/auditLedger");

function makeLedger(bounds) {
    let t = 1_700_000_000_000;
    return createAuditLedger({
        clock: () => (t += 10),
        bounds
    });
}

const BASE = { eventType: "probe.event", source: "test.probe" };

test("minimal event: only eventType+source required; all else optional/null", () => {
    const ledger = makeLedger();
    const event = ledger.append({ ...BASE });
    assert.equal(event.eventType, "probe.event");
    assert.equal(event.source, "test.probe");
    assert.equal(event.actor, null);
    assert.equal(event.subject, null);
    assert.equal(event.metadata, null);
    assert.equal(event.outcome, "unspecified");
});

test("full model round trip", () => {
    const ledger = makeLedger();
    const event = ledger.append({
        eventType: "authority.grant.recorded",
        source: "authority",
        timestampMs: 123,
        actor: { kind: "agent", id: "agent-7" },
        subject: { kind: "device", id: "device-3" },
        operation: "observe-grant",
        outcome: "ok",
        generation: "rtg-" + "a".repeat(32),
        correlation: { sessionId: "ses_000000000001", deviceId: "device-3" },
        evidenceRefs: [{ kind: "toolResult", id: "tr-1", digest: "a".repeat(64) }],
        authorityRef: { kind: "grant", id: "cap-1" },
        causalParentId: null,
        metadata: { note: "observation only" }
    });
    assert.equal(event.timestampMs, 123);
    assert.equal(event.generation, "rtg-" + "a".repeat(32));
    assert.equal(event.authorityRef.kind, "grant");
});

test("unknown top-level fields rejected fail-closed", () => {
    const ledger = makeLedger();
    assert.throws(() => ledger.append({ ...BASE, evilField: "x", grantMe: true }),
        /unknown event field/);
    assert.equal(ledger.size(), 0);
});

test("outcome enum enforced", () => {
    const ledger = makeLedger();
    for (const bad of ["OK", "granted", 1, null && "ok", {}]) {
        if (bad === null || bad === undefined) continue;
        assert.throws(() => ledger.append({ ...BASE, outcome: bad }), /outcome/);
    }
    for (const good of ["ok", "denied", "error", "timeout", "partial"]) {
        ledger.append({ ...BASE, outcome: good });
    }
});

test("eventType naming rules", () => {
    const ledger = makeLedger();
    assert.throws(() => ledger.append({ eventType: "UPPER.case", source: "s" }), /eventType/);
    assert.throws(() => ledger.append({ eventType: "sp ace", source: "s" }), /eventType/);
    assert.throws(() => ledger.append({ eventType: "", source: "s" }), /eventType/);
    assert.doesNotThrow(() => ledger.append({ eventType: "a.b.c.d.e.f", source: "s" }));
});

test("source subsystem id rules", () => {
    const ledger = makeLedger();
    assert.doesNotThrow(() => ledger.append({ eventType: "e", source: "runtime.recovery" }));
    assert.throws(() => ledger.append({ eventType: "e", source: "Bad/Sub" }), /source/);
    assert.throws(() => ledger.append({ eventType: "e", source: "" }), /source/);
});
