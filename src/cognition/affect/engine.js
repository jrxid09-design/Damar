const { clamp01 } = require("../core/envelope");

/**
 * AFFECT (§18–§21) — variabel kontrol fungsional, bukan klaim perasaan.
 *
 * Transisi deterministik & bounded:
 *   S(t+dt) = baseline + (S(t) - baseline) * 0.5 ** (dt / halfLife)
 *   lalu + dampak appraisal, clamp01 tiap dimensi.
 */

const DIMENSIONS = [
    "valence", "arousal", "confidence", "uncertainty", "frustration",
    "caution", "curiosity", "goalPressure", "consistencyPressure",
    "resourcePressure", "predictionError", "selfConsistency"
];

function emptyAffect(config) {
    return structuredAffect(config.affect.baseline);
}

function structuredAffect(source) {
    const out = {};
    for (const d of DIMENSIONS) out[d] = clamp01(source[d]);
    return out;
}

/** Peluruhan eksponensial multi-timescale terhadap baseline. */
function decay(affect, config, dtMs) {

    if (!(dtMs > 0)) return structuredAffect(affect);

    const { baseline, halfLifeMs, dimensionScale } = config.affect;
    const next = {};

    for (const dim of DIMENSIONS) {
        const scale = dimensionScale[dim] ?? "medium";
        const half = Math.max(1, halfLifeMs[scale]);
        const base = clamp01(baseline[dim]);
        const current = clamp01(affect[dim]);
        next[dim] = clamp01(
            base + (current - base) * Math.pow(0.5, dtMs / half)
        );
    }

    return next;

}

/** Terapkan dampak appraisal {dim: delta}. */
function applyImpact(affect, impact) {
    const next = structuredAffect(affect);
    for (const [dim, delta] of Object.entries(impact ?? {})) {
        if (!(dim in next)) continue;                 // dimensi asing diabaikan
        if (!Number.isFinite(delta)) continue;
        next[dim] = clamp01(next[dim] + delta);
    }
    return next;
}

function affectMagnitude(affect) {
    let sum = 0;
    for (const d of DIMENSIONS) {
        sum += Math.abs(clamp01(affect[d]) - clamp01(d === "valence" ? 0 : d));
    }
    return clamp01(sum / DIMENSIONS.length);
}

module.exports = {
    DIMENSIONS, emptyAffect, decay, applyImpact,
    affectMagnitude, structuredAffect
};
