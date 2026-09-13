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

function determineBasis(evidenceQuality, nowMs) {
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
    const sourceCount = safeNumber(raw.sourceCount);
    const contradictionCount = safeNumber(raw.contradictionCount);
    const verifiedCount = safeNumber(raw.verifiedCount);
    const freshestAtMs = (typeof raw.freshestAtMs === "number" && Number.isFinite(raw.freshestAtMs)) ? raw.freshestAtMs : null;
    const inferenceOnly = raw.inferenceOnly === true;

    if (contradictionCount > 0) return "CONTESTED";
    if (verifiedCount > 0) return "VERIFIED_EVIDENCE";
    if (sourceCount >= 2) return "MULTI_SOURCE";
    if (sourceCount === 1) {
        const age = freshestAtMs !== null ? nowMs - freshestAtMs : Infinity;
        return age > STALE_AFTER_MS ? "STALE_SOURCE" : "SINGLE_SOURCE";
    }
    if (inferenceOnly) return "INFERENCE_ONLY";
    return "NO_EVIDENCE";
}

/** MC-1/MC-2: fungsi murni, deterministik, dan satu-satunya penulis value. */
function computeConfidence(evidenceQuality, nowMs) {
    const basis = determineBasis(evidenceQuality, nowMs);

    let raw;
    switch (basis) {
        case "VERIFIED_EVIDENCE": raw = 0.85 + 0.03 * Math.min(evidenceQuality.verifiedCount, 5); break;
        case "MULTI_SOURCE": raw = 0.55 + 0.05 * Math.min(evidenceQuality.sourceCount, 6); break;
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

module.exports = { BASIS, STALE_AFTER_MS, determineBasis, computeConfidence };
