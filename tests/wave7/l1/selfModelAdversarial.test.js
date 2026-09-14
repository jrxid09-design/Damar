const test = require("node:test");
const assert = require("node:assert");

const { createSelfModel } = require("../../../src/cognition/selfmodel");
const { BOUNDS } = require("../../../src/cognition/selfmodel/bounds");

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

test("SM-repair-2: assess()'s successWindow.history is frozen, mutating it cannot forge canonical confidence (independent audit W7R8-P1-2)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const clock = manualClock(1000);
    const sm = await createSelfModel({ capabilityRegistry: registry, clock });
    sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "FAILED", at: "t1", evidenceRef: "e1" });

    const a = sm.assess("cap.x");
    assert.equal(Object.isFrozen(a.successWindow.history), true);
    assert.equal(Object.isFrozen(a.successWindow.history[0]), true);
    assert.throws(() => { "use strict"; a.successWindow.history.push({ at: "t2", outcome: "SUCCESS", evidenceRef: "e2" }); });
    assert.throws(() => { "use strict"; a.successWindow.history[0].outcome = "SUCCESS"; });

    sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "FAILED", at: "t2", evidenceRef: "e2" });
    const a2 = sm.assess("cap.x");
    assert.equal(a2.successWindow.successes, 0, "forged SUCCESS entry from a mutated read must not leak into canonical state");
    assert.equal(a2.successWindow.attempts, 2);
});

test("SM-repair-6: a store whose getKv() throws (corrupt/unreadable KV) starts with an empty successWindow instead of aborting createSelfModel entirely (independent audit AUD15-P2-2)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const brokenStore = { getKv: async () => { throw new Error("STORE_DOWN"); }, putKv: async () => {} };
    const sm = await createSelfModel({ capabilityRegistry: registry, store: brokenStore });
    assert.equal(sm.assess("cap.x").selfBelief, "UNKNOWN");
});

test("SM-repair-7: a BigInt in ingestHealth's 'at' is rejected, not accepted and left to crash snapshot()/persist() (independent audit AUD17-P2-2)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    assert.throws(() => sm.ingestHealth({ subsystem: "x", state: "DEGRADED", at: 10n }));
    assert.doesNotThrow(() => sm.snapshot());
});

test("SM-repair-3: a BigInt in ingestOutcome's 'at' is rejected, not accepted and left to crash persist() (independent audit AUD10-P2-1)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    assert.throws(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "FAILED", at: 10n, evidenceRef: "e1" }));
});

test("SM-repair-4: a nested BigInt (or any object) in ingestOutcome's 'at' is rejected, not accepted and left to crash persist() or corrupt canonical history via reference (independent audit AUD11-P2-4)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    assert.throws(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "FAILED", at: { n: 10n }, evidenceRef: "e1" }));
    assert.throws(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "FAILED", at: { nested: { deep: "orig" } }, evidenceRef: "e2" }));
});

test("SM-repair-5: a replayed evidenceRef is a no-op, not a fabricated extra attempt/success (independent audit AUD11-P2-6)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "FAILED", at: "t1", evidenceRef: "F1" });
    for (let i = 0; i < 5; i++) {
        sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: "t2", evidenceRef: "S1" });
    }
    const a = sm.assess("cap.x");
    assert.equal(a.successWindow.attempts, 2, "a replayed evidenceRef must not be counted as a new attempt");
    assert.equal(a.successWindow.successes, 1, "a replayed evidenceRef must not inflate successes");
});

test("SM-repair-8: replaying an evidenceRef already evicted from the 32-entry history window is still a no-op, not a fabricated success (independent audit AUD20-P2-1)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: "t0", evidenceRef: "E0" });
    for (let i = 0; i < BOUNDS.MAX_SUCCESS_WINDOW; i++) {
        sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "FAILED", at: `t${i + 1}`, evidenceRef: `F${i}` });
    }
    const before = sm.assess("cap.x");
    assert.equal(before.successWindow.successes, 0, "E0 must have scrolled out of the 32-entry history by now");
    // replay E0 — a naive dedup scoped only to `history` would see it as new
    sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: "t0", evidenceRef: "E0" });
    const after = sm.assess("cap.x");
    assert.equal(after.successWindow.successes, 0, "replaying an evicted evidenceRef must not fabricate a success (DEGRADED must not become USABLE)");
    assert.equal(after.successWindow.attempts, BOUNDS.MAX_SUCCESS_WINDOW, "replay must not grow the window past its cap either");
});

