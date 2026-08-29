const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "../../data");

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "damar.db");

/**
 * MIGRASI NAMA BERKAS — data/aether.db → data/damar.db.
 *
 * Rename identitas TIDAK BOLEH menghapus state pemilik. Basis data
 * lama dipindahkan APA ADANYA (tanpa membaca/menulis skema) beserta
 * sidecar WAL/SHM, HANYA bila:
 *
 *   - berkas kanonik `damar.db` belum ada, DAN
 *   - berkas lama `aether.db` ada
 *
 * Idempoten: setelah sekali berjalan `damar.db` ada, sehingga
 * pemanggilan berikutnya (restart/reload) tidak melakukan apa pun.
 * Tidak pernah ada dua penyimpanan aktif sekaligus.
 *
 * Dijalankan SEBELUM koneksi dibuka supaya tidak ada WAL aktif.
 */
function adoptLegacyDatabase() {

    const legacyPath = path.join(dataDir, "aether.db");

    if (fs.existsSync(dbPath) || !fs.existsSync(legacyPath)) return;

    fs.renameSync(legacyPath, dbPath);

    for (const suffix of ["-wal", "-shm"]) {
        const from = legacyPath + suffix;
        const to = dbPath + suffix;
        if (fs.existsSync(from) && !fs.existsSync(to)) {
            try { fs.renameSync(from, to); }
            catch { /* sidecar opsional: SQLite membangunnya ulang */ }
        }
    }

}

adoptLegacyDatabase();

const db = new sqlite3.Database(dbPath, (err) => {

    if (err) {

        console.error(
            "SQLite connection failed:",
            err.message
        );

    }

});

module.exports = db;