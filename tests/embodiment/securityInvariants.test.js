const test = require("node:test");
const assert = require("node:assert");

/**
 * INVARIAN KEAMANAN & ARSITEKTUR V0 (A–G) + persistensi (B0.31–B0.35).
 *
 * Invariant yang DIBUKTIKAN di sini:
 *   A. Menemukan perangkat keras tidak pernah memberi otoritas.
 *   B. Model tidak bisa menciptakan perangkat fisik lewat teks.
 *   C. Model tidak bisa memutasi BodySchema kanonik secara langsung.
 *   D. Kemampuan = fakta/klaim observasi + provenance, BUKAN izin.
 *   E. Perangkat unknown tetap unknown sampai ada bukti klasifikasi.
 *   F. Observasi sensor tidak pernah memicu aktuasi di V0.
 *   G. BodySchema hidup tanpa Console / LLM / database.
 */

const emb = require("../../src/embodiment");

const T0 = 1_000_000;
const MIC = "usb:1111:aaaa:mica";

function makeSchema() {
    return emb.createBodySchema({ clock: emb.manualClock(T0) });
}

function fake(schema, script, id = "fake.discovery") {
    // Registrasi produsen = tindakan operator (kontrak B§5a):
    schema.registerProducer(id);
    // Tiap siklus memajukan jam 1ms agar urutan temporal antar-langkah nyata.
    const adapter = emb.createFakeDiscoveryAdapter({ id, script });
    const results = [];
    for (let i = 0; i < script.length; i++) {
        results.push(...emb.runDiscoveryCycle(schema, adapter));
        schema.clock.advance(1);
    }
    return results;
}

test("INVARIANT A + B0.31: penemuan tidak membawa otoritas — bentuk data melarangnya", () => {

    const body = makeSchema();
    body.registerProducer("fake.discovery");

    // Coba selundupkan field otoritas ke deskriptor — whitelist menolak:
    for (const field of ["authority", "grants", "allowed", "permission",
        "authorized", "acl"]) {
        const r = body.ingest(emb.makeEvent({
            type: "DEVICE_DISCOVERED", source: "fake.discovery",
            provenance: "SYSTEM_SENSOR", subject: MIC,
            payload: { descriptor: {
                deviceId: MIC, deviceClass: "AUDIO_INPUT",
                displayName: "Mic",
                [field]: { "audio.capture": true }     // "boleh pakai aku"
            } }, clock: body.clock
        }));
        assert.equal(r.accepted, false,
            `field '${field}' tidak boleh lolos`);
        assert.match(r.reason, /UNKNOWN_DESCRIPTOR_FIELD/);
    }

    // dan permukaan API tidak punya pintu pemberian kuasa:
    for (const name of Object.keys(emb)) {
        assert.ok(!/grant|authorize|permit/i.test(name), name);
    }
});

test("INVARIANT B: teks model tidak bisa menciptakan perangkat", () => {

    const body = makeSchema();
    // model berperan sebagai produsen tak terdaftar:
    body.registerProducer("fake.discovery");   // hanya adapter sah

    // 1) DEVICE_DISCOVERED dari sumber tak terdaftar → dead-letter:
    const purifikasi = body.ingest({
        eventId: "e1", schemaVersion: 1, type: "DEVICE_DISCOVERED",
        timestamp: new Date(T0).toISOString(), timestampMs: T0,
        monotonic: 999, source: "model.bahasa",        // <-- si model
        provenance: "OBSERVATION", subject: MIC,
        confidence: 1,
        payload: { descriptor: {
            deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Mic khayalan"
        } }
    });
    assert.equal(purifikasi.accepted, false);
    assert.equal(body.getDevice(MIC), null);

    // 2) event kehadiran untuk perangkat yang belum ditemukan → ditolak:
    body.registerProducer("fake.discovery2");
    const hantu = body.ingest(emb.makeEvent({
        type: "DEVICE_ONLINE", source: "fake.discovery2",
        provenance: "OBSERVATION", subject: "usb:dead:beef:ghost",
        payload: {}, clock: body.clock
    }));
    assert.equal(hantu.accepted, false);
    assert.equal(body.counts().devices, 0);

    // 3) DEVICE_CHANGED untuk perangkat asing juga ditolak:
    const body2 = makeSchema();
    body2.registerProducer("fake.discovery");
    const changed = body2.ingest(emb.makeEvent({
        type: "DEVICE_CHANGED", source: "fake.discovery",
        provenance: "OBSERVATION", subject: MIC,
        payload: { descriptor: {
            deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "X"
        } }, clock: body2.clock
    }));
    assert.equal(changed.accepted, false);
});

