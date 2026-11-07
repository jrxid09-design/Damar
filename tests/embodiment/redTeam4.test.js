const test = require("node:test");
const assert = require("node:assert");

/**
 * RED-TEAM ROUND 4 — integritas baris modern WAJIB.
 *
 * Baris durable yang membawa presence/health modern TANPA rowDigest
 * ditolak gagal-tutup (EMB_DIGEST_MISSING). Jalur legacy hanya untuk
 * baris yang mengabaikan ketiganya sekaligus.
 */

const emb = require("../../src/embodiment");

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

/** Snapshot perangkat online + health failing (baris modern penuh). */
function snapFailingOnline() {
    const body = makeSchema();
    fake(body, [[{ discover: [{ deviceId: MIC,
        deviceClass: "AUDIO_INPUT", displayName: "Mic",
        capabilities: ["audio.capture"] }] }]]);
    fake(body, [[{ health: { deviceId: MIC, status: "failing",
        detail: "sensor mati" } }]]);
    return body;
}

function restoreMustReject(data, nama) {
    let threw = null;
    try { emb.BodySchema.restore(data, { clock: emb.manualClock(T0) }); }
    catch (err) { threw = err; }
    assert.ok(threw, `${nama}: harusnya ditolak`);
    assert.equal(threw.code, "EMB_INVALID_SERIALIZATION", nama);
    assert.ok(threw.details.some(d => /EMB_DIGEST_MISSING/.test(d)),
        `${nama}: diagnostik wajib menyebut EMB_DIGEST_MISSING — ${threw.details}`);
    return threw;
}

test("R4-1: tamper health + hapus rowDigest → REJECT (bukan lolos sbg legacy)", () => {

    const data = JSON.parse(JSON.stringify(snapFailingOnline().serialize()));
    const row = data.devices.find(d => d.descriptor.deviceId === MIC);

    row.health.status = "healthy";   // tamu tanpa jejak
    delete row.rowDigest;            // dan coba lewat pintu legacy

    restoreMustReject(data, "health-digodok-rowDigest-dihapus");
});

test("R4-2: tamper presence + hapus rowDigest → REJECT", () => {

    const data = JSON.parse(JSON.stringify(makeSchema().serialize()));
    // pastikan ada perangkat:
    const src = makeSchema();
    fake(src, [[{ discover: [{ deviceId: MIC,
        deviceClass: "AUDIO_INPUT", displayName: "Mic" }] }]]);
    const d2 = JSON.parse(JSON.stringify(src.serialize()));
    const row = d2.devices.find(x => x.descriptor.deviceId === MIC);

    row.presence.state = "removed";  // sembunyikan perangkat dari tubuh
    delete row.rowDigest;

    restoreMustReject(d2, "presence-digodok-rowDigest-dihapus");
});

test("R4-3: baris modern SAH tanpa rowDigest pun ditolak (tanpa nilai digodok)", () => {

    const data = JSON.parse(JSON.stringify(snapFailingOnline().serialize()));
    const row = data.devices.find(d => d.descriptor.deviceId === MIC);
    delete row.rowDigest;            // nilai utuh, integritas hilang

    restoreMustReject(data, "modern-tanpa-integritas");
});

test("R4-4: legacy murni (tanpa rowDigest/presence/health) → ACCEPT + kanonik", () => {

    const data = JSON.parse(JSON.stringify(snapFailingOnline().serialize()));
    for (const row of data.devices) {
        delete row.rowDigest;
        delete row.presence;
        delete row.health;
    }

    const restored = emb.BodySchema.restore(data, { clock: emb.manualClock(T0) });

    // serialisasi ulang = format kanonik saat ini dengan rowDigest:
    const canonical = restored.serialize();
    for (const row of canonical.devices) {
        assert.equal(typeof row.rowDigest, "string");
        assert.match(row.rowDigest, /^[0-9a-f]{64}$/);
        assert.ok("presence" in row && "health" in row);
    }

    // deterministik: restore kedua identik byte-untuk-byte
    const again = emb.BodySchema.restore(
        JSON.parse(JSON.stringify(canonical)), { clock: emb.manualClock(T0) });
    assert.deepEqual(again.serialize(), canonical);

    // dan setelah migrasi, integritas aktif: godokan ditolak.
    const tampered = JSON.parse(JSON.stringify(canonical));
    tampered.devices.find(d => d.descriptor.deviceId === MIC)
        .presence.state = "offline";
    assert.throws(() => emb.BodySchema.restore(tampered,
        { clock: emb.manualClock(T0) }),
    (e) => e.code === "EMB_INVALID_SERIALIZATION");
});
