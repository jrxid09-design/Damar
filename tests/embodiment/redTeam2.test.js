const test = require("node:test");
const assert = require("node:assert");

/**
 * RED-TEAM ROUND 2 — restore/presence, konvergensi firstSeen,
 * kesehatan kanonik berurutan, dan buta-titik tes.
 *
 * R2-B1  restore menghasilkan record LENGKAP (presence+health) dan
 *        komit atomik secara STRUKTURAL (klon-swap).
 * R2-B2  firstSeenAtMs konvergen secara TEMPORAL (min/max), bukan
 *        urutan kedatangan.
 * R2-B3  kesehatan = field kanonik terpisah dengan urutan totalnya;
 *        konten pemenang tidak pernah menghapus observasi kesehatan.
 * R2-B4  mutasi NYATA pada skema hasil restore (bukan sekadar inspeksi).
 */

const emb = require("../../src/embodiment");

const T0 = 1_000_000;
const MIC = "usb:1111:aaaa:mica";
const HOST = "host.os:kantor";

function makeSchema() {
    return emb.createBodySchema({ clock: emb.manualClock(T0) });
}

function fake(schema, script, id = "fake.discovery") {
    schema.registerProducer(id);
    const adapter = emb.createFakeDiscoveryAdapter({ id, script });
    const results = [];
    for (let i = 0; i < script.length; i++) {
        results.push(...emb.runDiscoveryCycle(schema, adapter));
        schema.clock.advance(1);
    }
    return results;
}

/* ============ R2-B1 — RESTORE LENGKAP + KOMIT PASCA-RESTORE ============ */

test("R2-B1: rantai penuh persist→restore→mutasi→persist→restore", async () => {

    const store = emb.createMemoryBodyStore();

    // 1) skema hidup → persist:
    const a = makeSchema();
    a.store = store;
    fake(a, [[{ discover: [
        { deviceId: HOST, deviceClass: "HOST", displayName: "kantor" },
        { deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Mic USB",
          capabilities: ["audio.capture"],
          relationships: [{ type: "attached_to", fromId: MIC, toId: HOST }] }
    ] }]]);
    await a.persist();

    // 2) batas JSON nyata → restore:
    const b = emb.BodySchema.restore(
        JSON.parse(JSON.stringify(await store.load())),
        { clock: emb.manualClock(T0 + 1000) });

    // 3) MUTASI NYATA pada skema hasil restore:
    bodyMutations(b);

    // 4) persist lagi → restore lagi:
    b.store = store;
    await b.persist();
    const c = emb.BodySchema.restore(
        JSON.parse(JSON.stringify(await store.load())),
        { clock: emb.manualClock(T0 + 2000) });

    assert.equal(c.getDevice(MIC).descriptor.state, "offline",
        "presence hasil restore harus berfungsi untuk event berikutnya");
    assert.ok(c.devicesWithCapability("device.health.read")
        .some(d => d.descriptor.deviceId === HOST),
        "klaim pasca-restore harus bertahan");
    assert.deepEqual(c.serialize(), b.serialize(),
        "round-trip kedua wajib identik");

    // 5) event DITOLAK pada skema hasil restore → nol mutasi byte-identik:
    const before = JSON.stringify(c.serialize());
    const r = c.ingest(emb.makeEvent({
        type: "DEVICE_ONLINE", source: "fake.discovery",
        provenance: "OBSERVATION", subject: "usb:dead:beef:hantu",
        payload: {}, clock: c.clock }));
    assert.equal(r.accepted, false);
    assert.equal(JSON.stringify(c.serialize()), before,
        "penolakan pasca-restore wajib byte-identik");
});

