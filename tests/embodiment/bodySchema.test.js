const test = require("node:test");
const assert = require("node:assert");

/**
 * BODY SCHEMA V0 — siklus hidup perangkat (B0.1–B0.10).
 *
 * Semua tes memakai jam manual dan adapter palsu: nol waktu-dinding,
 * nol perangkat keras, deterministik penuh.
 */

const emb = require("../../src/embodiment");

const T0 = 1_000_000;
const HOST = "host.os:mesin-uji";
const MIC_A = "usb:1111:aaaa:mica";
const MIC_B = "usb:2222:bbbb:micb";

function makeSchema() {
    return emb.createBodySchema({ clock: emb.manualClock(T0) });
}

function fake(schema, script, id = "fake.discovery") {
    // Registrasi produsen = tindakan operator (kontrak B§5a):
    schema.registerProducer(id);
    // adapter memakan skrip satu langkah per siklus; tiap siklus juga
    // memajukan jam 1ms agar urutan temporal antar-langkah nyata.
    const adapter = emb.createFakeDiscoveryAdapter({ id, script });
    const results = [];
    for (let i = 0; i < script.length; i++) {
        results.push(...emb.runDiscoveryCycle(schema, adapter));
        schema.clock.advance(1);
    }
    return results;
}

const micA = (extra = {}) => ({
    deviceId: MIC_A, deviceClass: "AUDIO_INPUT", displayName: "Mic A",
    identity: { namespace: "usb", stableKey: "1111:aaaa:mica", stability: "stable" },
    capabilities: [{ name: "audio.capture", confidence: 0.9, source: "fake.discovery" }],
    ...extra
});

test("B0.1: host lalu perangkat lokal terdaftar dengan relasi topologi", () => {

    const body = makeSchema();
    const results = fake(body, [[
        { discover: [{ deviceId: HOST, deviceClass: "HOST", displayName: "mesin-uji" }] }
    ], [
        { discover: [micA()] },
        { capability: { deviceId: MIC_A, claim: "device.health.read" } }
    ]]);

    // langkah kedua membawa relasi attached_to → host:
    assert.ok(results.every(r => r.accepted), JSON.stringify(results));
    assert.equal(body.getDevice(HOST).descriptor.deviceClass, "HOST");
    assert.equal(body.getDevice(MIC_A).descriptor.displayName, "Mic A");
});

test("B0.2: penemuan duplikat idempoten — tidak ada perangkat kembar", () => {

    const body = makeSchema();
    body.registerProducer("fake.discovery");

    const ev = (displayName, confidence) => emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "fake.discovery",
        provenance: "SYSTEM_SENSOR", subject: MIC_A,
        payload: { descriptor: micA({ displayName }) },
        confidence, clock: body.clock
    });

    assert.ok(body.ingest(ev("Mic A", 1)).accepted);
    const before = body.counts().devices;
    const r1 = body.ingest(ev("Mic A", 1));   // duplikat persis
    const r2 = body.ingest(ev("Mic A (salinan)", 0.5)); // kalah confidence

    assert.ok(r1.accepted && r2.accepted);
    assert.equal(body.counts().devices, before);
    // yang menang tetap nama asli (confidence lebih tinggi):
    assert.equal(body.getDevice(MIC_A).descriptor.displayName, "Mic A");
});

test("B0.3+B0.30: pengamatan ulang mengembalikan perangkat yang dihapus", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [micA()] }], [{ remove: [MIC_A] }]]);

    assert.equal(body.getDevice(MIC_A).descriptor.state, "removed");
    assert.equal(body.listDevices({ state: "online" }).length, 0);

    // identitas bertahan; rediscovery memulihkan:
    fake(body, [[{ discover: [micA()] }]]);
    assert.equal(body.getDevice(MIC_A).descriptor.state, "online");
    assert.equal(body.getDevice(MIC_A).provenance.source, "fake.discovery");
});

