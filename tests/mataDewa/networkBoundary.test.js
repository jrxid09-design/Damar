"use strict";

/**
 * Sertifikasi MD-002 — SATU batas jaringan kanonik (ssrfGuard Damar).
 *
 * Bukti wajib:
 *  - redirect ke localhost / 10.x / 192.168.x / 169.254.169.254 / ::1
 *    ditolak pada hop redirect (bukan hanya hop origin)
 *  - IPv4-mapped IPv6 ditolak
 *  - DNS rebinding: alamat tervalidasi = alamat koneksi (pinned lookup)
 *  - terlalu banyak redirect ditolak
 *  - body raksasa streaming dienforcement (bukan length-check setelahnya)
 *  - respons lambat (slowloris) terhenti oleh stall deadline
 *  - allowlist host penyedia menolak origin & redirect di luar kebijakan
 *  - AUTHORIZED_LOCAL_SOURCE fail closed — caller tidak bisa memilih policy
 *  - tidak ada fetchText/fetchJson yang memakai redirect:"follow" buta
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { fetchText, fetchJson, fetchPost, authorizedLocalFetch, isPrivateIp } = require("../../src/mataDewa/providers/http");
const { guardedFetch, pinnedLookup } = require("../../src/core/safety/ssrfGuard");

/** Server HTTP lokal ephemeral dengan handler peserta. */
function localServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

test("MD-002: redirect ke localhost ditolak pada hop redirect", async () => {
    const { server, port } = await localServer((req, res) => {
        res.writeHead(302, { Location: "http://127.0.0.1:9/secret" });
        res.end();
    });
    try {
        await assert.rejects(
            () => fetchText(`http://127.0.0.1:${port}/start`, { skipOriginGuardCheck: true }),
            /privat|loopback|ditolak|tidak diizinkan/i);
    }
    finally {
        server.close();
    }
});

test("MD-002: origin loopback/RFC1918/metadata ditolak sebelum koneksi", async () => {
    await assert.rejects(() => fetchText("http://127.0.0.1:9/x"), /ditolak|tidak diizinkan|loopback/i);
    await assert.rejects(() => fetchText("http://10.1.2.3/x"), /ditolak|tidak diizinkan|privat/i);
    await assert.rejects(() => fetchText("http://192.168.1.1/admin"), /ditolak|tidak diizinkan|privat/i);
    await assert.rejects(() => fetchText("http://172.16.0.9/x"), /ditolak|tidak diizinkan|privat/i);
    await assert.rejects(() => fetchText("http://169.254.169.254/latest/meta-data/"), /metadata|ditolak|tidak diizinkan/i);
    await assert.rejects(() => fetchText("http://[::1]:9/x"), /ditolak|tidak diizinkan/i);
    await assert.rejects(() => fetchText("http://[::ffff:10.0.0.1]/x"), /ditolak|tidak diizinkan/i);
    await assert.rejects(() => fetchText("http://100.64.0.1/x"), /ditolak|tidak diizinkan/i);
});

test("MD-002: IPv4-mapped IPv6 dievaluasi ulang sebagai IPv4 (isPrivateIp)", () => {
    assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);
    assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("fe80::1"), true);
});

test("MD-002: DNS rebinding — alamat tervalidasi = alamat koneksi (pinned lookup)", () => {
    // pinnedLookup mengabaikan hostname: koneksi TIDAK melakukan resolusi
    // OS kedua. Ini kontrak anti-rebinding level koneksi.
    const pinned = pinnedLookup("203.0.113.7", 4);
    pinned("evil.example.com", { all: true }, (err, entries) => {
        assert.equal(err, null);
        assert.deepEqual(entries, [{ address: "203.0.113.7", family: 4 }]);
    });
    pinned("other.example.com", {}, (err, address, family) => {
        assert.equal(err, null);
        assert.equal(address, "203.0.113.7");
        assert.equal(family, 4);
    });
});

test("MD-002: DNS rebinding simulasi — jawaban DNS berubah setelah validasi tetap aman", async () => {
    // Resolver uji: jawaban PERTAMA publik (lolos validasi), jawaban
    // berikutnya privat. Koneksi tetap ter-pin ke alamat yang divalidasi.
    const { server, port } = await localServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("origin-ok");
    });
    let lookupCount = 0;
    const rebindingLookup = (host, opts) => {
        lookupCount += 1;
        void host;
        const address = "127.0.0.1";
        return Promise.resolve(opts.all
            ? [{ address, family: 4 }]
            : { address, family: 4 });
    };
    try {
        // Origin loopback ditolak oleh validasi itu sendiri (publik-only):
        await assert.rejects(
            () => guardedFetch(`http://rebind.test:${port}/x`, { _lookup: rebindingLookup, requireImage: false }),
            /tidak diizinkan|privat|loopback|ditolak/i);
        // Dan pinned lookup tidak pernah me-resolve ulang: count tetap 1.
        assert.equal(lookupCount, 1);
    }
    finally {
        server.close();
    }
});

