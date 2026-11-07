const test = require("node:test");
const assert = require("node:assert");

/**
 * ACC CONTINUITY (§8–§9/§46–§53) — identitas, jurnal, replay,
 * restart, dedupe event, integritas rantai hash.
 */

const acc = require("../../src/cognition");
const { createMemoryAccStore } = require("../../src/cognition/persistence/AccStore");

function makeCore(store, clock, overrides = {}) {
    return new acc.ContinuityCore({
        store: store ?? createMemoryAccStore(),
        clock: clock ?? acc.manualClock(1_000_000),
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" }, overrides)
    });
}

const env = (type, payload, extra = {}) => acc.envelope.makeEnvelope({
    type, source: extra.source ?? "test", provenance: extra.provenance ?? "SYSTEM_EVENT",
    payload, clock: { nowMs: () => 1_000_000 }
});

test("C0.1: identitas dibuat SEKALI; core kedua pada store yang sama mewarisi", async () => {

    const store = createMemoryAccStore();
    const c1 = await makeCore(store).initialize();

    assert.ok(c1.state.identity.identityId, "identitas terinisialisasi");

    const idBefore = c1.state.identity.identityId;
    const contBefore = c1.state.identity.continuityId;

    // "Restart": instance baru di atas store yang sama.
    const c2 = await makeCore(store).initialize();

    assert.equal(c2.state.identity.identityId, idBefore,
        "identityId TIDAK boleh berubah karena restart");
    assert.equal(c2.state.identity.continuityId, contBefore,
        "continuityId TIDAK boleh berubah karena restart");
    assert.notEqual(c2.bootId, c1.bootId, "bootId WAJIB baru tiap boot");

    // Boot epoch tercatat dua kali, identitas tetap satu.
    assert.equal(
        c2.state.boots.length >= 2, true);
});

test("C0.1: replay deterministik — digest live == digest restore", async () => {

    const store = createMemoryAccStore();
    const c1 = await makeCore(store).initialize();

    await c1.feed(env("COMMITMENT_ADDED",
        { commitmentId: "c-1", statement: "jaga kontinuitas",
          source: "USER_EXPLICIT", priority: 0.8 }));
    await c1.feed(env("TOOL_FAILED",
        { tool: "browse" }, { provenance: "OBSERVATION" }));
    await c1.observeSubstrateChange({ provider: "ox", modelId: "ox-alpha" });

    // Snapshot + tambahan event setelahnya → jalur snapshot+replay.
    await c1.snapshot();
    await c1.feed(env("TOOL_SUCCEEDED",
        { tool: "memory_recall" }, { provenance: "OBSERVATION" }));

    const digestLive = c1.semanticDigest();

    // Instance baru: muat snapshot lalu replay sisanya.
    const c2 = await makeCore(store).initialize();
    const digestRestored = c2.semanticDigest();

    assert.equal(digestRestored, digestLive,
        "snapshot+replay wajib merekonstruksi state yang sama persis");
});

test("C0.1: duplikasi eventId diterapkan SEKALI (§102)", async () => {

    const c = await makeCore().initialize();

    const e = env("COMMITMENT_ADDED",
        { commitmentId: "dup", statement: "sekali saja",
          source: "USER_EXPLICIT" });

    const first = await c.feed(e);
    const second = await c.feed(e);

    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.equal(Object.keys(c.state.commitments.active).length, 1);
});

test("C0.1: reset kontinuitas eksplisit → epoch baru, identityId tetap, lineage dicatat", async () => {

    const c = await makeCore().initialize();

    const identityId = c.state.identity.identityId;
    const oldContinuity = c.state.identity.continuityId;

    await c.createContinuityEpoch("reset destruktif oleh operator");

    assert.equal(c.state.identity.identityId, identityId);
    assert.notEqual(c.state.identity.continuityId, oldContinuity);
    assert.equal(c.state.identity.lineage.length, 1);
    assert.equal(c.state.identity.lineage[0].continuityId, oldContinuity);
});

test("C0.1: integritas rantai hash jurnal terverifikasi", async () => {

    const c = await makeCore().initialize();
    await c.feed(env("TOOL_SUCCEEDED",
        { tool: "x" }, { provenance: "OBSERVATION" }));
    await c.feed(env("TOOL_FAILED",
        { tool: "x" }, { provenance: "OBSERVATION" }));

    const verdict = await c.verifyJournalIntegrity();
    assert.equal(verdict.ok, true);
    assert.ok(verdict.length >= 3, "jurnal berisi event init+boot+feed");
});

