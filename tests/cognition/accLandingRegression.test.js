const test = require("node:test");
const assert = require("node:assert");

/**
 * ACC C0 LANDING REGRESSION — B1 & B2 (red-team final).
 *
 * B1: MEMORY_ACTIVATED reducer membaca ctx.config tanpa menerima ctx
 *     (ReferenceError) dan meminjam buffer pengalaman. Kini ctx wajib,
 *     buffer memakai autobiography.activationBufferSize.
 *
 * B2: mirror substrate memakai guard pertumbuhan PANJANG array; setelah
 * ring canonical penuh (50), epoch valid baru berhenti terproyeksi.
 * Kini guard transisi bebas kapasitas (elemen terakhir = event ini).
 */

const acc = require("../../src/cognition");
const { ContinuityCore } = acc;
const { createMemoryAccStore } = require("../../src/cognition/persistence/AccStore");

const T0 = 1_000_000;

function makeContinuity({ store, overrides = {}, startMs = T0 } = {}) {
    const clock = acc.manualClock(startMs);
    const config = acc.createACCConfig(
        { DAMAR_ACC: "shadow" }, overrides);
    const core = new ContinuityCore({
        store: store ?? createMemoryAccStore(),
        clock, config
    });
    return { core, clock };
}

/* --------------------------------- B1 ------------------------------------ */

function activationEnvelope(i, clock) {
    return acc.envelope.makeEnvelope({
        type: "MEMORY_ACTIVATED",
        source: "acc.autobiography", provenance: "SYSTEM_EVENT",
        payload: { experienceId: "exp-" + i, reason: "uji buffer",
                   relevance: 0.5 },
        clock
    });
}

test("B1: MEMORY_ACTIVATED dieksekusi lewat feed produksi tanpa ReferenceError", async () => {

    const { core } = makeContinuity();
    await core.initialize();

    const out = await core.feed(activationEnvelope(1, core.clock));
    assert.equal(out.applied, true);

    const acts = core.state.autobiography.activations;
    assert.equal(acts.length, 1);
    assert.equal(acts[0].experienceId, "exp-1");
    assert.equal(acts[0].reason, "uji buffer");
});

test("B1: buffer aktivasi mengikuti konfigurasi (oldest evicted, urutan utuh)", async () => {

    const clock = acc.manualClock(T0);

    // createACCConfig melakukan merge SHALLOW per sub-objek:
    // override menyediakan sub-objek autobiography LENGKAP.
    const config = acc.createACCConfig({}, {
        autobiography: { activationBufferSize: 3 }
    });

    const store = createMemoryAccStore();
    const core = new ContinuityCore({ store, clock, config });
    await core.initialize();

    for (let i = 1; i <= 5; i++) {
        await core.feed(activationEnvelope(i, clock));
        clock.advance(1);
    }

    const acts = core.state.autobiography.activations;
    assert.equal(acts.length, 3, "buffer harus terpotong ke ukuran config");
    assert.deepEqual(acts.map(a => a.experienceId),
        ["exp-3", "exp-4", "exp-5"],
        "yang tersisa adalah yang TERBARU, urutan tetap");

    // Invalid tidak menambah & tidak mengganggu buffer:
    await core.feed(acc.envelope.makeEnvelope({
        type: "MEMORY_ACTIVATED",
        source: "acc.autobiography", provenance: "SYSTEM_EVENT",
        payload: { reason: "tanpa id" }, clock
    }));
    assert.equal(core.state.autobiography.activations.length, 3);
});

/* --------------------------------- B2 ------------------------------------ */

function makeSubstrateCore(store) {
    const clock = acc.manualClock(T0);
    const core = new ContinuityCore({
        store: store ?? createMemoryAccStore(),
        clock,
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" })
    });
    return { core, clock };
}

async function pushEpoch(core, clock, i) {
    clock.advance(1);                       // timestamp deterministik naik
    await core.observeSubstrateChange({
        provider: "synthetic",
        modelId: "model-" + i,
        substrateEpochId: "sub-" + i
    });
}

const TOTAL_EPOCHS = 55;                    // melewati kapasitas ring 50

