"use strict";

/**
 * Audit Ledger durable file sink tests (Trust Foundation stage).
 *
 * Proves the durable production sink behind the EXISTING ledger persistence
 * port: durable events survive restart, sequence continues, hash chain stays
 * valid, a failed write never produces a false durable success, corruption /
 * truncation fails closed, and redaction + trust event vocabulary are
 * preserved.  These events are test vocabulary only — no Owner logic here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    createAuditLedger,
    createFileAuditSink,
    LedgerError,
    LEDGER_ERROR_CODES
} = require("../../src/runtime/auditLedger");

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "audit-filesink-"));
}

function makeLedger(sink, extra = {}) {
    let t = 0;
    return createAuditLedger({ clock: () => ++t, sink, ...extra });
}

test("durable event survives restart and is read back identically", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    const e1 = ledger.append({ eventType: "trust.owner.enrolled", source: "test", outcome: "ok" }, { durable: true });
    const e2 = ledger.append({ eventType: "trust.proof.failed", source: "test", outcome: "denied" }, { durable: true });
    sink.close();

    // "Restart": a fresh sink over the same file (single-writer lock freed).
    const sink2 = createFileAuditSink(file);
    const records = sink2.readAll();
    assert.equal(records.length, 2);
    assert.equal(records[0].eventId, e1.eventId);
    assert.equal(records[1].eventId, e2.eventId);
    assert.equal(records[0].eventType, "trust.owner.enrolled");
    assert.equal(records[1].eventType, "trust.proof.failed");
    sink2.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("sequence is strictly increasing and continues across restart", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    ledger.append({ eventType: "a.b", source: "s" }, { durable: true });
    ledger.append({ eventType: "a.b", source: "s" }, { durable: true });

    const tail = sink.describeDurable();
    assert.equal(tail.lastSequence, 2);
    assert.equal(tail.corrupt, false);
    sink.close();

    const sink2 = createFileAuditSink(file);
    const tail2 = sink2.describeDurable();
    assert.equal(tail2.lastSequence, 2, "sequence tail continues across restart");
    assert.ok(typeof tail2.lastDigest === "string" && tail2.lastDigest.length === 64);
    sink2.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("hash chain remains valid across many durable appends", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    for (let i = 0; i < 12; i += 1) {
        ledger.append({ eventType: "trust.credential.rotated", source: "test" }, { durable: true });
    }
    sink.close();
    const sink2 = createFileAuditSink(file);
    assert.equal(sink2.describeDurable().corrupt, false, "chain verifies clean on reopen");
    assert.equal(sink2.describeDurable().records, 12);
    sink2.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("failed durable write does not produce false durable success (atomic reject)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    ledger.append({ eventType: "trust.owner.enrolled", source: "test" }, { durable: true });

    // Force a write failure by making the sink file a directory.
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    const before = ledger.stats().logicalSequence;
    assert.throws(() =>
        ledger.append({ eventType: "trust.device.revoked", source: "test" }, { durable: true }),
        (err) => err instanceof LedgerError && err.code === LEDGER_ERROR_CODES.PERSIST_FAILED);
    assert.equal(ledger.stats().logicalSequence, before,
        "rejected durable append must NOT advance the sequence (no false durable success)");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("duplicate eventId is rejected by the durable sink", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    const e = ledger.append({ eventType: "a.b", source: "s" }, { durable: true });
    sink.close();
    // A second sink instance over the same file knows the eventId.
    const sink2 = createFileAuditSink(file);
    assert.throws(() => sink2.append(e),
        (err) => err instanceof LedgerError && err.code === LEDGER_ERROR_CODES.PERSIST_FAILED);
    sink2.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("corrupt history fails closed and refuses further appends (no silent reset)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    ledger.append({ eventType: "a.b", source: "s" }, { durable: true });
    sink.close();

    // Corrupt the file (break the JSON of the record).
    fs.writeFileSync(file, '{"eventId":"x","sequence":1,"integrity":', "utf8");
    const sink2 = createFileAuditSink(file);
    const tail = sink2.describeDurable();
    assert.equal(tail.corrupt, true, "corrupt history must be detected");
    assert.ok(tail.corruptReason);
    assert.throws(() => sink2.append({ eventId: "y", sequence: 2, integrity: {} }),
        (err) => err instanceof LedgerError && err.code === LEDGER_ERROR_CODES.PERSIST_FAILED,
        "sink in corrupt state must refuse appends");
    sink2.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("tampered record (digest mismatch) fails closed on reopen", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    ledger.append({ eventType: "trust.proof.failed", source: "test" }, { durable: true });
    sink.close();

    // Tamper: rewrite the eventType but keep the old digest.
    const raw = fs.readFileSync(file, "utf8");
    const tampered = raw.replace("trust.proof.failed", "trust.owner.enrolled");
    assert.notEqual(tampered, raw);
    fs.writeFileSync(file, tampered, "utf8");

    const sink2 = createFileAuditSink(file);
    assert.equal(sink2.describeDurable().corrupt, true,
        "a tampered record must break the chain and be detected");
    sink2.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("truncated/partial last write is treated as corruption (fail closed)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    ledger.append({ eventType: "a.b", source: "s" }, { durable: true });
    sink.close();

    // Append a truncated partial line.
    fs.appendFileSync(file, '{"eventId":"partial","sequence":2');
    const sink2 = createFileAuditSink(file);
    assert.equal(sink2.describeDurable().corrupt, true,
        "a truncated trailing write must fail closed, not be silently dropped or accepted");
    sink2.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("redaction is preserved through the durable path (no secret metadata)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    ledger.appendSafe({
        eventType: "trust.owner.enrolled",
        source: "test",
        metadata: { note: "ok", password: "shh-secret" }
    }, { durable: true });

    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.includes("shh-secret"), false,
        "redacted secret-shaped metadata must never reach the durable file");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("trust-style event vocabulary accepted under the dotted grammar", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    const types = [
        "trust.owner.enrolled",
        "trust.proof.failed",
        "trust.device.revoked",
        "trust.credential.rotated"
    ];
    for (const eventType of types) {
        const r = ledger.append({ eventType, source: "test" }, { durable: true });
        assert.equal(r.eventType, eventType);
    }
    sink.close();
    const records = createFileAuditSink(file).readAll();
    assert.deepEqual(records.map((r) => r.eventType), types);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("non-durable appends do not write to the durable file", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = makeLedger(sink);
    ledger.appendSafe({ eventType: "a.b", source: "s" }); // NOT durable
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().length : 0, 0,
        "non-durable append must not be persisted");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("sink remains an AuditPersistencePort-shaped append(record) -> true", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    assert.equal(typeof sink.append, "function");
    const ledger = makeLedger(sink);
    const e = ledger.append({ eventType: "a.b", source: "s" }, { durable: true });
    assert.equal(typeof e.eventId, "string");
    fs.rmSync(dir, { recursive: true, force: true });
});
