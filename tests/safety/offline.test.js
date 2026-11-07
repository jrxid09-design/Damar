const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const dns = require("node:dns");

/**
 * Uji offline yang benar-benar menguji offline (§276 pertanyaan 10).
 *
 * Pemeriksaan sebelumnya di scripts/audit-276.js menambal
 * globalThis.fetch DI DALAM PROSES AUDIT SENDIRI, lalu memanggil
 * /api/tags — daftar model, bukan inferensi. Daemon yang seharusnya
 * diuji berjalan di proses lain dan jaringannya tidak pernah
 * disentuh. "LULUS" di sana tidak membuktikan Damar dapat menjawab
 * tanpa internet; buktinya bahkan berbunyi "jalur inferensi tetap
 * terjawab" padahal tak ada satu pun inferensi yang dijalankan.
 * Persis kelas klaim sukses palsu yang dibangun VerificationEngine
 * untuk menangkapnya (§222).
 *
 * Di sini jalur keluar diputus pada lapisan SOCKET, bukan pada satu
 * API: fetch/undici, http, https, dan pustaka apa pun yang membuka
 * koneksi ikut terblokir. Localhost tetap boleh supaya layanan lokal —
 * yang memang berjalan di mesin ini — tetap terjangkau.
 *
 * Jaringan pengguna TIDAK disentuh. Memutusnya sungguhan dapat
 * memutus Tailscale dan akses pemilik ke mesinnya sendiri.
 */

const HOST_LOKAL =
    /^(localhost|127\.\d+\.\d+\.\d+|::1|0:0:0:0:0:0:0:1)$/i;

const lokal = (host) =>
    HOST_LOKAL.test(String(host ?? "localhost").replace(/^\[|\]$/g, ""));

const aslinya = {
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup
};

/** Putuskan seluruh jalur keluar non-lokal untuk proses ini saja. */
function putuskanJalurKeluar() {

    net.Socket.prototype.connect = function (...args) {

        const opsi = (typeof args[0] === "object" && args[0] !== null)
            ? args[0]
            : { port: args[0], host: args[1] };

        const host = opsi.host ?? opsi.hostname ?? "localhost";

        if (!lokal(host)) {

            // Gagal seperti jaringan mati sungguhan: error asinkron
            // pada socket, bukan throw sinkron yang tak pernah terjadi
            // di dunia nyata.
            process.nextTick(() => {
                this.destroy(Object.assign(
                    new Error(`uji-offline: koneksi ke ${host} diblokir`),
                    { code: "ENETUNREACH" }
                ));
            });

            return this;

        }

        return aslinya.connect.apply(this, args);

    };

    dns.lookup = function (hostname, opsi, callback) {

        if (typeof opsi === "function") {
            callback = opsi;
            opsi = {};
        }

        if (!lokal(hostname)) {
            return process.nextTick(() => callback(Object.assign(
                new Error(`uji-offline: DNS ${hostname} diblokir`),
                { code: "ENOTFOUND" }
            )));
        }

        return aslinya.lookup.call(dns, hostname, opsi, callback);

    };

}

function pulihkanJalurKeluar() {
    net.Socket.prototype.connect = aslinya.connect;
    dns.lookup = aslinya.lookup;
}

// Otak lokal kini in-process (node-llama-cpp) — tidak butuh server.
// Prasyaratnya cuma satu: ada berkas GGUF di models/.
const modelLokalAda = () => {
    try {
        const fs = require("node:fs");
        const path = require("node:path");
        const dir = path.join(__dirname, "..", "..", "models");
        return fs.readdirSync(dir).some(f => f.toLowerCase().endsWith(".gguf"));
    }
    catch {
        return false;
    }
};

// ---------------------------------------------------------------------
// 1. Alat ukurnya sendiri harus terbukti dulu.
//
// Tanpa langkah ini, seluruh berkas ini bisa "lulus" hanya karena
// blokirnya tidak pernah bekerja — kesalahan yang sama dengan
// pemeriksaan audit yang digantikannya.
// ---------------------------------------------------------------------

test("blokir jalur keluar benar-benar memutus host non-lokal", async () => {

    putuskanJalurKeluar();

    try {

        await assert.rejects(
            () => fetch("https://api.github.com/"),
            "host non-lokal masih terjangkau — blokir tidak bekerja, " +
            "jadi uji offline di berkas ini tidak membuktikan apa pun"
        );

    }
    finally {
        pulihkanJalurKeluar();
    }

});

test("blokir jalur keluar TIDAK ikut memutus localhost", async (t) => {

    // Server kecil DI DALAM uji ini: deterministik, tak bergantung
    // layanan luar mana pun yang mungkin tidak berjalan.
    const http = require("node:http");
    const server = http.createServer((_req, res) => res.end("ok"));

    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    putuskanJalurKeluar();

    try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        assert.ok(res.ok, "layanan localhost ikut terputus — blokirnya terlalu luas");
    }
    finally {
        pulihkanJalurKeluar();
        server.close();
    }

});

// ---------------------------------------------------------------------
// 2. Pertanyaan yang sesungguhnya: Damar tetap MENJAWAB tanpa internet.
//
// Dijalankan di proses ANAK (tests/helpers/offlineChild.js): jalur
// keluar di sana mati sebelum satu pun modul Damar dimuat, sehingga
// tidak ada koneksi yang sempat dibuka lebih dulu lalu dipakai ulang.
// Dengan jalur keluar mati, runtime juga belum melepas seluruh
// pegangannya — tak berakibat pada daemon yang hidup terus, tetapi di
// test runner ia menggantung suite bila dijalankan sedang-proses.
// ---------------------------------------------------------------------

test("Damar tetap menjawab dengan seluruh jalur keluar mati", async (t) => {

    if (!modelLokalAda()) {
        return t.skip("Tidak ada model GGUF di models/ — otak lokal tak bisa diuji");
    }

    const { spawnSync } = require("node:child_process");
    const path = require("node:path");

    const anak = spawnSync(
        process.execPath,
        [
            "--require", path.join(__dirname, "..", "helpers", "testEnv.js"),
            path.join(__dirname, "..", "helpers", "offlineChild.js")
        ],
        { encoding: "utf8", timeout: 300000, cwd: path.join(__dirname, "..", "..") }
    );

    assert.equal(anak.status, 0, `proses anak gagal keluar bersih: ${anak.stderr?.slice(-400)}`);

    const baris = String(anak.stdout ?? "").trim().split("\n").pop();

    let hasil;

    try {
        hasil = JSON.parse(baris);
    }
    catch {
        assert.fail(`proses anak tidak melaporkan JSON: ${String(anak.stdout).slice(-400)}`);
    }

    assert.ok(
        hasil.ok,
        `inferensi lokal tidak menjawab saat offline: ${hasil.alasan ?? JSON.stringify(hasil)}`
    );

    assert.ok(hasil.panjang > 0, "jawaban kosong");

});
