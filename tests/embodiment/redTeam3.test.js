const test = require("node:test");
const assert = require("node:assert");

/**
 * RED-TEAM ROUND 3 — integritas baris durable penuh + kesehatan
 * bawaan-discovery.
 *
 * R3-B1  rowDigest mencakup SELURUH materi kanonik durable baris;
 *        presence/health divalidasi KETAT; legacy-omission ditangani
 *        eksplisit; SHA-256 tak berkunci = deteksi korupsi saja.
 * R3-B2  kesehatan pada DEVICE_DISCOVERED dihormati lewat healthWins
 *        yang sama dengan DEVICE_HEALTH_CHANGED — satu algoritma.
 */

const emb = require("../../src/embodiment");
const { digestOf } = require("../../src/embodiment/core/util");

const T0 = 1_000_000;
const MIC = "usb:1111:aaaa:mica";

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

/** Skema dengan perangkat online + kesehatan failing (durabel). */
function snapFailingOnline() {
    const body = makeSchema();
    fake(body, [[{ discover: [{ deviceId: MIC,
        deviceClass: "AUDIO_INPUT", displayName: "Mic",
        capabilities: ["audio.capture"] }] }]]);
    fake(body, [[{ health: { deviceId: MIC, status: "failing",
        detail: "sensor mati" } }]]);
    return body;
}

/* ================= R3-B1 — INTEGRITAS BARIS DURABLE ==================== */

test("R3-B1: godokan health failing→healthy tanpa digest baru → tolak", () => {

    const data = JSON.parse(JSON.stringify(snapFailingOnline().serialize()));
    const row = data.devices.find(d => d.descriptor.deviceId === MIC);
    assert.equal(row.health.status, "failing");

    row.health.status = "healthy";                    // TAMPER

    let threw = null;
    try {
        emb.BodySchema.restore(data, { clock: emb.manualClock(T0) });
    } catch (err) { threw = err; }
    assert.ok(threw, "harusnya ditolak");
    assert.equal(threw.code, "EMB_INVALID_SERIALIZATION");
    assert.ok(threw.details.some(d => /integritas/.test(d)), threw.details);
});

