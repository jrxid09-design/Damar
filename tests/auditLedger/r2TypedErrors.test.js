"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createAuditLedger,
    LedgerError,
    LEDGER_ERROR_CODES
} = require("../../src/runtime/auditLedger");

/**
 * R2 — MALFORMED CALLER INPUT MUST NEVER BECOME E_INTERNAL.
 *
 * Validation/coercion helpers in ids.js throw native TypeError/RangeError.
 * buildEventRecord() wraps those calls so that:
 *   - append()  throws a LedgerError with a stable E_* code,
 *   - appendSafe() returns { ok:false, error:{ code, message } },
 * and neither path ever leaks a raw TypeError/RangeError or maps a known
 * malformed input to E_INTERNAL.
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

/**
 * Each probe: a malformed input object plus the expected stable code.
 * The same semantic code must be produced by append() and appendSafe().
 */
const PROBES = [
    { name: "eventId (non-string)", input: { eventType: "e", source: "s", eventId: 123 }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "eventId (malformed shape)", input: { eventType: "e", source: "s", eventId: "not-an-id" }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "eventId (too long)", input: { eventType: "e", source: "s", eventId: "ae-" + "f".repeat(100) }, code: LEDGER_ERROR_CODES.INVALID_EVENT },

    { name: "source (non-string)", input: { eventType: "e", source: 42 }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "source (malformed shape)", input: { eventType: "e", source: "Bad/Sub" }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "source (empty)", input: { eventType: "e", source: "" }, code: LEDGER_ERROR_CODES.INVALID_EVENT },

    { name: "generation (malformed)", input: { eventType: "e", source: "s", generation: "../rollback" }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "generation (non-string)", input: { eventType: "e", source: "s", generation: 7 }, code: LEDGER_ERROR_CODES.INVALID_EVENT },

    { name: "correlation (non-object)", input: { eventType: "e", source: "s", correlation: "nope" }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "correlation (unknown key)", input: { eventType: "e", source: "s", correlation: { bogus: "x" } }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "correlation (bad value)", input: { eventType: "e", source: "s", correlation: { sessionId: "" } }, code: LEDGER_ERROR_CODES.INVALID_EVENT },

    { name: "causalParentId (malformed)", input: { eventType: "e", source: "s", causalParentId: "../../etc/passwd" }, code: LEDGER_ERROR_CODES.MALFORMED_REF },

    { name: "actor.kind", input: { eventType: "e", source: "s", actor: { kind: "wizard", id: "a-1" } }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "actor.id", input: { eventType: "e", source: "s", actor: { kind: "agent", id: "" } }, code: LEDGER_ERROR_CODES.MALFORMED_REF },
    { name: "subject.kind", input: { eventType: "e", source: "s", subject: { kind: "wizard", id: "s-1" } }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "subject.id", input: { eventType: "e", source: "s", subject: { kind: "device", id: "" } }, code: LEDGER_ERROR_CODES.MALFORMED_REF },

    { name: "evidenceRef.kind", input: { eventType: "e", source: "s", evidenceRefs: [{ kind: "unknown", id: "x" }] }, code: LEDGER_ERROR_CODES.MALFORMED_REF },
    { name: "evidenceRef.id", input: { eventType: "e", source: "s", evidenceRefs: [{ kind: "toolResult", id: "" }] }, code: LEDGER_ERROR_CODES.MALFORMED_REF },
    { name: "evidenceRef.digest", input: { eventType: "e", source: "s", evidenceRefs: [{ kind: "toolResult", id: "x", digest: "short" }] }, code: LEDGER_ERROR_CODES.MALFORMED_REF },

    { name: "authorityRef.kind", input: { eventType: "e", source: "s", authorityRef: { kind: "root-god-mode", id: "x" } }, code: LEDGER_ERROR_CODES.INVALID_EVENT },
    { name: "authorityRef.id", input: { eventType: "e", source: "s", authorityRef: { kind: "grant", id: "" } }, code: LEDGER_ERROR_CODES.MALFORMED_REF },
    { name: "authorityRef.digest", input: { eventType: "e", source: "s", authorityRef: { kind: "grant", id: "x", digest: "nothex" } }, code: LEDGER_ERROR_CODES.MALFORMED_REF }
];

test("R2: append() throws LedgerError with stable code — never raw TypeError/RangeError", () => {
    for (const probe of PROBES) {
        const ledger = makeLedger();
        let thrown = null;
        try {
            ledger.append(probe.input);
        }
        catch (err) {
            thrown = err;
        }
        assert.ok(thrown !== null, `append must throw for ${probe.name}`);
        assert.ok(thrown instanceof LedgerError,
            `${probe.name}: append must throw LedgerError (got ${thrown.constructor.name})`);
        assert.equal(thrown instanceof TypeError, false, `${probe.name}: no raw TypeError`);
        assert.equal(thrown instanceof RangeError, false, `${probe.name}: no raw RangeError`);
        assert.equal(thrown.code, probe.code, `${probe.name}: stable code`);
        assert.equal(typeof thrown.message, "string");
    }
});

test("R2: appendSafe() returns ok:false with the same code — never E_INTERNAL", () => {
    for (const probe of PROBES) {
        const ledger = makeLedger();
        const result = ledger.appendSafe(probe.input);
        assert.equal(result.ok, false, `${probe.name}: appendSafe must reject`);
        assert.equal(result.error.code, probe.code,
            `${probe.name}: same semantic code`);
        assert.notEqual(result.error.code, "E_INTERNAL",
            `${probe.name}: must never map to E_INTERNAL`);
        assert.equal(typeof result.error.message, "string");
    }
});

test("R2: rejection leaves canonical ledger state byte-identical (no sequence burn)", () => {
    const ledger = makeLedger();
    const first = ledger.append({ eventType: "e", source: "s" });
    assert.equal(first.sequence, 1);

    const before = {
        logicalSequence: ledger.stats().logicalSequence,
        chainHead: ledger.stats().chainHead,
        retained: JSON.stringify(ledger.exportWindow({ limit: 100 })),
        size: ledger.size(),
        integrity: ledger.verifyIntegrity({ limit: 100 }).ok
    };

    for (const probe of PROBES) {
        assert.equal(ledger.appendSafe(probe.input).ok, false, `${probe.name} rejected`);
    }

    const after = {
        logicalSequence: ledger.stats().logicalSequence,
        chainHead: ledger.stats().chainHead,
        retained: JSON.stringify(ledger.exportWindow({ limit: 100 })),
        size: ledger.size(),
        integrity: ledger.verifyIntegrity({ limit: 100 }).ok
    };

    assert.deepEqual(after, before, "rejection batch must not mutate canonical state");

    const next = ledger.append({ eventType: "e", source: "s" });
    assert.equal(next.sequence, 2, "no sequence burned by rejections");
});

test("R2: arbitrary programming errors are not relabeled as caller mistakes", () => {
    // A sink that throws a non-TypeError/RangeError during durable append
    // is a persistence failure, not malformed caller input; it must keep
    // its own stable code (PERSIST_FAILED), not INVALID_EVENT/MALFORMED_REF.
    const sink = {
        append() { throw new Error("boom"); }
    };
    const ledger = makeLedger({ sink });
    const result = ledger.appendSafe({ eventType: "e", source: "s" }, { durable: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, LEDGER_ERROR_CODES.PERSIST_FAILED);
    assert.notEqual(result.error.code, "E_INTERNAL");
});