test("SM-repair-9: a legacy successWindow (history populated, no appliedEvidenceRefs yet) still dedups a replay against its history (independent audit AUD21-P2-2)", async () => {
    function jsonStore() {
        const kv = new Map();
        return {
            async getKv(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
            async putKv(k, v) { kv.set(k, JSON.stringify(v)); }
        };
    }
    const store = jsonStore();
    // simulate a window written by a pre-round-20 candidate: has `history`,
    // no `appliedEvidenceRefs` field at all.
    await store.putKv("selfmodel.successWindows", {
        "cap.x": { attempts: 1, successes: 1, windowStartedAt: 0, history: [{ at: "t0", outcome: "SUCCESS", evidenceRef: "E0" }] }
    });
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry, store });
    sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: "t0", evidenceRef: "E0" }); // exact replay
    const a = sm.assess("cap.x");
    assert.equal(a.successWindow.successes, 1, "replaying an evidenceRef already in legacy `history` must stay a no-op even before appliedEvidenceRefs is seeded");
    assert.equal(a.successWindow.attempts, 1);
});

test("SM-repair-10: a legacy successWindow still dedups a replay even after enough churn to scroll the ref out of `history` (independent audit AUD22-F-1)", async () => {
    function jsonStore() {
        const kv = new Map();
        return {
            async getKv(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
            async putKv(k, v) { kv.set(k, JSON.stringify(v)); }
        };
    }
    const store = jsonStore();
    await store.putKv("selfmodel.successWindows", {
        "cap.x": { attempts: 1, successes: 1, windowStartedAt: 0, history: [{ at: "t0", outcome: "SUCCESS", evidenceRef: "E0" }] }
    });
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry, store });
    for (let i = 0; i < BOUNDS.MAX_SUCCESS_WINDOW + 2; i++) {
        sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "FAILED", at: `t${i + 1}`, evidenceRef: `N${i}` });
    }
    sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: "t0", evidenceRef: "E0" }); // replay, long after E0 scrolled out of `history`
    const a = sm.assess("cap.x");
    assert.equal(a.successWindow.successes, 0, "replaying a legacy evidenceRef must stay a no-op even after it has scrolled out of both history and appliedEvidenceRefs' unseeded state");
});

test("SM-repair-11: hostile toString on tier/outcome/health-state never executes, and Symbol variants are rejected as domain errors, not raw TypeErrors (independent audit AUD25-P2-1)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    let calledTier = 0;
    const evilTier = { toString() { calledTier++; return "T1"; } };
    assertThrowsReason(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: evilTier, outcome: "SUCCESS", at: "t0", evidenceRef: "E0" }), "INVALID_OUTCOME");
    assert.equal(calledTier, 0, "tier's toString must never be invoked before the enum check");
    assertThrowsReason(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: Symbol("t"), outcome: "SUCCESS", at: "t0", evidenceRef: "E0" }), "INVALID_OUTCOME");

    let calledOutcome = 0;
    const evilOutcome = { toString() { calledOutcome++; return "SUCCESS"; } };
    assertThrowsReason(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: evilOutcome, at: "t0", evidenceRef: "E0" }), "INVALID_OUTCOME");
    assert.equal(calledOutcome, 0, "outcome's toString must never be invoked before the enum check");

    let calledState = 0;
    const evilState = { toString() { calledState++; return "HEALTHY"; } };
    assertThrowsReason(() => sm.ingestHealth({ subsystem: "s1", state: evilState }), "INVALID_OBSERVATION");
    assert.equal(calledState, 0, "health state's toString must never be invoked before the enum check");
});