test("C0.1: ignored COMMITMENT_COMPLETED tidak boleh membuat projection hantu", async () => {

    const store = createMemoryAccStore();
    const c = await makeCore(store).initialize();

    const completedBefore = c.state.commitments.completedCount;

    // Tidak pernah ada commitment bernama ghost.
    await c.completeCommitment("ghost");

    // Canonical reducer wajib mengabaikannya.
    assert.equal(
        c.state.commitments.completedCount,
        completedBefore,
        "unknown commitment tidak boleh menaikkan completedCount"
    );

    assert.equal(
        c.state.commitments.active["ghost"],
        undefined,
        "unknown commitment tidak boleh muncul di canonical state"
    );

    // Projection juga WAJIB mengikuti canonical transition.
    const projected = await store.listCommitments();
    const ghost = projected.find(x => x.commitment_id === "ghost");

    assert.equal(
        ghost,
        undefined,
        "ignored completion tidak boleh membuat COMPLETED projection hantu"
    );
});

test("C0.1: lifecycle commitment valid ACTIVE -> COMPLETED terproyeksi utuh", async () => {

    const store = createMemoryAccStore();
    const c = await makeCore(store).initialize();

    await c.feed(env("COMMITMENT_ADDED", {
        commitmentId: "life-1",
        statement: "pertahankan kontinuitas",
        source: "USER_EXPLICIT",
        priority: 0.8
    }));

    // Canonical ACTIVE.
    assert.ok(c.state.commitments.active["life-1"]);
    assert.equal(
        c.state.commitments.active["life-1"].statement,
        "pertahankan kontinuitas"
    );

    // Projection ACTIVE.
    let rows = await store.listCommitments();
    let projected = rows.find(x => x.commitment_id === "life-1");

    assert.ok(projected, "commitment ACTIVE wajib ada di projection");
    assert.equal(projected.status, "ACTIVE");
    assert.equal(projected.payload.statement, "pertahankan kontinuitas");
    assert.equal(projected.payload.source, "USER_EXPLICIT");
    assert.equal(projected.payload.priority, 0.8);

    const completedBefore = c.state.commitments.completedCount;

    await c.completeCommitment("life-1");

    // Canonical transition benar-benar terjadi.
    assert.equal(
        c.state.commitments.active["life-1"],
        undefined,
        "commitment selesai harus keluar dari active"
    );

    assert.equal(
        c.state.commitments.completedCount,
        completedBefore + 1
    );

    // Projection ikut menjadi COMPLETED dan metadata lama tidak hilang.
    rows = await store.listCommitments();
    projected = rows.find(x => x.commitment_id === "life-1");

    assert.ok(projected, "projection commitment tidak boleh hilang");
    assert.equal(projected.status, "COMPLETED");

    assert.equal(
        projected.payload.statement,
        "pertahankan kontinuitas",
        "statement commitment harus survive completion"
    );

    assert.equal(projected.payload.source, "USER_EXPLICIT");
    assert.equal(projected.payload.priority, 0.8);

    assert.ok(
        projected.payload.createdAt,
        "createdAt awal harus dipertahankan"
    );

    assert.ok(
        projected.payload.completedAt,
        "completedAt wajib dicatat"
    );

    assert.ok(
        projected.payload.completionEventId,
        "completionEventId wajib dicatat"
    );
});

