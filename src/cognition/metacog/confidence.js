"use strict";

/**
 * W7-L6 METACOGNITION — fungsi confidence murni (spec §3, MC-1/MC-2).
 * SATU-SATUNYA penulis `value` — tidak ada jalur lain yang boleh menyetel
 * angka confidence langsung (MC-A1). `evidenceQuality` diasumsikan sudah
 * dihitung pemanggil dari SUMBER BERBEDA (bukan pesan berulang, MC-A7).
 */

const { clamp01 } = require("../core/envelope");
const { BOUNDS } = require("./bounds");

const BASIS = Object.freeze([
    "VERIFIED_EVIDENCE", "MULTI_SOURCE", "SINGLE_SOURCE", "STALE_SOURCE",
    "INFERENCE_ONLY", "NO_EVIDENCE", "CONTESTED"
]);

const STALE_AFTER_MS = 30 * 60_000;

// Bug review independen (audit putaran-29, AUD29-P2-2): putaran-28
// menutup crash-nya (Symbol pada baca KEDUA tidak lagi meledak), tapi
// determineBasis dan computeConfidence tetap membaca evidenceQuality
// SECARA TERPISAH -- getter/Proxy stateful yang mengembalikan nilai sah
// pada baca pertama (dipakai determineBasis memilih basis) lalu nilai
// LAIN pada baca kedua (dipakai computeConfidence menghitung value)
// menghasilkan basis dan value yang TIDAK KONSISTEN untuk satu evidenceQuality
// yang sama -- pelanggaran MC-1/MC-2 (satu-satunya penulis, deterministik).
// Field dibaca SEKALI di sini ke snapshot, dipakai bersama oleh determineBasis
// (via basisFromSafe) MAUPUN computeConfidence -- tidak pernah membaca
// evidenceQuality mentah lebih dari sekali per panggilan publik.
function sanitizeEvidenceQuality(evidenceQuality) {
    // Bug review independen (audit putaran-21, AUD21-ADV-1): evidenceQuality
    // null/undefined meledakkan destructuring jadi TypeError mentah --
    // diperlakukan sebagai "tidak ada bukti" (NO_EVIDENCE), gagal aman,
    // bukan crash.
    const raw = evidenceQuality || {};
    // Bug review independen (audit putaran-27, AUD27-P2-6): field numerik
    // dari evidenceQuality dulu dipakai APA ADANYA di perbandingan relasi
    // (`> 0`, `>= 2`, `=== 1`) -- Symbol meledakkan TypeError mentah di
    // perbandingan itu (relational comparison memaksa ToNumber), dan
    // `{valueOf(){...}}` mengeksekusi valueOf pemanggil. Dinormalisasi ke
    // angka aman (0 kalau bukan angka valid) sebelum dipakai.
    const safeNumber = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : 0;
    return {
        sourceCount: safeNumber(raw.sourceCount),
        contradictionCount: safeNumber(raw.contradictionCount),
        verifiedCount: safeNumber(raw.verifiedCount),
        freshestAtMs: (typeof raw.freshestAtMs === "number" && Number.isFinite(raw.freshestAtMs)) ? raw.freshestAtMs : null,
        inferenceOnly: raw.inferenceOnly === true
    };
}

function basisFromSafe(safe, nowMs) {
    if (safe.contradictionCount > 0) return "CONTESTED";
    if (safe.verifiedCount > 0) return "VERIFIED_EVIDENCE";
    if (safe.sourceCount >= 2) return "MULTI_SOURCE";
    if (safe.sourceCount === 1) {
        const age = safe.freshestAtMs !== null ? nowMs - safe.freshestAtMs : Infinity;
        return age > STALE_AFTER_MS ? "STALE_SOURCE" : "SINGLE_SOURCE";
    }
    if (safe.inferenceOnly) return "INFERENCE_ONLY";
    return "NO_EVIDENCE";
}

function determineBasis(evidenceQuality, nowMs) {
    return basisFromSafe(sanitizeEvidenceQuality(evidenceQuality), nowMs);
}

function confidenceFromSafe(safe, nowMs) {
    const basis = basisFromSafe(safe, nowMs);

    let raw;
    switch (basis) {
        case "VERIFIED_EVIDENCE": raw = 0.85 + 0.03 * Math.min(safe.verifiedCount, 5); break;
        case "MULTI_SOURCE": raw = 0.55 + 0.05 * Math.min(safe.sourceCount, 6); break;
        case "SINGLE_SOURCE": raw = 0.45; break;
        case "STALE_SOURCE": raw = 0.25; break;
        case "INFERENCE_ONLY": raw = 0.30; break; // MC-A7: repetisi tidak menambah sumber, ceiling tetap rendah
        case "CONTESTED": raw = 0.30; break;
        case "NO_EVIDENCE":
        default: raw = 0;
    }

    let value = clamp01(raw);
    if (basis === "NO_EVIDENCE") value = Math.min(value, BOUNDS.NO_EVIDENCE_CEILING);

    return Object.freeze({ value, basis });
}

/** MC-1/MC-2: fungsi murni, deterministik, dan satu-satunya penulis value. */
function computeConfidence(evidenceQuality, nowMs) {
    // SATU pembacaan evidenceQuality untuk seluruh panggilan ini -- basis
    // DAN value berasal dari snapshot yang SAMA, tidak pernah dari dua
    // pembacaan terpisah (lihat komentar AUD29-P2-2 di atas).
    return confidenceFromSafe(sanitizeEvidenceQuality(evidenceQuality), nowMs);
}

module.exports = {
    BASIS, STALE_AFTER_MS, determineBasis, computeConfidence,
    // Bug review independen (audit putaran-30, AUD30-P2-3): diekspor
    // supaya pemanggil (mis. metacog/records.js's makeAssessment) bisa
    // menyaring evidenceQuality SEKALI dan menurunkan value/basis DAN
    // salinan tersimpan dari snapshot yang SAMA persis -- alih-alih
    // makeAssessment membaca evidenceQuality mentah lagi secara terpisah
    // setelah computeConfidence sudah menyaringnya sendiri di dalam.
    sanitizeEvidenceQuality, confidenceFromSafe
};
