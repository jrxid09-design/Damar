"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditLedger } = require("../../src/runtime/auditLedger");

function makeLedger(extra = {}) {
    let t = 0;
    return createAuditLedger({ clock: () => ++t, ...extra });
}

/** Getter that would pass validation on read #1 and be malicious later. */
function splitReadGetter(valid, malicious) {
    let reads = 0;
    return {
        get reads() { return reads; },
        descriptorFor(obj, key) {
            Object.defineProperty(obj, key, {
                enumerable: true,
                get() { reads += 1; return reads === 1 ? valid : malicious; }
            });
        }
    };
}

test("B1: actor.id getter (valid -> malicious) is rejected WITHOUT invocation", () => {
    const ledger = makeLedger();
    const g = splitReadGetter("agent-1", "x".repeat(500));
    const actor = { kind: "agent", id: "placeholder" };
    g.descriptorFor(actor, "id");

    const result = ledger.appendSafe({
        eventType: "probe.e", source: "t", actor
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "E_INVALID_EVENT");
    assert.match(result.error.message, /accessor property/);
    assert.equal(g.reads, 0, "getter must never be invoked");
    assert.equal(ledger.size(), 0);
});

test("B1: actor.kind getter (valid -> forged vocabulary) rejected", () => {
    const ledger = makeLedger();
    const g = splitReadGetter("agent", "superadmin-godmode");
    const actor = { kind: "placeholder", id: "a-1" };
    g.descriptorFor(actor, "kind");

    const result = ledger.appendSafe({ eventType: "probe.e", source: "t", actor });
    assert.equal(result.ok, false);
    assert.equal(g.reads, 0);
});

test("B1: subject equivalent getters rejected identically", () => {
    for (const field of ["id", "kind"]) {
        const ledger = makeLedger();
        let reads = 0;
        const subject = { kind: "device", id: "d-1" };
        delete subject[field];
        Object.defineProperty(subject, field, {
            enumerable: true,
            get() { reads += 1; return field === "kind" ? "device" : "d-1"; }
        });
        const result = ledger.appendSafe({ eventType: "probe.e", source: "t", subject });
        assert.equal(result.ok, false, `subject.${field} accessor must reject`);
        assert.equal(reads, 0);
        assert.equal(ledger.size(), 0);
    }
});

test("B1: authorityRef.id getter smuggling a JWT is rejected", () => {
    const ledger = makeLedger();
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lciJ9.sig";
    const authorityRef = { kind: "grant", id: "cap-ok" };
    let reads = 0;
    Object.defineProperty(authorityRef, "id", {
        enumerable: true,
        get() { reads += 1; return reads === 1 ? "cap-ok" : jwt; }
    });

    const result = ledger.appendSafe({
        eventType: "authority.grant.observed", source: "t", authorityRef
    });
    assert.equal(result.ok, false);
    assert.equal(reads, 0);

    // And nothing resembling the token may exist anywhere in storage.
    const raw = JSON.stringify(ledger.exportWindow({ limit: 100 }));
    assert.ok(!raw.includes("eyJhbGci"));
});

test("B1: evidenceRef.id getter (short -> over max length) rejected", () => {
    const ledger = makeLedger();
    const evidenceRefs = [{ kind: "toolResult", id: "tr-1" }];
    let reads = 0;
    Object.defineProperty(evidenceRefs[0], "id", {
        enumerable: true,
        get() { reads += 1; return reads === 1 ? "tr-1" : "z".repeat(5000); }
    });

    const result = ledger.appendSafe({ eventType: "probe.e", source: "t", evidenceRefs });
    assert.equal(result.ok, false);
    assert.equal(reads, 0);
});

test("B1: evidenceRef.digest and outcome getters rejected", () => {
    const ledger = makeLedger();

    const evidenceRefs = [{ kind: "digest", id: "d-1", digest: "a".repeat(64) }];
    let digestReads = 0;
    Object.defineProperty(evidenceRefs[0], "digest", {
        enumerable: true,
        get() { digestReads += 1; return digestReads === 1 ? "a".repeat(64) : "f".repeat(64); }
    });
    assert.equal(ledger.appendSafe({ eventType: "probe.e", source: "t", evidenceRefs }).ok, false);
    assert.equal(digestReads, 0);

    const event = { eventType: "probe.e", source: "t", outcome: "ok" };
    let outcomeReads = 0;
    Object.defineProperty(event, "outcome", {
        enumerable: true,
        get() { outcomeReads += 1; return outcomeReads === 1 ? "ok" : "GRANTED"; }
    });
    assert.equal(ledger.appendSafe(event).ok, false);
    assert.equal(outcomeReads, 0);
    assert.equal(ledger.size(), 0);
});

test("B1: Proxy returning different values across reads stores FIRST read only", () => {
    const ledger = makeLedger();

    const evil = { kind: "user", id: "x".repeat(300) };
    const honest = { kind: "device", id: "dev-1" };
    let getTraps = 0;

    const proxy = new Proxy(
        { eventType: "probe.proxy", source: "t", subject: honest },
        {
            get(target, key, receiver) {
                getTraps += 1;
                if (key === "subject") {
                    getTraps += 1000; // marker per subject read
                    return getTraps < 1002 ? honest : evil;
                }
                return Reflect.get(target, key, receiver);
            }
        }
    );

    const result = ledger.appendSafe(proxy);
    assert.equal(result.ok, true);
    const firstSubjectReads = getTraps;

    // Whatever was snapshotted must be inert, bounded, and stable.
    const stored = ledger.getByEventId(result.event.eventId);
    assert.equal(stored.subject.kind, "device");
    assert.equal(stored.subject.id, "dev-1");
    assert.equal(stored.subject.id.length <= 128, true);

    // Queries must not touch the caller's proxy again.
    ledger.list({}, { limit: 100 });
    ledger.list({ types: ["probe.proxy"] }, { limit: 100 });
    ledger.getByEventId(result.event.eventId);
    ledger.exportWindow({ limit: 100 });
    ledger.verifyIntegrity();
    assert.equal(getTraps, firstSubjectReads,
        "proxy traps must not fire during query/export/integrity work");

    // Mutating the source object must not affect the store.
    honest.id = "TAMPERED";
    assert.equal(ledger.getByEventId(result.event.eventId).subject.id, "dev-1");
});

test("B1: Proxy spoofing a plain prototype still yields inert storage", () => {
    const ledger = makeLedger();
    let calls = 0;
    const sneaky = new Proxy({}, {
        getPrototypeOf() { return Object.prototype; }, // lie: claim plainness
        ownKeys() { calls += 1; return ["eventType", "source"]; },
        getOwnPropertyDescriptor(t, key) {
            if (key === "eventType") return { enumerable: true, value: "probe.sneaky", writable: true, configurable: true };
            if (key === "source") return { enumerable: true, value: "t", writable: true, configurable: true };
            return undefined;
        },
        get(t, key) { calls += 1; return key === "eventType" ? "probe.sneaky" : "t"; }
    });

    const result = ledger.appendSafe(sneaky);
    assert.equal(result.ok, true);
    const stored = ledger.list({ types: ["probe.sneaky"] }, { limit: 5 })[0];
    assert.equal(stored.eventType, "probe.sneaky");
    assert.equal(stored.source, "t");
    const trapsAfterStorage = calls;
    ledger.getByEventId(stored.eventId);
    ledger.verifyIntegrity();
    assert.equal(calls, trapsAfterStorage, "no caller-code execution after storage");
});

test("B1: DATA-ONLY proof over EVERY stored AuditEvent", () => {
    const ledger = makeLedger();
    ledger.append({
        eventType: "probe.deep", source: "t",
        actor: { kind: "agent", id: "a-1" },
        correlation: { sessionId: "ses_1" },
        metadata: { nested: { deeper: [1, "two", { three: 3 }] } },
        evidenceRefs: [{ kind: "digest", id: "d-1", digest: "a".repeat(64) }]
    });
    ledger.correct((ledger.exportWindow({ limit: 10 }))[0].eventId, { reason: "fix" });

    const window = ledger.exportWindow({ limit: 100 });
    assert.equal(window.length, 2);

    const stack = [...window];
    while (stack.length) {
        const node = stack.pop();
        if (node === null || typeof node !== "object") continue;
        assert.ok(Array.isArray(node) || Object.getPrototypeOf(node) === Object.prototype || Object.getPrototypeOf(node) === null,
            "every stored node must be a plain object/array");
        for (const value of Object.values(node)) {
            assert.notEqual(typeof value, "function");
            assert.notEqual(typeof value, "symbol");
            if (value && typeof value === "object") stack.push(value);
        }
    }
});