test("C0.1: stale OPEN prediction projection tidak boleh di-resolve jika canonical tidak punya", async () => {

    const store = createMemoryAccStore();
    const c = await makeCore(store).initialize();

    // Simulasikan projection stale/corrupt: read-model punya OPEN,
    // tetapi canonical continuity state TIDAK punya prediction tersebut.
    await store.upsertPrediction(
        "stale-p",
        "OPEN",
        {
            predictionId: "stale-p",
            subject: "projection stale",
            expectedOutcome: { ok: true },
            probability: 0.8,
            horizonMs: 60000,
            createdAtMs: 1000000,
            status: "OPEN",
            evidenceRefs: []
        }
    );

    const resolvedBefore = c.state.predictions.resolvedCount;
    const correctBefore = c.state.predictions.correctCount;
    const brierBefore = c.state.meta.stats.brierN;

    await c.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_RESOLVED_CORRECT",
        source: "acc.prediction",
        provenance: "SYSTEM_EVENT",
        payload: { predictionId: "stale-p" },
        clock: acc.manualClock(1_000_000)
    }));

    // Canonical reducer wajib mengabaikan resolution tanpa OPEN canonical.
    assert.equal(c.state.predictions.open["stale-p"], undefined);
    assert.equal(c.state.predictions.resolvedCount, resolvedBefore);
    assert.equal(c.state.predictions.correctCount, correctBefore);
    assert.equal(c.state.meta.stats.brierN, brierBefore);

    // Projection juga tidak boleh mengarang transisi.
    const projected = await store.getPrediction("stale-p");

    assert.ok(projected, "fixture stale projection harus tetap ada");
    assert.equal(
        projected.status,
        "OPEN",
        "ignored canonical resolution tidak boleh mengubah stale projection"
    );
});

test("C0.1: lifecycle prediction valid OPEN -> RESOLVED terproyeksi utuh", async () => {

    const store = createMemoryAccStore();
    const clock = acc.manualClock(1_000_000);
    const c = await makeCore(store, clock).initialize();

    const prediction = acc.Predictions.newPrediction({
        predictionId: "life-p-1",
        subject: "retry browse akan sukses",
        expectedOutcome: { ok: true },
        probability: 0.8,
        horizonMs: 60_000,
        createdAtMs: clock.nowMs(),
        evidenceRefs: ["evt-evidence-1"]
    });

    await c.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_OPENED",
        source: "acc.prediction",
        provenance: "SYSTEM_EVENT",
        payload: { prediction },
        clock
    }));

    // Canonical OPEN.
    assert.ok(c.state.predictions.open["life-p-1"]);
    assert.equal(
        c.state.predictions.open["life-p-1"].subject,
        "retry browse akan sukses"
    );

    // Projection OPEN.
    let projected = await store.getPrediction("life-p-1");

    assert.ok(projected, "prediction OPEN wajib ada di projection");
    assert.equal(projected.status, "OPEN");
    assert.equal(projected.payload.probability, 0.8);
    assert.equal(projected.payload.subject, "retry browse akan sukses");
    assert.deepEqual(projected.payload.evidenceRefs, ["evt-evidence-1"]);

    const resolvedBefore = c.state.predictions.resolvedCount;
    const correctBefore = c.state.predictions.correctCount;

    await c.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_RESOLVED_CORRECT",
        source: "acc.prediction",
        provenance: "SYSTEM_EVENT",
        payload: { predictionId: "life-p-1" },
        clock
    }));

    // Canonical transition.
    assert.equal(c.state.predictions.open["life-p-1"], undefined);
    assert.equal(c.state.predictions.resolvedCount, resolvedBefore + 1);
    assert.equal(c.state.predictions.correctCount, correctBefore + 1);

    // Projection ikut resolved, metadata OPEN tetap utuh.
    projected = await store.getPrediction("life-p-1");

    assert.ok(projected);
    assert.equal(projected.status, "RESOLVED_CORRECT");
    assert.equal(projected.payload.status, "RESOLVED_CORRECT");

    assert.equal(
        projected.payload.subject,
        "retry browse akan sukses"
    );

    assert.equal(projected.payload.probability, 0.8);
    assert.deepEqual(
        projected.payload.expectedOutcome,
        { ok: true }
    );
    assert.deepEqual(
        projected.payload.evidenceRefs,
        ["evt-evidence-1"]
    );

    assert.ok(
        projected.payload.resolvedAt,
        "resolvedAt wajib dicatat"
    );

    assert.ok(
        projected.payload.resolutionEventId,
        "resolutionEventId wajib dicatat"
    );
});

