"use strict";

/**
 * W7 shared bounds-override sanitizer.
 *
 * Bug review independen (audit putaran-57, Codex, W7R57-P2-1): sejak
 * putaran-53 tiap lane index.js menormalisasi `bounds` lewat
 * `{...BOUNDS, ...bounds}` -- ini memvalidasi bahwa `bounds` ITU SENDIRI
 * adalah objek, tapi TIDAK memvalidasi setiap NILAI override. Pemanggil
 * bisa mengoverride satu MAX_* jadi Infinity/NaN/negatif; nilai itu lolos
 * merge dan diekspos lewat kontrak publik yang sudah frozen (putaran-55),
 * melumpuhkan batas itu sepenuhnya (mis. cap activeProviders dilewati
 * total dengan `MAX_ACTIVE_PROVIDERS: Infinity`).
 *
 * Divalidasi PER KEY di sini: harus number finite dan >= 0 (fractional
 * diperbolehkan -- attention's DECAY_PER_MS dan metacog's
 * NO_EVIDENCE_CEILING bukan integer secara sah), jatuh ke nilai default
 * lane kalau tidak. Dipakai identik oleh ke-6 lane (selfmodel/worldmodel/
 * goals/prospective/attention/metacog).
 */
function sanitizeBounds(defaults, override) {
    let merged;
    try {
        merged = (override && typeof override === "object") ? { ...defaults, ...override } : defaults;
    } catch {
        merged = defaults;
    }
    const out = {};
    for (const key of Object.keys(defaults)) {
        let value;
        try {
            value = merged[key];
        } catch {
            value = undefined;
        }
        out[key] = (typeof value === "number" && Number.isFinite(value) && value >= 0) ? value : defaults[key];
    }
    return Object.freeze(out);
}

module.exports = { sanitizeBounds };
