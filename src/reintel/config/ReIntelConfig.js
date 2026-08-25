/**
 * RE Intelligence V0 — konfigurasi terpusat dan feature flag.
 *
 * AETHER_REINTEL = "on" (default) | "off".
 * Semua anggaran (budget) analisis ada DI SINI — tidak ada konstanta
 * tuning yang tersebar di file sumber. Anggaran bersifat DETERMINISTIK
 * (hitungan elemen, bukan waktu-dinding) agar analisis berulang
 * menghasilkan laporan identik.
 *
 * Prinsip: artifact dianggap HOSTILE. Tidak ada alokasi memori berbasis
 * field yang dikendalikan penyerang tanpa batas dari config ini.
 */

const MODES = Object.freeze(["on", "off"]);

const DEFAULTS = Object.freeze({
    schemaVersion: 1,

    /** Batas ukuran & pemindaian (byte). */
    limits: Object.freeze({
        /** File lebih besar dari ini tetap di-hash, tapi tidak deep-parse. */
        maxFileBytes: 64 * 1024 * 1024,
        /** Ukuran buffer header yang dibaca untuk identifikasi. */
        maxHeaderBytes: 64 * 1024,
        /** Ukuran maksimum buffer yang boleh dimuat untuk parsing mendalam. */
        maxDeepParseBytes: 32 * 1024 * 1024,
        /** Batas byte pemindaian string. */
        maxStringScanBytes: 8 * 1024 * 1024,
        /** Panjang minimum printable-string. */
        minStringLength: 4,
        /** Jumlah maksimum string yang diekstrak. */
        maxStrings: 5000,
        /** Jumlah maksimum section PE yang diparse. */
        maxSections: 96,
        /** Jumlah maksimum entri import (DLL + fungsi). */
        maxImports: 2048,
        /** Jumlah maksimum DLL import. */
        maxImportDlls: 128,
        /** Jumlah maksimum nama export. */
        maxExports: 4096,
        /** Jumlah maksimum embedded artifact terdeteksi per artifact. */
        maxEmbeddedArtifacts: 16,
        /** Kedalaman rekursi analisis embedded artifact. */
        maxRecursionDepth: 3,
        /** Panjang maksimum literal yang disimpan sebagai bukti. */
        maxEvidenceLiteralChars: 256,
        /** Batas match per kategori pola skrip. */
        maxScriptMatchesPerCategory: 50,
        /** Ukuran sampel entropy. */
        entropySampleBytes: 64 * 1024
    }),

    /** Confidence numerik 0..1 → level. Banding dokumenter, tanpa pseudo-presisi. */
    confidenceBands: Object.freeze({
        lowBelow: 0.35,      // < 0.35            → LOW
        mediumBelow: 0.7     // [0.35, 0.7)       → MEDIUM; >= 0.7 → HIGH
    })
});

/**
 * Bangun config final: default dibekukan + override dangkal per-grup.
 * Mode "off" tidak mengubah perilaku modul lain — modul ini berdiri sendiri.
 */
function createReIntelConfig(env = process.env, overrides = {}) {
    const rawMode = String(env.AETHER_REINTEL ?? "on").toLowerCase();
    const mode = MODES.includes(rawMode) ? rawMode : "on";

    const limits = Object.freeze({
        ...DEFAULTS.limits,
        ...(overrides.limits ?? {})
    });
    const confidenceBands = Object.freeze({
        ...DEFAULTS.confidenceBands,
        ...(overrides.confidenceBands ?? {})
    });

    return Object.freeze({
        schemaVersion: DEFAULTS.schemaVersion,
        mode,
        limits,
        confidenceBands
    });
}

module.exports = { createReIntelConfig, DEFAULTS, MODES };