test("INVARIANT C: snapshot & view beku — tidak ada jalur tulis referensial", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [
        { deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Mic",
          capabilities: ["audio.capture"] }
    ] }]]);

    const view = body.getDevice(MIC);
    assert.equal(Object.isFrozen(view.descriptor), true);
    assert.throws(() => {
        "use strict";
        view.descriptor.displayName = "diretas";
    }, TypeError);

    const snap = body.snapshot();
    assert.throws(() => {
        "use strict";
        snap.devices[0].descriptor.deviceClass = "CAMERA";
    }, TypeError);
    assert.equal(body.getDevice(MIC).descriptor.deviceClass, "AUDIO_INPUT");

    // proyeksi self-model juga beku & read-only:
    const summary = emb.getEmbodimentSummary(body);
    assert.throws(() => {
        "use strict";
        summary.hearing.availableInputs = 99;
    }, TypeError);

    // dan tidak ada metode eksekusi/mutasi pada skema:
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(body))) {
        assert.ok(!/^actuate|execute|invoke|control/.test(key), key);
    }
});

test("INVARIANT D + B0.32: klaim kemampuan adalah fakta+provenance, bukan izin", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [
        { deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Mic" }
    ] }], [{ capability: { deviceId: MIC, claim: {
        name: "audio.capture", confidence: 0.9, source: "windows.audio"
    } } }]]);

    const claim = body.getDevice(MIC).capabilities.find(
        c => c.name === "audio.capture");

    // klaim menyimpan EVIDENSI:
    assert.equal(claim.source, "windows.audio");
    assert.equal(claim.confidence, 0.9);

    // klaim TIDAK bisa membawa keputusan akses:
    assert.ok(!("grants" in claim));
    assert.ok(!("allowedBy" in claim));

    // confidence dibatasi [0..1] — "super claim" dinormalisasi clamp01:
    const r = fake(body, [[{ capability: { deviceId: MIC, claim: {
        name: "audio.capture", confidence: 999
    } } }]]);
    assert.equal(r[0].accepted, true,
        "klaim sah dengan confidence 999 harus diterima (dinormalisasi)");
    const after = body.getDevice(MIC).capabilities.find(
        c => c.name === "audio.capture");
    assert.ok(after.confidence >= 0 && after.confidence <= 1,
        "confidence wajib terkurung [0..1]");
    // klaim yang SAMA PERSIS diulang = NO-OP (digest tidak berubah):
    const digestSetelahKlaimBaru = body.digestDurable();
    fake(body, [[{ capability: { deviceId: MIC, claim: {
        name: "audio.capture", confidence: 1
    } } }]]);
    assert.equal(body.digestDurable(), digestSetelahKlaimBaru,
        "pengulangan klaim identik wajib no-op");
});

test("INVARIANT E: unknown tetap unknown sampai ada bukti klasifikasi", () => {

    const body = makeSchema();
    fake(body, [
        [{ discover: [{
            deviceId: "net:x:y:misteri", deviceClass: "UNKNOWN",
            displayName: "?", capabilities: ["network.observe"]
        }] }],
        [{ discover: [{
            // pengamatan ulang TANPA bukti kelas — tetap unknown:
            deviceId: "net:x:y:misteri", displayName: "masih saja"
        }] }]
    ]);

    assert.equal(body.getDevice("net:x:y:misteri").descriptor.deviceClass,
        "UNKNOWN");

    // klasifikasi HANYA lewat pengamatan eksplisit adapter tepercaya
    // dengan kelas nyata (bukti) — dan sumber yang memenangkan urutan total:
    body.registerProducer("a.discovery");
    body.ingest(emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "a.discovery",
        provenance: "SYSTEM_SENSOR", subject: "net:x:y:misteri",
        confidence: 1,
        payload: { descriptor: {
            deviceId: "net:x:y:misteri", deviceClass: "SMART_HOME_DEVICE",
            displayName: "ternyata lampu pintar"
        } }, clock: body.clock
    }));
    assert.equal(
        body.getDevice("net:x:y:misteri").descriptor.deviceClass,
        "SMART_HOME_DEVICE");
});

