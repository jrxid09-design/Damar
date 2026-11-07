const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const dns = require("node:dns");

/**
 * CLOSURE — SSRF: ADDRESS PINNING (H2), REDIRECT POLICY (H3),
 * PER-CALL RESOLVER STATE (M2). Jalur nyata di mana pun memungkinkan:
 * socket sungguhan untuk uji rebinding, TLS sungguhan untuk uji SNI.
 */

const ssrf = require("../../src/core/safety/ssrfGuard");

const PUBLIC_IP = { address: "93.184.216.34", family: 4 };
// TEST-NET-2: klasifikasi publik, nyata-nya tak ter-route — aman untuk
// membuktikan "alamat ini yang DICOBA, bukan yang lain".
const UNREACHABLE_PUBLIC = "198.51.100.7";

function imgResponse(buf, type = "image/jpeg") {
    return new Response(buf ?? Buffer.from("x"), {
        status: 200,
        headers: { "content-type": type }
    });
}

function redirectResponse(location) {
    return new Response(null, { status: 302, headers: { location } });
}

// ---- 7. DNS REBINDING / TOCTOU — pinned address -------------------------

test("H2-7: lookup#1 publik → lookup#2 privat — alamat privat TIDAK PERNAH dihubungi", async () => {

    // Korban: server loopback sungguhan. Bila guard me-resolve ulang
    // lewat OS pada saat connect, inilah yang akan disentuh.
    let victimHits = 0;
    const victim = http.createServer((req, res) => {
        victimHits++;
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end(Buffer.from("korbAN"));
    });
    await new Promise(r => victim.listen(0, "127.0.0.1", r));

    try {
        let lookupCalls = 0;
        const answers = [
            [{ address: UNREACHABLE_PUBLIC, family: 4 }],   // jawaban #1: publik
            [{ address: "127.0.0.1", family: 4 }]           // jawaban #2+: privat
        ];

        // Port 81 (bukan 80/443): proxy transparan jarang menyentuhnya,
        // jadi koneksi ke TEST-NET gagal deterministik di lingkungan mana pun.
        const result = await ssrf.guardedFetch("http://rebind.test:81/img.jpg", {
            timeoutMs: 2000,
            _lookup: async () => {
                const ans = answers[Math.min(lookupCalls, answers.length - 1)];
                lookupCalls++;
                return ans;
            }
        }).then(
            ok => ({ ok }),
            err => ({ err })
        );

        assert.ok(result.err, `koneksi ke ${UNREACHABLE_PUBLIC} wajib gagal (pin)`);
        assert.doesNotMatch(String(result.err.message ?? ""), /privat|tidak diizinkan/i,
            "penolakan berasal dari koneksi ke alamat PERTAMA tervalidasi, bukan validasi kedua");
        assert.ok(lookupCalls >= 1);

        // Bukti utama: korban privat TIDAK PERNAH menerima permintaan.
        assert.equal(victimHits, 0,
            "alamat privat tidak boleh pernah dihubungi");
    }
    finally {
        await new Promise(r => victim.close(r));
    }

});

test("H2-7b: pin fungsional — lookup terkunci mengabaikan hostname (semua bentuk callback)", () => {

    const lk = ssrf.pinnedLookup(PUBLIC_IP.address, 4);

    lk("evil.rebind.test", { all: true }, (err, entries) => {
        assert.equal(err, null);
        assert.deepEqual(entries, [{ address: PUBLIC_IP.address, family: 4 }]);
    });

    lk("evil.rebind.test", {}, (err, address, family) => {
        assert.equal(err, null);
        assert.equal(address, PUBLIC_IP.address);
        assert.equal(family, 4);
    });

    // Jawaban campuran publik+privat → seluruh target ditolak sejak awal.
    assert.rejects(
        () => ssrf.guardedFetch("https://mixed.example/img.jpg", {
            _lookup: async () => [
                { address: PUBLIC_IP.address, family: 4 },
                { address: "10.9.9.9", family: 4 }
            ],
            _fetch: async () => imgResponse()
        })
    );
});

