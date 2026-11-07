const test = require("node:test");
const assert = require("node:assert");

/**
 * SENSORIUM V0 — amplop event gagal-tutup, identitas kanonik,
 * dan kait reverse-engineering (B0.19, B0.25, B0.33).
 */

const emb = require("../../src/embodiment");

const T0 = 1_000_000;
const HOST = "host.os:mesin-uji";

function makeSchema() {
    return emb.createBodySchema({ clock: emb.manualClock(T0) });
}

test("B0.19: event cacat ditolak saat konstruksi — gagal-tutup dengan kode", () => {

    const clock = emb.manualClock(T0);
    const base = { source: "fake.discovery", provenance: "SYSTEM_SENSOR",
        subject: "usb:1:a:x", payload: {}, clock };

    // tipe tidak dikenal:
    assert.throws(() => emb.makeEvent({ ...base, type: "HANTU_MUNCUL" }),
        (e) => e.code === "EMB_UNKNOWN_EVENT_TYPE");
    // provenance tidak sah:
    assert.throws(() => emb.makeEvent({ ...base, type: "DEVICE_ONLINE",
        provenance: "MODEL_KATA" }), (e) => e.code === "EMB_UNKNOWN_PROVENANCE");;
    // subjek bukan deviceId kanonik — teks bebas tidak bisa jadi subjek:
    for (const subjek of ["mikrofonku", "", null, "USB:DEV", "a:b;rm -rf"]) {
        assert.throws(() => emb.makeEvent({ ...base,
            type: "DEVICE_ONLINE", subject: subjek }),
            (e) => e.code === "EMB_INVALID_SUBJECT", `subjek: ${subjek}`);
    }
    // payload bukan objek:
    assert.throws(() => emb.makeEvent({ ...base, type: "DEVICE_ONLINE",
        payload: "hapus semua" }), (e) => e.code === "EMB_INVALID_PAYLOAD");
});

test("B0.19b: ingest sampah dari dunia luar → dead-letter, state tak tersentuh", () => {

    const body = makeSchema();
    const before = body.digestDurable();

    const sampah = [
        null, undefined, 42, "event",
        { type: "DEVICE_DISCOVERED" },                    // setengah jadi
        { eventId: "x", schemaVersion: 1, type: "TIDAK_ADA",
          timestamp: "t", timestampMs: 1, monotonic: 1, source: "s",
          provenance: "OBSERVATION", subject: "usb:1:a:x",
          confidence: 1, payload: {} },
    ];
    for (const s of sampah) {
        const r = body.ingest(s);
        assert.equal(r.accepted, false);
    }

    assert.equal(body.digestDurable(), before, "tidak boleh ada mutasi diam-diam");
    assert.ok(body.deadLetters().length >= sampah.length - 2);
    assert.ok(body.deadLetters().every(d => typeof d.reason === "string"));
});

test("B0.25: identitas kanonik stabil — namespace + stableKey, bukan nama tampilan", () => {

    const id = emb.identity;

    // bentuk sah:
    assert.equal(id.canonicalDeviceId(
        { namespace: "windows.audio", stableKey: "{0.0.1.00000000}.1" }),
        "windows.audio:{0.0.1.00000000}.1");
    assert.deepEqual(id.parseDeviceId("usb:1234:5678:abc"),
        { namespace: "usb", stableKey: "1234:5678:abc" });

    // bentuk busuk ditolak:
    for (const buruk of [
        { namespace: "Windows Audio", stableKey: "x" },   // spasi/besar
        { namespace: "usb", stableKey: "" },
        { namespace: "usb", stableKey: "key dengan spasi" },
        { namespace: "", stableKey: "k" },
    ]) {
        assert.throws(() => id.canonicalDeviceId(buruk),
            (e) => String(e.code).startsWith("EMB_"));
    }

    // fallback jujur: deterministik dari sifat teramati, bukan nama:
    const a = id.fallbackStableKey({ vid: "1234", pid: "5678", port: "3-2" });
    const b = id.fallbackStableKey({ port: "3-2", vid: "1234", pid: "5678" });
    assert.equal(a, b);                                   // urutan key tak relevan
    assert.match(a, /^unverified-[0-9a-f]{16}$/);

    // rediscovery via ID yang sama menyatu, walau nama berubah:
    const body = makeSchema();
    body.registerProducer("fake.discovery");
    const ev = (nama) => emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "fake.discovery",
        provenance: "SYSTEM_SENSOR", subject: "usb:1234:5678:abc",
        payload: { descriptor: {
            deviceId: "usb:1234:5678:abc", deviceClass: "AUDIO_INPUT", displayName: nama
        } }, clock: body.clock
    });
    body.ingest(ev("Mic Lama"));
    body.clock.advance(5_000);            // penemuan ulang terjadi KEMUDIAN
    body.ingest(ev("Mic Ganti Nama (perangkat sama)"));
    assert.equal(body.counts().devices, 1);
    assert.equal(body.getDevice("usb:1234:5678:abc").descriptor.displayName,
        "Mic Ganti Nama (perangkat sama)");
});

