"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createAuditLedger,
    LedgerError,
    LEDGER_ERROR_CODES
} = require("../../src/runtime/auditLedger");

function makeLedger() {
    let t = 0;
    return createAuditLedger({ clock: () => ++t });
}

test("HOSTILE: forged authority fields are inert observations or rejected", () => {
    const ledger = makeLedger();

    // A well-formed authorityRef is RECORDED as a reference. It must be
    // plain data with zero behavior — it grants, revokes, and authorizes
    // nothing.
    ledger.append({
        eventType: "authority.grant.observed",
        source: "test.probe",
        authorityRef: { kind: "grant", id: "cap-123", digest: "a".repeat(64) }
    });

    const recorded = ledger.list({ types: ["authority.grant.observed"] }, { limit: 5 })[0];
    // Detached copy is plain data — every authorityRef field is a string.
    assert.equal(typeof recorded.authorityRef, "object");
    for (const key of Object.keys(recorded.authorityRef)) {
        const value = recorded.authorityRef[key];
        assert.ok(["string"].includes(typeof value), `authorityRef field ${key} must be data`);
    }

    // Unknown kinds and malformed ids/digests rejected.
    assert.throws(() => ledger.append({
        eventType: "e", source: "s",
        authorityRef: { kind: "root-god-mode", id: "x" }
    }), /kind invalid/);
    assert.throws(() => ledger.append({
        eventType: "e", source: "s",
        authorityRef: { kind: "grant", id: "x", digest: "nothex" }
    }), /digest malformed/);
});

test("HOSTILE: forged owner identity carries no power", () => {
    const ledger = makeLedger();
    ledger.append({
        eventType: "probe", source: "s",
        actor: { kind: "user", id: "owner" },
        subject: { kind: "device", id: "all-devices" }
    });
    // The ledger's API surface contains no authorize/grant/revoke/execute.
    for (const key of Object.keys(ledger)) {
        assert.doesNotMatch(key, /^(grant|revoke|delegate|ratify|authoriz|execute|restore|replay|actuate)/);
    }
});

test("HOSTILE: duplicate event ids rejected atomically", () => {
    const ledger = makeLedger();
    const id = "ae-" + "7".repeat(32);
    ledger.append({ eventType: "first", source: "s", eventId: id });
    const before = JSON.stringify(ledger.exportWindow({ limit: 100 }));
    assert.throws(() =>
        ledger.append({ eventType: "second", source: "s", eventId: id }),
        (err) => err.code === LEDGER_ERROR_CODES.DUPLICATE_EVENT_ID);
    assert.equal(JSON.stringify(ledger.exportWindow({ limit: 100 })), before);
});

test("HOSTILE: invalid timestamps fail closed", () => {
    const ledger = makeLedger();
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, 9e15 + 1, "123", {}, true]) {
        const result = ledger.appendSafe({ eventType: "e", source: "s", timestampMs: bad });
        assert.equal(result.ok, false, `should reject timestamp: ${String(bad)}`);
    }
    // Direct throw-path assertions (NaN is caught at the snapshot
    // boundary as non-finite; other shapes by the timestamp coercer):
    assert.throws(() => ledger.append({ eventType: "e", source: "s", timestampMs: NaN }),
        /timestampMs invalid|non-finite number/);
    for (const bad of [-1, 1.5, "123"]) {
        assert.throws(() => ledger.append({ eventType: "e", source: "s", timestampMs: bad }),
            /timestampMs invalid/);
    }
    assert.equal(ledger.size(), 0);
});

test("HOSTILE: generation refs are opaque identity — no rollback semantics exist", () => {
    const ledger = makeLedger();
    const oldGen = `rtg-${"0".repeat(32)}`;
    const newGen = `rtg-${"f".repeat(32)}`;
    ledger.append({ eventType: "e", source: "s", generation: newGen });
    ledger.append({ eventType: "e", source: "s", generation: oldGen }); // "older" gen fine: it's just an observation
    assert.equal(ledger.size(), 2);
    assert.throws(() => ledger.append({ eventType: "e", source: "s", generation: "../rollback" }),
        /generation ref malformed/);
    assert.throws(() => ledger.append({ eventType: "e", source: "s", generation: "gen_" + "x".repeat(100) }),
        /generation ref malformed/);
    // No rollback/replay method exists anywhere on the surface:
    for (const key of Object.keys(ledger)) {
        assert.doesNotMatch(key, /rollback|replay|rewind/i);
    }
});

test("HOSTILE: malformed evidence refs rejected", () => {
    const ledger = makeLedger();
    const cases = [
        ["not-array"],
        [{ kind: "unknownKind", id: "x" }],
        [{ kind: "toolResult" }],
        [{ kind: "toolResult", id: "" }],
        [{ kind: "toolResult", id: "ok", digest: "short" }],
        [{ kind: "toolResult", id: "ok", evilFn: () => {} }],
        [{}, { kind: "digest", id: "d" }]
    ];
    for (const evidenceRefs of cases) {
        assert.throws(() =>
            ledger.append({ eventType: "e", source: "s", evidenceRefs }),
            LedgerError, `should reject: ${JSON.stringify(evidenceRefs.map((r) => Object.keys(r)))}`);
    }
    assert.equal(ledger.size(), 0);
});

test("HOSTILE: function/callback payloads cannot enter the ledger", () => {
    const ledger = makeLedger();
    // As metadata value
    const r1 = ledger.appendSafe({ eventType: "e", source: "s", metadata: { cb: () => console.log("pwned") } });
    assert.equal(r1.ok, false);
    // As top-level field (rejected as unknown/invalid type)
    const r2 = ledger.appendSafe({
        eventType: () => {}, source: "s"
    });
    assert.equal(r2.ok, false);
    // As evidence ref field (function value rejected at snapshot boundary)
    assert.throws(() =>
        ledger.append({ eventType: "e", source: "s", evidenceRefs: [{ kind: "digest", id: { toString: () => "x" } }] }),
        /id malformed|must be an object|unsupported value type|non-plain object/);
    // Nothing stored can execute:
    for (const record of ledger.exportWindow({ limit: 10 })) {
        JSON.parse(JSON.stringify(record)); // serializable == no functions survive
    }
});

test("HOSTILE: very deep structures rejected atomically", () => {
    const ledger = makeLedger();
    let deep = {};
    let cursor = deep;
    for (let i = 0; i < 500; i++) { cursor.n = {}; cursor = cursor.n; }
    const result = ledger.appendSafe({ eventType: "e", source: "s", metadata: deep });
    assert.equal(result.ok, false);
    assert.equal(ledger.size(), 0);
});

test("HOSTILE: secret-shaped values never reach storage through any field", () => {
    const ledger = makeLedger();
    const secret = "sk-proj-supersecretvalue123456";
    ledger.append({
        eventType: "e", source: "s",
        metadata: { apiKey: secret, nested: { token: secret }, plain: secret }
    });
    const stored = ledger.list({}, { limit: 10 })[0];
    const raw = JSON.stringify(stored);
    assert.ok(!raw.includes(secret), "secret material leaked into stored record");
});
