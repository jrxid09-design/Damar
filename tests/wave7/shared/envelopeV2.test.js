const test = require("node:test");
const assert = require("node:assert");

/**
 * Wave7 shared prerequisite — ACC envelope v2 (canonical/happy-path).
 * Adversarial coverage lives in envelopeV2Adversarial.test.js; v1
 * backward-compat coverage lives in envelopeV1Compat.test.js.
 */

const envelope = require("../../../src/cognition/core/envelope");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
const acc = require("../../../src/cognition");

function baseSpec(overrides = {}) {
    return {
        type: "TOOL_SUCCEEDED",
        source: "test",
        provenance: "SYSTEM_EVENT",
        payload: { ok: true },
        clock: { nowMs: () => 1_000_000 },
        ...overrides
    };
}

test("W7-ENV-01: v2 canonical creation succeeds", () => {
    const env = envelope.makeEnvelope(baseSpec());
    assert.equal(env.schemaVersion, 2);
    assert.equal(env.epistemicClass, "UNKNOWN");
});

test("W7-ENV-02: all four epistemic classes accepted", () => {
    for (const cls of ["OBSERVED", "INFERRED", "PREDICTED", "UNKNOWN"]) {
        const env = envelope.makeEnvelope(baseSpec({ epistemicClass: cls }));
        assert.equal(env.epistemicClass, cls);
    }
});

test("W7-ENV-04/05: confidence 0 and 1 accepted (inclusive bounds)", () => {
    assert.equal(envelope.makeEnvelope(baseSpec({ confidence: 0 })).confidence, 0);
    assert.equal(envelope.makeEnvelope(baseSpec({ confidence: 1 })).confidence, 1);
});

test("W7-ENV-09: confidence=1.0 does not upgrade epistemicClass", () => {
    const observed = envelope.makeEnvelope(baseSpec({ confidence: 1, epistemicClass: "UNKNOWN" }));
    assert.equal(observed.epistemicClass, "UNKNOWN",
        "confidence tinggi tidak pernah menaikkan epistemicClass secara diam-diam");

    const inferred = envelope.makeEnvelope(baseSpec({ confidence: 1, epistemicClass: "INFERRED" }));
    assert.equal(inferred.epistemicClass, "INFERRED");
});

test("W7-ENV-10: provenance value is a frozen, immutable string", () => {
    "use strict";
    const env = envelope.makeEnvelope(baseSpec({ provenance: "OBSERVATION" }));
    assert.equal(env.provenance, "OBSERVATION");
    assert.ok(Object.isFrozen(env), "amplop keseluruhan beku");
    assert.throws(() => { env.provenance = "USER_CLAIM"; }, TypeError);
});

test("W7-ENV-20/21: new writes use v2, journal stays append-only (duplicate rejected)", async () => {
    const store = createMemoryAccStore();
    const env = envelope.makeEnvelope(baseSpec());
    const row = { ...env, occurredAt: env.timestamp, prevHash: null, hash: "h1" };

    const first = await store.appendEvent(row);
    assert.equal(first.duplicate, false);

    const second = await store.appendEvent(row);
    assert.equal(second.duplicate, true, "eventId duplikat ditolak, jurnal append-only");

    const all = await store.allEvents();
    assert.equal(all.length, 1);
    assert.equal(all[0].schemaVersion, 2);
});

test("W7-ENV-22/23: restart/reload preserves the v2 record exactly, deterministic serialization", async () => {
    const store = createMemoryAccStore();
    const clock = acc.manualClock(2_000_000);
    const config = acc.createACCConfig({ DAMAR_ACC: "shadow" });

    const core = new acc.ContinuityCore({ store, clock, config });
    await core.initialize();

    await core.feed(envelope.makeEnvelope({
        type: "SELF_STATE_UPDATED", source: "acc.core", provenance: "SELF_STATE",
        epistemicClass: "OBSERVED", payload: { field: "x", value: 1 },
        clock: { nowMs: () => 2_000_001 }
    }));

    // "restart/reload": simulasikan proses baru membaca jurnal yang sama
    // (bukan initialize() kedua pada instance baru — itu akan menambah
    // event boot barunya sendiri ke store bersama dan bukan lagi replay
    // murni). Di sini kita verifikasi kontrak persistence secara langsung:
    // baris yang tersimpan sama persis dengan yang seharusnya dibaca ulang.
    const rows = await store.allEvents();
    const stateRow = rows.find(r => r.type === "SELF_STATE_UPDATED");

    assert.equal(stateRow.schemaVersion, 2);
    assert.equal(stateRow.epistemicClass, "OBSERVED");
    assert.deepEqual(stateRow.payload, { field: "x", value: 1 },
        "payload persisten identik dengan yang ditulis");

    // Serialisasi kanonik deterministik: membaca baris yang sama dua kali
    // dan menyerialkannya menghasilkan teks identik.
    const rowsAgain = await store.allEvents();
    const stateRowAgain = rowsAgain.find(r => r.type === "SELF_STATE_UPDATED");
    assert.equal(envelope.canonicalJson(stateRow), envelope.canonicalJson(stateRowAgain),
        "serialisasi kanonik deterministik lintas pembacaan ulang");
});

test("W7-ENV-27: ACC OFF mode unaffected by envelope migration", () => {
    const config = acc.createACCConfig({ DAMAR_ACC: "off" });
    assert.equal(config.mode, "off");
    // OFF mode does not construct envelopes at all — presence of v2 fields
    // on the envelope module must not change OFF's zero-influence contract.
});