/** Rangkaian mutasi nyata pada skema apa pun yang memuat MIC+HOST. */
function bodyMutations(body) {
    // rediscovery lebih dulu (menyiratkan kehadiran):
    const r2 = body.ingest(emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "fake.discovery",
        provenance: "SYSTEM_SENSOR", subject: MIC,
        payload: { descriptor: { deviceId: MIC, deviceClass: "AUDIO_INPUT",
            displayName: "Mic USB (revisi)" } },
        confidence: 0.7, clock: emb.manualClock(T0 + 1200) }));
    assert.equal(r2.accepted, true, `rediscover: ${r2.reason ?? ""}`);

    // lalu OFFLINE LEBIH BARU — harus menang presence dan bertahan
    // melalui persist/restore berikutnya:
    const r1 = body.ingest(emb.makeEvent({
        type: "DEVICE_OFFLINE", source: "fake.discovery",
        provenance: "OBSERVATION", subject: MIC,
        payload: {}, confidence: 0.8, clock: emb.manualClock(T0 + 1300) }));
    assert.equal(r1.accepted, true, `offline: ${r1.reason ?? ""}`);

    const r3 = body.ingest(emb.makeEvent({
        type: "CAPABILITY_DISCOVERED", source: "fake.discovery",
        provenance: "SYSTEM_SENSOR", subject: HOST,
        payload: { capability: { name: "device.health.read", confidence: 0.9,
            source: "fake.discovery" } },
        clock: emb.manualClock(T0 + 1400) }));
    assert.equal(r3.accepted, true, `claim: ${r3.reason ?? ""}`);
}

test("R2-B1b: atomisitas struktural — relasi hantu di skema restored nol mutasi", () => {

    const a = makeSchema();
    fake(a, [[{ discover: [
        { deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Mic" }
    ] }]]);
    const b = emb.BodySchema.restore(
        JSON.parse(JSON.stringify(a.serialize())),
        { clock: emb.manualClock(T0 + 500) });
    b.registerProducer("p.discovery");

    const before = JSON.stringify(b.serialize());
    const r = b.ingest(emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "p.discovery",
        provenance: "SYSTEM_SENSOR", subject: "usb:2222:bbbb:kamera",
        payload: {
            descriptor: { deviceId: "usb:2222:bbbb:kamera",
                deviceClass: "CAMERA", displayName: "K" },
            relationships: [{ type: "attached_to",
                fromId: "usb:2222:bbbb:kamera", toId: "host.os:ngasal" }]
        },
        clock: b.clock }));

    assert.equal(r.accepted, false);
    assert.equal(JSON.stringify(b.serialize()), before,
        "komit struktural wajib meninggalkan state utuh saat gagal");
});

/* ============ R2-B2 — FIRSTSEEN KONVERGEN TEMPORAL ===================== */

test("R2-B2: dua penemuan beda-waktu — kedua permutasi konvergen penuh", () => {

    const build = (order) => {
        const body = makeSchema();
        body.registerProducer("p.discovery");
        const mk = (name, atMs, conf, state) => emb.makeEvent({
            type: "DEVICE_DISCOVERED", source: "p.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            confidence: conf,
            payload: { descriptor: {
                deviceId: MIC, deviceClass: "AUDIO_INPUT",
                displayName: name, ...(state ? { state } : {}) } },
            clock: emb.manualClock(atMs) });

        const dini  = mk("Nama Dini", T0 - 700, 0.4);          // lebih tua
        const akhir = mk("Nama Akhir", T0 + 900, 0.95, "online"); // lebih baru

        for (const e of order(dini, akhir)) body.ingest(e);
        return body;
    };

    const x = build((a, b) => [a, b]);
    const y = build((a, b) => [b, a]);

    for (const s of [x, y]) {
        const v = s.getDevice(MIC);
        assert.equal(v.firstSeenAtMs, T0 - 700,
            "firstSeen = observasi TERtua (min), bebas urutan");
        assert.equal(v.lastSeenAtMs, T0 + 900,
            "lastSeen = observasi TERbaru (max)");
        assert.equal(v.descriptor.displayName, "Nama Akhir",
            "konten tetap milik pemenang confidence tertinggi");
    }
    assert.deepEqual(y.serialize(), x.serialize());
    assert.equal(x.digestDurable(), y.digestDurable());
});