test("SM-repair-12: a Symbol generation is rejected as INVALID_OBSERVATION, not a raw TypeError (independent audit AUD27-P2-5)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    assertThrowsReason(() => sm.ingestAvailability({
        capabilityId: "cap.x", availability: "AVAILABLE", generation: Symbol("g"), observedAtMs: 0
    }), "INVALID_OBSERVATION");
});

test("SM-repair-13: a Symbol/hostile-object observedAtMs never throws and never invokes caller valueOf, falling back safely like other invalid values (independent audit AUD28-P2-1)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    assert.doesNotThrow(() => sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: Symbol("t") }));
    let called = 0;
    const evil = { valueOf() { called++; return 1; } };
    sm.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 2, observedAtMs: evil });
    assert.equal(called, 0, "observedAtMs's valueOf must never be invoked");
});

test("SM-repair-15: snapshot()'s runtimeLocation/resourcePressure/activeProviders are deep-frozen, not just shallow (independent audit AUD34-ADV-5a)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const presencePort = { state: () => ({ nested: { mode: "ONLINE" } }) };
    const governorPort = { pressure: () => ({ cpu: { pct: 10 } }) };
    const providerPort = { activeProviders: () => [{ id: "p1", nested: { ok: true } }] };
    const sm = await createSelfModel({ capabilityRegistry: registry, presencePort, governorPort, providerPort });
    const snap = sm.snapshot();
    assert.throws(() => { "use strict"; snap.runtimeLocation.presence.nested.mode = "PWNED"; });
    assert.throws(() => { "use strict"; snap.resourcePressure.cpu.pct = 999; });
    assert.throws(() => { "use strict"; snap.activeProviders[0].nested.ok = false; });
});

test("SM-repair-20: createSelfModel never raw-throws on a revoked/throwing clock or bounds -- normalized once at construction (independent audit AUD53-P2-2)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const rev = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    await assert.doesNotReject(() => createSelfModel({ capabilityRegistry: registry, clock: rev() }));
    await assert.doesNotReject(() => createSelfModel({ capabilityRegistry: registry, bounds: rev() }));
    const sm = await createSelfModel({ capabilityRegistry: registry, clock: { nowMs() { throw new Error("x"); } } });
    assert.doesNotThrow(() => sm.assess("cap.x"));
});

test("SM-repair-19: snapshot() never raw-throws on revoked/throwing soft ports (mesh/provider/governor/presence) or a BigInt inside a port result -- safeCall only wraps the port CALL, not the consumption of what it returns (independent audit W7R51-ADV-1)", async () => {
    const reg = { get: () => ({ id: "x" }), has: () => true, getAvailability: () => null };
    const rev = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    const cases = [
        { meshPort: { identity: () => rev(), knownNodes: () => [], reachableNodes: () => [] } },
        { meshPort: { identity: () => null, knownNodes: () => rev(), reachableNodes: () => [] } },
        { providerPort: { activeProviders: () => rev() } },
        { governorPort: { pressure: () => rev() } },
        { presencePort: { state: () => rev() } },
        { providerPort: { activeProviders: () => [{ id: "p", big: 1n }] } }
    ];
    for (const c of cases) {
        const sm = await createSelfModel({ capabilityRegistry: reg, ...c });
        assert.doesNotThrow(() => sm.snapshot());
    }
});

test("SM-repair-21: snapshot() never raw-throws when providerPort.activeProviders() returns an array Proxy whose Symbol.iterator getter throws -- Array.isArray proves identity, not trap-safety (independent audit round 55, W7R55-P2-1)", async () => {
    const reg = { get: () => ({ id: "x" }), has: () => true, getAvailability: () => null };
    const arrProxy = new Proxy([1, 2, 3], {
        get(t, p, rec) {
            if (p === Symbol.iterator) throw new Error("hostile iterator");
            return Reflect.get(t, p, rec);
        }
    });
    const sm = await createSelfModel({ capabilityRegistry: reg, providerPort: { activeProviders: () => arrProxy } });
    assert.doesNotThrow(() => sm.snapshot());
});

