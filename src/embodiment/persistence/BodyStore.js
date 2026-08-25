/**
 * BodyStore — kontrak persistensi V0 (B§8).
 *
 * PEMBEDAAN PENTING:
 *   - observasi sensor  = EPHEMERAL  → cincin memori di BodySchema,
 *     tidak pernah diserialisasi.
 *   - identitas/riwayat = DURABLE    → serialize() + store.
 *
 * V0 menyediakan implementasi MEMORI saja. Alasan: integrasi sqlite
 * yang benar berarti memakai pemilik koneksi database yang sudah ada
 * (konvensi repo), dan itu menembus batas isolasi milestone ini.
 * TITIK INTEGRASI MASA DEPAN (terdokumentasi, belum dieksekusi):
 *   createSqliteBodyStore(db) dengan tabel body_device / body_relationship
 *   yang menerima hasil serialize() apa adanya — bentuk data SUDAH
 *   final, hanya backend penyimpannya yang mengganti.
 */

const { fail } = require("../core/util");

function createMemoryBodyStore() {
    let saved = null;
    return {
        backend: "memory",
        async save(serialized) { saved = serialized; return true; },
        async load() { return saved; }
    };
}

/** Muat skema dari store bila ada simpanan; selain itu skema baru. */
async function loadBodySchema({ store, factory }) {
    if (!store) throw fail("EMB_NO_STORE", "store wajib untuk loadBodySchema");
    const data = await store.load();
    if (!data) return null;
    return factory(data);
}

module.exports = { createMemoryBodyStore, loadBodySchema };
