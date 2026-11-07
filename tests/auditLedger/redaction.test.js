"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditLedger } = require("../../src/runtime/auditLedger");
const { sanitizeMetadata, REDACTED } = require("../../src/runtime/auditLedger/redact");

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

function makeLedger() {
    let t = 0;
    return createAuditLedger({ clock: () => ++t, bounds: BOUNDS });
}

test("credential-shaped keys are redacted regardless of value", () => {
    const meta = sanitizeMetadata({
        password: "harmless-string",
        apiKey: "123",
        AUTH_TOKEN: "short",
        privateKeyPath: "/home/user/.ssh/id_rsa",
        sessionKey: "abc",
        safeField: "kept"
    }, { ...BOUNDS, maxMetadataDepth: 8 });
    assert.equal(meta.password, REDACTED);
    assert.equal(meta.apiKey, REDACTED);
    assert.equal(meta.AUTH_TOKEN, REDACTED);
    assert.equal(meta.privateKeyPath, REDACTED);
    assert.equal(meta.sessionKey, REDACTED);
    assert.equal(meta.safeField, "kept");
});

test("credential-shaped values redacted", () => {
    const meta = sanitizeMetadata({
        a: "sk-proj-abcdefghijklmnop",
        b: "ghp_" + "x".repeat(30),
        c: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig",
        d: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.abc",
        e: "AKIA" + "IOSFODNN7EXAMPLE".slice(0, 16),
        f: "A".repeat(24)
    }, BOUNDS);
    assert.equal(meta.a, REDACTED);
    assert.equal(meta.b, REDACTED);
    assert.equal(meta.c, REDACTED);
    assert.equal(meta.d, REDACTED);
    assert.equal(meta.f, "A".repeat(24)); // not secret-shaped, kept
});

test("high-entropy long strings redacted", () => {
    const meta = sanitizeMetadata({ blob: "aB3$xY9" + "qQ7zZ2pP5vV8nN4mK1jH6gF0dS9wE2rT5uI8oL3k" }, BOUNDS);
    assert.equal(meta.blob, REDACTED);
});

test("functions, symbols, bigints rejected", () => {
    for (const bad of [
        { fn: () => {} },
        { s: Symbol("x") },
        { b: BigInt(1) },
        { u: undefined }
    ]) {
        assert.throws(() => sanitizeMetadata(bad, BOUNDS));
    }
});

test("cyclic structures rejected atomically", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    // Depth cap or cycle detection may fire first; both fail closed.
    assert.throws(() => sanitizeMetadata(cyclic, BOUNDS), /cyclic|deeper/);

    const deepCycle = { list: [{}] };
    deepCycle.list[0].back = deepCycle;
    assert.throws(() => sanitizeMetadata(deepCycle, BOUNDS), /cyclic|deeper/);
});

test("prototype pollution keys rejected fail-closed", () => {
    assert.throws(() => sanitizeMetadata(JSON.parse('{"__proto__": {"polluted": true}}'), BOUNDS),
        /forbidden metadata key/);
    assert.throws(() => sanitizeMetadata({ constructor: {} }, BOUNDS));
    assert.throws(() => sanitizeMetadata({ prototype: {} }, BOUNDS));

    // And the class-based pollution vector through the ledger:
    const ledger = makeLedger();
    const result = ledger.appendSafe({
        eventType: "e", source: "s",
        metadata: JSON.parse('{"__proto__": {"isAdmin": true}, "ok": 1}')
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "E_INVALID_EVENT");
    assert.equal(({}).isAdmin, undefined, "global prototype must be untouched");
    assert.equal(ledger.size(), 0);
});

test("depth / size bounds enforced", () => {
    let deep = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) { cursor.child = {}; cursor = cursor.child; }
    assert.throws(() => sanitizeMetadata(deep, BOUNDS), /deeper|depth/);

    // Long non-secret-shaped strings are truncated, not thrown away...
    const truncated = sanitizeMetadata(
        { blob: ("lorem ipsum dolor ".repeat(400)).slice(0, 4096) }, BOUNDS);
    assert.equal(truncated.blob.length, BOUNDS.maxMetadataStringLength);

    // ...but total byte budget still fails closed.
    const filler = "lorem ipsum dolor ".repeat(25); // spaced => not secret-shaped
    const manyBigFields = {};
    for (let i = 0; i < 10; i++) manyBigFields[`field${i}`] = filler;
    assert.throws(() => sanitizeMetadata(manyBigFields, BOUNDS), /exceeds 2048 bytes/);
});

test("ledger rejects oversized and malformed metadata without mutation", () => {
    const ledger = makeLedger();
    assert.throws(() => ledger.append({
        eventType: "e", source: "s", metadata: "not-an-object"
    }), /metadata/);
    assert.throws(() => ledger.append({
        eventType: "e", source: "s", metadata: [1, 2, 3]
    }), /metadata/);
    assert.equal(ledger.size(), 0);
});
