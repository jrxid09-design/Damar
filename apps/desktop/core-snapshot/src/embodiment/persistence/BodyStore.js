/**
 * BodyStore — kontrak persistensi V0 (B§8).
 *
 * PEMBEDAAN PENTING:
 *   - observasi sensor  = EPHEMERAL  → cincin memori di BodySchema,
 *     tidak pernah diserialisasi.
 *   - identitas/riwayat = DURABLE    → serialize() + store.
 *
 * BATAS REFERENSI: save() MENYALIN input secara mendalam; load()
 * mengembalikan salinan segar. Dua BodySchema tidak akan pernah
 * berbagi graf objek lewat store — mutasi hasil load tidak pernah
 * menyentuh sumber, dan sebaliknya.
 *
 * V0 menyediakan implementasi MEMORI saja. TITIK INTEGRASI MASA DEPAN
 * (terdokumentasi, belum dieksekusi): createSqliteBodyStore(db) dengan
 * tabel body_device / body_relationship yang menerima hasil serialize()
 * apa adanya — bentuk data SUDAH final, hanya backend penyimpannya
 * yang mengganti. Batas JSON (stringify→parse) adalah batas kepercayaan
 * minimum yang harus diuji paritasnya.
 */

const { fail } = require("../core/util");
const { structuredCopy } = require("../core/util");

function createMemoryBodyStore() {
    let saved = null;
    return {
        backend: "memory",
        async save(serialized) { saved = structuredCopy(serialized); return true; },
        async load() { return saved ? structuredCopy(saved) : null; }
    };
}

/** Muat skema dari store bila ada simpanan; selain itu null. */
async function loadBodySchema({ store }) {
    if (!store) throw fail("EMB_NO_STORE", "store wajib untuk loadBodySchema");
    return store.load();
}

module.exports = { createMemoryBodyStore, loadBodySchema };
