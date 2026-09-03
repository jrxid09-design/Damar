"use strict";

/**
 * Batas terpusat impor spasial privat (MD-003).
 *
 * Satu sumber kebenaran untuk semua batas parser KML/KMZ/CSV/GeoJSON.
 * Nilai bisa dikonfigurasi per pemanggilan TETAPI hanya DI BAWAH hard
 * maxima di sini — tidak ada konfigurasi yang bisa melampaui plafon.
 * Data yang melanggar batas DITOLAK (fail closed), tidak pernah
 * diam-diam dipotong untuk bidang yang relevan keamanan.
 */

const HARD_LIMITS = Object.freeze({
    /** Ukuran file input maksimum (bytes). */
    MAX_FILE_BYTES: 20 * 1024 * 1024,          // 20 MB
    /** Jumlah fitur/asset maksimum per impor. */
    MAX_FEATURES: 50000,
    /** Ukuran satu field/metadata string maksimum (bytes). */
    MAX_FIELD_BYTES: 4096,
    /** Total bytes metadata per fitur. */
    MAX_METADATA_BYTES: 64 * 1024,
    /** Jumlah koordinat maksimum per geometri. */
    MAX_GEOMETRY_COORDINATES: 20000,
    /** Kedalaman geometri bersarang maksimum (Polygon→ring→titik = 3). */
    MAX_GEOMETRY_DEPTH: 4,
    /** Kedalaman JSON maksimum. */
    MAX_JSON_DEPTH: 64,
    /** Kedalaman XML maksimum. */
    MAX_XML_DEPTH: 32,
    /** Jumlah elemen XML maksimum. */
    MAX_XML_ELEMENTS: 200000,
    /** Jumlah entry ZIP maksimum. */
    MAX_ZIP_ENTRIES: 200,
    /** Total bytes terkompresi ZIP maksimum. */
    MAX_ZIP_COMPRESSED_BYTES: 20 * 1024 * 1024,
    /** Total bytes terekspansi ZIP maksimum. */
    MAX_ZIP_EXPANDED_BYTES: 40 * 1024 * 1024,
    /** Bytes terekspansi per entry ZIP maksimum. */
    MAX_ZIP_ENTRY_BYTES: 20 * 1024 * 1024,
    /** Rasio ekspansi ZIP maksimum (anti zip-bomb). */
    MAX_ZIP_RATIO: 200,
    /** Bytes per string di dalam XML/JSON (name, description, dll). */
    MAX_STRING_BYTES: 8192,
    /** Jumlah baris CSV maksimum. */
    MAX_CSV_ROWS: 100000,
    /** Jumlah kolom CSV maksimum. */
    MAX_CSV_COLUMNS: 128,
    /** Ukuran satu sel CSV maksimum (bytes). */
    MAX_CSV_CELL_BYTES: 8192,
    /** Jumlah kolom metadata yang dipertahankan per fitur. */
    MAX_METADATA_KEYS: 64
});

/** Plafon yang TIDAK bisa dinaikkan siapa pun. */
const CEILINGS = Object.freeze({
    MAX_FILE_BYTES: 100 * 1024 * 1024,
    MAX_FEATURES: 200000,
    MAX_FIELD_BYTES: 65536,
    MAX_METADATA_BYTES: 1024 * 1024,
    MAX_GEOMETRY_COORDINATES: 100000,
    MAX_GEOMETRY_DEPTH: 8,
    MAX_JSON_DEPTH: 128,
    MAX_XML_DEPTH: 64,
    MAX_XML_ELEMENTS: 1000000,
    MAX_ZIP_ENTRIES: 1000,
    MAX_ZIP_COMPRESSED_BYTES: 100 * 1024 * 1024,
    MAX_ZIP_EXPANDED_BYTES: 200 * 1024 * 1024,
    MAX_ZIP_ENTRY_BYTES: 100 * 1024 * 1024,
    MAX_ZIP_RATIO: 1000,
    MAX_STRING_BYTES: 65536,
    MAX_CSV_ROWS: 500000,
    MAX_CSV_COLUMNS: 512,
    MAX_CSV_CELL_BYTES: 65536,
    MAX_METADATA_KEYS: 256
});

/**
 * Resolve batas efektif: overrides ≤ plafon; di luar itu pakai default.
 * @param {object} [overrides]
 * @returns {object} frozen limits
 */
function resolveImportLimits(overrides) {
    const effective = {};
    for (const key of Object.keys(HARD_LIMITS)) {
        const ceiling = CEILINGS[key];
        const requested = overrides?.[key];
        effective[key] = (Number.isSafeInteger(requested) && requested > 0 && requested <= ceiling)
            ? requested
            : Math.min(HARD_LIMITS[key], ceiling);
    }
    return Object.freeze(effective);
}

module.exports = Object.freeze({
    HARD_LIMITS,
    CEILINGS,
    resolveImportLimits
});
