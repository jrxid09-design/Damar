"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditLedger, AuditPersistencePort } = require("../../src/runtime/auditLedger");

/**
 * STORM — >=10,000 deterministic mixed append/query operations.
 *
 * Requirements under pressure:
 *   - bounded memory (retention window respected exactly)
 *   - stable ordering (sequence strictly monotonic; query order consistent)
 *   - no cross-record mutation
 *   - no command replay surface (no method executes anything)
 *   - no Authority mutations (structural — see structural.test.js)
 *   - no hidden execution / no timer or handle leak
 */

const BOUNDS = {
    maxInMemoryEvents: 2000,
    maxQueryLimit: 500,
    defaultQueryLimit: 100,
    maxMetadataBytes: 1024,
    maxMetadataStringLength: 256,
    maxMetadataDepth: 6,
    maxMetadataKeysPerLevel: 32,
    maxMetadataArrayItems: 16,
    maxEvidenceRefs: 8,
    maxEventTypeLength: 96,
    maxRefLength: 128
};

function activeResourceCounts() {
    if (typeof process.getActiveResourcesInfo !== "function") return null;
    const counts = {};
    for (const resource of process.getActiveResourcesInfo()) {
        counts[resource] = (counts[resource] || 0) + 1;
    }
    return counts;
}

test("storm: 12,000 mixed operations stay bounded, ordered, and leak-free", () => {
    let t = 0;
    const ledger = createAuditLedger({
        clock: () => ++t,
        bounds: BOUNDS
    });

    const before = activeResourceCounts();

    let accepted = 0;
    let rejected = 0;
    let lastSequence = 0;

    const eventTypes = ["tool.executed", "authority.grant.observed", "presence.transition.observed", "recovery.checkpoint.recorded"];
    const sources = ["runtime.tools", "authority", "presence", "recovery"];
    const generations = [`rtg-${"1".repeat(32)}`, `rtg-${"2".repeat(32)}`, `gen_${"3".repeat(30)}aaaa`];

    for (let i = 0; i < 12_000; i++) {
        const mode = i % 4;

        if (mode === 3) {
            // ---- malformed quarter: hostile mix ----------------------
            const bad = [
                { eventType: "e", source: "s", metadata: JSON.parse('{"__proto__":{"x":1}}') },
                { eventType: "e", source: "s", eventId: "ae-" + "d".repeat(32) }, // dup of earlier valid id? no—fresh but collides with nothing; make real dups below
                { eventType: "e", source: "s", timestampMs: -5 },
                { eventType: "", source: "s" },
                { eventType: "e", source: "s", metadata: { secret: "sk-abcdefghijklmnop" } },
                null,
                { eventType: "e", source: "s", generation: "bogus-gen" }
            ][i % 7];
            const result = ledger.appendSafe(bad);
            if (result.ok) accepted++; else rejected++;
            continue;
        }

        if (mode === 2) {
            // ---- query quarter ---------------------------------------
            const queries = [
                () => ledger.list({ types: ["tool.executed"] }),
                () => ledger.list({ source: "authority" }),
                () => ledger.list({ correlation: { sessionId: `ses_${i % 50}` } }),
                () => ledger.list({ generation: generations[i % 3] }, { limit: 50, order: "desc" }),
                () => ledger.getByEventId(`ae-${String(i).padStart(8, "0").slice(0, 8)}`),
                () => ledger.verifyIntegrity(),
                () => ledger.exportWindow()
            ];
            const run = queries[i % queries.length];
            const out = run();
            assert.ok(out !== undefined);
            continue;
        }

        // ---- valid append (with occasional true duplicate ids) -------
        const isDup = mode === 1 && i > 100;
        const input = {
            eventType: eventTypes[i % eventTypes.length],
            source: sources[i % sources.length],
            actor: { kind: i % 2 ? "agent" : "device", id: `actor-${i % 97}` },
            subject: { kind: "device", id: `dev-${i % 31}` },
            outcome: i % 9 === 0 ? "error" : "ok",
            generation: generations[i % generations.length],
            correlation: {
                sessionId: `ses_${i % 50}`,
                interactionId: `ix_${i % 200}`,
                deviceId: `dev-${i % 31}`
            },
            evidenceRefs: [{ kind: "toolResult", id: `tr-${i % 500}` }],
            metadata: { iteration: i, note: `op-${i % 13}` }
        };
        if (!isDup && mode === 1) input.eventId = `ae-${String(i).padStart(32, "0").slice(0, 32)}`;
        if (isDup) input.eventId = `ae-${String(i - 100).padStart(32, "0").slice(0, 32)}`;

        const result = ledger.appendSafe(input);
        if (result.ok) {
            accepted++;
            assert.ok(result.event.sequence > lastSequence);
            lastSequence = result.event.sequence;
        }
        else rejected++;
    }

    // ---- post-storm invariants ---------------------------------------
    assert.equal(ledger.size() <= BOUNDS.maxInMemoryEvents, true, "memory bound");
    const stats = ledger.stats();
    assert.ok(stats.acceptedCount + stats.rejectedCount >= 9_000,
        "all append attempts must be accounted (3 of 4 quarters are appends)");
    assert.equal(stats.retainedEvents, ledger.size());

    // Stable ordering across the retained window.
    const windowAsc = ledger.list({}, { limit: BOUNDS.maxQueryLimit });
    for (let i = 1; i < windowAsc.length; i++) {
        assert.ok(windowAsc[i].sequence > windowAsc[i - 1].sequence);
    }
    const windowDesc = ledger.list({}, { limit: BOUNDS.maxQueryLimit, order: "desc" });
    for (let i = 1; i < windowDesc.length; i++) {
        assert.ok(windowDesc[i].sequence < windowDesc[i - 1].sequence);
    }
    // The newest retained record is exactly the last accepted append.
    assert.equal(windowDesc[0].sequence, stats.logicalSequence);

    // Integrity holds over the retained window.
    assert.equal(ledger.verifyIntegrity({ limit: BOUNDS.maxQueryLimit }).ok, true);

    // No handle/timer leak introduced by the ledger.
    const after = activeResourceCounts();
    if (before && after) {
        const resources = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const resource of resources) {
            const grew = (after[resource] || 0) - (before[resource] || 0);
            if (resource === "AsyncResource" || resource === "TestContext") continue; // test harness noise
            assert.ok(grew <= 0, `resource ${resource} leaked (${before[resource] || 0} -> ${after[resource] || 0})`);
        }
    }
});

