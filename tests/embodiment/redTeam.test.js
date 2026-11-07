const test = require("node:test");
const assert = require("node:assert");

/**
 * RED-TEAM REGRESSION V0 — delapan blocker perbaikan kepercayaan.
 *
 * RT1  restore = batas input tidak terpercaya (gagal-tutup penuh)
 * RT2  serialisasi/store tidak bocor referensi hidup
 * RT3  ingest atomik per event; pelanggan gagal tidak menggugurkan komit
 * RT4  konvergensi presence bebas urutan kedatangan
 * RT5  event inti tak-dapat-dipalsukan (+ tidak menekan analisis asli)
 * RT6  gabungan kemampuan & digest deterministik termasuk tie
 * RT7  identitas NIC ganda-MAC tetap dua perangkat + jujur
 * RT8  subjek event wajib sama dengan perangkat yang dimutasi
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

function validSnapshot() {
    const body = makeSchema();
    fake(body, [[{ discover: [
        { deviceId: HOST, deviceClass: "HOST", displayName: "kantor" },
        { deviceId: MIC, deviceClass: "AUDIO_INPUT", displayName: "Mic USB",
          capabilities: ["audio.capture"],
          relationships: [{ type: "attached_to", fromId: MIC, toId: HOST }] }
    ] }]]);
    return body;
}

/* ===================== RT1 — RESTORE BATAS TIDAK TERPERCAYA ============ */

test("RT1: restore menolak SELURUH snapshot yang dijinakkan (gagal-tutup)", () => {

    const base = JSON.parse(JSON.stringify(validSnapshot().serialize()));
    const micRow = (d) => d.devices.find(x => x.descriptor.deviceId === MIC);

    const tampered = (name, mutate) => {
        const data = JSON.parse(JSON.stringify(base));
        mutate(data);
        let threw = null;
        try {
            emb.BodySchema.restore(data, { clock: emb.manualClock(T0) });
        } catch (err) {
            threw = err;
        }
        assert.ok(threw, `${name}: seharusnya ditolak`);
        assert.equal(threw.code, "EMB_INVALID_SERIALIZATION", name);
        assert.ok(Array.isArray(threw.details) && threw.details.length > 0,
            `${name}: diagnostik wajib ada`);
        // tidak ada skema yang kembali → tidak ada state yang tercemar.
    };

    // field otoritas diselundupkan:
    tampered("authority-field", (d) => {
        micRow(d).descriptor.authority = { "audio.capture": true };
    });
    // kelas istana langit:
    tampered("god-mode-class", (d) => {
        micRow(d).descriptor.deviceClass = "GOD_MODE";
    });
    // state istimewa:
    tampered("privileged-state", (d) => {
        micRow(d).descriptor.state = "omnipotent";
    });
    // deviceId tidak kanonik:
    tampered("invalid-device-id", (d) => {
        micRow(d).descriptor.deviceId = "mikrofon kesayangan";
    });
    // relasi menggantung:
    tampered("dangling-relationship", (d) => {
        d.relationships.push({
            type: "attached_to", fromId: MIC, toId: "host.os:hantu" });
    });
    // klaim kemampuan cacat:
    tampered("malformed-capability", (d) => {
        micRow(d).descriptor.capabilities.push(
            { name: "AUDIO CAPTURE!!", confidence: 0.9 });
    });
    // digest digodok setelah isi diubah (anti-tamper):
    tampered("digest-tamper", (d) => {
        micRow(d).descriptor.displayName = "Mic Palsu";
    });

    // snapshot yang jujur tetap diterima dan isinya ternormalisasi:
    const ok = emb.BodySchema.restore(JSON.parse(JSON.stringify(base)), {
        clock: emb.manualClock(T0) });
    assert.equal(ok.getDevice(MIC).descriptor.displayName, "Mic USB");
});

/* ============== RT2 — TIDAK ADA REFERENSI HIDUP YANG BOCOR ============= */

test("RT2a: serialize() terlepas penuh — mutasi hasil tidak menyentuh hidup", () => {

    const body = validSnapshot();
    const digestSebelum = body.digestDurable();

    const s1 = body.serialize();
    const s2 = body.serialize();
    assert.notEqual(s1.devices[0], s2.devices[0],
        "dua serialize wajib menghasilkan objek berbeda");

    // bebas diputasi — dan tetap tidak menyentuh skema:
    s1.devices[0].descriptor.displayName = "DIRUSAK";
    s1.relationships.length = 0;

    assert.equal(body.digestDurable(), digestSebelum);
    assert.equal(body.getDevice(MIC).descriptor.displayName, "Mic USB");
    assert.equal(body.getRelationships().length, 1);

    // tidak ada aliasing ke rekaman internal mana pun:
    const internal = body.getDevice(MIC);
    assert.notEqual(body.serialize().devices[0].descriptor,
        internal.descriptor);
});

