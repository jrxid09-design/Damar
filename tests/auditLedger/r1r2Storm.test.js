"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditLedger, AuditPersistencePort } = require("../../src/runtime/auditLedger");

/**
 * R1/R2 STORM — >=12,000 deterministic mixed operations.
 *
 * Exercises top-level optional-undefined compatibility and typed validation
 * errors under sustained pressure, alongside the B1/B2/B3 hostile shapes.
 *
 * Required invariants:
 *   - logicalSequence == committed count (no sequence gaps / burns)
 *   - top-level undefined fields behave as absent
 *   - E_INTERNAL for malformed caller input == 0
 *   - no accessor/function retained; no getter invocation from stored records
 *   - integrity not poisoned; no Authority mutation; no timer/handle leak
 */

const BOUNDS = {
    maxInMemoryEvents: 2000,
    maxQueryLimit: 500,
    defaultQueryLimit: 100,
    maxMetadataBytes: 1024,
    maxMetadataStringLength: 256,
    maxMetadataDepth: 6,
    maxMetadataNodes: 4096,
    maxMetadataKeysPerLevel: 32,
    maxMetadataArrayItems: 16,
    maxEvidenceRefs: 8,
    maxEventTypeLength: 96,
    maxRefLength: 128
};

class FlakySink extends AuditPersistencePort {
    constructor() { super("r1r2-storm-sink"); this.calls = 0; }
    append() {
        this.calls += 1;
        if (this.calls % 2 === 0) throw new Error("transient io failure");
        return true;
    }
}

function activeResourceCounts() {
    if (typeof process.getActiveResourcesInfo !== "function") return null;
    const counts = {};
    for (const resource of process.getActiveResourcesInfo()) {
        counts[resource] = (counts[resource] || 0) + 1;
    }
    return counts;
}

function branchingDag(depth, branch) {
    let node = { leaf: "x" };
    for (let level = 0; level < depth; level++) {
        const parent = {};
        for (let k = 0; k < branch; k++) parent[`k${k}`] = node;
        node = parent;
    }
    return node;
}

const OPTIONAL_FIELDS = [
    "actor", "subject", "metadata", "operation", "outcome",
    "generation", "correlation", "evidenceRefs", "authorityRef",
    "eventId", "causalParentId"
];