/* ====================================================================
 * REPAIR STORM — B1/B2/B3 categories under sustained pressure.
 * ==================================================================== */

class FlakySink extends AuditPersistencePort {
    constructor() { super("flaky-repair-storm-sink"); this.calls = 0; }
    append(record) {
        this.calls += 1;
        if (this.calls % 2 === 0) throw new Error("transient io failure");
        return true;
    }
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

test("repair storm: 12,000 mixed ops with getter/Proxy/DAG/durable/dup attacks", () => {
    let t = 0;
    const sink = new FlakySink();
    const bounds = { ...BOUNDS };
    const ledger = createAuditLedger({ clock: () => ++t, sink, bounds });

    const before = activeResourceCounts();
    const dag = branchingDag(5, 64);

    function makeGetterEvent(i) {
        const actor = { kind: "agent", id: "stable" };
        let reads = 0;
        Object.defineProperty(actor, "id", {
            enumerable: true,
            get() { reads += 1; return reads === 1 ? "stable" : "x".repeat(5000); }
        });
        return { eventType: "probe.getter", source: "attack", actor };
    }

    function makeProxyEvent() {
        const honest = { kind: "device", id: "dev-1" };
        let subjectReads = 0;
        return new Proxy(
            { eventType: "probe.proxy.storm", source: "attack", subject: honest },
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
    }

    const pinnedId = "ae-" + "c".repeat(32);
    let accepted = 0;
    let rejected = 0;
    let lastSeq = 0;

    for (let i = 0; i < 12_000; i++) {
        const mode = i % 6;
        let outcome;

        switch (mode) {
            case 0: { // legitimate append
                const event = ledger.appendSafe({
                    eventType: `legit.op${i % 5}`, source: `svc.${i % 4}`,
                    actor: { kind: i % 2 ? "agent" : "device", id: `a-${i % 89}` },
                    correlation: { sessionId: `ses_${i % 40}` },
                    generation: `rtg-${String(i % 3).repeat(32)}`,
                    metadata: { i, tag: `op-${i % 11}` }
                });
                outcome = event.ok ? event.event : null;
                break;
            }
            case 1: // getter attack
                outcome = null;
                assert.equal(ledger.appendSafe(makeGetterEvent(i)).ok, false);
                break;
            case 2: // Proxy double-return attack
                outcome = ledger.appendSafe(makeProxyEvent()).event || null;
                break;
            case 3: { // shared-reference amplification / canonicalization failure
                const r = ledger.appendSafe({
                    eventType: "attack.dag", source: "attack",
                    metadata: i % 2 ? dag : { fn: () => {}, b: BigInt(i) }
                });
                if (r.ok) outcome = r.event;
                break;
            }
            case 4: { // duplicate ID + durable flakiness
                if (i % 12 === 4) {
                    const r = ledger.appendSafe(
                        { eventType: "dup", source: "s", eventId: i % 24 === 4 ? pinnedId : undefined,
                          metadata: { i } },
                        { durable: i % 2 === 0 });
                    if (r.ok) outcome = r.event;
                }
                else {
                    const r = ledger.appendSafe({ eventType: `durable.op`, source: "s", metadata: { i } },
                        { durable: true });
                    if (r.ok) outcome = r.event;
                }
                break;
            }
            default: { // queries + retention pressure + integrity checks
                const q = [
                    () => ledger.list({}, { limit: 100 }),
                    () => ledger.list({ types: ["legit.op0"] }, { limit: 50, order: "desc" }),
                    () => ledger.list({ correlation: { sessionId: `ses_${i % 40}` } }),
                    () => ledger.getByEventId(pinnedId),
                    () => ledger.verifyIntegrity(),
                    () => ledger.exportWindow()
                ][i % 6];
                q();
                outcome = undefined;
            }
        }

        if (outcome === null) rejected++;
        else if (outcome !== undefined) {
            accepted++;
            assert.ok(outcome.sequence > lastSeq, "sequence strictly monotonic");
            lastSeq = outcome.sequence;
        }
    }

    // ---- zero sequence gaps from rejected operations -----------------
    const stats = ledger.stats();
    assert.equal(stats.logicalSequence, stats.acceptedCount,
        "sequence must advance exactly once per committed event");

    // ---- bounded memory / retention pressure --------------------------
    assert.ok(ledger.size() <= BOUNDS.maxInMemoryEvents);

    // ---- no accessor/function retained anywhere in the window --------
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

    // ---- integrity not poisoned ---------------------------------------
    assert.equal(ledger.verifyIntegrity({ limit: BOUNDS.maxQueryLimit }).ok, true);

    // ---- no Authority mutation / execution surface (structural keys) --
    for (const key of Object.keys(ledger)) {
        assert.doesNotMatch(key, /^(grant|revoke|delegate|ratify|authoriz|execute|restore|replay|actuate)/);
    }

    // ---- no timer/handle leak -----------------------------------------
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