test("R3-B1b: godokan presence online→removed tanpa digest baru → tolak", () => {

    const data = JSON.parse(JSON.stringify(makeSchema().serialize()));
    fake((() => { const b = makeSchema(); return b; })(), []); // noop san

    // buat snapshot berisi perangkat sungguhan:
    const src = makeSchema();
    fake(src, [[{ discover: [{ deviceId: MIC,
        deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);
    const d2 = JSON.parse(JSON.stringify(src.serialize()));
    d2.devices.find(x => x.descriptor.deviceId === MIC).presence.state = "removed";

    let threw = null;
    try { emb.BodySchema.restore(d2, { clock: emb.manualClock(T0) }); }
    catch (err) { threw = err; }
    assert.ok(threw);
    assert.equal(threw.code, "EMB_INVALID_SERIALIZATION");
});

test("R3-B1c: nilai semantik-invalid tetap ditolak walau rowDigest dihitung ulang", () => {

    const data = JSON.parse(JSON.stringify(snapFailingOnline().serialize()));
    const row = data.devices.find(d => d.descriptor.deviceId === MIC);

    // penyerang mengganti status jadi tak-valid lalu MENGHITUNG ULANG digest:
    row.health.status = "kebal-semua";
    row.rowDigest = digestOf({
        descriptor: row.descriptor,
        meta: row.meta,
        presence: row.presence,
        health: row.health,
        capabilities: row.capabilities,
        firstSeenAtMs: row.firstSeenAtMs,
        lastSeenAtMs: row.lastSeenAtMs
    });

    let threw = null;
    try { emb.BodySchema.restore(data, { clock: emb.manualClock(T0) }); }
    catch (err) { threw = err; }
    assert.ok(threw, "validator wajib berjalan independen dari digest");
    assert.equal(threw.code, "EMB_INVALID_SERIALIZATION");
    assert.ok(threw.details.some(d => /health\.status/.test(d)), threw.details);
});

test("R3-B1d: field presence/health salah-satu-sah ditolak ketat (tanpa fallback)", () => {

    const base = JSON.parse(JSON.stringify(snapFailingOnline().serialize()));
    const row = () => JSON.parse(JSON.stringify(base))
        .devices.find(d => d.descriptor.deviceId === MIC);

    const cases = [
        ["presence.state asing", (r) => { r.presence.state = "melayang"; }],
        ["presence.confidence teks", (r) => { r.presence.confidence = "tinggi"; }],
        ["presence.confidence > 1", (r) => { r.presence.confidence = 5; }],
        ["presence.timestampMs pecahan", (r) => { r.presence.timestampMs = 1.5; }],
        ["presence.source kosong", (r) => { r.presence.source = ""; }],
        ["health.status tak-enum", (r) => { r.health.status = "meledak"; }],
        ["health.checkedAtMs string", (r) => { r.health.checkedAtMs = "kemarin"; }],
        ["health.source kosong", (r) => { r.health.source = ""; }],
        ["health.detail non-string", (r) => { r.health.detail = 42; }],
        ["checkedAt tanpa checkedAtMs", (r) => { r.health.checkedAtMs = null;
            r.health.checkedAt = new Date().toISOString(); }],
    ];
    for (const [nama, mutate] of cases) {
        const data = JSON.parse(JSON.stringify(base));
        mutate(data.devices.find(d => d.descriptor.deviceId === MIC));
        let threw = null;
        try { emb.BodySchema.restore(data, { clock: emb.manualClock(T0) }); }
        catch (err) { threw = err; }
        assert.ok(threw, `${nama}: harusnya ditolak`);
        assert.equal(threw.code, "EMB_INVALID_SERIALIZATION",
            `${nama}: seluruh snapshot ditolak`);
        assert.ok(
            threw.details.some(d => /EMB_INVALID_(PRESENCE|HEALTH)/.test(d)),
            `${nama}: diagnostik wajib menyebut validator presence/health — ${threw.details}`);
    }
});

test("R3-B1e: legacy tanpa presence/health/rowDigest → rekonstruksi deterministik", () => {

    const src = snapFailingOnline();
    const data = JSON.parse(JSON.stringify(src.serialize()));
    const row = data.devices.find(d => d.descriptor.deviceId === MIC);

    // snapshot LEGACY: benar-benar MENGABAIKAN field baru (omission, bukan
    // nilai salah):
    delete row.presence;
    delete row.health;
    delete row.rowDigest;

    const restored = emb.BodySchema.restore(data, { clock: emb.manualClock(T0) });

    // langsung terserialisasi ke format kanonik saat ini:
    const canonical = restored.serialize();
    const crow = canonical.devices.find(d => d.descriptor.deviceId === MIC);
    assert.equal(typeof crow.rowDigest, "string");
    assert.ok("presence" in crow && "health" in crow);
    // rekonstruksi legacy deterministik dari meta+state deskriptor:
    assert.deepEqual(crow.presence, {
        state: "online",
        timestampMs: crow.meta.timestampMs,
        confidence: crow.meta.confidence,
        source: crow.meta.source
    });
    assert.deepEqual(crow.health, {
        status: "unknown", detail: null,
        checkedAt: null, checkedAtMs: null, source: null
    });

    // dua kali restore → serialisasi identik (deterministik):
    const again = emb.BodySchema.restore(
        JSON.parse(JSON.stringify(canonical)), { clock: emb.manualClock(T0) });
    assert.deepEqual(again.serialize(), canonical);

    // dan integritas kanonik sekarang aktif: godokan pasca-legacy ditolak.
    const tampered = JSON.parse(JSON.stringify(canonical));
    tampered.devices.find(d => d.descriptor.deviceId === MIC)
        .health.status = "healthy";
    assert.throws(() => emb.BodySchema.restore(tampered,
        { clock: emb.manualClock(T0) }),
    (e) => e.code === "EMB_INVALID_SERIALIZATION");
});

test("R3-B1f: paritas penuh failing-device lintas persist/restore", () => {

    const a = snapFailingOnline();
    const b = emb.BodySchema.restore(
        JSON.parse(JSON.stringify(a.serialize())),
        { clock: emb.manualClock(T0) });
    assert.deepEqual(b.serialize(), a.serialize());
    assert.equal(b.getDevice(MIC).descriptor.health.status, "failing");
    assert.equal(b.digestDurable(), a.digestDurable());
});

/* ========== R3-B2 — KESEHATAN BAWAAN-DISCOVERY DIHORMATI =============== */

test("R3-B2a: perangkat BARU dengan health=failing langsung dipercaya", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [{
        deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Mic",
        health: { status: "failing", detail: "mati total" }
    }] }]]);

    assert.equal(body.counts().deadLetters, 0);
    const v = body.getDevice(MIC);
    assert.equal(v.descriptor.health.status, "failing");
    assert.equal(v.descriptor.health.detail, "mati total");

    const summary = emb.getEmbodimentSummary(body);
    assert.ok(summary.health.failedDevices.includes(MIC),
        "ringkasan wajib mencerminkan kesehatan bawaan-discovery");
});

