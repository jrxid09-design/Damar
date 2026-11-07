const test = require("node:test");
const assert = require("node:assert");

/**
 * D — SSRF GUARD: URL model/pengguna tidak boleh menyentuh jaringan
 * internal. Resolver & fetch disuntik agar deterministik offline;
 * logika validasi, redirect per-hop, batas ukuran, dan kebijakan
 * trusted-lan dijalankan KODENYA YANG SEBENARNYA.
 */

const ssrf = require("../../src/core/safety/ssrfGuard");

const PUBLIC_IP = { address: "93.184.216.34", family: 4 };

function imgResponse(buf, type = "image/jpeg") {
    return new Response(buf, { status: 200, headers: { "content-type": type } });
}

function redirectResponse(location) {
    return new Response(null, { status: 302, headers: { location } });
}

const BLOCKED_TARGETS = [
    "http://127.0.0.1/snap.jpg",
    "http://localhost/snap.jpg",
    "http://LOCALHOST:8080/x.jpg",
    "http://[::1]/snap.jpg",
    "http://192.168.1.10/snap.jpg",
    "http://10.0.0.5/photo.jpg",
    "http://172.16.0.9/img.jpg",
    "http://172.31.255.254/img.jpg",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.170.2/v2/credentials",
    "http://100.64.0.1/x.jpg",
    "http://0.0.0.0/x.jpg",
    "http://[fc00::1]/x.jpg",
    "http://[fe80::1]/x.jpg",
    "http://[::ffff:10.0.0.1]/x.jpg",
    "http://camera.local/snap.jpg",
    "file:///etc/passwd",
    "ftp://example.com/x.jpg"
];

test("D: target loopback/RFC1918/link-local/metadata/IPv6-lokal ditolak", async () => {

    for (const url of BLOCKED_TARGETS) {
        await assert.rejects(
            () => ssrf.guardedFetch(url, { _fetch: async () => imgResponse(Buffer.from("x")) }),
            undefined,
            `${url} wajib ditolak`
        );
    }

});

test("D: DNS yang me-resolve ke alamat privat ditolak (anti rebinding)", async () => {

    let fetchCalls = 0;

    await assert.rejects(
        () => ssrf.guardedFetch("https://rebind.example/img.jpg", {
            _lookup: async () => [{ address: "192.168.0.44", family: 4 }],
            _fetch: async () => { fetchCalls++; return imgResponse(Buffer.from("x")); }
        })
    );

    assert.equal(fetchCalls, 0, "fetch tidak boleh terjadi setelah DNS privat");

    // Semua hasil resolve dinilai — satu saja privat → tolak.
    await assert.rejects(
        () => ssrf.guardedFetch("https://mixed.example/img.jpg", {
            _lookup: async () => [
                { address: "93.184.216.34", family: 4 },
                { address: "10.9.9.9", family: 4 }
            ],
            _fetch: async () => imgResponse(Buffer.from("x"))
        })
    );

});

test("D: redirect publik→privat divalidasi ulang dan DITOLAK", async () => {

    const fetchCalls = [];

    await assert.rejects(
        () => ssrf.guardedFetch("https://public.example/jump", {
            _lookup: async (host) =>
                host === "public.example"
                    ? [PUBLIC_IP]
                    : [{ address: "127.0.0.1", family: 4 }],
            _fetch: async (url) => {
                fetchCalls.push(String(url));
                return redirectResponse("http://127.0.0.1:9000/private.jpg");
            }
        })
    );

    assert.equal(fetchCalls.length, 1,
        "hop kedua harus ditolak SEBELUM fetch dieksekusi");

});

test("D: gambar publik normal DIIZINKAN end-to-end guard", async () => {

    const bytes = Buffer.from("gambar-palsu-untuk-uji");

    const { buffer } = await ssrf.guardedFetch("https://cdn.example/cat.jpg", {
        _lookup: async () => [PUBLIC_IP],
        _fetch: async () => imgResponse(bytes)
    });

    assert.deepEqual(buffer, bytes);

});

test("D: konten bukan-gambar ditolak; ukuran melebihi batas ditolak", async () => {

    await assert.rejects(
        () => ssrf.guardedFetch("https://cdn.example/page", {
            _lookup: async () => [PUBLIC_IP],
            _fetch: async () => new Response("<html>halo</html>", {
                status: 200, headers: { "content-type": "text/html" }
            })
        }),
        /bukan gambar/
    );

    await assert.rejects(
        () => ssrf.guardedFetch("https://cdn.example/big.jpg", {
            maxBytes: 1000,
            _lookup: async () => [PUBLIC_IP],
            _fetch: async () => imgResponse(Buffer.alloc(4000, 7))
        }),
        /batas ukuran/
    );

});

test("D: kamera LAN tepercaya TETAP BERJALAN lewat policy khusus registry", async () => {

    const bytes = Buffer.from("frame-cctv-lan");

    // URL registry kamera pemilik (LAN) — trusted-lan mengizinkan.
    const { buffer } = await ssrf.guardedFetch("http://192.168.1.50/snapshot.jpg", {
        policy: "trusted-lan",
        _lookup: async () => [],
        _fetch: async () => imgResponse(bytes)
    });
    assert.deepEqual(buffer, bytes);

    // ...tetapi skema tetap dibatasi walau trusted.
    await assert.rejects(
        () => ssrf.guardedFetch("ftp://192.168.1.50/snap", {
            policy: "trusted-lan",
            _fetch: async () => imgResponse(Buffer.from("x"))
        })
    );

    // URL arbitrer user TIDAK boleh memakai trusted-lan lewat jalur
    // public default — tetap ditolak.
    await assert.rejects(
        () => ssrf.guardedFetch("http://192.168.1.50/snapshot.jpg", {
            _fetch: async () => imgResponse(Buffer.from("x"))
        })
    );

});

test("D: visionService.analyzeUrl menolak URL privat (jalur describe_image)", async () => {

    const vision = require("../../src/services/visionService");

    await assert.rejects(
        () => vision.analyzeUrl({
            url: "http://169.254.169.254/latest/meta-data/",
            prompt: "apa isinya?"
        }),
        /privat|loopback|link/i
    );

});