test("C0.1: ignored SUBSTRATE_CHANGED tidak boleh memutasi projection epoch sebelumnya", async () => {

    const store = createMemoryAccStore();
    const clock = acc.manualClock(1_000_000);
    const c = await makeCore(store, clock).initialize();

    // Seed substrate valid.
    await c.observeSubstrateChange({
        provider: "ox",
        modelId: "ox-alpha"
    });

    const canonicalBefore =
        JSON.parse(JSON.stringify(c.state.substrate));

    const projectedBefore =
        JSON.parse(JSON.stringify(await store.listSubstrateEpochs()));

    assert.ok(projectedBefore.length > 0,
        "fixture wajib menghasilkan substrate projection");

    // Provenance salah => reducer wajib IGNORE.
    await c.feed(acc.envelope.makeEnvelope({
        type: "SUBSTRATE_CHANGED",
        source: "acc.substrate",
        provenance: "OBSERVATION",
        payload: {
            descriptor: {
                provider: "evil",
                modelId: "evil-model",
                substrateEpochId: "evil-epoch"
            }
        },
        clock
    }));

    assert.deepEqual(
        c.state.substrate,
        canonicalBefore,
        "ignored substrate event tidak boleh mengubah canonical state"
    );

    const projectedAfter =
        JSON.parse(JSON.stringify(await store.listSubstrateEpochs()));

    assert.deepEqual(
        projectedAfter,
        projectedBefore,
        "ignored substrate event tidak boleh memutasi projection lama"
    );
});


test("C0.1: EXPERIENCE_RECORDED projection harus memakai significance canonical yang sudah di-clamp", async () => {

    const store = createMemoryAccStore();
    const clock = acc.manualClock(1_000_000);
    const c = await makeCore(store, clock).initialize();

    await c.feed(acc.envelope.makeEnvelope({
        type: "EXPERIENCE_RECORDED",
        source: "acc.autobiography",
        provenance: "SYSTEM_EVENT",
        payload: {
            significance: 9.7,
            experience: {
                experienceId: "exp-clamp-1",
                timestamp: new Date(clock.nowMs()).toISOString(),
                eventRefs: [],
                outcome: "observed"
            }
        },
        clock
    }));

    const canonical =
        c.state.autobiography.recent.find(
            x => x.experienceId === "exp-clamp-1"
        );

    assert.ok(canonical);
    assert.equal(
        canonical.significance,
        1,
        "canonical reducer wajib clamp significance ke 1"
    );

    const rows = await store.listExperiences();
    const projected =
        rows.find(x => x.experience_id === "exp-clamp-1");

    assert.ok(projected,
        "experience wajib ada di projection");

    assert.equal(
        projected.significance,
        canonical.significance,
        "projection significance wajib identik dengan canonical significance"
    );
});

test("C0.1: projection failure setelah canonical commit harus pulih saat restart", async () => {

    const store = createMemoryAccStore();

    const realUpsertCommitment =
        store.upsertCommitment.bind(store);

    let failOnce = true;

    store.upsertCommitment = async (...args) => {
        const [commitmentId] = args;

        if (failOnce && commitmentId === "reconcile-1") {
            failOnce = false;

            const error =
                new Error("INJECTED_PROJECTION_FAILURE");

            error.code =
                "INJECTED_PROJECTION_FAILURE";

            throw error;
        }

        return realUpsertCommitment(...args);
    };

    const c1 = await makeCore(store).initialize();

    const event = env("COMMITMENT_ADDED", {
        commitmentId: "reconcile-1",
        statement: "projection harus bisa dipulihkan",
        source: "USER_EXPLICIT",
        priority: 0.9
    });

    // Journal + canonical commit terjadi SEBELUM mirror. Karena hasil
    // otoritatif sudah durabel, feed() TIDAK melapor gagal — ia melapor
    // applied=true dengan diagnostik projeksi kotor. Melempar di sini akan
    // mendorong pemanggil me-retry dan menggandakan event kanonik.
    const outcome = await c1.feed(event);

    assert.equal(outcome.applied, true,
        "event kanonik sudah durabel — feed tidak boleh melapor gagal");
    assert.equal(outcome.projection.ok, false,
        "kegagalan projeksi wajib dilaporkan eksplisit, bukan disembunyikan");
    assert.equal(outcome.projection.dirty, true);
    assert.match(outcome.projection.error, /INJECTED_PROJECTION_FAILURE/);

    // Walaupun mirror gagal, canonical transition sudah terjadi.
    assert.ok(
        c1.state.commitments.active["reconcile-1"],
        "canonical commitment seharusnya sudah committed"
    );

    let rows = await store.listCommitments();

    assert.equal(
        rows.find(x =>
            x.commitment_id === "reconcile-1"),
        undefined,
        "failure injection harus benar-benar meninggalkan projection kosong"
    );

    // Restart dari journal/store yang sama.
    const c2 = await makeCore(store).initialize();

    // Canonical state harus pulih dari journal.
    assert.ok(
        c2.state.commitments.active["reconcile-1"],
        "restart wajib merekonstruksi canonical commitment dari journal"
    );

    // Derived projection juga seharusnya direkonsiliasi.
    rows = await store.listCommitments();

    const projected = rows.find(
        x => x.commitment_id === "reconcile-1"
    );

    assert.ok(
        projected,
        "restart wajib memperbaiki projection yang hilang setelah crash"
    );

    assert.equal(projected.status, "ACTIVE");
    assert.equal(
        projected.payload.statement,
        "projection harus bisa dipulihkan"
    );
    assert.equal(projected.payload.source, "USER_EXPLICIT");
    assert.equal(projected.payload.priority, 0.9);
});