test("R3-B2b: discovery pemenang-konten TANPA health tidak menghapus failing", () => {

    const body = makeSchema();
    // perangkat baru dengan kesehatan bawaan-discovery:
    fake(body, [[{ confidence: 0.4, discover: [{
        deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Low",
        health: { status: "failing" }
    }] }]]);
    assert.equal(body.getDevice(MIC).descriptor.health.status, "failing");

    // discovery berikutnya MENANG konten (confidence lebih tinggi) tetapi
    // TIDAK menyertakan laporan kesehatan → failing wajib selamat:
    fake(body, [[{ confidence: 0.9, discover: [{
        deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "High"
    }] }]]);

    const v = body.getDevice(MIC);
    assert.equal(v.descriptor.displayName, "High",
        "konten milik confidence tertinggi");
    assert.equal(v.descriptor.health.status, "failing",
        "ketiadaan laporan kesehatan bukan laporan 'unknown'");
    assert.equal(emb.getEmbodimentSummary(body).health.failedDevices
        .includes(MIC), true);
});

test("R3-B2c: rediscovery bawaan-health lewat healthWins yang sama (permutasi)", () => {

    const build = (order) => {
        const body = makeSchema();
        fake(body, [[{ discover: [{ deviceId: MIC,
            deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);

        const rediscoverHealthyLama = emb.makeEvent({
            type: "DEVICE_DISCOVERED", source: "fake.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { descriptor: {
                deviceId: MIC, deviceClass: "AUDIO_INPUT",
                displayName: "Rediscover",
                health: { status: "healthy" } } },
            confidence: 1,                       // menang KONTEN
            clock: emb.manualClock(T0 + 100) }); // tapi kesehatannya LAMA

        const failBaru = emb.makeEvent({
            type: "DEVICE_HEALTH_CHANGED", source: "fake.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { health: { status: "degraded" } },
            clock: emb.manualClock(T0 + 300) }); // kesehatan LEBIH BARU

        for (const e of order(rediscoverHealthyLama, failBaru)) {
            body.ingest(e);
        }
        return body;
    };

    for (const body of [
        build((h, f) => [h, f]),
        build((h, f) => [f, h]),
    ]) {
        const v = body.getDevice(MIC);
        assert.equal(v.descriptor.displayName, "Rediscover",
            "konten milik confidence tertinggi");
        assert.equal(v.descriptor.health.status, "degraded",
            "kesehatan terbaru menang walau pembawanya kalah konten");
    }

    // rediscovery membawa kesehatan LEBIH BARU → menang atas event lama:
    const build2 = (order) => {
        const body = makeSchema();
        fake(body, [[{ discover: [{ deviceId: MIC,
            deviceClass: "AUDIO_INPUT", displayName: "Mic" },
        ], health: undefined }], [
            { health: { deviceId: MIC, status: "failing" } }
        ]]);

        const rediscoverSehatBaru = emb.makeEvent({
            type: "DEVICE_DISCOVERED", source: "fake.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { descriptor: {
                deviceId: MIC, deviceClass: "AUDIO_INPUT",
                displayName: "Sehat Lagi",
                health: { status: "healthy" } } },
            confidence: 1,
            clock: emb.manualClock(T0 + 500) });   // PEMULIHAN TERBARU

        void order;
        body.ingest(rediscoverSehatBaru);
        return body;
    };

    for (const body of [build2(0), build2(1)]) {
        assert.equal(body.getDevice(MIC).descriptor.health.status, "healthy",
            "pemulihan via discovery lebih baru wajib menang");
    }

    // dan konvergen bebas urutan lawan DEVICE_HEALTH_CHANGED lama:
    const perm = (order) => {
        const body = makeSchema();
        fake(body, [[{ discover: [{ deviceId: MIC,
            deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);
        const failOld = emb.makeEvent({
            type: "DEVICE_HEALTH_CHANGED", source: "fake.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { health: { status: "failing" } },
            clock: emb.manualClock(T0 + 100) });
        const discHealthyNew = emb.makeEvent({
            type: "DEVICE_DISCOVERED", source: "fake.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { descriptor: { deviceId: MIC,
                deviceClass: "AUDIO_INPUT", displayName: "Baik",
                health: { status: "healthy" } } },
            confidence: 1,
            clock: emb.manualClock(T0 + 400) });
        for (const e of order(failOld, discHealthyNew)) body.ingest(e);
        return body;
    };
    const q1 = perm((a, b) => [a, b]);
    const q2 = perm((a, b) => [b, a]);
    for (const q of [q1, q2]) {
        assert.equal(q.getDevice(MIC).descriptor.health.status, "healthy");
    }
    assert.equal(q1.digestDurable(), q2.digestDurable());
});