test("B0.5+B0.29: offline vs removed — removed tidak tersedia sama sekali", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [micA(), {
        deviceId: MIC_B, deviceClass: "AUDIO_INPUT", displayName: "Mic B",
        capabilities: ["audio.capture"]
    }] }], [{ offline: [MIC_B] }]]);

    assert.equal(body.getDevice(MIC_B).descriptor.state, "offline");
    // kueri kemampuan murni tetap melihat MIC_B, tapi kanal indrawi
    // dan resolusi preferensi hanya menghitung yang online:
    assert.ok(body.devicesWithCapability("audio.capture")
        .some(d => d.descriptor.deviceId === MIC_B));
    assert.ok(body.sensorChannels()[0].deviceIds
        .every(id => id !== MIC_B));
    assert.ok(body.resolvePreferred("audio.capture")
        .every(d => d.descriptor.deviceId !== MIC_B));

    fake(body, [[{ remove: [MIC_B] }]]);
    assert.equal(body.getDevice(MIC_B).descriptor.state, "removed");
});

test("B0.6+B0.7: CAPABILITY_DISCOVERED menambah kemampuan + kueri kemampuan", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [micA({
        capabilities: []
    })] }], [{ capability: { deviceId: MIC_A, claim: {
        name: "audio.capture", confidence: 0.8, source: "fake.discovery"
    } } }]]);

    const withCap = body.devicesWithCapability("audio.capture");
    assert.equal(withCap.length, 1);
    assert.equal(withCap[0].descriptor.deviceId, MIC_A);
    assert.equal(withCap[0].capabilities[0].confidence, 0.8);
});

test("B0.8: kemampuan cacat ditolak gagal-tutup tanpa mutasi state", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [micA({ capabilities: [] })] }]]);

    for (const jelek of ["Audio Capture", "audio", "AUDIO.capture",
        "audio..capture", "audio.capture!", 42]) {
        const r = body.ingest(emb.makeEvent({
            type: "CAPABILITY_DISCOVERED", source: "fake.discovery",
            provenance: "OBSERVATION", subject: MIC_A,
            payload: { capability: { name: jelek } }, clock: body.clock
        }));
        assert.equal(r.accepted, false, `harusnya ditolak: ${jelek}`);
        assert.match(r.reason, /CAPABILITY|CLAIM/);
    }
    // klaim sah tapi field asing juga ditolak (tidak ada celah "grants"):
    const r = body.ingest(emb.makeEvent({
        type: "CAPABILITY_DISCOVERED", source: "fake.discovery",
        provenance: "OBSERVATION", subject: MIC_A,
        payload: { capability: { name: "audio.capture", grants: ["all"] } },
        clock: body.clock
    }));
    assert.equal(r.accepted, false);
    assert.equal(body.devicesWithCapability("audio.capture").length, 0);
});

test("B0.9+B0.10: relasi struktural terdaftar dan bisa dikueri", () => {

    const body = makeSchema();
    fake(body, [[
        { discover: [{ deviceId: HOST, deviceClass: "HOST", displayName: "h" }] },
        { discover: [{
            deviceId: MIC_A, deviceClass: "AUDIO_INPUT", displayName: "m",
            relationships: [
                { type: "attached_to", fromId: MIC_A, toId: HOST },
                { type: "provides", fromId: MIC_A, toId: "audio.capture" }
            ]
        }] }
    ]]);

    const all = body.getRelationships();
    assert.equal(all.length, 2);

    const attached = body.getRelationships({ fromId: MIC_A, type: "attached_to" });
    assert.equal(attached[0].toId, HOST);
    const provides = body.getRelationships({ fromId: MIC_A, type: "provides" });
    assert.equal(provides[0].toId, "cap:audio.capture");
});

test("B0.9b: relasi dengan ujung hantu ditolak atomik — nol mutasi", () => {

    const body = makeSchema();
    fake(body, [[
        { discover: [{ deviceId: HOST, deviceClass: "HOST", displayName: "h" }] }
    ]]);
    // registrasi produsen kedua = tindakan operator (mengubah state durable
    // secara sah) — snapshot diambil SETELAHnya:
    body.registerProducer("fake.discovery2");
    const digestSebelum = body.digestDurable();

    // relasi menunjuk host yang tidak ada → event ditolak utuh:
    const r = fake(body, [[{ discover: [{
        deviceId: "usb:3333:cccc:cam", deviceClass: "CAMERA", displayName: "c",
        relationships: [
            { type: "attached_to", fromId: "usb:3333:cccc:cam", toId: "host.os:ngasal" }
        ]
    }] }]], "fake.discovery2");

    assert.equal(r[0].accepted, false);
    assert.equal(r[0].reason, "EMB_RELATIONSHIP_DANGLING_TO");
    assert.equal(body.getDevice("usb:3333:cccc:cam"), null,
        "perangkat tidak boleh terpasang karena reliksinya gagal");
    assert.equal(body.digestDurable(), digestSebelum,
        "penolakan wajib meninggalkan state byte-identik");
});