/* ====================================================================== *
 * C0.1 — REKONSILIASI READ-MODEL (projection rebuild dari jurnal penuh)
 *
 * Jurnal adalah sumber kebenaran; tabel prediksi/komitmen/pengalaman/
 * substrat hanyalah turunan. Kelompok tes ini menjaga: projeksi yang
 * hilang/gagal SELALU bisa dibangun ulang dari sejarah event, hasilnya
 * idempoten, dan event yang di-IGNORE reducer tidak pernah memunculkan
 * baris hantu.
 * ====================================================================== */

/** Store memory dengan sakelar kegagalan untuk SEMUA tulisan projeksi. */
function failingProjectionStore() {

    const store = createMemoryAccStore();
    const real = {
        upsertCommitment: store.upsertCommitment.bind(store),
        upsertPrediction: store.upsertPrediction.bind(store),
        upsertExperience: store.upsertExperience.bind(store),
        upsertSubstrateEpoch: store.upsertSubstrateEpoch.bind(store)
    };

    let failing = false;

    for (const name of Object.keys(real)) {
        store[name] = async (...args) => {
            if (failing) {
                const error = new Error("INJECTED_PROJECTION_FAILURE");
                error.code = "INJECTED_PROJECTION_FAILURE";
                throw error;
            }
            return real[name](...args);
        };
    }

    return { store, setFailing: (v) => { failing = v; } };
}

/** Siklus hidup lengkap: komitmen, prediksi, pengalaman, substrat, ignored. */
async function seedLifecycle(core, clock) {

    await core.feed(acc.envelope.makeEnvelope({
        type: "COMMITMENT_ADDED", source: "operator", provenance: "SYSTEM_EVENT",
        payload: {
            commitmentId: "rb-c-1", statement: "selesaikan audit",
            source: "USER_EXPLICIT", priority: 0.5
        },
        clock
    }));

    await core.feed(acc.envelope.makeEnvelope({
        type: "COMMITMENT_COMPLETED", source: "system_policy",
        provenance: "SYSTEM_EVENT",
        payload: { commitmentId: "rb-c-1" }, clock
    }));

    // IGNORED: komitmen yang tidak dikenal tidak boleh jadi baris hantu.
    await core.feed(acc.envelope.makeEnvelope({
        type: "COMMITMENT_COMPLETED", source: "system_policy",
        provenance: "SYSTEM_EVENT",
        payload: { commitmentId: "rb-c-hantu" }, clock
    }));

    const prediction = acc.Predictions.newPrediction({
        predictionId: "rb-p-1",
        subject: "rebuild akan konsisten",
        expectedOutcome: { ok: true },
        probability: 0.75,
        horizonMs: 60000,
        createdAtMs: clock.nowMs(),
        evidenceRefs: ["evt-rb-1"]
    });

    await core.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_OPENED", source: "acc.prediction",
        provenance: "SYSTEM_EVENT", payload: { prediction }, clock
    }));

    await core.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_RESOLVED_CORRECT", source: "acc.prediction",
        provenance: "SYSTEM_EVENT", payload: { predictionId: "rb-p-1" }, clock
    }));

    // IGNORED: resolusi prediksi yang tidak pernah OPEN.
    await core.feed(acc.envelope.makeEnvelope({
        type: "PREDICTION_RESOLVED_INCORRECT", source: "acc.prediction",
        provenance: "SYSTEM_EVENT", payload: { predictionId: "rb-p-hantu" }, clock
    }));

    await core.feed(acc.envelope.makeEnvelope({
        type: "EXPERIENCE_RECORDED", source: "acc.autobiography",
        provenance: "SYSTEM_EVENT",
        payload: {
            significance: 9.7,                       // di luar rentang -> clamp 1
            experience: {
                experienceId: "rb-e-1",
                timestamp: new Date(clock.nowMs()).toISOString(),
                eventRefs: [], outcome: "observed"
            }
        },
        clock
    }));

    await core.observeSubstrateChange({ provider: "ox", modelId: "ox-alpha" });
    await core.observeSubstrateChange({ provider: "ox", modelId: "ox-beta" });

    // IGNORED: provenance salah -> reducer menolak, projeksi tak berubah.
    await core.feed(acc.envelope.makeEnvelope({
        type: "SUBSTRATE_CHANGED", source: "acc.substrate",
        provenance: "OBSERVATION",
        payload: {
            descriptor: {
                provider: "evil", modelId: "evil-model",
                substrateEpochId: "evil-epoch"
            }
        },
        clock
    }));

}