test("INVARIANT F: observasi sensor tidak memicu aktuasi apa pun di V0", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [
        { deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Mic",
          capabilities: ["audio.capture"] },
        { deviceId: "windows.audio:out", deviceClass: "AUDIO_OUTPUT",
          displayName: "Speaker", capabilities: ["audio.playback"] }
    ] }]]);

    let reaksi = 0;
    body.subscribe(() => { reaksi++; });   // hook otonomik masa depan

    const obs = emb.makeEvent({
        type: "SENSOR_OBSERVATION", source: "fake.discovery",
        provenance: "SYSTEM_SENSOR", subject: MIC,
        payload: {
            channel: { id: "audio.capture", modality: "audio" },
            sample: { rms: 0.42 }
        },
        clock: body.clock
    });
    const accepted = body.ingest(obs);
    assert.equal(accepted.accepted, true);

    // satu-satunya efek: catatan ephemeris di ring buffer. Tidak ada
    // tindak lanjut, tidak ada pemanggilan aktuator:
    const ring = body.getChannelObservations("audio.capture");
    assert.equal(ring.length, 1);
    assert.deepEqual(ring[0].sample, { rms: 0.42 });

    // observasi untuk perangkat tak dikenal ditolak — sensor bukan jalur
    // penciptaan entitas:
    const ghost = body.ingest(emb.makeEvent({
        type: "SENSOR_OBSERVATION", source: "fake.discovery",
        provenance: "SYSTEM_SENSOR", subject: "usb:000:000:hantu",
        payload: { channel: { id: "audio.capture" }, sample: {} },
        clock: body.clock
    }));
    assert.equal(ghost.accepted, false);
});

test("INVARIANT G: BodySchema hidup sendirian — tanpa Console/LLM/database", () => {

    // instansiasi telanjang di proses yang sama, nol dependensi lain:
    const body = emb.createBodySchema({ clock: emb.manualClock(T0) });
    // registrasi produsen = tindakan operator (kontrak B§5a):
    body.registerProducer("fake.discovery");
    const results = emb.runDiscoveryCycle(body, emb.createFakeDiscoveryAdapter({
        script: [[{ discover: [
            { deviceId: "host.os:sendiri", deviceClass: "HOST",
              displayName: "sendiri" }
        ] }]]
    }));
    assert.ok(results[0].accepted);
    assert.equal(emb.getEmbodimentSummary(body).totals.devices, 1);
});

test("B0.35: paritas serialisasi/restart — digest durable identik", async () => {

    const store = emb.createMemoryBodyStore();

    const build = () => {
        const body = emb.createBodySchema({
            clock: emb.manualClock(T0), store
        });
        fake(body, [[{ discover: [
            { deviceId: "host.os:kantor", deviceClass: "HOST", displayName: "kantor" },
            { deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Mic USB",
              identity: { namespace: "usb", stableKey: "1111:aaaa:mica",
                          stability: "stable" },
              capabilities: ["audio.capture"],
              relationships: [{ type: "attached_to", fromId: MIC,
                                toId: "host.os:kantor" }] }
        ] }]]);
        body.setPreference({
            purpose: "audio.capture", kind: "default", deviceId: MIC
        });
        return body;
    };

    const original = build();
    await original.persist();                       // simpan ke store

    // BATAS SERIALIZASI NYATA: stringify → parse — tanpa berbagi graf
    // objek dengan skema sumber maupun store.
    const payload = JSON.parse(JSON.stringify(await store.load()));
    const restored = emb.BodySchema.restore(payload, {
        clock: emb.manualClock(T0)
    });

    // identitas, kemampuan, relasi, preferensi — semua bertahan:
    assert.equal(original.digestDurable(), restored.digestDurable(),
        "digest durable wajib identik lintas restart");
    assert.deepEqual(restored.serialize(), original.serialize(),
        "serialisasi kanonik wajib identik lintas restart");
    assert.equal(restored.getDevice(MIC).descriptor.displayName, "Mic USB");
    // attached_to (dari adapter) + default_for (kebijakan operator):
    assert.deepEqual(
        restored.getRelationships().map(r => r.type).sort(),
        ["attached_to", "default_for"]);
    assert.deepEqual(
        restored.resolvePreferred("audio.capture").map(d => d.descriptor.deviceId),
        [MIC]);
    assert.equal(restored.getDevice(MIC).firstSeenAtMs, T0);

    // observasi EPHEMERAL memang tidak ikut diserialisasi — V0 jujur pada
    // batas ephemeral vs durable (lihat docs/architecture/BODY-SCHEMA-V0.md):
    const serialized = JSON.stringify(original.serialize());
    assert.ok(!serialized.includes("\"rms\""));
});