test("R1/R2 storm: 12,000 mixed ops — undefined compat + typed errors, zero E_INTERNAL", () => {
    let t = 0;
    let id = 0;
    const sink = new FlakySink();
    const ledger = createAuditLedger({
        clock: () => ++t,
        idFactory: () => `ae-${String(++id).padStart(32, "0")}`,
        sink,
        bounds: BOUNDS
    });

    const before = activeResourceCounts();
    const dag = branchingDag(5, 64);

    let committed = 0;
    let eInternal = 0;
    let getterReads = 0;
    let lastSeq = 0;

    // A stable target for corrections/supersessions (first valid append).
    const anchor = ledger.append({ eventType: "anchor", source: "storm" });
    committed += 1;
    lastSeq = anchor.sequence;

    const malformedInputs = [
        { eventType: "e", source: "s", eventId: "bogus-id" },
        { eventType: "e", source: "Bad/Sub" },
        { eventType: "e", source: "s", generation: "../rollback" },
        { eventType: "e", source: "s", correlation: { bogus: "x" } },
        { eventType: "e", source: "s", correlation: { sessionId: "" } },
        { eventType: "e", source: "s", causalParentId: "../../etc/passwd" },
        { eventType: "e", source: "s", actor: { kind: "wizard", id: "x" } },
        { eventType: "e", source: "s", subject: { kind: "device", id: "" } },
        { eventType: "e", source: "s", evidenceRefs: [{ kind: "unknown", id: "x" }] },
        { eventType: "e", source: "s", authorityRef: { kind: "grant", id: "", digest: "short" } }
    ];

    for (let i = 0; i < 12_000; i++) {
        const mode = i % 10;

        switch (mode) {
            case 0: { // valid append
                const r = ledger.appendSafe({
                    eventType: `op.t${i % 7}`,
                    source: `svc.${i % 5}`,
                    actor: { kind: i % 2 ? "agent" : "device", id: `a-${i % 89}` },
                    subject: { kind: "device", id: `d-${i % 31}` },
                    outcome: i % 9 === 0 ? "error" : "ok",
                    generation: `rtg-${String(i % 3).repeat(32)}`,
                    correlation: { sessionId: `ses_${i % 40}`, interactionId: `ix_${i % 200}` },
                    evidenceRefs: [{ kind: "toolResult", id: `tr-${i % 500}` }],
                    metadata: { i, tag: `op-${i % 11}` }
                });
                if (r.ok) { committed += 1; lastSeq = r.event.sequence; }
                break;
            }
            case 1: { // top-level optional undefined (must behave as absent)
                const field = OPTIONAL_FIELDS[i % OPTIONAL_FIELDS.length];
                const input = { eventType: `op.t${i % 7}`, source: "svc.undefined" };
                input[field] = undefined;
                const r = ledger.appendSafe(input);
                assert.equal(r.ok, true, "top-level undefined must be accepted");
                // The undefined field must resolve to its absent default (never a literal undefined).
                assert.notEqual(r.event[field], undefined, "no undefined stored");
                committed += 1;
                lastSeq = r.event.sequence;
                break;
            }
            case 2: { // malformed input — typed error, never E_INTERNAL
                const r = ledger.appendSafe(malformedInputs[i % malformedInputs.length]);
                assert.equal(r.ok, false);
                if (r.error.code === "E_INTERNAL") eInternal += 1;
                break;
            }
            case 3: { // getter attack — rejected with zero invocation
                const actor = { kind: "agent", id: "stable" };
                Object.defineProperty(actor, "id", {
                    enumerable: true,
                    get() { getterReads += 1; return "x".repeat(5000); }
                });
                const r = ledger.appendSafe({ eventType: "probe.getter", source: "attack", actor });
                assert.equal(r.ok, false, "getter attack must reject");
                break;
            }
            case 4: { // Proxy double-return — store first read only
                const honest = { kind: "device", id: "dev-1" };
                let subjectReads = 0;
                const proxy = new Proxy(
                    { eventType: "probe.proxy", source: "attack", subject: honest },
                    {
                        get(target, key, receiver) {
                            if (key === "subject") {
                                subjectReads += 1;
                                return subjectReads === 1 ? honest : { kind: "user", id: "y".repeat(400) };
                            }
                            return Reflect.get(target, key, receiver);
                        }
                    }
                );
                const r = ledger.appendSafe(proxy);
                if (r.ok) { committed += 1; lastSeq = r.event.sequence; }
                break;
            }
            case 5: { // DAG amplification — bounded rejection
                const r = ledger.appendSafe({
                    eventType: "attack.dag", source: "attack",
                    metadata: i % 2 ? dag : { fn: () => {}, b: BigInt(i) }
                });
                assert.equal(r.ok, false);
                break;
            }
            case 6: { // duplicate ID (deterministic collision window)
                const dupId = `ae-${String((i % 100) + 1).padStart(32, "0")}`;
                const r = ledger.appendSafe({ eventType: "dup", source: "s", eventId: dupId });
                if (r.ok) { committed += 1; lastSeq = r.event.sequence; }
                else if (r.error.code === "E_INTERNAL") eInternal += 1;
                break;
            }
            case 7: { // durable failure (flaky sink)
                const r = ledger.appendSafe({ eventType: "durable", source: "s", metadata: { i } },
                    { durable: true });
                if (r.ok) { committed += 1; lastSeq = r.event.sequence; }
                else if (r.error.code === "E_INTERNAL") eInternal += 1;
                break;
            }
            case 8: { // correction / supersession (append-only new events)
                try {
                    const ev = (i % 2 === 0)
                        ? ledger.correct(anchor.eventId, { reason: `fix-${i}` })
                        : ledger.supersede(anchor.eventId, { reason: `sup-${i}` });
                    committed += 1;
                    lastSeq = ev.sequence;
                }
                catch (err) {
                    // target may be evicted under retention pressure — that is a
                    // typed NOT_APPENDABLE, never E_INTERNAL, and never a burn.
                    if (err.code === "E_INTERNAL") eInternal += 1;
                }
                break;
            }
            default: { // queries + integrity checks
                const q = [
                    () => ledger.list({}, { limit: 100 }),
                    () => ledger.list({ types: ["op.t0"] }, { limit: 50, order: "desc" }),
                    () => ledger.list({ correlation: { sessionId: `ses_${i % 40}` } }),
                    () => ledger.getByEventId(anchor.eventId),
                    () => ledger.verifyIntegrity(),
                    () => ledger.exportWindow()
                ][i % 6];
                q();
                break;
            }
        }
    }

    const stats = ledger.stats();

    // logicalSequence == committed count (zero sequence gaps / burns)
    assert.equal(stats.logicalSequence, committed,
        "logicalSequence must equal committed count");

    // malformed caller input never surfaced as E_INTERNAL
    assert.equal(eInternal, 0, "E_INTERNAL for malformed caller input must be 0");

    // getters never invoked during rejected hostile snapshots
    assert.equal(getterReads, 0, "getter invocation must be 0");

    // bounded memory / retention pressure
    assert.ok(ledger.size() <= BOUNDS.maxInMemoryEvents);

    // no accessor/function retained anywhere in the window
    const window = ledger.exportWindow({ limit: BOUNDS.maxQueryLimit });
    const stack = [...window];
    while (stack.length) {
        const node = stack.pop();
        if (node === null || typeof node !== "object") continue;
        for (const value of Object.values(node)) {
            assert.notEqual(typeof value, "function", "no callable retained");
            if (value && typeof value === "object") stack.push(value);
        }
    }

    // integrity not poisoned
    assert.equal(ledger.verifyIntegrity({ limit: BOUNDS.maxQueryLimit }).ok, true);

    // no Authority mutation / execution surface
    for (const key of Object.keys(ledger)) {
        assert.doesNotMatch(key, /^(grant|revoke|delegate|ratify|authoriz|execute|restore|replay|actuate)/);
    }

    // no timer/handle leak
    const after = activeResourceCounts();
    if (before && after) {
        const resources = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const resource of resources) {
            if (resource === "AsyncResource" || resource === "TestContext") continue;
            assert.ok((after[resource] || 0) - (before[resource] || 0) <= 0,
                `resource ${resource} leaked`);
        }
    }
});