test("SM-repair-22: snapshot()'s activeProviders copy is capped at MAX_ACTIVE_PROVIDERS even when a hostile Proxy fabricates a huge .length -- round 55's per-index copy removed the raw-throw but had no upper bound (independent audit round 56, Codex, W7R56-P2-1)", async () => {
    const { BOUNDS } = require("../../../src/cognition/selfmodel/bounds");
    const reg = { get: () => ({ id: "x" }), has: () => true, getAvailability: () => null };
    let reads = 0;
    const arrProxy = new Proxy([], {
        get(t, p, rec) {
            if (p === Symbol.iterator) throw new Error("hostile iterator");
            if (p === "length") return 100000;
            if (typeof p === "string" && /^\d+$/.test(p)) { reads++; return undefined; }
            return Reflect.get(t, p, rec);
        }
    });
    const sm = await createSelfModel({ capabilityRegistry: reg, providerPort: { activeProviders: () => arrProxy } });
    const snap = sm.snapshot();
    assert.ok(snap.activeProviders.length <= BOUNDS.MAX_ACTIVE_PROVIDERS, "activeProviders harus dibatasi MAX_ACTIVE_PROVIDERS");
    assert.ok(reads <= BOUNDS.MAX_ACTIVE_PROVIDERS, "jumlah baca index tidak boleh melebihi MAX_ACTIVE_PROVIDERS");
});

test("SM-repair-18: assess() never raw-throws when the capability registry returns a revoked-Proxy descriptor -- descriptorRef falls back to capabilityId, same as a missing descriptor.id (independent audit W7R50-ADV-1)", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const registry = {
        get: (id) => (id === "cap.x" ? proxy : null),
        has: (id) => id === "cap.x",
        getAvailability: () => { throw new Error("unused"); }
    };
    const sm = await createSelfModel({ capabilityRegistry: registry });
    let a;
    assert.doesNotThrow(() => { a = sm.assess("cap.x"); }, "a revoked-Proxy descriptor must not raw-throw out of assess()");
    assert.equal(a.capabilityId, "cap.x");
});

test("SM-repair-17: ingestOutcome/ingestHealth fail closed (not raw-throw) on a revoked-Proxy TOP-LEVEL argument, the exact sibling ingestAvailability's own comment (round 43) incorrectly claimed was already safe (independent audit W7R44-P2-2)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    const r1 = Proxy.revocable({}, {});
    r1.revoke();
    assert.throws(() => sm.ingestOutcome(r1.proxy), (err) => {
        assert.equal(err.reason, "INVALID_OUTCOME", `expected INVALID_OUTCOME, got '${err.reason}': ${err.message}`);
        return true;
    });
    const r2 = Proxy.revocable({}, {});
    r2.revoke();
    assert.throws(() => sm.ingestHealth(r2.proxy), (err) => {
        assert.equal(err.reason, "INVALID_OBSERVATION", `expected INVALID_OBSERVATION, got '${err.reason}': ${err.message}`);
        return true;
    });
});

test("SM-repair-16: ingestAvailability fails closed on a revoked-Proxy observation instead of raw-throwing (independent audit W7R43-P2-2)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    const r = Proxy.revocable({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: 1 }, {});
    r.revoke();
    assert.throws(() => sm.ingestAvailability(r.proxy), (err) => {
        assert.equal(err.reason, "INVALID_OBSERVATION", `expected INVALID_OBSERVATION, got '${err.reason}': ${err.message}`);
        return true;
    });
});

test("SM-repair-14: a non-finite numeric 'at' in ingestOutcome/ingestHealth is rejected, not silently corrupted to null by a JSON-round-tripping store (independent audit AUD32-P2-4)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const sm = await createSelfModel({ capabilityRegistry: registry });
    assertThrowsReason(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: Infinity, evidenceRef: "ev-1" }), "INVALID_OUTCOME");
    assertThrowsReason(() => sm.ingestOutcome({ capabilityId: "cap.x", tier: "T1", outcome: "SUCCESS", at: NaN, evidenceRef: "ev-2" }), "INVALID_OUTCOME");
    assertThrowsReason(() => sm.ingestHealth({ subsystem: "sub1", state: "DOWN", at: Infinity }), "INVALID_OBSERVATION");
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
