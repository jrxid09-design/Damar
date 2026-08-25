/**
 * Utilitas dasar lapisan embodiment (B§1).
 *
 * Lapisan ini SADAR DIRI SECARA JASMANI, bukan secara kognitif: ia hanya
 * mencatat fakta observasi tentang "tubuh" komputasi Aether. Semua nilai
 * yang keluar dari modul ini dibekukan (frozen) agar tidak ada jalur tulis
 * diam-diam dari luar — model bahasa TIDAK PERNAH bisa memutasi state
 * otoritatif tubuh lewat referensi objek.
 *
 * Modul ini sengaja TIDAK me-require apa pun dari src/cognition maupun
 * src/database (arah dependensi: cognition boleh membaca embodiment,
 * embodiment tidak boleh tahu cognition).
 */

const crypto = require("node:crypto");

/** Pembekuan mendalam — daun sekaligus cabang dibekukan. */
function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
        return value;
    }
    for (const key of Object.keys(value)) {
        deepFreeze(value[key]);
    }
    return Object.freeze(value);
}

/** Salinan struktur aman-JSON (tanpa referensi ke objek hidup). */
function structuredCopy(value) {
    return value === undefined ? {} : JSON.parse(JSON.stringify(value));
}

/** JSON kanonik: key terurut deterministik — dasar digest lintas-proses. */
function canonicalJson(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function sha256Hex(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

function digestOf(value) {
    return sha256Hex(canonicalJson(value));
}

/** Confidence selalu 0..1; input kotor jatuh ke 0 (gagal-tutup). */
function clamp01(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.min(1, Math.max(0, x));
}

function realClock() {
    return {
        nowMs: () => Date.now(),
        nowIso: () => new Date().toISOString()
    };
}

/** Jam uji: maju manual, tanpa sleep — seluruh reducer deterministik. */
function manualClock(startMs = 0) {
    let t = startMs;
    return {
        nowMs: () => t,
        nowIso: () => new Date(t).toISOString(),
        advance(ms) { t += ms; return t; },
        set(ms) { t = ms; return t; }
    };
}

/** Kesalahan gagal-tutup dengan kode stabil untuk pengujian/diagnostik. */
function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

module.exports = {
    deepFreeze, structuredCopy, canonicalJson, sha256Hex, digestOf,
    clamp01, realClock, manualClock, fail
};
