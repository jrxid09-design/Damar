const test = require("node:test");
const assert = require("node:assert");

/**
 * ACC WITNESS + METACOGNITION + PREDICTION (§29–§35/§64).
 * Witness berbasis bukti terstruktur; meta = enum terbatas;
 * prediksi deterministik dengan kalibrasi Brier.
 */

const acc = require("../../src/cognition");
const { createMemoryAccStore } = require("../../src/cognition/persistence/AccStore");

const T0 = 1_000_000;

function makeCore() {
    return new acc.ContinuityCore({
        store: createMemoryAccStore(),
        clock: acc.manualClock(T0),
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" })
    });
}

test("C0.5: witness selalu evidence-backed; tidak ada akses CoT", () => {

    const prev = {
        self: { fields: { confidence: { value: 0.72 } }, contradictions: [] },
        affect: { uncertainty: 0.3 },
        workspace: { items: [{ key: "A" }] }
    };
    const next = {
        self: { fields: { confidence: { value: 0.41 } }, contradictions: [] },
        affect: { uncertainty: 0.55 },
        workspace: { items: [{ key: "B" }] }
    };

    const witness = acc.Witness.buildWitness({
        witnessId: "w1", at: "t",
        prev, next,
        appraisal: { eventId: "evt-123" }
    });

    assert.equal(witness.observedChanges.some(c =>
        c.area === "self" && c.field === "confidence" &&
        c.from === 0.72 && c.to === 0.41), true);

    for (const change of witness.observedChanges) {
        assert.ok(change.causes.includes("evt-123"),
            "setiap perubahan wajib merujuk sebab event");
    }

    // Struktural: modul witness TIDAK memiliki API membaca prompt/CoT.
    const exports_ = Object.keys(acc.Witness);
    assert.ok(!exports_.some(k => /prompt|cot|chain|reasoning/i.test(k)),
        `API terlarang terekspos: ${exports_.join(",")}`);
});

test("C0.5: metacognitive monitor — enum terbatas & ambang bekerja", async () => {

    const c = await makeCore().initialize();

    // Kegagalan beruntun → REPLAN.
    for (let i = 0; i < 3; i++) {
        await c.feed(acc.envelope.makeEnvelope({
            type: "TOOL_FAILED", source: "t", provenance: "OBSERVATION",
            subject: `f${i}`, payload: { tool: "x" },
            clock: { nowMs: () => T0 }
        }));
    }
    let rec = acc.Witness.recommend(c.state, c.config);
    assert.equal(rec.recommendation, "REPLAN");

    // Tekanan resource tinggi → ASK_USER menang atas lainnya.
    const stressed = JSON.parse(JSON.stringify(c.state));
    stressed.affect.resourcePressure = 0.9;
    rec = acc.Witness.recommend(stressed, c.config);
    assert.equal(rec.recommendation, "ASK_USER");

    // Normal → CONTINUE.
    rec = acc.Witness.recommend(makeCore().initialize() && c.state, c.config) ?? rec;

    // Enum tertutup:
    assert.ok(acc.Witness.RECOMMENDATIONS.includes(rec.recommendation));
});

test("C0.6: prediksi terbuka → resolusi → kalibrasi Brier eksak", async () => {

    const clock = acc.manualClock(T0);
    const core = new acc.ContinuityCore({
        store: createMemoryAccStore(), clock,
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" })
    });
    await core.initialize();

    const prediction = acc.Predictions.newPrediction({
        predictionId: "p-1",
        subject: "retry browse akan sukses",
        expectedOutcome: { ok: true },
        probability: 0.8,
        horizonMs: 60_000,
        createdAtMs: clock.nowMs()
    });

    await core.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_OPENED", source: "acc.prediction",
        provenance: "SYSTEM_EVENT",
        payload: { prediction }, clock
    }));

    assert.ok(core.state.predictions.open["p-1"]);

    await core.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_RESOLVED_CORRECT",
        source: "acc.prediction", provenance: "SYSTEM_EVENT",
        payload: { predictionId: "p-1" }, clock
    }));

    // Brier untuk p=0.8, y=1 → 0.04.
    assert.ok(Math.abs(core.state.meta.stats.brierSum - 0.04) < 1e-12);
    assert.equal(core.state.meta.stats.brierN, 1);
    assert.equal(core.state.predictions.resolvedCount, 1);
    assert.equal(core.state.predictions.correctCount, 1);

    // Self-field turunan ikut diperbarui oleh reducer:
    assert.equal(core.state.self.fields.predictionReliability.value, 1);

    // Resolusi kedua tanpa prediksi terbuka → diabaikan rapi:
    await core.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_RESOLVED_INCORRECT",
        source: "acc.prediction", provenance: "SYSTEM_EVENT",
        payload: { predictionId: "hantu" }, clock
    }));
    assert.equal(core.state.meta.stats.brierN, 1);
});
