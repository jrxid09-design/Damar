const test = require("node:test");
const assert = require("node:assert");

/**
 * BODY SCHEMA V0 — kueri, proyeksi, dan determinisme (B0.16–B0.23, B0.26).
 */

const emb = require("../../src/embodiment");

const T0 = 1_000_000;
const HOST = "host.os:mesin-uji";

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

test("B0.16: perangkat UNKNOWN adalah warga kelas satu — tidak dibuang", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [{
        deviceId: "net:prot:misterius-7",
        deviceClass: "UNKNOWN",
        displayName: "perangkat tak dikenal di LAN",
        capabilities: [{ name: "network.observe", confidence: 0.3 }],
        metadata: { transport: "network", vendorHint: "acme" }
    }] }]]);

    const device = body.getDevice("net:prot:misterius-7");
    assert.equal(device.descriptor.deviceClass, "UNKNOWN");
    // tetap muncul di daftar dan di ringkasan:
    assert.ok(body.listDevices().some(d => d.descriptor.deviceClass === "UNKNOWN"));
});

test("B0.17+B0.18: provenance dan confidence pengamatan tersimpan utuh", () => {

    const body = makeSchema();
    body.registerProducer("fake.discovery");

    body.ingest(emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "fake.discovery",
        provenance: "EXTERNAL_SOURCE", subject: "usb:1:a:x",
        confidence: 0.42,
        payload: { descriptor: {
            deviceId: "usb:1:a:x", deviceClass: "HID", displayName: "?"
        } },
        clock: body.clock
    }));

    const view = body.getDevice("usb:1:a:x");
    assert.equal(view.provenance.source, "fake.discovery");
    assert.equal(view.provenance.confidence, 0.42);
    assert.equal(view.capabilities[0]?.source ?? null, null);
});

test("B0.21: kanal indrawi hanya dari perangkat online, terklasifikasi modality", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [
        { deviceId: HOST, deviceClass: "HOST", displayName: "h" },
        { deviceId: "usb:1:a:mic", deviceClass: "AUDIO_INPUT", displayName: "Mic",
          capabilities: ["audio.capture"] },
        { deviceId: "windows.camera:abc", deviceClass: "CAMERA", displayName: "Cam",
          capabilities: ["vision.capture"], metadata: { transport: "usb" } },
        { deviceId: "network:rtsp:kamera-luar", deviceClass: "CAMERA",
          displayName: "Kam Luar", capabilities: ["vision.snapshot"],
          metadata: { transport: "network" } }
    ] }, { offline: ["windows.camera:abc"] }]]);

    const channels = body.sensorChannels();
    const ids = channels.map(c => c.channelId);
    assert.deepEqual(ids.sort(), ["audio.capture", "vision.snapshot"]);
    // kamera offline tidak menyumbang kanal:
    assert.ok(!channels.some(c => c.deviceIds.includes("windows.camera:abc")));
    assert.equal(channels.find(c => c.channelId === "audio.capture").modality, "audio");
    assert.equal(channels.find(c => c.channelId === "vision.snapshot").direction, "sensor");
});

test("B0.22: kanal aktuator terdeskripsi — bukan izin, bukan eksekusi", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [
        { deviceId: "windows.audio:out-1", deviceClass: "AUDIO_OUTPUT",
          displayName: "Speaker", capabilities: ["audio.playback"] },
        { deviceId: "windows.display:0", deviceClass: "DISPLAY",
          displayName: "Monitor", capabilities: ["display.render"] }
    ] }]]);

    const act = body.actuatorChannels();
    assert.deepEqual(act.map(c => c.channelId).sort(),
        ["audio.playback", "display.render"]);

    // INVARIANT F: keberadaan kanal TIDAK memberi cara mengeksekusinya.
    for (const channel of act) {
        for (const key of Object.keys(channel)) {
            assert.match(key, /^(channelId|direction|modality|deviceIds)$/);
        }
    }
});