test("RT2b: store memori menyalin masuk & keluar — dua skema tak pernah ikut", async () => {

    const store = emb.createMemoryBodyStore();
    const a = validSnapshot();
    a.store = store;
    await a.persist();

    // mutasi payload SETELAH simpan → muatan tersimpan kebal:
    const payloadA = await store.load();
    payloadA.devices[0].descriptor.displayName = "DIRUSAK-LUAR";

    const loaded = await store.load();
    assert.notEqual(loaded.devices[0].descriptor.displayName, "DIRUSAK-LUAR",
        "load() wajib salinan segar");

    // restore ke skema B lalu mutasi keluaran B → A kebal:
    const b = emb.BodySchema.restore(await store.load(), {
        clock: emb.manualClock(T0) });
    b.getDevice(MIC).descriptor.displayName = "B-DIRUSAK";   // beku: no-op/throw

    assert.equal(a.getDevice(MIC).descriptor.displayName, "Mic USB");
    assert.equal(a.digestDurable(),
        emb.BodySchema.restore(await store.load(),
            { clock: emb.manualClock(T0) }).digestDurable());
});

test("RT2c: meta rekaman terpasang selalu beku", () => {

    const body = validSnapshot();
    const r = body.ingest(emb.makeEvent({
        type: "DEVICE_OFFLINE", source: "fake.discovery",
        provenance: "OBSERVATION", subject: MIC,
        clock: body.clock }));
    assert.ok(r.accepted);
    assert.equal(Object.isFrozen(body.getDevice(MIC).provenance), true);
    assert.equal(Object.isFrozen(body.getDevice(MIC).capabilities), true);
});

/* ==================== RT3 — INGEST ATOMIK PER EVENT ==================== */

test("RT3a: klaim cacat → penolakan tanpa satu byte pun berubah", () => {

    const body = validSnapshot();
    const before = body.serialize();

    const r = body.ingest(emb.makeEvent({
        type: "CAPABILITY_DISCOVERED", source: "fake.discovery",
        provenance: "OBSERVATION", subject: MIC,
        payload: { capability: { name: "audio capture", grants: "*" } },
        clock: body.clock }));

    assert.equal(r.accepted, false);
    assert.deepEqual(body.serialize(), before);
});

test("RT3b: pelanggan yang melempar tidak menggugurkan event yang sah", () => {

    const body = validSnapshot();
    body.subscribe(() => { throw new Error("refleks rusak"); });

    const r = body.ingest(emb.makeEvent({
        type: "DEVICE_ONLINE", source: "fake.discovery",
        provenance: "OBSERVATION", subject: HOST,
        clock: body.clock }));

    assert.equal(r.accepted, true, "komit sah tetap komit");
    assert.equal(body.getDevice(HOST).descriptor.state, "online");
    assert.ok(body.subscriberErrors().length === 1);
    assert.match(body.subscriberErrors()[0].message, /refleks rusak/);
    assert.ok(!body.deadLetters().some(d => d.eventId === r?.eventId),
        "event sukses tidak boleh mendarat di dead-letter");
});

/* ============ RT4 — KONVERGENSI BEBAS URUTAN KEDATANGAN ================ */