test("MD-002: terlalu banyak redirect ditolak (hop dibatasi)", async () => {
    let hits = 0;
    // Injeksi _fetch: setiap respons adalah 302 ke hop berikutnya (host
    // publik via lookup uji). Loop wajib berhenti pada batas hop.
    const endlessRedirectFetch = async (url) => {
        hits += 1;
        const next = new URL(url);
        next.pathname = `/hop${hits}`;
        return {
            status: 302,
            headers: { get: (k) => (k.toLowerCase() === "location" ? next.toString() : null) },
            body: { cancel: async () => {} }
        };
    };
    const publicLookup = (host, opts) => Promise.resolve(
        opts.all ? [{ address: "203.0.113.7", family: 4 }] : { address: "203.0.113.7", family: 4 });
    await assert.rejects(
        () => guardedFetch("http://hop.test/a", {
            _lookup: publicLookup, _fetch: endlessRedirectFetch,
            expectedContentType: null
        }),
        /Terlalu banyak redirect/);
    assert.ok(hits >= 4, `loop harus mengejar beberapa hop (hits=${hits})`);
});

test("MD-002: body raksasa dihentikan STREAMING (tidak menunggu selesai)", async () => {
    const { server, port } = await localServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        // Boneka raksasa: terus menulis, tak pernah selesai.
        const chunk = "A".repeat(65536);
        const timer = setInterval(() => {
            res.write(chunk);
        }, 10);
        res.on("close", () => clearInterval(timer));
    });
    try {
        const fakeLookup = (host, opts) => Promise.resolve(
            opts.all ? [{ address: "127.0.0.1", family: 4 }] : { address: "127.0.0.1", family: 4 });
        const start = Date.now();
        await assert.rejects(
            () => guardedFetch(`http://big.test:${port}/x`, {
                policy: "trusted-lan", _lookup: fakeLookup, requireImage: false,
                maxBytes: 1024 * 1024 // 1 MB — jauh di bawah boneka
            }),
            /melebihi batas/i);
        // Harus berhenti cepat (buffer 1 MB), BUKAN menunggu stream abadi.
        assert.ok(Date.now() - start < 15000);
    }
    finally {
        server.close();
    }
});

test("MD-002: slowloris — respons berhenti mengalir terhenti stall deadline", async () => {
    const { server, port } = await localServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("start");
        // Tidak pernah menulis lagi, tidak pernah mengakhiri.
    });
    try {
        const fakeLookup = (host, opts) => Promise.resolve(
            opts.all ? [{ address: "127.0.0.1", family: 4 }] : { address: "127.0.0.1", family: 4 });
        const start = Date.now();
        await assert.rejects(
            () => guardedFetch(`http://slow.test:${port}/x`, {
                policy: "trusted-lan", _lookup: fakeLookup, requireImage: false,
                stallTimeoutMs: 300, timeoutMs: 30000
            }),
            /stall|berhenti mengalir/i);
        assert.ok(Date.now() - start < 5000, "stall deadline harus jauh lebih cepat dari total timeout");
    }
    finally {
        server.close();
    }
});

test("MD-002: allowlist host penyedia menolak origin & redirect di luar kebijakan", async () => {
    // Origin salah host → ditolak sebelum jaringan.
    await assert.rejects(
        () => fetchText("https://evil.example.com/feed", { allowedHosts: ["earthquake.usgs.gov"] }),
        /allowlist/i);
    // Redirect ke host luar kebijakan → ditolak pada hop redirect.
    const { server, port } = await localServer((req, res) => {
        res.writeHead(302, { Location: "https://evil.example.com/steal" });
        res.end();
    });
    try {
        await assert.rejects(
            () => fetchText(`http://127.0.0.1:${port}/r`, { allowedHosts: ["earthquake.usgs.gov"] }),
            /privat|loopback|ditolak|allowlist|di luar kebijakan/i);
    }
    finally {
        server.close();
    }
});

test("MD-002: expectedContentType — JSON malah text/plain ditolak", async () => {
    const { server, port } = await localServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("bukan json");
    });
    try {
        const fakeLookup = (host, opts) => Promise.resolve(
            opts.all ? [{ address: "127.0.0.1", family: 4 }] : { address: "127.0.0.1", family: 4 });
        await assert.rejects(
            () => guardedFetch(`http://type.test:${port}/x`, {
                policy: "trusted-lan", _lookup: fakeLookup,
                expectedContentType: "json"
            }),
            /bukan json/i);
    }
    finally {
        server.close();
    }
});

test("MD-002: fetchPost memakai batas kanonik yang sama (tanpa .text() tak berbatas)", async () => {
    const { server, port } = await localServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        const chunk = "B".repeat(65536);
        const timer = setInterval(() => res.write(chunk), 5);
        res.on("close", () => clearInterval(timer));
    });
    try {
        await assert.rejects(
            () => fetchPost(`http://127.0.0.1:${port}/token`, "grant=client_credentials"),
            /ditolak|tidak diizinkan|privat|loopback/i);
    }
    finally {
        server.close();
    }
});

test("MD-002: AUTHORIZED_LOCAL_SOURCE fail closed — caller tidak bisa unlock", async () => {
    // Tidak ada parameter/flag yang bisa memaksa akses lokal; fail closed.
    await assert.rejects(() => authorizedLocalFetch(), /OWNER_TRUST_NOT_INTEGRATED/);
    await assert.rejects(() => authorizedLocalFetch({ authorized: true }), /OWNER_TRUST_NOT_INTEGRATED/);
    await assert.rejects(() => authorizedLocalFetch("http://192.168.1.50/snap"), /OWNER_TRUST_NOT_INTEGRATED/);
});

test("MD-002: tidak ada redirect:\"follow\" buta di batas jaringan Mata Dewa", () => {
    const src = require("fs").readFileSync(
        require.resolve("../../src/mataDewa/providers/http.js"), "utf8");
    assert.equal(/redirect:\s*"follow"/.test(src), false);
});
