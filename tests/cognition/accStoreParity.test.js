const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * ACC STORE PARITY (§46–§48) — backend memory vs sqlite.
 *
 * Dua backend dijanjikan "semantik identik". Sebelum berkas ini, jalur
 * sqlite ACC tidak punya satu pun tes otomatis: divergensi nyata
 * (listSubstrateEpochs menyebar payload di memory tetapi membungkusnya
 * di sqlite) lolos justru karena tidak ada yang membacanya.
 *
 * Skenario yang SAMA dijalankan pada kedua backend, lalu hasilnya
 * dibandingkan secara struktural setelah normalisasi id volatil.
 * Yang diuji adalah kontrak read-model + rekonsiliasi crash.
 *
 * Basis data sqlite dibuat di direktori sementara terisolasi dan
 * dihapus kembali; tidak ada data produksi yang tersentuh.
 */

const acc = require("../../src/cognition");
const {
    createMemoryAccStore,
    createSqliteAccStore
} = require("../../src/cognition/persistence/AccStore");

const Database = require("../../src/memory/db/Database");
const migrate = require("../../src/memory/db/migrate");

const WATERMARK_KEY = "acc.projection.appliedSeq";

/* ------------------------------ utilitas ------------------------------- */

/** Buang nilai volatil (uuid) dan urutkan kunci agar dapat dibandingkan. */
function stable(value) {

    if (Array.isArray(value)) return value.map(stable);

    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
        return out;
    }

    if (typeof value === "string") {
        return value.replace(
            /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
            "<uuid>");
    }

    return value;
}

/** Bungkus store agar SEMUA tulisan projeksi bisa digagalkan sesaat. */
function withProjectionFailure(store) {

    const names = ["upsertCommitment", "upsertPrediction",
                   "upsertExperience", "upsertSubstrateEpoch"];
    const real = {};
    for (const n of names) real[n] = store[n].bind(store);

    let failing = false;

    for (const n of names) {
        store[n] = async (...args) => {
            if (failing) {
                const error = new Error("INJECTED_PROJECTION_FAILURE");
                error.code = "INJECTED_PROJECTION_FAILURE";
                throw error;
            }
            return real[n](...args);
        };
    }

    return { store, setFailing: (v) => { failing = v; } };
}

function coreOn(store, clock) {
    return new acc.ContinuityCore({
        store,
        clock,
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" })
    });
}

async function readAll(store) {
    return stable({
        commitments: [...await store.listCommitments()]
            .sort((a, b) => a.commitment_id.localeCompare(b.commitment_id)),
        predictions: [...await store.listPredictions()]
            .sort((a, b) => a.prediction_id.localeCompare(b.prediction_id)),
        experiences: [...await store.listExperiences()]
            .sort((a, b) => a.experience_id.localeCompare(b.experience_id)),
        // Substrat sengaja TIDAK diurut ulang: urutan epoch bagian kontrak.
        substrate: await store.listSubstrateEpochs()
    });
}

/**
 * Skenario tunggal yang mencakup ke-12 titik paritas.
 * Mengembalikan ringkasan ternormalisasi + penanda proses.
 */