test("B0.33: perangkat UNKNOWN memicu UNKNOWN_DEVICE_REQUIRES_ANALYSIS dengan bukti", () => {

    const body = makeSchema();
    const seen = [];
    body.subscribe((e) => { if (e.type === "UNKNOWN_DEVICE_REQUIRES_ANALYSIS") seen.push(e); });

    body.registerProducer("fake.discovery");

    const raw = {
        deviceId: "network:mystery:dengan-serial",
        deviceClass: "UNKNOWN",
        displayName: "kotak aneh di LAN",
        capabilities: [{ name: "network.observe", confidence: 0.2 }],
        metadata: { transport: "network" }
    };
    body.ingest(emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "fake.discovery",
        provenance: "EXTERNAL_SOURCE", subject: raw.deviceId,
        confidence: 0.6,
        payload: { descriptor: raw }, clock: body.clock
    }));

    assert.equal(seen.length, 1);
    const evidence = seen[0].payload.evidence;
    assert.equal(typeof evidence.descriptorDigest, "string");
    assert.match(evidence.descriptorDigest, /^[0-9a-f]{64}$/);
    assert.equal(evidence.deviceClass, "UNKNOWN");
    assert.deepEqual(evidence.capabilities, ["network.observe"]);
    assert.equal(evidence.provenance.source, "fake.discovery");
    assert.equal(evidence.provenance.confidence, 0.6);

    // idempoten: penemuan ulang TIDAK memicu analisis kedua:
    body.ingest(emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "fake.discovery",
        provenance: "EXTERNAL_SOURCE", subject: raw.deviceId,
        payload: { descriptor: raw }, clock: body.clock
    }));
    assert.equal(seen.length, 1);

    // perangkat dikenal TIDAK memicu:
    body.ingest(emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "fake.discovery",
        provenance: "SYSTEM_SENSOR", subject: "usb:5:e:mic",
        payload: { descriptor: {
            deviceId: "usb:5:e:mic", deviceClass: "AUDIO_INPUT", displayName: "Mic"
        } }, clock: body.clock
    }));
    assert.equal(seen.length, 1);
});

test("sensorium: event inti tidak dapat dipalsukan dari luar modul", () => {

    const body = makeSchema();
    body.registerProducer("fake.discovery");

    // 1) Pintu publik makeEvent MENOLAK membangun event inti sama sekali:
    assert.throws(() => emb.makeEvent({
        type: "UNKNOWN_DEVICE_REQUIRES_ANALYSIS",
        source: "fake.discovery", provenance: "SYSTEM_EVENT",
        subject: "net:x:y:z", payload: {}, clock: body.clock
    }), (e) => e.code === "EMB_CORE_EVENT_PROTECTED");

    assert.throws(() => emb.makeEvent({
        type: "DEVICE_DEFAULT_CHANGED",
        source: "sensorium.core", provenance: "SYSTEM_EVENT",
        subject: "usb:1:a:x", payload: { explicit: true, kind: "default",
            purpose: "audio.capture", deviceId: "usb:1:a:x" },
        clock: body.clock
    }), (e) => e.code === "EMB_CORE_EVENT_PROTECTED");

    // 2) Objek inti PALSU rakitan pemanggil (melewati pabrik) ditolak
    //    ingest karena tidak membawa token internal:
    const before = body.digestDurable();
    for (const palsu of [
        { eventId: "f1", schemaVersion: 1, type: "UNKNOWN_DEVICE_REQUIRES_ANALYSIS",
          timestamp: new Date(T0).toISOString(), timestampMs: T0,
          monotonic: 1, source: "sensorium.core", provenance: "SYSTEM_EVENT",
          subject: "net:x:y:palsu", confidence: 1, payload: {} },
        { eventId: "f2", schemaVersion: 1, type: "DEVICE_DEFAULT_CHANGED",
          timestamp: new Date(T0).toISOString(), timestampMs: T0,
          monotonic: 2, source: "sensorium.core", provenance: "SYSTEM_EVENT",
          subject: "usb:1:a:x", confidence: 1,
          payload: { explicit: true, kind: "default", purpose: "audio.capture",
              deviceId: "usb:1:a:x" } },
    ]) {
        const r = body.ingest(palsu);
        assert.equal(r.accepted, false, JSON.stringify(palsu.type));
    }
    assert.equal(body.digestDurable(), before,
        "pemalsuan tidak boleh mengubah state");

    // 3) MODEL_TEXT (teks bebas) tidak bisa menjadi sumber inti:
    const r = body.ingest({ ...{
        eventId: "f3", schemaVersion: 1, type: "DEVICE_ONLINE",
        timestamp: new Date(T0).toISOString(), timestampMs: T0,
        monotonic: 3, source: "sensorium.core ",   // spasi = format tak sah
        provenance: "SYSTEM_EVENT", subject: "usb:1:a:x",
        confidence: 1, payload: {} } });
    assert.equal(r.accepted, false);
});