test("B0.11: urutan preferensi deterministik default→preferred→fallback→lain", () => {

    const body = makeSchema();
    const micC = { deviceId: "usb:3333:cccc:micc", deviceClass: "AUDIO_INPUT", displayName: "C", capabilities: ["audio.capture"] };
    fake(body, [[{ discover: [micA(), micC, {
        deviceId: MIC_B, deviceClass: "AUDIO_INPUT", displayName: "B",
        capabilities: ["audio.capture"]
    }] }]]);

    body.setPreference({ purpose: "audio.capture", kind: "fallback", deviceId: MIC_B, rank: 1 });

    let order = body.resolvePreferred("audio.capture").map(d => d.descriptor.deviceId);
    // tanpa default/preferred eksplisit: fallback menang atas penyedia lain,
    // sisanya urut id kanonik.
    assert.deepEqual(order, [MIC_B, MIC_A, "usb:3333:cccc:micc"]);

    body.setPreference({ purpose: "audio.capture", kind: "preferred", deviceId: MIC_A });
    order = body.resolvePreferred("audio.capture").map(d => d.descriptor.deviceId);
    assert.deepEqual(order, [MIC_A, MIC_B, "usb:3333:cccc:micc"]);

    body.setPreference({ purpose: "audio.capture", kind: "default", deviceId: "usb:3333:cccc:micc" });
    order = body.resolvePreferred("audio.capture").map(d => d.descriptor.deviceId);
    assert.deepEqual(order, ["usb:3333:cccc:micc", MIC_A, MIC_B]);
});

test("B0.12: hilangnya default terdeteksi sebagai DEVICE_DEFAULT_CHANGED turunan", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [micA(), {
        deviceId: MIC_B, deviceClass: "AUDIO_INPUT", displayName: "B",
        capabilities: ["audio.capture"]
    }] }]]);
    body.setPreference({ purpose: "audio.capture", kind: "default", deviceId: MIC_A });

    const derivedTypes = () => body.journal()
        .filter(e => e.type === "DEVICE_DEFAULT_CHANGED" && e.payload.derived)
        .map(e => e.payload);

    fake(body, [[{ offline: [MIC_A] }]]);
    const last = derivedTypes().at(-1);
    assert.equal(last.previousDeviceId, MIC_A);
    assert.equal(last.nextDeviceId, MIC_B);   // fallback otomatis ke penyedia sisa
    assert.equal(last.purpose, "audio.capture");
});

test("B0.27+B0.28: degradasi kesehatan lalu pulih", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [micA()] }], [
        { health: { deviceId: MIC_A, status: "degraded", detail: "noise tinggi" } }
    ]]);
    assert.equal(body.getDevice(MIC_A).descriptor.health.status, "degraded");

    fake(body, [[{ health: { deviceId: MIC_A, status: "healthy" } }]]);
    assert.equal(body.getDevice(MIC_A).descriptor.health.status, "healthy");

    // status kesehatan tak dikenal ditolak:
    const r = fake(body, [[{ health: { deviceId: MIC_A, status: "meledak" } }]]);
    assert.equal(r[0].accepted, false);
});

test("B0.14+B0.15: snapshot imutabel — potret tidak bisa menyentuh state hidup", () => {

    const body = makeSchema();
    fake(body, [[{ discover: [micA()] }]]);

    const snap = body.snapshot();
    assert.equal(Object.isFrozen(snap), true);
    assert.equal(Object.isFrozen(snap.devices[0]), true);

    // percobaan mutasi dalam mode ketat melempar TypeError:
    assert.throws(() => {
        "use strict";
        snap.devices[0].descriptor.displayName = "diretas";
    }, TypeError);
    // dan state hidup tetap utuh:
    assert.equal(body.getDevice(MIC_A).descriptor.displayName, "Mic A");

    // perubahan setelah potret tidak merusak potret lama:
    fake(body, [[{ remove: [MIC_A] }]]);
    assert.equal(snap.devices.length, 1);
    assert.equal(body.snapshot().counts.byState.removed, 1);
});