async function runScenario(rawStore) {

    const clock = acc.manualClock(1_000_000);
    const { store, setFailing } = withProjectionFailure(rawStore);

    const c1 = await coreOn(store, clock).initialize();

    // (2) Projeksi GAGAL sesudah commit kanonik.
    setFailing(true);

    const dirtyFeed = await c1.feed(acc.envelope.makeEnvelope({
        type: "COMMITMENT_ADDED", source: "operator", provenance: "SYSTEM_EVENT",
        payload: {
            commitmentId: "pc-1", statement: "parity lifecycle",
            source: "USER_EXPLICIT", priority: 0.5
        },
        clock
    }));

    // (1) Lifecycle komitmen ACTIVE -> COMPLETED.
    await c1.feed(acc.envelope.makeEnvelope({
        type: "COMMITMENT_COMPLETED", source: "system_policy",
        provenance: "SYSTEM_EVENT", payload: { commitmentId: "pc-1" }, clock
    }));

    // (11) Event yang WAJIB diabaikan reducer.
    await c1.feed(acc.envelope.makeEnvelope({
        type: "COMMITMENT_COMPLETED", source: "system_policy",
        provenance: "SYSTEM_EVENT", payload: { commitmentId: "pc-ghost" }, clock
    }));
    await c1.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_RESOLVED_INCORRECT", source: "acc.prediction",
        provenance: "SYSTEM_EVENT", payload: { predictionId: "pp-ghost" }, clock
    }));
    await c1.feed(acc.envelope.makeEnvelope({
        type: "SUBSTRATE_CHANGED", source: "acc.substrate",
        provenance: "OBSERVATION",
        payload: {
            descriptor: {
                provider: "evil", modelId: "evil-model",
                substrateEpochId: "ghost-epoch"
            }
        },
        clock
    }));

    // (8) Lifecycle prediksi OPEN -> RESOLVED.
    const prediction = acc.Predictions.newPrediction({
        predictionId: "pp-1",
        subject: "paritas backend terjaga",
        expectedOutcome: { ok: true },
        probability: 0.75,
        horizonMs: 60000,
        createdAtMs: clock.nowMs(),
        evidenceRefs: ["evt-parity-1"]
    });

    await c1.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_OPENED", source: "acc.prediction",
        provenance: "SYSTEM_EVENT", payload: { prediction }, clock
    }));
    await c1.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_RESOLVED_CORRECT", source: "acc.prediction",
        provenance: "SYSTEM_EVENT", payload: { predictionId: "pp-1" }, clock
    }));

    // (9) Significance di luar rentang -> di-clamp kanonik.
    await c1.feed(acc.envelope.makeEnvelope({
        type: "EXPERIENCE_RECORDED", source: "acc.autobiography",
        provenance: "SYSTEM_EVENT",
        payload: {
            significance: 9.7,
            experience: {
                experienceId: "pe-1",
                timestamp: new Date(clock.nowMs()).toISOString(),
                eventRefs: [], outcome: "observed"
            }
        },
        clock
    }));

    // (10) Dua epoch substrat sah, berurutan.
    await c1.observeSubstrateChange({ provider: "ox", modelId: "ox-alpha" });
    await c1.observeSubstrateChange({ provider: "ox", modelId: "ox-beta" });

    const projectionsWhileDirty = {
        commitments: (await store.listCommitments()).length,
        predictions: (await store.listPredictions()).length,
        experiences: (await store.listExperiences()).length,
        substrate: (await store.listSubstrateEpochs()).length
    };

    // (6) Watermark TIDAK boleh melompati lubang.
    const journalEnd = (await store.lastJournalRow()).seq;
    const watermarkWhileDirty = await store.getKv(WATERMARK_KEY);

    // (3) Snapshot diambil SESUDAH projeksi gagal.
    setFailing(false);
    await c1.snapshot();

    // (4)(5) Restart -> rekonsiliasi.
    const c2 = await coreOn(store, clock).initialize();

    const afterRestart = await readAll(store);

    // (12) Rekonsiliasi kedua tidak boleh mengubah apa pun.
    await c2.reconcileProjections();
    const afterSecondReconcile = await readAll(store);

    return {
        backend: rawStore.backend,
        dirtyFeed: {
            applied: dirtyFeed.applied,
            projectionOk: dirtyFeed.projection.ok,
            projectionDirty: dirtyFeed.projection.dirty
        },
        projectionsWhileDirty,
        watermarkLaggedWhileDirty: Number(watermarkWhileDirty) < journalEnd,
        canonicalAfterRestart: {
            activeCommitments: Object.keys(c2.state.commitments.active).sort(),
            completedCount: c2.state.commitments.completedCount,
            openPredictions: Object.keys(c2.state.predictions.open).sort(),
            resolvedCount: c2.state.predictions.resolvedCount,
            substrateEpochs: c2.state.substrate.epochs.length
        },
        afterRestart,
        afterSecondReconcile,
        watermarkAfterRestart:
            Number(await store.getKv(WATERMARK_KEY)) ===
            (await store.lastJournalRow()).seq
    };

}

/* -------------------------------- tes ---------------------------------- */

