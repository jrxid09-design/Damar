const test = require("node:test");
const assert = require("node:assert");

const {
    detectAddresses,
    companionUrls,
    isTailscaleRange,
    isPrivateLan
} = require("../../src/companion/addresses");

/**
 * Deteksi alamat akses companion — LAN vs Tailscale (CGNAT 100.64/10).
 */

// ---- Klasifikasi IP ----

test("isTailscaleRange: rentang CGNAT 100.64–100.127", () => {
    assert.equal(isTailscaleRange("100.64.1.2"), true);
    assert.equal(isTailscaleRange("100.100.1.2"), true);
    assert.equal(isTailscaleRange("100.127.255.255"), true);
    assert.equal(isTailscaleRange("100.63.1.2"), false);   // di bawah
    assert.equal(isTailscaleRange("100.128.1.2"), false);  // di atas
});

test("isPrivateLan: rentang privat umum", () => {
    assert.equal(isPrivateLan("192.168.1.5"), true);
    assert.equal(isPrivateLan("10.0.0.2"), true);
    assert.equal(isPrivateLan("172.16.0.1"), true);
    assert.equal(isPrivateLan("172.31.9.9"), true);
    assert.equal(isPrivateLan("172.32.0.1"), false);
    assert.equal(isPrivateLan("8.8.8.8"), false);
});

// ---- detectAddresses dengan interfaces injeksi ----

const FAKE = {
    "Ethernet": [
        { address: "192.168.1.10", family: "IPv4", internal: false }
    ],
    "Tailscale": [
        { address: "100.101.22.33", family: "IPv4", internal: false }
    ],
    "Loopback Pseudo-Interface 1": [
        { address: "127.0.0.1", family: "IPv4", internal: true }
    ],
    "vEthernet (WSL)": [
        { address: "172.20.96.1", family: "IPv4", internal: false }
    ]
};

test("detectAddresses: memisahkan tailscale, lan, dan abaikan loopback", () => {

    const a = detectAddresses({ port: 3000, hostname: "pc-ronny", interfaces: FAKE });

    assert.equal(a.host, "pc-ronny");
    assert.equal(a.port, 3000);

    assert.equal(a.tailscale.length, 1);
    assert.equal(a.tailscale[0].address, "100.101.22.33");

    // 192.168 (LAN) dan 172.20 (vEthernet) masuk lan — keduanya privat.
    assert.equal(a.lan.length, 2);
    assert.ok(a.lan.some(l => l.address === "192.168.1.10"));

    // loopback tidak muncul di mana pun.
    assert.ok(!JSON.stringify(a).includes("127.0.0.1"));
});

test("detectAddresses: nama interface 'tailscale*' ikut terdeteksi walau IP di luar CGNAT", () => {

    const fake = {
        "tailscale0": [{ address: "100.200.1.1", family: "IPv4", internal: false }]
    };

    const a = detectAddresses({ port: 3000, interfaces: fake });

    // 100.200 di luar 64–127, tapi nama interface "tailscale0" → tetap tailscale.
    assert.equal(a.tailscale.length, 1);
});

// ---- companionUrls ----

test("companionUrls: tailscale didahulukan, URL lengkap dengan port", () => {

    const access = {
        host: "pc",
        port: 3000,
        lan: [{ address: "192.168.1.10", iface: "Ethernet" }],
        tailscale: [{ address: "100.64.0.1", iface: "Tailscale" }]
    };

    const urls = companionUrls(access);

    assert.equal(urls.length, 2);
    assert.equal(urls[0].kind, "tailscale");                       // prioritas
    assert.equal(urls[0].url, "http://100.64.0.1:3000/companion");
    assert.equal(urls[1].url, "http://192.168.1.10:3000/companion");
});
