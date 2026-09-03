/**
 * Status epistemik Mata Dewa — membedakan OBSERVED / INFERRED / PREDICTED.
 *
 * Hukum: sebuah observasi LAMA tidak boleh dideskripsikan sebagai "live".
 * Setiap kesimpulan spasial material membawa status epistemik + freshness
 * sehingga UI, alert, dan Manager jujur tentang apa yang benar-benar terlihat.
 */

const EPISTEMIC_STATUS = Object.freeze({
    /** Teramati langsung oleh sebuah sumber. */
    OBSERVED: "OBSERVED",
    /** Disimpulkan dari satu/lebih observasi (fusi, interpolasi). */
    INFERRED: "INFERRED",
    /** Diproyeksikan ke depan (pergerakan badai, lintasan). */
    PREDICTED: "PREDICTED"
});

const VALUES = new Set(Object.values(EPISTEMIC_STATUS));

function isEpistemicStatus(value) { return VALUES.has(value); }

function canonical(value, fallback = EPISTEMIC_STATUS.OBSERVED) {
    return isEpistemicStatus(value) ? value : fallback;
}

/**
 * Freshness (umur) sebuah observasi dalam milidetik.
 * observedAt/receivedAt dalam epoch ms; nowMs default Date.now().
 */
function ageMs(observedAt, nowMs = Date.now()) {
    if (!Number.isFinite(observedAt)) return Infinity;
    return Math.max(0, nowMs - observedAt);
}

/**
 * Klasifikasi kesegaran berbasis ambang. fresh/stale/expired menurut
 * freshAfterMs / staleAfterMs / expireAfterMs. Mengembalikan salah satu dari
 * "fresh" | "aging" | "stale" | "expired" | "unknown".
 */
function freshnessBand(observedAt, {
    freshAfterMs = 5 * 60 * 1000,
    staleAfterMs = 30 * 60 * 1000,
    expireAfterMs = 6 * 60 * 60 * 1000
} = {}, nowMs = Date.now()) {
    if (!Number.isFinite(observedAt)) return "unknown";
    const age = ageMs(observedAt, nowMs);
    if (age <= freshAfterMs) return "fresh";
    if (age <= staleAfterMs) return "aging";
    if (age <= expireAfterMs) return "stale";
    return "expired";
}

/** Apakah observasi masih boleh disebut "live" (hanya yang benar-benar fresh). */
function isLive(observedAt, opts, nowMs) {
    return freshnessBand(observedAt, opts, nowMs) === "fresh";
}

module.exports = Object.freeze({
    EPISTEMIC_STATUS,
    isEpistemicStatus,
    canonical,
    ageMs,
    freshnessBand,
    isLive
});
