"use strict";

/**
 * KOMPATIBILITAS ENV — Aether → Damar (§rename migration).
 *
 * Nama kanonik seluruh konfigurasi runtime kini `DAMAR_*`
 * (dan `DAMARSELF_DIR`). Instalasi lama memakai `AETHER_*`.
 *
 * Modul ini MENYELARASKAN keduanya di dalam proses:
 *
 *   AETHER_X terisi, DAMAR_X kosong  → DAMAR_X = AETHER_X
 *   DAMAR_X  terisi, AETHER_X kosong → AETHER_X = DAMAR_X
 *
 * ATURAN LOAD-BEARING:
 *
 *   1. TIDAK PERNAH menimpa nilai yang sudah ada. Kunci kanonik
 *      (DAMAR_*) selalu menang bila keduanya diset.
 *   2. Kunci yang TIDAK ADA tetap TIDAK ADA. Ini menjaga perilaku
 *      fail-closed autentikasi: `DAMAR_TOKEN` kosong tetap kosong,
 *      tidak pernah "dibuatkan" nilai.
 *   3. Idempoten — aman dipanggil berkali-kali (sebelum dan sesudah
 *      dotenv memuat .env).
 *   4. Ini ALIAS NAMA, bukan identitas kedua: satu nilai, dua ejaan,
 *      arah kanonik jelas ke Damar.
 *
 * DEPRECATED: ejaan `AETHER_*` dipertahankan hanya sebagai jalur
 * migrasi. Lihat docs/architecture/DAMAR-IDENTITY-MIGRATION.md.
 */

const LEGACY_PREFIX = "AETHER_";
const CANONICAL_PREFIX = "DAMAR_";

/** Pasangan kunci yang tidak mengikuti pola prefiks. */
const EXPLICIT_PAIRS = [
    ["AETHERSELF_DIR", "DAMARSELF_DIR"]
];

/** Salin bila tujuan belum terisi; kembalikan true bila menyalin. */
function fill(env, from, to) {
    if (env[from] === undefined) return false;
    if (env[to] !== undefined) return false;
    env[to] = env[from];
    return true;
}

/**
 * @param {NodeJS.ProcessEnv} [env] default process.env
 * @returns {string[]} nama kunci kanonik yang diisi dari ejaan lama
 */
function applyEnvCompat(env = process.env) {

    const adopted = [];

    for (const [legacy, canonical] of EXPLICIT_PAIRS) {
        if (fill(env, legacy, canonical)) adopted.push(canonical);
        fill(env, canonical, legacy);
    }

    // Snapshot kunci: menulis ke env sambil mengiterasinya harus aman.
    for (const key of Object.keys(env)) {
        if (key.startsWith(LEGACY_PREFIX)) {
            const canonical = CANONICAL_PREFIX + key.slice(LEGACY_PREFIX.length);
            if (fill(env, key, canonical)) adopted.push(canonical);
        }
    }

    for (const key of Object.keys(env)) {
        if (key.startsWith(CANONICAL_PREFIX)) {
            fill(env, key, LEGACY_PREFIX + key.slice(CANONICAL_PREFIX.length));
        }
    }

    return adopted;

}

// Dijalankan saat require: env SHELL sudah tersedia sebelum dotenv.
applyEnvCompat();

module.exports = { applyEnvCompat, LEGACY_PREFIX, CANONICAL_PREFIX, EXPLICIT_PAIRS };