test("ACC store parity: memory dan sqlite menghasilkan read-model yang identik", async (t) => {

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-parity-"));
    const file = path.join(dir, "acc-parity.db");
    const database = new Database(file);

    t.after(async () => {
        try { await database.close(); } catch { /* sudah tertutup */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch { /* biarkan OS membersihkan */ }
    });

    await database.open();
    await migrate(database);

    const memory = await runScenario(createMemoryAccStore());
    const sqlite = await runScenario(createSqliteAccStore(database));

    // ---- PARITAS STRUKTURAL -------------------------------------------
    assert.equal(memory.backend, "memory");
    assert.equal(sqlite.backend, "sqlite");

    assert.deepEqual(sqlite.afterRestart, memory.afterRestart,
        "read-model hasil rekonsiliasi wajib identik di kedua backend");
    assert.deepEqual(sqlite.canonicalAfterRestart, memory.canonicalAfterRestart,
        "state kanonik hasil restart wajib identik di kedua backend");
    assert.deepEqual(sqlite.dirtyFeed, memory.dirtyFeed,
        "kontrak feed() saat projeksi gagal wajib identik");
    assert.deepEqual(sqlite.projectionsWhileDirty, memory.projectionsWhileDirty,
        "keadaan projeksi saat kotor wajib identik");

    for (const r of [memory, sqlite]) {

        const label = r.backend;

        // (2) Projeksi gagal SESUDAH commit kanonik: event tetap applied.
        assert.equal(r.dirtyFeed.applied, true, `${label}: event kanonik tetap durabel`);
        assert.equal(r.dirtyFeed.projectionOk, false, `${label}: kegagalan dilaporkan`);
        assert.equal(r.dirtyFeed.projectionDirty, true, `${label}: ditandai kotor`);

        assert.deepEqual(r.projectionsWhileDirty,
            { commitments: 0, predictions: 0, experiences: 0, substrate: 0 },
            `${label}: prasyarat — tidak ada projeksi tertulis saat kotor`);

        // (6) Watermark tertinggal, tidak melompati lubang.
        assert.equal(r.watermarkLaggedWhileDirty, true,
            `${label}: watermark tidak boleh melewati projeksi yang gagal`);

        // (4)(5) Restart merekonsiliasi sampai ujung jurnal.
        assert.equal(r.watermarkAfterRestart, true,
            `${label}: setelah rekonsiliasi watermark = ujung jurnal`);

        // (1)(7) Lifecycle komitmen selesai, payload lengkap.
        const commitment = r.afterRestart.commitments
            .find(x => x.commitment_id === "pc-1");
        assert.ok(commitment, `${label}: komitmen selesai hadir kembali`);
        assert.equal(commitment.status, "COMPLETED");
        assert.equal(commitment.payload.statement, "parity lifecycle");
        assert.equal(commitment.payload.source, "USER_EXPLICIT");
        assert.equal(commitment.payload.priority, 0.5);
        assert.equal(commitment.payload.status, "COMPLETED");
        assert.ok(commitment.payload.completedAt, `${label}: completedAt bertahan`);
        assert.ok(commitment.payload.completionEventId,
            `${label}: completionEventId bertahan`);
        assert.equal(r.canonicalAfterRestart.completedCount, 1);
        assert.deepEqual(r.canonicalAfterRestart.activeCommitments, []);

        // (8) Lifecycle prediksi resolved, payload lengkap.
        const predictionRow = r.afterRestart.predictions
            .find(x => x.prediction_id === "pp-1");
        assert.ok(predictionRow, `${label}: prediksi resolved hadir kembali`);
        assert.equal(predictionRow.status, "RESOLVED_CORRECT");
        assert.equal(predictionRow.payload.status, "RESOLVED_CORRECT");
        assert.equal(predictionRow.payload.probability, 0.75);
        assert.equal(predictionRow.payload.subject, "paritas backend terjaga");
        assert.deepEqual(predictionRow.payload.evidenceRefs, ["evt-parity-1"]);
        assert.ok(predictionRow.payload.resolvedAt);
        assert.ok(predictionRow.payload.resolutionEventId);
        assert.deepEqual(r.canonicalAfterRestart.openPredictions, []);
        assert.equal(r.canonicalAfterRestart.resolvedCount, 1);

        // (9) Significance = nilai kanonik yang sudah di-clamp.
        const experience = r.afterRestart.experiences
            .find(x => x.experience_id === "pe-1");
        assert.ok(experience, `${label}: pengalaman hadir kembali`);
        assert.equal(experience.significance, 1,
            `${label}: significance memakai nilai kanonik, bukan 9.7 mentah`);

        // (10) Urutan + struktur payload epoch substrat.
        assert.equal(r.afterRestart.substrate.length, 2,
            `${label}: kedua epoch substrat hadir kembali`);
        assert.equal(r.afterRestart.substrate[0].payload.descriptor.modelId, "ox-alpha");
        assert.equal(r.afterRestart.substrate[1].payload.descriptor.modelId, "ox-beta");
        for (const row of r.afterRestart.substrate) {
            assert.ok(row.payload.at, `${label}: metadata waktu epoch bertahan`);
            assert.ok(row.payload.eventId, `${label}: metadata eventId epoch bertahan`);
        }
        assert.equal(r.canonicalAfterRestart.substrateEpochs, 2);

        // (11) Event yang diabaikan tidak menghasilkan baris hantu.
        assert.equal(
            r.afterRestart.commitments.find(x => x.commitment_id === "pc-ghost"),
            undefined, `${label}: komitmen hantu tidak boleh ada`);
        assert.equal(
            r.afterRestart.predictions.find(x => x.prediction_id === "pp-ghost"),
            undefined, `${label}: prediksi hantu tidak boleh ada`);
        assert.equal(
            r.afterRestart.substrate.find(x => x.epoch_id === "ghost-epoch"),
            undefined, `${label}: epoch hantu tidak boleh ada`);

        // (12) Rekonsiliasi idempoten.
        assert.deepEqual(r.afterSecondReconcile, r.afterRestart,
            `${label}: rekonsiliasi kedua tidak boleh mengubah read-model`);
    }

});

test("ACC store parity: bentuk baris list* identik antar backend", async (t) => {

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-shape-"));
    const file = path.join(dir, "acc-shape.db");
    const database = new Database(file);

    t.after(async () => {
        try { await database.close(); } catch { /* sudah tertutup */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch { /* biarkan OS membersihkan */ }
    });

    await database.open();
    await migrate(database);

    const shapes = [];

    for (const store of [createMemoryAccStore(), createSqliteAccStore(database)]) {

        await store.upsertCommitment("s-c", "ACTIVE", { statement: "x" });
        await store.upsertPrediction("s-p", "OPEN", { probability: 0.5 });
        await store.upsertExperience("s-e", 0.5, { note: "x" });
        await store.upsertSubstrateEpoch("s-s", { descriptor: { provider: "ox" }, at: "t" });
        await store.putKv(WATERMARK_KEY, 7);

        shapes.push({
            backend: store.backend,
            commitment: Object.keys((await store.listCommitments())[0]).sort(),
            prediction: Object.keys((await store.listPredictions())[0]).sort(),
            experience: Object.keys((await store.listExperiences())[0]).sort(),
            substrate: Object.keys((await store.listSubstrateEpochs())[0]).sort(),
            kv: await store.getKv(WATERMARK_KEY)
        });
    }

    const [mem, sql] = shapes;

    assert.deepEqual(sql.commitment, mem.commitment,
        "bentuk baris commitment wajib sama");
    assert.deepEqual(sql.prediction, mem.prediction,
        "bentuk baris prediction wajib sama");
    assert.deepEqual(sql.experience, mem.experience,
        "bentuk baris experience wajib sama");
    assert.deepEqual(sql.substrate, mem.substrate,
        "bentuk baris substrate epoch wajib sama (payload BERSARANG, bukan disebar)");
    assert.deepEqual(sql.substrate, ["epoch_id", "payload"],
        "kontrak eksplisit: { epoch_id, payload }");
    assert.equal(Number(mem.kv), 7, "kv memory bolak-balik utuh");
    assert.equal(Number(sql.kv), 7, "kv sqlite bolak-balik utuh");

});
