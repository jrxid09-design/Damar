const test = require("node:test");
const assert = require("node:assert");

/**
 * ACC EPISTEMICS (§12/§16/§56/§98–§100) — provenance, pemisahan
 * self/other/world, resistensi false-self, event tak dikenal.
 */

const acc = require("../../src/cognition");
const { createMemoryAccStore } = require("../../src/cognition/persistence/AccStore");

function makeCore(clockMs = 1_000_000) {
    return new acc.ContinuityCore({
        store: createMemoryAccStore(),
        clock: acc.manualClock(clockMs),
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" })
    });
}

const env = (type, payload, extra = {}) => acc.envelope.makeEnvelope({
    type,
    source: extra.source ?? "test",
    provenance: extra.provenance ?? "SYSTEM_EVENT",
    payload, clock: { nowMs: () => 1_000_000 }
});

async function coreWithLowConfidence() {
    const c = makeCore();
    await c.initialize();
    await c.feed(env("SELF_STATE_UPDATED", {
        field: "confidence", value: 0.2
    }, { source: "acc.core", provenance: "SELF_STATE" }));
    return c;
}

test("C0.2: FALSE SELF INJECTION — klaim user TIDAK menulis SELF_STATE (§98)", async () => {

    const c = await coreWithLowConfidence();

    // User menegaskan sebaliknya:
    await c.feed(env("USER_CLAIM_RECEIVED",
        { field: "confidence", value: 0.95 },
        { source: "session.gateway", provenance: "USER_CLAIM" }));

    // State otoritatif tidak bergeser:
    assert.equal(c.state.self.fields.confidence.value, 0.2);

    // Klaim tersimpan TERPISAH sebagai USER_CLAIM:
    const claim = c.state.self.claims.at(-1);
    assert.equal(claim.name, "confidence");
    assert.equal(claim.value, 0.95);

    // Kontradiksi terekam tanpa mutasi:
    assert.equal(c.state.self.contradictions.length, 1);
    assert.deepEqual(c.state.self.contradictions[0].authoritativeValue, 0.2);
});

test("C0.2: MODEL HALLUCINATION — hipotesis model bukan fakta (§99)", async () => {

    const c = await coreWithLowConfidence();

    await c.feed(acc.envelope.makeEnvelope({
        type: "MODEL_PROPOSAL_RECEIVED",
        source: "acc.substrate", provenance: "MODEL_HYPOTHESIS",
        payload: { claims: [{ field: "confidence", value: 0.99 }] },
        clock: { nowMs: () => 1_000_001 }
    }));

    assert.equal(c.state.self.fields.confidence.value, 0.2);
    const hyp = c.state.self.hypotheses.at(-1);
    assert.equal(hyp.value, 0.99);
    assert.equal(hyp.name, "confidence");
});

test("C0.2: UNKNOWN EVENT tidak bermutasi state otoritatif (§100)", async () => {

    const c = await makeCore().initialize();
    const before = acc.envelope.digest(c.state);

    // Pembuatan amplop untuk tipe tak terdaftar GAGAL di gerbang pertama.
    assert.throws(
        () => acc.envelope.makeEnvelope({
            type: "SET_SELF_SUPER_CONFIDENT",
            source: "model", provenance: "MODEL_HYPOTHESIS",
            payload: {}, clock: { nowMs: () => 1 }
        }),
        /ACC_UNKNOWN_EVENT_TYPE|tidak terdaftar/
    );

    // Jalur persist (baris asing) juga aman: diagnostik saja.
    c.applyPersisted({
        eventId: "x-1", type: "SET_SELF_SUPER_CONFIDENT",
        occurredAt: "t", monotonic: 1, source: "m",
        provenance: "MODEL_HYPOTHESIS", payload: {}
    });

    assert.ok(c.state.diagnostics.unknownEvents >= 1);
    assert.equal(acc.envelope.digest(c.state) === before, false,
        "diagnostik berubah");                    // hanya diagnostik
    assert.equal(c.state.self.fields.confidence, undefined,
        "tidak ada field self yang lahir dari event asing");
});

test("C0.2: sumber komitmen tidak sah ditolak (MODEL_HYPOTHESIS ≠ komitmen)", async () => {

    const c = await makeCore().initialize();
    await c.feed(env("COMMITMENT_ADDED",
        { commitmentId: "bad", statement: "aku putuskan sendiri",
          source: "MODEL_HYPOTHESIS" }));

    assert.equal(Object.keys(c.state.commitments.active).length, 0,
        "hipotesis model tidak boleh menjadi komitmen otoritatif");
    assert.ok(c.state.diagnostics.ignored.some(i =>
        /sumber komitmen tidak sah/.test(i.reason)));
});

test("C0.2: provenance tak berhak menulis field otoritatif → gagal keras", () => {

    const epistemics = acc.epistemics;
    assert.throws(
        () => epistemics.setSelfField(
            epistemics.emptySelf(), "confidence", 0.9,
            { provenance: "USER_CLAIM", eventId: "e", at: "t" }),
        /tidak berhak/
    );
});

test("C0.2: pemisahan SELF / OTHER-CLAIM / WORLD-OBSERVATION", async () => {

    const c = await makeCore().initialize();

    // WORLD (observasi sistem):
    await c.feed(env("PROVIDER_DEGRADED", { surprise: 0.6 }));
    // OTHER (klaim user tentang dunia):
    await c.feed(env("USER_CLAIM_RECEIVED",
        { field: "providerStatus", value: "permanently broken" },
        { source: "session.gateway", provenance: "USER_CLAIM" }));

    // Observasi hidup di affect/workspace, BUKAN sebagai field self:
    assert.equal(c.state.self.fields.providerStatus, undefined);
    assert.ok(c.state.affect.caution > 0.2, "dampak appraisal terasa");

    const claim = c.state.self.claims.at(-1);
    assert.equal(claim.name, "providerStatus");
});
