"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    newAuditEventId,
    coerceAuditEventId,
    CORRELATION_KEYS
} = require("../../src/runtime/auditLedger/ids");

test("AuditEventId canonical shape and randomness", () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
        const id = newAuditEventId();
        assert.match(id, /^ae-[0-9a-f]{32}$/);
        seen.add(id);
    }
    assert.equal(seen.size, 1000, "ids must not collide");
});

test("coerceAuditEventId round-trips valid ids", () => {
    const id = newAuditEventId();
    assert.equal(coerceAuditEventId(id), id);
});

test("coerceAuditEventId fails closed on garbage", () => {
    for (const bad of [
        null, undefined, 42, {}, [],
        "", "ae-", "ae-ZZZZ", "AE-" + "a".repeat(32),
        "ae-" + "a".repeat(31), "ae-" + "a".repeat(33),
        "ix_" + "a".repeat(32), "x" + "a".repeat(40),
        "ae-" + "a".repeat(32) + "extra"
    ]) {
        assert.throws(() => coerceAuditEventId(bad), /AuditEventId/,
            `should reject: ${JSON.stringify(String(bad))}`);
    }
});

test("correlation keys are a closed set", () => {
    assert.deepEqual([...CORRELATION_KEYS].sort(), [
        "correlationId", "deviceId", "interactionId", "projectId", "sessionId", "turnId"
    ]);
});
