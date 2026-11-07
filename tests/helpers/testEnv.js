const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Pemasangan lingkungan untuk seluruh berkas tes.
 *
 * Dimuat lewat `--require` sebelum berkas tes mana pun dijalankan,
 * karena setiap berkas tes berjalan di prosesnya sendiri: mengatur
 * ini di satu berkas tidak melindungi berkas lainnya.
 *
 * Tanpa ini, tes yang menyentuh `toolGuard` menulis peristiwa palsu
 * ke jejak audit sungguhan. Jejak audit yang tercampur data tes
 * tidak dapat dipercaya justru saat dibutuhkan untuk menelusuri
 * kejadian nyata — dan itu menghapus seluruh gunanya.
 */

if (!process.env.DAMAR_AUDIT_DIR) {
    process.env.DAMAR_AUDIT_DIR =
        fs.mkdtempSync(path.join(os.tmpdir(), "damar-audit-test-"));
}

// Basis memori juga. Tes buildMemory sempat menitipkan 9 catatan
// palsu ke memori sungguhan, dan karena memori disuntikkan ke
// system prompt, catatan "Area: uji" itu benar-benar muncul sebagai
// konteks saat pengguna menyapa Damar.
if (!process.env.DAMAR_MEMORY_DB) {
    process.env.DAMAR_MEMORY_DB = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "damar-memdb-test-")),
        "memory.db"
    );
}

// Basis sesi percakapan kanal (src/channels) juga diisolasi — tes
// kanal tidak boleh menulis ke data/channels.db sungguhan.
if (!process.env.DAMAR_CHANNEL_DB) {
    process.env.DAMAR_CHANNEL_DB = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "damar-chandb-test-")),
        "channels.db"
    );
}

// Snapshot kontinuitas sesi (Wave 5 Lane 4) juga diisolasi — tes host
// mana pun yang membangun komposisi produksi tidak boleh menulis ke
// ~/.damar/continuity-v1.json milik pengguna sungguhan.
if (!process.env.DAMAR_CONTINUITY_STATE) {
    process.env.DAMAR_CONTINUITY_STATE = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "damar-cont-test-")),
        "continuity.json"
    );
}

// R5-03: basis data otoritas kanonik produksi (authority-v1.db) juga
// diisolasi — tes komposisi produksi tidak boleh menyentuh store
// otoritas sungguhan pemilik. Default ke mode memori (non-durable)
// agar tes deterministik; tes durability menyetel path eksplisit.
if (!process.env.DAMAR_AUTHORITY_DB) {
    process.env.DAMAR_AUTHORITY_DB = "memory";
}

// R5-03: state Owner/Admin trust kanonik juga diisolasi — komposisi
// produksi yang dijalankan tes tidak boleh menulis ke
// ~/.damar/ownertrust-v1.json milik pengguna sungguhan. Mode memori =
// non-durable, deterministik.
if (!process.env.DAMAR_OWNER_TRUST_STATE) {
    process.env.DAMAR_OWNER_TRUST_STATE = "memory";
}

process.on("exit", () => {

    for (const jalur of [
        process.env.DAMAR_AUDIT_DIR,
        process.env.DAMAR_MEMORY_DB && path.dirname(process.env.DAMAR_MEMORY_DB),
        process.env.DAMAR_CHANNEL_DB && path.dirname(process.env.DAMAR_CHANNEL_DB),
        process.env.DAMAR_CONTINUITY_STATE && path.dirname(process.env.DAMAR_CONTINUITY_STATE)
    ]) {
        try {
            if (jalur && /damar-(audit|memdb|chandb|cont)-test-/.test(jalur)) {
                fs.rmSync(jalur, { recursive: true, force: true });
            }
        }
        catch { /* biarkan OS yang membersihkan */ }
    }

});