test("C0.1/rebuild: snapshot SESUDAH commit kanonik tetap bisa memperbaiki projeksi", async () => {

    const { store, setFailing } = failingProjectionStore();
    const clock = acc.manualClock(1_000_000);
    const c1 = await makeCore(store, clock).initialize();

    setFailing(true);

    const outcome = await c1.feed(acc.envelope.makeEnvelope({
        type: "COMMITMENT_ADDED", source: "operator", provenance: "SYSTEM_EVENT",
        payload: {
            commitmentId: "snap-c-1", statement: "bertahan melewati snapshot",
            source: "USER_EXPLICIT", priority: 0.4
        },
        clock
    }));

    assert.equal(outcome.applied, true);
    assert.equal(outcome.projection.ok, false, "projeksi memang gagal");

    // SNAPSHOT dibuat SESUDAH commit kanonik: replay-setelah-snapshot
    // tidak akan pernah menyentuh event ini lagi. Rekonsiliasi karena itu
    // WAJIB berbasis jurnal penuh, bukan berbasis snapshot.
    setFailing(false);
    await c1.snapshot();

    assert.equal(
        (await store.listCommitments()).length, 0,
        "prasyarat: projeksi masih kosong saat snapshot diambil");

    const c2 = await makeCore(store, clock).initialize();

    assert.ok(c2.state.commitments.active["snap-c-1"],
        "canonical dipulihkan dari snapshot");

    const projected = (await store.listCommitments())
        .find(x => x.commitment_id === "snap-c-1");

    assert.ok(projected,
        "projeksi yang tercakup snapshot tetap wajib diperbaiki");
    assert.equal(projected.status, "ACTIVE");
    assert.equal(projected.payload.statement, "bertahan melewati snapshot");
});

test("C0.1/rebuild: rekonsiliasi idempoten — dua kali jalan, hasil identik", async () => {

    const { store, setFailing } = failingProjectionStore();
    const clock = acc.manualClock(1_000_000);
    const c = await makeCore(store, clock).initialize();

    setFailing(false);
    await seedLifecycle(c, clock);

    const snapshotOf = async () => JSON.parse(JSON.stringify({
        commitments: await store.listCommitments(),
        predictions: await store.listPredictions(),
        experiences: await store.listExperiences(),
        substrate: await store.listSubstrateEpochs()
    }));

    const live = await snapshotOf();

    const first = await c.reconcileProjections();
    const afterFirst = await snapshotOf();

    const second = await c.reconcileProjections();
    const afterSecond = await snapshotOf();

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.reconciled, second.reconciled,
        "jumlah event yang diputar ulang stabil");

    assert.deepEqual(afterFirst, live,
        "rebuild wajib mereproduksi persis hasil jalur live");
    assert.deepEqual(afterSecond, afterFirst,
        "rekonsiliasi kedua tidak boleh mengubah apa pun (idempoten)");
});

