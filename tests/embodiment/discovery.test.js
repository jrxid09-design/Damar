const test = require("node:test");
const assert = require("node:assert");

/**
 * DISCOVERY V0 — kontrak adapter, fake deterministik, adapter host
 * nyata yang kecil (B0.24 + kelanjutan B0.3/B0.4 lewat adapter).
 */

const emb = require("../../src/embodiment");

const T0 = 1_000_000;

test("B0.24: fake adapter membuktikan siklus hidup penuh tanpa perangkat keras", () => {

    const body = emb.createBodySchema({ clock: emb.manualClock(T0) });
    body.registerProducer("fake.discovery");

    const adapter = emb.createFakeDiscoveryAdapter({
        id: "fake.discovery",
        script: [
            // 1) muncul:
            [{ discover: [
                { deviceId: "host.os:kantor", deviceClass: "HOST", displayName: "kantor" },
                { deviceId: "usb:1111:aaaa:mica", deviceClass: "AUDIO_INPUT",
                  displayName: "Mic USB",
                  identity: { namespace: "usb", stableKey: "1111:aaaa:mica",
                              stability: "stable" },
                  capabilities: ["audio.capture"],
                  relationships: [
                      { type: "attached_to", fromId: "usb:1111:aaaa:mica",
                        toId: "host.os:kantor" },
                      { type: "provides", fromId: "usb:1111:aaaa:mica",
                        toId: "audio.capture" }
                  ] }
            ] }],
            // 2) sakit:
            [{ health: { deviceId: "usb:1111:aaaa:mica", status: "degraded" } }],
            // 3) hilang:
            [{ remove: ["usb:1111:aaaa:mica"] }],
            // 4) muncul lagi — ID kanonik sama:
            [{ discover: [
                { deviceId: "usb:1111:aaaa:mica", deviceClass: "AUDIO_INPUT",
                  displayName: "Mic USB",
                  capabilities: ["audio.capture"] }
            ] }]
        ]
    });

    for (let i = 0; i < 4; i++) {
        const results = emb.runDiscoveryCycle(body, adapter);
        assert.ok(results.every(r => r.accepted), `langkah ${i}: ${JSON.stringify(results)}`);
    }

    assert.equal(body.getDevice("usb:1111:aaaa:mica").descriptor.state, "online");
    assert.equal(body.getRelationships({ fromId: "usb:1111:aaaa:mica" }).length, 2);
    assert.equal(body.counts().devices, 2);
});

test("B0.24b: siklus habis → tenang; adapter divalidasi gagal-tutup", () => {

    const body = emb.createBodySchema({ clock: emb.manualClock(T0) });
    body.registerProducer("fake.discovery");
    const adapter = emb.createFakeDiscoveryAdapter({
        script: [[{ discover: [] }]]
    });
    emb.runDiscoveryCycle(body, adapter);
    assert.deepEqual(emb.runDiscoveryCycle(body, adapter), []);

    // kontrak dilanggar → melempar, bukan diam-diam:
    assert.throws(() => emb.createFakeDiscoveryAdapter({
        id: "ID BURUK", script: []
    }), (e) => e.code === "EMB_INVALID_PRODUCER_ID");
    assert.throws(() => emb.runDiscoveryCycle(body, { id: "tanpa.next", namespaces: ["x"] }),
        (e) => e.code === "EMB_INVALID_ADAPTER");
});

test("adapter host nyata: tubuh minimal dengan kejujuran identitas", () => {

    const body = emb.createBodySchema({ clock: emb.manualClock(T0) });
    body.registerProducer("host.os");

    // injeksi os palsu agar deterministik & tanpa sentuhan sistem:
    const fakeOs = {
        hostname: () => "mesin-damar",
        platform: () => "win32",
        arch: () => "x64",
        cpus: () => [{ model: "Test CPU Model" }, { model: "Test CPU Model" }],
        totalmem: () => 34_359_738_368,
        networkInterfaces: () => ({
            "Ethernet": [{ mac: "aa:bb:cc:dd:ee:ff", internal: false,
                           address: "192.168.1.10", family: "IPv4" }],
            "Loopback Pseudo-Interface 1": [
                { mac: "00:00:00:00:00:00", internal: true, address: "127.0.0.1" }]
        })
    };

    const adapter = emb.createHostSelfDiscoveryAdapter({ os: fakeOs });
    const results = emb.runDiscoveryCycle(body, adapter);
    assert.ok(results.every(r => r.accepted));

    const devices = body.listDevices();
    const classes = Object.fromEntries(
        devices.map(d => [d.descriptor.deviceClass, true]));
    assert.ok(classes.HOST && classes.CPU && classes.MEMORY
        && classes.NETWORK_INTERFACE);

    // loopback tidak dilaporkan sebagai tepi tubuh:
    assert.equal(devices.filter(d =>
        d.descriptor.deviceClass === "NETWORK_INTERFACE").length, 1);

    // kejujuran identitas: host stabil, CPU/memori hanya klaim sesi:
    const host = body.getDevice("host.os:mesin-damar");
    assert.equal(host.descriptor.identity.stability, "stable");
    const cpu = body.devicesByClass("CPU")[0];
    assert.equal(cpu.descriptor.identity.stability, "session");

    // topologi terhubung ke host:
    const attached = body.getRelationships({ type: "attached_to" });
    assert.ok(attached.length >= 2);
    assert.ok(attached.every(r => r.toId === "host.os:mesin-damar"));

    // deterministik: dua pemanggilan berikutnya tidak menambah apa pun
    // (idempoten pada level perangkat):
    const before = body.counts().devices;
    emb.runDiscoveryCycle(body, adapter);
    body.clock.advance(1_000);
    emb.runDiscoveryCycle(body, adapter);
    assert.equal(body.counts().devices, before);
});
