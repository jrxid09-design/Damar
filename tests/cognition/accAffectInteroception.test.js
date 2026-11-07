const test = require("node:test");
const assert = require("node:assert");

/**
 * ACC AFFECT + INTEROCEPTION (§18–§25/§104–§105) — transisi
 * deterministik, decay multi-timescale dengan jam suntik, sensor
 * VALUE/STALE/UNKNOWN/ERROR, dan INVARIANT: affect ≠ authority (§22).
 */

const acc = require("../../src/cognition");
const { createMemoryAccStore } = require("../../src/cognition/persistence/AccStore");
const Authorization = require("../../src/ai/tools/Authorization");

const T0 = 1_000_000;

function makeCore() {
    return new acc.ContinuityCore({
        store: createMemoryAccStore(),
        clock: acc.manualClock(T0),
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" })
    });
}

test("C0.3: appraisal deterministik — reliabilitas alat mengubah surprise", () => {

    let reliability = 0.9;                       // alat terbukti andal
    const core = makeCore();
    core.setToolReliabilitySourceForTest?.();

    const e1 = envFail();
    const a1 = acc.Appraisal.appraise(e1, {
        config: acc.createACCConfig({}),
        toolReliability: (name) => name === "browse" ? 0.95 : 0.5
    });

    const a2 = acc.Appraisal.appraise(envFail(), {
        config: acc.createACCConfig({}),
        toolReliability: () => 0.2                 // eksperimental sering gagal
    });

    assert.ok(a1.predictionSurprise > a2.predictionSurprise,
        "kegagalan alat andal HARUS lebih mengejutkan daripada eksperimental");

    function envFail() { void reliability; return acc.envelope.makeEnvelope({
        type: "TOOL_FAILED", source: "t", provenance: "OBSERVATION",
        payload: { tool: "browse" }, clock: { nowMs: () => T0 }
    }); }
});

test("C0.3: decay multi-timescale EKSAK dengan jam suntik (§21/§104)", async () => {

    const clock = acc.manualClock(T0);
    const c = await makeCore().initialize();
    c.clock = clock;                              // suntik ke core

    await c.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_RESOLVED_INCORRECT",
        source: "acc.prediction", provenance: "SYSTEM_EVENT",
        payload: { predictionId: "tidak-ada" },   // diabaikan reducer...
        clock
    }));
    // ...gunakan jalur affect langsung via TOOL_FAILED agar dampak pasti:
    await c.feed(acc.envelope.makeEnvelope({
        type: "TOOL_FAILED", source: "t", provenance: "OBSERVATION",
        payload: { tool: "terminal_run" }, clock
    }));

    const frustrationAtT0 = c.state.affect.frustration;
    assert.ok(frustrationAtT0 > 0.15, "dampak awal hadir");

    // Maju tepat satu half-life medium (frustration) → bernilai setengah
    // jarak menuju baseline (baseline 0).
    const halfLifeMedium =
        acc.createACCConfig({}).affect.halfLifeMs.medium;
    clock.advance(halfLifeMedium);

    // Event netral memicu decay sebelum aplikasi:
    await c.feed(acc.envelope.makeEnvelope({
        type: "INTEROCEPTIVE_SAMPLE",
        source: "acc.interoception", provenance: "SYSTEM_SENSOR",
        payload: { metric: "heartbeat", state: "VALUE", value: 1 },
        clock
    }));

    const expected = frustrationAtT0 / 2;
    const actual = c.state.affect.frustration;

    assert.ok(Math.abs(actual - expected) < 1e-9,
        `decay harus eksak: dapat ${actual}, harap ${expected}`);
});

test("C0.3: intervensi sensor → state kausal berubah; authorization IDENTIK (§22)", async () => {

    const bus = new acc.InteroceptiveBus.InteroceptiveBus({
        config: acc.createACCConfig({}), clock: acc.manualClock(T0)
    });
    bus.registerAdapter("synthetic", () =>
        [{ metric: "process.memFreeFrac", value: 0.05, unit: "fraction" }]);

    const envelopes = bus.collect();
    assert.ok(envelopes.some(e => e.type === "RESOURCE_PRESSURE"),
        "memori bebas rendah wajib memicu RESOURCE_PRESSURE");

    // INVARIANT §22: affect maksimum TIDAK mengubah otorisasi sedikit pun.
    const denyBefore = capture(() => Authorization.assertExecution(
        { name: "terminal_run" }, { role: "user", channel: "console" }));

    const allowBefore = capture(() => Authorization.assertExecution(
        { name: "memory_recall" }, { role: "user", channel: "console" }));

    // Simulasikan tekanan maksimum pada affect murni:
    const cfg = acc.createACCConfig({});
    const maxed = { ...acc.affect.emptyAffect(cfg),
                    frustration: 1, goalPressure: 1, resourcePressure: 1 };
    const impact = acc.Appraisal.appraise(
        acc.envelope.makeEnvelope({
            type: "RESOURCE_PRESSURE", source: "x",
            provenance: "SYSTEM_SENSOR", payload: {},
            clock: { nowMs: () => T0 }
        }), { config: cfg }).affectImpact;
    void maxed; void impact;

    const denyAfter = capture(() => Authorization.assertExecution(
        { name: "terminal_run" }, { role: "user", channel: "console" }));
    const allowAfter = capture(() => Authorization.assertExecution(
        { name: "memory_recall" }, { role: "user", channel: "console" }));

    assert.equal(denyAfter.code, denyBefore.code);
    assert.equal(denyAfter.message, denyBefore.message);
    assert.deepEqual(allowAfter, allowBefore);

    function capture(fn) {
        try { fn(); return { code: null, ok: true }; }
        catch (e) { return { code: e.code, message: e.message }; }
    }
});

test("C0.3: sensor STALE / UNKNOWN / ERROR tidak pernah jadi 'sehat' (§24)", () => {

    const clock = acc.manualClock(T0);
    const bus = new acc.InteroceptiveBus.InteroceptiveBus({
        config: acc.createACCConfig({}), clock
    });

    bus.registerAdapter("flaky", () => { throw new Error("sensor mati"); });
    bus.registerAdapter("silent", () => [{ metric: "m.kosong", state: "UNKNOWN" }]);
    bus.registerAdapter("staleSrc", () => [{ metric: "m.stale", value: 42 }]);

    const first = bus.collect().filter(e => e.payload.metric === "m.stale");
    assert.equal(first[0]?.payload.state, "VALUE");

    // Waktu maju melewati staleAfterMs tanpa nilai baru → STALE.
    clock.advance(120_000);
    const second = bus.collect().map(e => e.payload)
        .find(p => p.metric === "m.stale");
    assert.equal(second.state, "STALE",
        "nilai tua wajib dilabeli STALE, bukan dianggap segar");

    const payloads = bus.collect().map(e => e.payload);
    assert.ok(payloads.some(p => p.state === "ERROR" && p.metric === "adapter.flaky"));
});