test("B0.23: ringkasan embodiment — pendengaran/penglihatan/tampilan/kesehatan", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [
        { deviceId: HOST, deviceClass: "HOST", displayName: "h" },
        { deviceId: "usb:1:a:mic", deviceClass: "AUDIO_INPUT", displayName: "Mic A",
          capabilities: ["audio.capture"] },
        { deviceId: "usb:2:b:mic", deviceClass: "AUDIO_INPUT", displayName: "Mic B",
          capabilities: ["audio.capture"] },
        { deviceId: "windows.camera:abc", deviceClass: "CAMERA", displayName: "Webcam",
          capabilities: ["vision.capture"] },
        { deviceId: "network:rtsp:luar-1", deviceClass: "CAMERA", displayName: "Luar 1",
          capabilities: ["vision.snapshot"], metadata: { transport: "network" } },
        { deviceId: "network:onvif:luar-2", deviceClass: "CAMERA", displayName: "Luar 2",
          capabilities: [], metadata: { transport: "network" } },
        { deviceId: "windows.display:0", deviceClass: "DISPLAY", displayName: "Monitor" },
        { deviceId: "net:prot:aneh", deviceClass: "UNKNOWN", displayName: "?" }
    ] }], [
        { health: { deviceId: "usb:2:b:mic", status: "degraded" } }
    ]]);

    body.setPreference({
        purpose: "audio.capture", kind: "default", deviceId: "usb:1:a:mic"
    });

    const summary = emb.getEmbodimentSummary(body);
    assert.equal(summary.hearing.availableInputs, 2);
    assert.equal(summary.hearing.preferredInput.deviceId, "usb:1:a:mic");
    assert.equal(summary.vision.localCameras, 1);
    assert.equal(summary.vision.networkCameras, 2);
    assert.equal(summary.display.monitors, 1);
    assert.deepEqual(summary.health.degradedDevices, ["usb:2:b:mic"]);
    assert.equal(summary.totals.unknownDevices, 1);
    assert.equal(Object.isFrozen(summary), true);
});

test("B0.26: observasi konflik — urutan kedatangan berbeda, state akhir identik", () => {

    const build = (order) => {
        const body = makeSchema();
        body.registerProducer("a.discovery");
        body.registerProducer("b.discovery");

        const ev = (src, name, conf) => emb.makeEvent({
            type: "DEVICE_DISCOVERED", source: src,
            provenance: "SYSTEM_SENSOR", subject: "usb:9:z:dev",
            confidence: conf,
            payload: { descriptor: {
                deviceId: "usb:9:z:dev", deviceClass: "AUDIO_INPUT",
                displayName: name
            } },
            clock: body.clock
        });

        for (const step of order) body.ingest(step(ev));
        return body;
    };

    const menang = build([
        (e) => e("a.discovery", "Nama Dari A", 0.9),
        (e) => e("b.discovery", "Nama Dari B", 0.4),
    ]);
    const terbalik = build([
        (e) => e("b.discovery", "Nama Dari B", 0.4),
        (e) => e("a.discovery", "Nama Dari A", 0.9),
    ]);

    // konvergensi dibandingkan pada TIGA lapis: digest, serialisasi, state.
    assert.equal(menang.digestDurable(), terbalik.digestDurable(),
        "digest durable wajib identik");
    assert.deepEqual(terbalik.serialize(), menang.serialize(),
        "serialisasi kanonik wajib identik");
    assert.equal(
        terbalik.getDevice("usb:9:z:dev").descriptor.displayName,
        "Nama Dari A", "konten pemenang (confidence tertinggi) wajib sama");
});

test("B0.20: monotonic naik ketat; urutan event tidak merusak konvergensi", () => {

    const body = makeSchema();
    body.registerProducer("fake.discovery");

    const mk = (i) => emb.makeEvent({
        type: "CAPABILITY_DISCOVERED", source: "fake.discovery",
        provenance: "OBSERVATION", subject: HOST,
        payload: { capability: { name: i % 2 ? "device.health.read" : "storage.read" } },
        clock: body.clock
    });

    fake(body, [[{ discover: [{ deviceId: HOST, deviceClass: "HOST", displayName: "h" }] }]]);
    const events = [mk(1), mk(2), mk(3)];
    const monotonics = events.map(e => e.monotonic);
    assert.deepEqual(monotonics, [...monotonics].sort((x, y) => x - y));
    assert.equal(new Set(monotonics).size, 3);

    // disuapi terbalik pun hasil akhir sama:
    for (const e of [...events].reverse()) body.ingest(e);
    assert.equal(body.devicesWithCapability("storage.read").length, 1);
    assert.equal(body.devicesWithCapability("device.health.read").length, 1);
});