async function runSubstrateStream(store) {

    const { core, clock } = makeSubstrateCore(store);
    await core.initialize();
    clock.advance(1);

    let ghostInjectedAt = -1;

    for (let i = 0; i < TOTAL_EPOCHS; i++) {
        await pushEpoch(core, clock, i);

        if (i === 25) {
            ghostInjectedAt = i;
            // Event INVALID di tengah aliran: provenance salah →
            // reducer mengabaikan → TIDAK boleh lahir projeksi hantu.
            await core.feed(acc.envelope.makeEnvelope({
                type: "SUBSTRATE_CHANGED",
                source: "attacker", provenance: "USER_CLAIM",
                payload: { descriptor: { provider: "evil",
                    modelId: "evil-model",
                    substrateEpochId: "sub-evil" } },
                clock
            }));
            assert.ok(core.state.diagnostics.ignored.some(x =>
                /substrate bukan event sistem/.test(x.reason)),
                "event invalid wajib tercatat sebagai ignored");
        }
    }

    return { core, ghostInjectedAt };

}

test("B2: >50 epoch — valid tetap terproyeksi setelah ring saturasi", async () => {

    const { core } = await runSubstrateStream(createMemoryAccStore());

    // --- canonical state: ring 50, current = TERAKHIR -------------------
    assert.equal(core.state.substrate.epochs.length, 50,
        "canonical ring tetap bounded");
    assert.equal(core.state.substrate.current.modelId, "model-54");
    assert.equal(core.state.substrate.epochs[0].epochId, "sub-5",
        "retensi ring: 5 tertua tergeser");
    assert.equal(core.state.substrate.epochs[49].epochId, "sub-54");

    // --- projection: SEMUA epoch valid hadir, termasuk pasca-saturasi ---
    const rows = await core.store.listSubstrateEpochs();
    assert.equal(rows.length, TOTAL_EPOCHS,
        "B2 DEFECT: setelah ring penuh, epoch valid baru wajib tetap "
        + "terproyeksi (guard lama berhenti di epoch ke-50)");

    const ids = rows.map(r => r.epoch_id ?? r.epochId);
    for (let i = 0; i < TOTAL_EPOCHS; i++) {
        assert.ok(ids.includes("sub-" + i), `epoch sub-${i} hilang`);
    }
    assert.ok(!ids.includes("sub-evil"),
        "event invalid tidak boleh menciptakan ghost projection");

    // Urutan insertion sesuai jurnal:
    assert.deepEqual(
        ids.map(x => Number(String(x).replace("sub-", ""))),
        Array.from({ length: TOTAL_EPOCHS }, (_, i) => i));

    // Watermark bersih sampai ujung jurnal (invalid pun tak membuat gap):
    const journalEnd = (await core.store.lastJournalRow()).seq;
    assert.equal(core.projectionSeq, journalEnd,
        "tidak ada gap watermark meski ada event invalid di tengah");
});

test("B2: restart → rebuild menghasilkan projeksi EKUIVALEN (live == rebuild)", async () => {

    const store = createMemoryAccStore();
    const { core: c1, clock } = await (async () => {
        const x = makeSubstrateCore(store);
        await x.core.initialize();
        return x;
    })();

    for (let i = 0; i < TOTAL_EPOCHS; i++) await pushEpoch(c1, clock, i);

    const liveRows = await store.listSubstrateEpochs();
    const liveCurrent = c1.state.substrate.current.modelId;
    const liveWatermark = c1.projectionSeq;

    // Paksa jalur REKONSILIASI full-journal pada boot berikutnya:
    await store.putKv("acc.projection.appliedSeq", 0);
    const c2 = makeSubstrateCore(store).core;
    await c2.initialize();

    assert.ok(c2.projectionSeq >= liveWatermark,
        "rekonsiliasi wajib menutup watermark sampai ujung jurnal");

    const rebuiltRows = await store.listSubstrateEpochs();
    assert.deepEqual(
        rebuiltRows.map(r => [r.epoch_id ?? r.epochId, r.payload]),
        liveRows.map(r => [r.epoch_id ?? r.epochId, r.payload]),
        "rebuild wajib menghasilkan baris identik dengan jalur live");

    assert.equal(c2.state.substrate.current.modelId, liveCurrent);
    assert.equal(c2.state.identity.identityId,
        c1.state.identity.identityId, "identitas kekal lintas restart");
    assert.notEqual(c2.bootId, c1.bootId);

    // Idempoten: rekonsiliasi kedua tidak mengubah apa pun (§G).
    const beforeSecondPass =
        JSON.stringify(await store.listSubstrateEpochs());
    await c2.reconcileProjections();
    assert.equal(JSON.stringify(await store.listSubstrateEpochs()),
        beforeSecondPass);
});