test("R2-B2b: stempel waktu sama persis — tetap konvergen", () => {

    const build = (order) => {
        const body = makeSchema();
        body.registerProducer("p.discovery");
        const mk = (name) => () => emb.makeEvent({
            type: "DEVICE_DISCOVERED", source: "p.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { descriptor: { deviceId: MIC,
                deviceClass: "AUDIO_INPUT", displayName: name } },
            clock: emb.manualClock(T0) });       // IDENTIK
        for (const e of order(mk)) body.ingest(e());
        return body;
    };

    const x = build((mk) => [mk("Satu"), mk("Dua")]);
    const y = build((mk) => [mk("Dua"), mk("Satu")]);
    void x; void y;

    assert.equal(x.digestDurable(), y.digestDurable());
    assert.deepEqual(y.serialize(), x.serialize());
});

/* ====== R2-B3 — KESEHATAN KANONIK BERURUTAN, ANTI-HAPUS-KONTEN ======== */

test("R2-B3: kesehatan selamat dari semua permutasi konten pemenang", () => {

    const variants = [];
    for (const seq of [
        ["low", "fail", "high"],
        ["low", "high", "fail"],
        ["fail-first"],                       // health dulu → discovery disemai dulu
    ]) {
        const body = makeSchema();
        body.registerProducer("p.discovery");

        const disc = (name, atMs, conf) => emb.makeEvent({
            type: "DEVICE_DISCOVERED", source: "p.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            confidence: conf,
            payload: { descriptor: { deviceId: MIC, deviceClass: "AUDIO_INPUT",
                displayName: name } },
            clock: emb.manualClock(atMs) });
        const failEv = () => emb.makeEvent({
            type: "DEVICE_HEALTH_CHANGED", source: "p.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { health: { status: "failing", detail: "sensor mati" } },
            clock: emb.manualClock(T0 + 200) });

        if (seq[0] === "fail-first") {
            // semai dengan discovery TERLAMA agar health sah:
            body.ingest(disc("Low", T0 + 100, 0.3));
            body.ingest(failEv());
            body.ingest(disc("High", T0 + 300, 0.95));
        } else if (seq[1] === "high") {
            body.ingest(disc("Low", T0 + 100, 0.3));
            body.ingest(disc("High", T0 + 300, 0.95));
            body.ingest(failEv());
        } else {
            body.ingest(disc("Low", T0 + 100, 0.3));
            body.ingest(failEv());
            body.ingest(disc("High", T0 + 300, 0.95));
        }
        variants.push(body);
    }

    const baseline = JSON.stringify(variants[0].serialize());
    for (const v of variants) {
        const view = v.getDevice(MIC);
        // konten pemenang = confidence 0.95:
        assert.equal(view.descriptor.displayName, "High");
        // kesehatan SELAMAT dari penimpaan konten:
        assert.equal(view.descriptor.health.status, "failing");
        assert.equal(view.descriptor.health.detail, "sensor mati");
        assert.deepEqual(JSON.stringify(v.serialize()), baseline,
            "seluruh permutasi wajib identik byte-untuk-byte");
        assert.equal(v.digestDurable(), variants[0].digestDurable());

        const summary = emb.getEmbodimentSummary(v);
        assert.deepEqual(summary.health.failedDevices, [MIC]);
    }

    // proyeksi konsisten: record.health → descriptor.health
    const restored = emb.BodySchema.restore(
        JSON.parse(JSON.stringify(variants[0].serialize())),
        { clock: emb.manualClock(T0 + 999) });
    assert.deepEqual(restored.serialize(), variants[0].serialize(),
        "presence+health wajib ikut terserialisasi dan pulih utuh");
});