test("C0.1/rebuild: lifecycle komitmen COMPLETED dibangun ulang lengkap dengan metadata", async () => {

    const { store, setFailing } = failingProjectionStore();
    const clock = acc.manualClock(1_000_000);
    const c1 = await makeCore(store, clock).initialize();

    setFailing(true);
    await seedLifecycle(c1, clock);

    assert.equal((await store.listCommitments()).length, 0,
        "prasyarat: semua projeksi gagal ditulis");

    // Canonical TIDAK lagi memuat komitmen yang sudah selesai —
    // hanya jurnal yang memuat lifecycle penuh.
    assert.equal(c1.state.commitments.active["rb-c-1"], undefined);
    assert.equal(c1.state.commitments.completedCount, 1);

    setFailing(false);
    const c2 = await makeCore(store, clock).initialize();

    const rows = await store.listCommitments();
    const done = rows.find(x => x.commitment_id === "rb-c-1");

    assert.ok(done, "komitmen selesai wajib hadir kembali di projeksi");
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.payload.statement, "selesaikan audit");
    assert.equal(done.payload.source, "USER_EXPLICIT");
    assert.equal(done.payload.status, "COMPLETED");
    assert.ok(done.payload.completedAt, "metadata completedAt wajib bertahan");
    assert.ok(done.payload.completionEventId,
        "metadata completionEventId wajib bertahan");

    assert.equal(c2.state.commitments.completedCount, 1);
});

test("C0.1/rebuild: lifecycle prediksi RESOLVED dibangun ulang lengkap dengan metadata", async () => {

    const { store, setFailing } = failingProjectionStore();
    const clock = acc.manualClock(1_000_000);
    const c1 = await makeCore(store, clock).initialize();

    setFailing(true);
    await seedLifecycle(c1, clock);

    assert.equal((await store.listPredictions()).length, 0);
    assert.equal(c1.state.predictions.open["rb-p-1"], undefined,
        "canonical sudah tidak memuat prediksi yang selesai");

    setFailing(false);
    await makeCore(store, clock).initialize();

    const projected = await store.getPrediction("rb-p-1");

    assert.ok(projected, "prediksi resolved wajib hadir kembali");
    assert.equal(projected.status, "RESOLVED_CORRECT");
    assert.equal(projected.payload.status, "RESOLVED_CORRECT");
    assert.equal(projected.payload.probability, 0.75);
    assert.equal(projected.payload.subject, "rebuild akan konsisten");
    assert.deepEqual(projected.payload.evidenceRefs, ["evt-rb-1"]);
    assert.ok(projected.payload.resolvedAt);
    assert.ok(projected.payload.resolutionEventId);
});

test("C0.1/rebuild: event yang di-IGNORE reducer tidak pernah menghasilkan baris projeksi", async () => {

    const { store, setFailing } = failingProjectionStore();
    const clock = acc.manualClock(1_000_000);
    const c1 = await makeCore(store, clock).initialize();

    setFailing(true);
    await seedLifecycle(c1, clock);

    setFailing(false);
    await makeCore(store, clock).initialize();

    const commitments = await store.listCommitments();
    const predictions = await store.listPredictions();
    const epochs = await store.listSubstrateEpochs();

    assert.equal(
        commitments.find(x => x.commitment_id === "rb-c-hantu"), undefined,
        "COMMITMENT_COMPLETED untuk id tak dikenal tidak boleh jadi projeksi");
    assert.equal(
        predictions.find(x => x.prediction_id === "rb-p-hantu"), undefined,
        "resolusi prediksi yang tidak pernah OPEN tidak boleh jadi projeksi");
    assert.equal(
        epochs.find(x => x.epoch_id === "evil-epoch"), undefined,
        "SUBSTRATE_CHANGED ber-provenance salah tidak boleh jadi projeksi");
});

test("C0.1/rebuild: significance pengalaman tetap nilai canonical yang di-clamp", async () => {

    const { store, setFailing } = failingProjectionStore();
    const clock = acc.manualClock(1_000_000);
    const c1 = await makeCore(store, clock).initialize();

    setFailing(true);
    await seedLifecycle(c1, clock);

    setFailing(false);
    const c2 = await makeCore(store, clock).initialize();

    const rows = await store.listExperiences();
    const exp = rows.find(x => x.experience_id === "rb-e-1");

    assert.ok(exp, "pengalaman signifikan wajib hadir kembali");
    assert.equal(exp.significance, 1,
        "significance projeksi = canonical yang sudah di-clamp, bukan 9.7 mentah");

    const canonical = c2.state.autobiography.recent
        .find(x => x.experienceId === "rb-e-1");

    assert.ok(canonical);
    assert.equal(exp.significance, canonical.significance,
        "projeksi dan canonical wajib menyebut angka yang sama");
});