test("RT4: kehadiran konflik — semua urutan kedatangan konvergen identik", () => {

    // Permutasi hanya sah atas himpunan event yang valid di semua urutan:
    // perangkat disemai dulu, lalu dua kehadiran bertentangan dengan
    // stempel waktu EKSPLISIT disuapi dalam dua urutan berlawanan.

    {
        // Kasus A di dua urutan kedatangan:
        const buildA = (reversed) => {
            const body = makeSchema();
            fake(body, [[{ discover: [{ deviceId: MIC,
                deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);
            const mk = (type, atMs, conf) => emb.makeEvent({
                type, source: "fake.discovery",
                provenance: "OBSERVATION", subject: MIC,
                payload: {}, confidence: conf, clock: emb.manualClock(atMs) });
            const on  = mk("DEVICE_ONLINE",  T0 + 101, 0.9);
            const off = mk("DEVICE_OFFLINE", T0 + 201, 0.5);
            for (const e of (reversed ? [off, on] : [on, off])) body.ingest(e);
            return body;
        };
        const x = buildA(false), y = buildA(true);
        assert.equal(x.getDevice(MIC).descriptor.state, "offline");
        assert.equal(y.getDevice(MIC).descriptor.state, "offline");
        assert.equal(x.digestDurable(), y.digestDurable());
        assert.deepEqual(y.serialize(), x.serialize());
    }

    {
        // Kasus B: online lebih baru — menang juga di dua urutan.
        const buildB = (reversed) => {
            const body = makeSchema();
            fake(body, [[{ discover: [{ deviceId: MIC,
                deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);
            body.registerProducer("p2.discovery");
            const mk = (type, atMs, conf, src) => emb.makeEvent({
                type, source: src, provenance: "OBSERVATION", subject: MIC,
                payload: {}, confidence: conf, clock: emb.manualClock(atMs) });
            const off = mk("DEVICE_OFFLINE", T0 + 111, 0.9, "p2.discovery");
            const on  = mk("DEVICE_ONLINE",  T0 + 211, 0.4, "p2.discovery");
            for (const e of (reversed ? [on, off] : [off, on])) body.ingest(e);
            return body;
        };
        const x = buildB(false), y = buildB(true);
        assert.equal(x.getDevice(MIC).descriptor.state, "online");
        assert.equal(y.getDevice(MIC).descriptor.state, "online");
        assert.equal(x.digestDurable(), y.digestDurable());
        assert.deepEqual(y.serialize(), x.serialize());
    }
});

/* ========== RT5 — PEMALSUAN EVENT INTI TIDAK MENEKAN ANALISIS ========== */

test("RT5: pemalsuan untuk device X tidak menekan analisis asli X", () => {

    const body = makeSchema();
    body.registerProducer("fake.discovery");
    const seen = [];
    body.subscribe(e => {
        if (e.type === "UNKNOWN_DEVICE_REQUIRES_ANALYSIS") seen.push(e.subject);
    });

    // palsukan analisis untuk X lewat objek rakitan (tanpa token):
    const forged = { eventId: "x", schemaVersion: 1,
        type: "UNKNOWN_DEVICE_REQUIRES_ANALYSIS",
        timestamp: new Date(T0).toISOString(), timestampMs: T0, monotonic: 1,
        source: "sensorium.core", provenance: "SYSTEM_EVENT",
        subject: "net:m:y:x", confidence: 1, payload: {} };
    assert.equal(body.ingest(forged).accepted, false);

    // penemuan ASLI X tetap memicu analisis sungguhan:
    fake(body, [[{ discover: [{
        deviceId: "net:m:y:x", deviceClass: "UNKNOWN", displayName: "?"
    }] }]]);

    assert.deepEqual(seen, ["net:m:y:x"],
        "analisis internal tetap bekerja setelah percobaan pemalsuan");
});

/* ===== RT6 — GABUNGAN KEMAMPUAN DETERMINISTIK TERMASUK TIE ============= */

test("RT6: urutan klaim A/B maupun tie prioritas-sama konvergen identik", () => {

    const buildWith = (claims) => {
        const body = makeSchema();
        body.registerProducer("p.discovery");
        fake(body, [[{ discover: [{ deviceId: MIC,
            deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);
        for (const claim of claims) {
            body.ingest(emb.makeEvent({
                type: "CAPABILITY_DISCOVERED", source: "p.discovery",
                provenance: "SYSTEM_SENSOR", subject: MIC,
                payload: { capability: claim }, clock: body.clock }));
        }
        return body;
    };

    const A = { name: "audio.capture", confidence: 0.7, source: "satu",
        claimedAt: "2026-01-01T00:00:00Z" };
    const B = { name: "device.health.read", confidence: 0.9, source: "dua",
        claimedAt: "2026-01-02T00:00:00Z" };

    const ab = buildWith([A, B]);
    const ba = buildWith([B, A]);

    assert.deepEqual(ba.serialize(), ab.serialize());
    assert.equal(ab.digestDurable(), ba.digestDurable());
    assert.deepEqual(
        ba.getDevice(MIC).descriptor.capabilities.map(c => c.name),
        ["audio.capture", "device.health.read"],  // urutan kanonik nama
        "materialisasi wajib terurut nama, bukan urutan kedatangan");
    assert.equal(
        ab.getDevice(MIC).descriptor.capabilities[1].confidence, 0.9);

    // tie prioritas sama (confidence+sumber identik, konten beda):
    const T1 = { name: "vision.capture", confidence: 0.5, source: "s",
        claimedAt: "2026-01-01T00:00:00Z" };
    const T2 = { name: "vision.capture", confidence: 0.5, source: "s",
        claimedAt: "2026-01-09T00:00:00Z" };
    const t12 = buildWith([T1, T2]);
    const t21 = buildWith([T2, T1]);
    assert.deepEqual(t21.serialize(), t12.serialize(),
        "tie prioritas-sama wajib jatuh ke pemenang kanonik yang sama");
});

/* ============ RT7 — IDENTITAS NIC MAC-GANDA TETAP DUAPERANGKAT ========== */

test("RT7: dua NIC bermac sama → dua perangkat, id kanonik beda, jujur", () => {

    const body = makeSchema();
    body.registerProducer("host.os");

    const fakeOs = {
        hostname: () => "mesin-nic",
        platform: () => "win32", arch: () => "x64",
        cpus: () => [{ model: "C" }],
        totalmem: () => 8 << 30,
        networkInterfaces: () => ({
            "Ethernet":   [{ mac: "aa:bb:cc:dd:ee:ff", internal: false }],
            "Ethernet 2": [{ mac: "aa:bb:cc:dd:ee:ff", internal: false }]
        })
    };

    const results = emb.runDiscoveryCycle(body,
        emb.createHostSelfDiscoveryAdapter({ os: fakeOs }));
    assert.ok(results.every(r => r.accepted));

    const nics = body.devicesByClass("NETWORK_INTERFACE");
    assert.equal(nics.length, 2, "MAC sama tidak boleh runtuh jadi satu");

    const ids = nics.map(d => d.descriptor.deviceId).sort();
    assert.equal(new Set(ids).size, 2, "id wajib berbeda");

    // tiap id kanonik & benar-benar turunan namespace net.os:
    for (const d of nics) {
        assert.match(d.descriptor.deviceId, /^net\.os:[A-Za-z0-9._:+@{}-]+$/);
        assert.equal(d.descriptor.identity.namespace, "net.os");
        assert.equal(d.descriptor.metadata.macShared, true);
        // kejujuran: mac ganda TIDAK boleh diklaim stable
        assert.equal(d.descriptor.identity.stability, "session");
    }

    // NIC unik tetap deterministik dan klaim stabilnya berdasar bukti:
    const uniqueOs = { ...fakeOs, networkInterfaces: () => ({
        "Ethernet": [{ mac: "aa:bb:cc:dd:ee:ff", internal: false }]
    }) };
    const body2 = makeSchema();
    body2.registerProducer("host.os");
    emb.runDiscoveryCycle(body2,
        emb.createHostSelfDiscoveryAdapter({ os: uniqueOs }));
    const nic = body2.devicesByClass("NETWORK_INTERFACE")[0];
    assert.equal(nic.descriptor.deviceId,
        `net.os:ethernet-${"aa-bb-cc-dd-ee-ff"}`,
        "id NIC unik = nama kanonik + MAC, via canonicalDeviceId");
    assert.equal(nic.descriptor.identity.stability, "stable");
});

/* ========= RT8 — SUBJEK EVENT WAJIB SAMA DENGAN TARGET DIMUTASI ======== */

test("RT8: subject=A + descriptor.deviceId=B → tolak, A dan B tak tersentuh", () => {

    const body = makeSchema();
    body.registerProducer("fake.discovery");
    fake(body, [[{ discover: [
        { deviceId: "usb:2222:bbbb:lain", deviceClass: "CAMERA",
          displayName: "Kamera Lain" }
    ] }]]);
    const digestSebelum = body.digestDurable();

    const r = body.ingest(emb.makeEvent({
        type: "DEVICE_DISCOVERED", source: "fake.discovery",
        provenance: "SYSTEM_SENSOR",
        subject: "usb:1111:aaaa:mica",                    // A
        payload: { descriptor: {
            deviceId: "usb:9999:zzzz:tersembunyi",        // B — korban selundupan
            deviceClass: "KEYBOARD", displayName: "perangkat selundupan"
        } }, clock: body.clock }));

    assert.equal(r.accepted, false);
    assert.equal(r.reason, "EMB_SUBJECT_MISMATCH");
    assert.equal(body.getDevice("usb:1111:aaaa:mica"), null,
        "subjek A tidak boleh tercipta");
    assert.equal(body.getDevice("usb:9999:zzzz:tersembunyi"), null,
        "target B tidak boleh tercipta");
    assert.equal(body.digestDurable(), digestSebelum);
});