test("R2-B3b: degradasi→pemulihan konvergen di kedua arah kedatangan", () => {

    const build = (order) => {
        const body = makeSchema();
        fake(body, [[{ discover: [{ deviceId: MIC,
            deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);
        const fail = emb.makeEvent({
            type: "DEVICE_HEALTH_CHANGED", source: "fake.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { health: { status: "failing" } },
            clock: emb.manualClock(T0 + 200) });
        const heal = emb.makeEvent({
            type: "DEVICE_HEALTH_CHANGED", source: "fake.discovery",
            provenance: "OBSERVATION", subject: MIC,
            payload: { health: { status: "healthy" } },
            clock: emb.manualClock(T0 + 500) });   // PEMULIHAN LEBIH BARU
        for (const e of order(fail, heal)) body.ingest(e);
        return body;
    };

    for (const body of [build((f, h) => [f, h]), build((f, h) => [h, f])]) {
        assert.equal(body.getDevice(MIC).descriptor.health.status, "healthy",
            "pemulihan terbaru menang walau datang belakangan/atram");
    }

    // kebalikan: pemulihan LAMA tidak bisa menimpa kegagalan SEGAR:
    const buildOldRecovery = (order) => {
        const body = makeSchema();
        fake(body, [[{ discover: [{ deviceId: MIC,
            deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);
        const oldHeal = emb.makeEvent({
            type: "DEVICE_HEALTH_CHANGED", source: "fake.discovery",
            provenance: "OBSERVATION", subject: MIC,
            payload: { health: { status: "healthy" } },
            clock: emb.manualClock(T0 + 100) });
        const freshFail = emb.makeEvent({
            type: "DEVICE_HEALTH_CHANGED", source: "fake.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { health: { status: "degraded" } },
            clock: emb.manualClock(T0 + 400) });
        for (const e of order(oldHeal, freshFail)) body.ingest(e);
        return body;
    };
    for (const body of [
        buildOldRecovery((a, b) => [a, b]),
        buildOldRecovery((a, b) => [b, a]),
    ]) {
        assert.equal(body.getDevice(MIC).descriptor.health.status, "degraded");
    }
});

/* ================= R2-B4 — TUTUP BUTA-TITIK TES ======================== */

test("R2-B4c: ingest sesudah restore sepenuhnya fungsional (A+B+C)", () => {

    const a = makeSchema();
    fake(a, [[{ discover: [{ deviceId: MIC,
        deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);
    const b = emb.BodySchema.restore(
        JSON.parse(JSON.stringify(a.serialize())),
        { clock: emb.manualClock(T0 + 50) });

    // A) offline → online bolak-balik pada skema restored:
    b.ingest(emb.makeEvent({ type: "DEVICE_OFFLINE", source: "fake.discovery",
        provenance: "OBSERVATION", subject: MIC, payload: {},
        clock: emb.manualClock(T0 + 60) }));
    assert.equal(b.getDevice(MIC).descriptor.state, "offline");
    b.ingest(emb.makeEvent({ type: "DEVICE_ONLINE", source: "fake.discovery",
        provenance: "OBSERVATION", subject: MIC, payload: {},
        clock: emb.manualClock(T0 + 70) }));
    assert.equal(b.getDevice(MIC).descriptor.state, "online");

    // B) dua discovery beda waktu, dua permutasi kedatangan:
    const two = (order) => {
        // seed dengan confidence RENDAH supaya pemenang konten jelas:
        const seeded = makeSchema();
        seeded.registerProducer("q.discovery");
        seeded.ingest(emb.makeEvent({ type: "DEVICE_DISCOVERED",
            source: "q.discovery", provenance: "SYSTEM_SENSOR", subject: MIC,
            confidence: 0.2,
            payload: { descriptor: { deviceId: MIC, deviceClass: "AUDIO_INPUT",
                displayName: "Seed" } }, clock: emb.manualClock(T0 + 1) }));
        const s = emb.BodySchema.restore(
            JSON.parse(JSON.stringify(seeded.serialize())),
            { clock: emb.manualClock(T0) });
        s.registerProducer("q.discovery");
        const e1 = emb.makeEvent({ type: "DEVICE_DISCOVERED",
            source: "q.discovery", provenance: "SYSTEM_SENSOR", subject: MIC,
            confidence: 0.6,
            payload: { descriptor: { deviceId: MIC, deviceClass: "AUDIO_INPUT",
                displayName: "E1" } }, clock: emb.manualClock(T0 + 10) });
        const e2 = emb.makeEvent({ type: "DEVICE_DISCOVERED",
            source: "q.discovery", provenance: "SYSTEM_SENSOR", subject: MIC,
            confidence: 0.8,
            payload: { descriptor: { deviceId: MIC, deviceClass: "AUDIO_INPUT",
                displayName: "E2" } }, clock: emb.manualClock(T0 + 20) });
        for (const e of order(e1, e2)) s.ingest(e);
        return s;
    };
    const p1 = two((x, y) => [x, y]), p2 = two((x, y) => [y, x]);
    assert.equal(p1.digestDurable(), p2.digestDurable());
    assert.equal(p1.getDevice(MIC).descriptor.displayName, "E2");
    assert.equal(p1.getDevice(MIC).lastSeenAtMs, T0 + 20);
    assert.equal(p1.getDevice(MIC).firstSeenAtMs, T0 + 1,
        "firstSeen min mencakup observasi pra-restore (seed)");
    void p2;

    // C) kesehatan dipermutasi lawan konten pada skema restored:
    const hc = (atMs, status) => emb.makeEvent({
        type: "DEVICE_HEALTH_CHANGED", source: "fake.discovery",
        provenance: "OBSERVATION", subject: MIC,
        payload: { health: { status } }, clock: emb.manualClock(atMs) });
    const discHi = emb.makeEvent({ type: "DEVICE_DISCOVERED",
        source: "fake.discovery", provenance: "SYSTEM_SENSOR", subject: MIC,
        confidence: 1,   // sama dgn seed → waktu terbaru yang menentukan
        payload: { descriptor: { deviceId: MIC, deviceClass: "AUDIO_INPUT",
            displayName: "Hi" } }, clock: emb.manualClock(T0 + 90) });

    const m1 = emb.BodySchema.restore(JSON.parse(JSON.stringify(a.serialize())),
        { clock: emb.manualClock(T0) });
    m1.ingest(hc(T0 + 80, "degraded"));
    m1.ingest(discHi);

    const m2 = emb.BodySchema.restore(JSON.parse(JSON.stringify(a.serialize())),
        { clock: emb.manualClock(T0) });
    m2.ingest(discHi);
    m2.ingest(hc(T0 + 80, "degraded"));

    for (const m of [m1, m2]) {
        assert.equal(m.getDevice(MIC).descriptor.displayName, "Hi");
        assert.equal(m.getDevice(MIC).descriptor.health.status, "degraded",
            "kesehatan tidak boleh terhapus oleh konten pemenang");
    }
    assert.equal(m1.digestDurable(), m2.digestDurable());
});

/* ========== ITEM ADJASEN — SAMPEL OBSERVASI ANTI-MUTASI-PEMANGGIL ====== */

test("adjasen: sampel observasi dilepas & dibekukan — pemanggil tak bisa merusak", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [{ deviceId: MIC,
        deviceClass: "AUDIO_INPUT", displayName: "Mic",
        capabilities: ["audio.capture"] }] }]]);

    const sample = { rms: 0.42, meta: { deep: true } };
    const obs = emb.makeEvent({
        type: "SENSOR_OBSERVATION", source: "fake.discovery",
        provenance: "SYSTEM_SENSOR", subject: MIC,
        payload: { channel: { id: "audio.capture" }, sample },
        clock: body.clock });
    assert.ok(body.ingest(obs).accepted);

    // pemanggil memutasi objek sampel ASLINYA SETELAH ingest:
    sample.rms = 999;
    sample.meta.deep = false;

    const ring = body.getChannelObservations("audio.capture");
    assert.equal(ring.length, 1);
    assert.equal(ring[0].sample.rms, 0.42, "cincin kebal mutasi eksternal");
    assert.equal(ring[0].sample.meta.deep, true);
    assert.equal(Object.isFrozen(ring[0].sample), true);
});