test("H2-7c: SETIAP hop re-pin — dispatcher per hop, alamat per host", async () => {

    const lookups = [];
    const dispatchers = [];
    const hops = [];

    const fakeFetch = async (url, init) => {
        hops.push(String(url));
        dispatchers.push(init?.dispatcher ?? null);
        if (hops.length === 1) {
            return redirectResponse("https://hop2.example/img.jpg");
        }
        return imgResponse(Buffer.from("ok"));
    };

    const { buffer } = await ssrf.guardedFetch("https://hop1.example/jump", {
        _fetch: fakeFetch,
        _lookup: async (host) => {
            lookups.push(host);
            return host === "hop1.example"
                ? [PUBLIC_IP]
                : [{ address: "198.51.100.9", family: 4 }];
        }
    });

    assert.deepEqual(buffer, Buffer.from("ok"));
    assert.deepEqual(lookups, ["hop1.example", "hop2.example"],
        "tujuan redirect wajib resolve→validate ulang");
    assert.equal(hops.length, 2);
    assert.ok(dispatchers[0] && dispatchers[1], "kedua hop memakai transport ter-pin");
    assert.notEqual(dispatchers[0], dispatchers[1],
        "dispatcher adalah state per-panggilan/hop (M2), bukan global");
});

test("H2-7d: jawaban IPv6 — publik dipin (family 6), ULA/link-local ditolak", async () => {

    const PUB6 = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

    let seenDispatcher = null;
    const { buffer } = await ssrf.guardedFetch("https://six.example/img.jpg", {
        _lookup: async () => [PUB6],
        _fetch: async (url, init) => {
            seenDispatcher = init?.dispatcher ?? null;
            return imgResponse(Buffer.from("v6"));
        }
    });
    assert.deepEqual(buffer, Buffer.from("v6"));
    assert.ok(seenDispatcher, "IPv6 publik tetap lewat transport ter-pin");

    for (const bad of ["fc00::1", "fe80::1", "::ffff:10.0.0.1"]) {
        await assert.rejects(
            () => ssrf.guardedFetch("https://sixbad.example/img.jpg", {
                _lookup: async () => [{ address: bad, family: 6 }],
                _fetch: async () => imgResponse()
            }),
            /tidak diizinkan|privat/,
            `${bad} wajib ditolak`
        );
    }
});

// ---- HTTPS: SNI + verifikasi sertifikat tetap hidup di atas pin ---------

/** Sertifikat self-signed untuk satu nama DNS; null bila tak bisa dibuat. */
function selfSignedCertFor(dir, hostname) {

    const fs = require("node:fs");
    const path = require("node:path");
    const { execFileSync } = require("node:child_process");

    const keyFile = path.join(dir, "key.pem");
    const crtFile = path.join(dir, "crt.pem");

    // Sertifikat sah HANYA untuk nama hostname — bukan untuk IP/localhost.
    const args = [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyFile, "-out", crtFile, "-days", "1",
        "-subj", `/CN=${hostname}`,
        "-addext", `subjectAltName=DNS:${hostname}`
    ];

    const attempts = [
        argv => execFileSync("openssl", argv, { stdio: "ignore" }),
        // Lingkungan Windows+WSL: openssl hidup di dalam WSL.
        argv => {
            const wslize = p => p
                .replace(/^([A-Za-z]):[\\/]/, (_, d) => `/mnt/${d.toLowerCase()}/`)
                .replace(/\\/g, "/");
            execFileSync(
                "wsl.exe",
                ["-e", "openssl", ...argv.map(a =>
                    [keyFile, crtFile].includes(a) ? wslize(a) : a)],
                { stdio: "ignore" }
            );
        }
    ];

    for (const run of attempts) {
        try {
            run(args);
            return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile) };
        }
        catch { /* coba jalur berikutnya */ }
    }

    return null;

}