test("C0.1/rebuild: riwayat substrat dibangun ulang urut dan lengkap", async () => {

    const { store, setFailing } = failingProjectionStore();
    const clock = acc.manualClock(1_000_000);
    const c1 = await makeCore(store, clock).initialize();

    setFailing(true);
    await seedLifecycle(c1, clock);

    assert.equal((await store.listSubstrateEpochs()).length, 0);

    const canonicalEpochs = c1.state.substrate.epochs.map(e => e.epochId);
    assert.equal(canonicalEpochs.length, 2,
        "prasyarat: dua perubahan substrat sah tercatat canonical");

    setFailing(false);
    await makeCore(store, clock).initialize();

    const rebuilt = await store.listSubstrateEpochs();

    assert.equal(rebuilt.length, 2,
        "kedua epoch substrat wajib hadir kembali");
    assert.deepEqual(rebuilt.map(r => r.epoch_id), canonicalEpochs,
        "urutan epoch hasil rebuild wajib sama dengan canonical");
    assert.equal(rebuilt[0].payload.descriptor.modelId, "ox-alpha");
    assert.equal(rebuilt[1].payload.descriptor.modelId, "ox-beta");
    for (const row of rebuilt) {
        assert.ok(row.payload.at, "metadata waktu epoch wajib bertahan");
        assert.ok(row.payload.eventId, "metadata eventId epoch wajib bertahan");
    }
});

test("C0.1/rebuild: watermark — boot bersih tidak merekonsiliasi, boot kotor merekonsiliasi", async () => {

    const { store, setFailing } = failingProjectionStore();
    const clock = acc.manualClock(1_000_000);
    const c1 = await makeCore(store, clock).initialize();

    setFailing(false);
    await seedLifecycle(c1, clock);

    const journalEnd = (await store.lastJournalRow()).seq;
    assert.equal(c1.projectionSeq, journalEnd,
        "jalur sehat: watermark mengikuti ujung jurnal");

    // Boot bersih: tidak ada pekerjaan rebuild.
    const c2 = makeCore(store, clock);
    let reconciled = 0;
    const realReconcile = c2.reconcileProjections.bind(c2);
    c2.reconcileProjections = async (...args) => {
        reconciled += 1;
        return realReconcile(...args);
    };
    await c2.initialize();
    assert.equal(reconciled, 0,
        "watermark sejajar ujung jurnal -> tidak perlu rebuild");

    // Boot kotor: projeksi gagal -> watermark tertinggal -> rebuild dipicu.
    setFailing(true);
    const dirty = await c2.feed(acc.envelope.makeEnvelope({
        type: "COMMITMENT_ADDED", source: "operator", provenance: "SYSTEM_EVENT",
        payload: {
            commitmentId: "wm-c-1", statement: "tandai kotor",
            source: "USER_EXPLICIT", priority: 0.3
        },
        clock
    }));

    assert.equal(dirty.applied, true);
    assert.equal(dirty.projection.dirty, true);

    const endAfterDirty = (await store.lastJournalRow()).seq;
    assert.ok(c2.projectionSeq < endAfterDirty,
        "watermark TIDAK boleh maju saat projeksi gagal");

    setFailing(false);
    const c3 = makeCore(store, clock);
    let rebuilt = 0;
    const realReconcile3 = c3.reconcileProjections.bind(c3);
    c3.reconcileProjections = async (...args) => {
        rebuilt += 1;
        return realReconcile3(...args);
    };
    await c3.initialize();

    assert.equal(rebuilt, 1, "watermark tertinggal -> rebuild dipicu tepat sekali");

    const repaired = (await store.listCommitments())
        .find(x => x.commitment_id === "wm-c-1");
    assert.ok(repaired, "projeksi kotor diperbaiki saat boot");
    assert.equal(repaired.status, "ACTIVE");
});
