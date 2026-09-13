const test = require("node:test");
const assert = require("node:assert");

const { createSelfModel } = require("../../../src/cognition/selfmodel");

/**
 * W7-L1 adversarial suite — the twelve attacks from
 * `W7_SELF_MODEL_FORMAL_SPEC.md` §11 (SM-A1..A12).
 */

function fakeRegistry(descriptors = {}) {
    const map = new Map(Object.entries(descriptors));
    return {
        get: (id) => (map.has(id) ? { id, ...map.get(id) } : null),
        has: (id) => map.has(id),
        getAvailability: () => { throw new Error("unused"); }
    };
}

function manualClock(startMs) {
    let t = startMs;
    return { nowMs: () => t, advance: (ms) => { t += ms; } };
}

/** Cocokkan `error.reason` (SelfModelError), bukan teks pesan. */
function assertThrowsReason(fn, reason) {
    assert.throws(fn, (err) => {
        assert.equal(err.reason, reason, `expected reason '${reason}', got '${err.reason}': ${err.message}`);
        return true;
    });
}

test("SM-A1: model claiming a capability in free text cannot set selfBelief", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    // there is no API path that accepts free text at all — the only inputs
    // are ingestAvailability/ingestOutcome/ingestHealth, all schema-checked.
    const a = sm.assess("cap.x");
    assert.equal(a.selfBelief, "UNKNOWN", "no observation ever ingested -> UNKNOWN, never USABLE from assertion");
});

test("SM-repair-1: a future-dated availability observation is rejected, not treated as fresh (Codex P2 round 5)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const clock = manualClock(1_000_000);
    const sm = await createSelfModel({ capabilityRegistry: registry, clock });
    assert.throws(() => sm.ingestAvailability({
        capabilityId: "cap.x", availability: "AVAILABLE", generation: 1,
        observedAtMs: 1_000_000 + 60_000 // 60s in the future, well past MAX_FUTURE_SKEW_MS
    }), (err) => {
        assert.equal(err.reason, "INVALID_OBSERVATION");
        return true;
    });
});

test("SM-A2: stale availability is marked STALE after TTL, never silently USABLE", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const clock = manualClock(0);
    const sm = await createSelfModel({ capabilityRegistry: registry, clock });
    sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 0 });
    clock.advance(31_000); // past the 30s AVAILABILITY_TTL_MS
    const a = sm.assess("cap.x");
    assert.equal(a.epistemicClass, "STALE");
    assert.equal(a.selfBelief, "UNKNOWN");
});

test("SM-A3: no authority surface anywhere in an assessment", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    const a = sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 1 });
    for (const forbidden of ["allowed", "authorized", "grant", "permission", "authProof"]) {
        assert.equal(Object.prototype.hasOwnProperty.call(a, forbidden), false, forbidden);
    }
});

test("SM-A4: forged outcome (bad tier / missing evidenceRef) is rejected", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    assertThrowsReason(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: "T5", outcome: "SUCCESS", at: "t", evidenceRef: "e" }),
        "INVALID_OUTCOME");
    assertThrowsReason(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: "t", evidenceRef: "" }),
        "INVALID_OUTCOME");
});

test("SM-A5: capability id spam stays bounded, does not grow unbounded", async () => {
    const descriptors = {};
    for (let i = 0; i < 10_000; i++) descriptors[`spam.${i}`] = { kind: "tool" };
    const registry = fakeRegistry(descriptors);
    const sm = await createSelfModel({ capabilityRegistry: registry });
    for (let i = 0; i < 10_000; i++) {
        sm.ingestAvailability({ capabilityId: `spam.${i}`, availability: "AVAILABLE", generation: 1, observedAtMs: i });
    }
    const snap = sm.snapshot();
    assert.ok(snap.capabilityAssessments.length <= sm.bounds.MAX_CAPABILITY_ASSESSMENTS);
});

test("SM-A5b: unregistered capability id is rejected outright (cannot even enter the cache)", async () => {
    const sm = await createSelfModel({ capabilityRegistry: fakeRegistry({}) });
    assertThrowsReason(() => sm.ingestAvailability({ capabilityId: "ghost", availability: "AVAILABLE", generation: 1, observedAtMs: 1 }),
        "UNKNOWN_CAPABILITY");
});

test("SM-A6: revocation invalidates immediately, self-model is not a stale cache bypassing it", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const clock = manualClock(1000);
    const sm = await createSelfModel({ capabilityRegistry: registry, clock });
    sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: clock.nowMs() });
    assert.equal(sm.assess("cap.x").selfBelief, "USABLE");

    sm.ingestAvailability({ capabilityId: "cap.x", availability: "UNAVAILABLE", generation: 2, observedAtMs: clock.nowMs() });
    assert.equal(sm.assess("cap.x").selfBelief, "UNUSABLE", "revocation reflected immediately");
});

test("SM-A7: nodeId can only come from meshPort.identity(), never from ingested payloads", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const meshPort = { identity: () => ({ nodeId: "real-node", nodeRole: "primary" }) };
    const sm = await createSelfModel({ capabilityRegistry: registry, meshPort });

    // An ingest payload smuggling a nodeId field is simply not read anywhere.
    sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 1, nodeId: "spoofed-node" });

    const snap = sm.snapshot();
    assert.equal(snap.identity.nodeId, "real-node", "identity comes only from meshPort, spoofed field ignored");
});

test("SM-A8: restart never restores availability as fresh", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const clock = manualClock(1000);
    const sm1 = await createSelfModel({ capabilityRegistry: registry, clock });
    sm1.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: clock.nowMs() });
    assert.equal(sm1.assess("cap.x").selfBelief, "USABLE");

    // "restart": brand-new instance, no availability cache carried over
    // (this module never persists availability at all, by construction).
    const sm2 = await createSelfModel({ capabilityRegistry: registry });
    assert.equal(sm2.assess("cap.x").epistemicClass, "UNKNOWN");
    assert.equal(sm2.assess("cap.x").selfBelief, "UNKNOWN");
});

test("SM-A9: a disconnected/never-reporting health port yields UNKNOWN, not HEALTHY", async () => {
    const sm = await createSelfModel({ capabilityRegistry: fakeRegistry({}) });
    const snap = sm.snapshot();
    assert.equal(snap.healthState, "UNKNOWN");
});

test("SM-A10: unknowns are surfaced, not suppressed, when a source is missing", async () => {
    const sm = await createSelfModel({ capabilityRegistry: fakeRegistry({}) });
    sm.assess("never-registered");
    assert.ok(sm.unknowns().some(u => u.subject === "never-registered"));
});

test("SM-A11: confidence basis is NO_EVIDENCE when there is no outcome history, never inflated", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 1 });
    const a = sm.assess("cap.x");
    assert.equal(a.confidence.basis, "NO_EVIDENCE");
    assert.equal(a.confidence.value, 0);
});

test("SM-A12: no boolean 'allowed'/authorization oracle field exists anywhere in the snapshot", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 1 });
    const snap = sm.snapshot();
    const serialized = JSON.stringify(snap);
    for (const forbidden of ["\"allowed\"", "\"authorized\"", "\"permission\"", "\"grant\""]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
});