test("H2-7e: HTTPS ter-pin — SNI & verifikasi hostname tetap ditegakkan", async () => {

    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssrf-tls-"));
    const material = selfSignedCertFor(dir, "pin.test");

    if (!material) {
        fs.rmSync(dir, { recursive: true, force: true });
        return test.skip("openssl tidak tersedia untuk membuat sertifikat uji");
    }

    const { key, cert } = material;

    // Alamat pin harus berkelas yang DIIZINKAN kebijakan. Loopback adalah
    // kelas tolak-keras — pakai alamat RFC1918 antarmuka nyata mesin ini
    // dan jalankan di bawah policy trusted-lan (kelas kamera).
    const os2 = require("node:os");
    const hostIp = Object.values(os2.networkInterfaces())
        .flat()
        .find(i => i && i.family === "IPv4" && !i.internal &&
                   ssrf.addressClass(i.address) === "rfc1918")?.address;

    if (!hostIp) {
        fs.rmSync(dir, { recursive: true, force: true });
        return test.skip("tidak ada antarmuka RFC1918 untuk pin TLS");
    }

    let handshakes = 0;
    const https = require("node:https");
    const hnd = (req, res) => {
        handshakes++;
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end("tls-ok");
    };
    const secure = https.createServer({ key, cert }, hnd);

    await new Promise(r => secure.listen(0, hostIp, r));
    const port = secure.address().port;

    try {
        // POSITIF: URL memakai NAMA pin.test, koneksi dipin ke hostIp;
        // SNI = pin.test, sertifikat cocok → sukses end-to-end.
        const { buffer } = await ssrf.guardedFetch(`https://pin.test:${port}/img.jpg`, {
            policy: "trusted-lan",
            timeoutMs: 5000,
            connect: { ca: [cert] },
            _lookup: async () => [{ address: hostIp, family: 4 }]
        });
        assert.equal(buffer.toString(), "tls-ok",
            "pinned HTTPS dengan nama yang cocok harus berhasil");
        assert.ok(handshakes >= 1, "TLS handshake sungguhan terjadi");

        // NEGATIF: nama lain (other.test) dipin ke server yang SAMA —
        // verifikasi hostname/sertifikat HARUS menolak; kalau guard
        // mematikan verifikasi, uji ini pasti gagal.
        handshakes = 0;
        await assert.rejects(
            () => ssrf.guardedFetch(`https://other.test:${port}/img.jpg`, {
                policy: "trusted-lan",
                timeoutMs: 5000,
                connect: { ca: [cert] },
                _lookup: async () => [{ address: hostIp, family: 4 }]
            }),
            (err) => {
                // undici membungkus: alasan sesungguhnya ada di cause.
                const text = [
                    err?.message, err?.code,
                    err?.cause?.message, err?.cause?.code
                ].map(x => String(x ?? "")).join(" ");
                return /certificate|CERT|altname|hostname|unable to verify|socket|ECONNRESET/i
                    .test(text);
            },
            "hostname mismatch wajib ditolak verifikasi TLS"
        );
    }
    finally {
        await new Promise(r => secure.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    }

});

test("H2-7f: pin kebal global fetch yang dibayangi pihak lain", async () => {

    const fsMod = require("node:fs");
    const tmpDir = fsMod.mkdtempSync(
        require("node:path").join(require("node:os").tmpdir(), "ssrf-tls2-"));
    const material = selfSignedCertFor(tmpDir, "pin.test");
    if (!material) {
        fsMod.rmSync(tmpDir, { recursive: true, force: true });
        return test.skip("openssl tidak tersedia");
    }

    const { key, cert } = material;
    const https = require("node:https");
    let hits = 0;
    const secure = https.createServer({ key, cert }, (req, res) => {
        hits++;
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end("tls-still-ok");
    });
    await new Promise(r => secure.listen(0, "127.0.0.1", r));
    const port = secure.address().port;

    // Bayangi global fetch dengan implementasi ASING — guard tetap
    // wajib memakai keluarga undici milik dispatchernya.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("global fetch dibayangi"); };

    try {
        const { buffer } = await ssrf.guardedFetch(`https://pin.test:${port}/img.jpg`, {
            policy: "trusted-lan",
            timeoutMs: 5000,
            connect: { ca: [cert] },
            _lookup: async () => [{ address: "127.0.0.1", family: 4 }]
        });
        assert.equal(buffer.toString(), "tls-still-ok");
        assert.ok(hits >= 1);
    }
    finally {
        globalThis.fetch = realFetch;
        await new Promise(r => secure.close(r));
        fsMod.rmSync(tmpDir, { recursive: true, force: true });
    }

});

// ---- 8. TRUSTED-LAN: redirect tidak mewarisi kepercayaan -----------------

test("H3-8: kamera LAN → 302 → metadata 169.254.169.254 = DENY sebelum fetch", async () => {

    const fetchCalls = [];

    await assert.rejects(
        () => ssrf.guardedFetch("http://192.168.1.50/snapshot.jpg", {
            policy: "trusted-lan",
            _fetch: async (url) => {
                fetchCalls.push(String(url));
                return redirectResponse("http://169.254.169.254/latest/meta-data/");
            }
        }),
        /tidak diizinkan|linklocal-metadata/i,
        "tujuan redirect metadata wajib DENY"
    );

    assert.equal(fetchCalls.length, 1,
        "hop kedua ditolak SEBELUM fetch dieksekusi");
});

test("H3-8b: daftar tolak keras redirect trusted-lan per kelas & nama", async () => {

    const cases = [
        ["http://169.254.169.254/latest/meta-data/", /linklocal-metadata/],
        ["http://127.0.0.1:9000/private.jpg", /loopback/],
        ["http://100.64.0.1/x.jpg", /cgnat/],
        ["http://0.0.0.0/x.jpg", /unspecified/],
        ["http://224.0.0.1/x.jpg", /multicast-reserved/]
    ];

    for (const [dest, match] of cases) {
        await assert.rejects(
            () => ssrf.guardedFetch("http://192.168.1.50/snap.jpg", {
                policy: "trusted-lan",
                _fetch: async () => redirectResponse(dest)
            }),
            match,
            `${dest} wajib DENY`
        );
    }

    // Metadata sebagai NAMA host juga ditolak walau policy tepercaya.
    await assert.rejects(
        () => ssrf.guardedFetch("http://192.168.1.50/snap.jpg", {
            policy: "trusted-lan",
            _fetch: async () => redirectResponse("http://metadata.google.internal/computeMetadata/v1/")
        }),
        /metadata/
    );
});

test("H3-8c: redirect trusted-lan ke kelas eksplisit-diizinkan tetap JALAN", async () => {

    // RFC1918 → RFC1918 (UI kamera sering redirect dalam LAN): sah.
    const bytes = Buffer.from("frame-lanjutan");
    const { buffer } = await ssrf.guardedFetch("http://192.168.1.50/snap.jpg", {
        policy: "trusted-lan",
        _fetch: async (url) =>
            String(url).endsWith("snap.jpg")
                ? redirectResponse("http://10.0.0.20/frame.jpg")
                : imgResponse(bytes)
    });
    assert.deepEqual(buffer, bytes);

    // Origin loopback tetap sah bila MEMANG terdaftar pemilik (mock/
    // kamera lokal) — kepercayaan origin adalah milik registry; yang
    // dilucuti adalah warisan ke tujuan redirect (lihat 8b).
    const bytesLocal = Buffer.from("frame-lokal");
    const { buffer: bufLocal } = await ssrf.guardedFetch("http://127.0.0.1/snap.jpg", {
        policy: "trusted-lan",
        _fetch: async () => imgResponse(bytesLocal)
    });
    assert.deepEqual(bufLocal, bytesLocal);
});

// ---- 9. PER-CALL RESOLVER STATE — tanpa kontaminasi silang ---------------

test("M2-9: resolver per-panggilan — konkuren tidak saling mencemari", async () => {

    const callsA = [];
    const callsB = [];

    const [resA, resB] = await Promise.allSettled([
        ssrf.guardedFetch("https://clean.example/img.jpg", {
            _lookup: async (host) => { callsA.push(host); return [PUBLIC_IP]; },
            _fetch: async () => imgResponse(Buffer.from("A"))
        }),
        ssrf.guardedFetch("https://dirty.example/img.jpg", {
            _lookup: async (host) => { callsB.push(host); return [{ address: "10.0.0.1", family: 4 }]; },
            _fetch: async () => imgResponse(Buffer.from("B"))
        })
    ]);

    assert.equal(resA.status, "fulfilled", "permintaan A tetap sukses");
    assert.deepEqual(resA.value.buffer, Buffer.from("A"));

    assert.equal(resB.status, "rejected", "permintaan B ditolak DNS privatnya sendiri");
    assert.match(String(resB.reason?.message ?? resB.reason ?? ""), /10\.0\.0\.1/);

    assert.deepEqual(callsA, ["clean.example"], "A memakai resolver A");
    assert.deepEqual(callsB, ["dirty.example"], "B memakai resolver B");
    assert.equal(callsB.includes("clean.example"), false,
        "resolver B tidak pernah menyentuh host milik A");
});

test("M2-9b: setelah injeksi kustom, panggilan bersih memakai DNS default lagi", async () => {

    // Panggilan dengan resolver kustom yang menjawab privat:
    await assert.rejects(
        () => ssrf.guardedFetch("https://poisoned.example/img.jpg", {
            _lookup: async () => [{ address: "172.16.5.5", family: 4 }],
            _fetch: async () => imgResponse()
        }),
        /172\.16\.5\.5/
    );

    // Panggilan BERIKUTNYA tanpa injeksi wajib kembali ke resolver OS
    // default — bukan mewarisi resolver kustom di atas.
    const realLookup = dns.promises.lookup.bind(dns.promises);
    let defaultUsed = 0;
    dns.promises.lookup = async (host, opts) => {
        defaultUsed++;
        throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    };

    try {
        await assert.rejects(
            () => ssrf.guardedFetch("https://offline.invalid/img.jpg"),
            (err) => /DNS gagal|ENOTFOUND/.test(String(err.message)) &&
                     !/172\.16\.5\.5/.test(String(err.message)),
            "error harus datang dari resolver DEFAULT (ENOTFOUND), bukan jawaban sisa"
        );
        assert.ok(defaultUsed >= 1,
            "resolver default benar-benar dipakai — tidak ada state global tersisa");
    }
    finally {
        dns.promises.lookup = realLookup;
    }
});
