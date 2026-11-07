/**
 * Proses anak untuk tests/safety/offline.test.js.
 *
 * Dijalankan terpisah dengan SENGAJA: jalur keluar diputus di sini
 * sebelum satu pun modul Damar dimuat, jadi tidak ada koneksi yang
 * sempat dibuka lebih dulu lalu dipakai ulang diam-diam. Ini lebih
 * dekat ke keadaan "mesin ini memang tidak punya internet" daripada
 * memblokir di tengah proses yang sudah berjalan.
 *
 * Alasan kedua yang praktis: dengan jalur keluar mati, ada sesuatu di
 * runtime yang belum melepas pegangannya sehingga proses tidak kunjung
 * selesai sendiri. Di dalam daemon yang memang hidup terus itu tak
 * berakibat, tetapi di test runner ia menggantung seluruh suite. Anak
 * ini keluar eksplisit setelah menjawab.
 *
 * Hasil ditulis sebagai satu baris JSON ke stdout.
 */

const net = require("node:net");
const dns = require("node:dns");

const HOST_LOKAL =
    /^(localhost|127\.\d+\.\d+\.\d+|::1|0:0:0:0:0:0:0:1)$/i;

const lokal = (host) =>
    HOST_LOKAL.test(String(host ?? "localhost").replace(/^\[|\]$/g, ""));

const aslinya = {
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup
};

net.Socket.prototype.connect = function (...args) {

    const opsi = (typeof args[0] === "object" && args[0] !== null)
        ? args[0]
        : { port: args[0], host: args[1] };

    const host = opsi.host ?? opsi.hostname ?? "localhost";

    if (!lokal(host)) {

        // Gagal seperti jaringan mati sungguhan: error asinkron pada
        // socket, bukan throw sinkron yang tak pernah terjadi nyata.
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

const lapor = (hasil) => {
    process.stdout.write(JSON.stringify(hasil));
    process.exit(0);
};

(async () => {

    // Alat ukurnya dibuktikan lebih dulu, di dalam proses yang sama
    // dengan inferensinya. Blokir yang tidak bekerja akan membuat
    // "lulus" di bawah ini tidak berarti apa-apa.
    let blokirBekerja = false;

    try {
        await fetch("https://api.github.com/");
    }
    catch {
        blokirBekerja = true;
    }

    if (!blokirBekerja) {
        return lapor({ ok: false, alasan: "blokir jalur keluar tidak bekerja di proses anak" });
    }

    try {

        const runtime = require("../../src/services/aiRuntimeService");

        // tools: [] disengaja — yang diuji jalur INFERENSI tanpa
        // internet, bukan pemilihan tool. Di CPU, melampirkan tool
        // menambah ~777 token yang dibayar dengan belasan detik.
        const jawaban = await runtime.chat({
            messages: [{ role: "user", content: "Jawab singkat: sebutkan warna langit." }],
            tools: []
        });

        const teks = String(
            jawaban?.content ?? jawaban?.text ?? jawaban?.message?.content ?? ""
        ).trim();

        return lapor({
            ok: teks.length > 0,
            panjang: teks.length,
            cuplikan: teks.slice(0, 120),
            model: jawaban?.model ?? null
        });

    }
    catch (error) {
        return lapor({ ok: false, alasan: error.message });
    }

})();
