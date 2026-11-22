const { clamp01 } = require("../core/envelope");

/**
 * PREDICTION (§34–§35/§64) + kalibrasi Brier (§33/§64).
 * Resolusi deterministik; error mengalir ke affect/self via reducer.
 */

function newPrediction({ predictionId, subject, expectedOutcome, probability, horizonMs, createdAtMs, evidenceRefs = [] }) {

    if (!subject || expectedOutcome === undefined) {
        throw new Error("ACC: prediksi wajib punya subject & expectedOutcome");
    }

    return Object.freeze({
        predictionId,
        subject: String(subject).slice(0, 200),
        expectedOutcome: structured(expectedOutcome),
        probability: clamp01(probability),
        horizonMs: Math.max(0, horizonMs ?? 60_000),
        createdAtMs,
        status: "OPEN",
        evidenceRefs: [...evidenceRefs].slice(0, 20)
    });

}

/** Status resolusi valid §34. */
const RESOLUTIONS = Object.freeze({
    CORRECT: "RESOLVED_CORRECT",
    INCORRECT: "RESOLVED_INCORRECT",
    PARTIAL: "PARTIAL",
    UNRESOLVABLE: "UNRESOLVABLE",
    EXPIRED: "EXPIRED"
});

/**
 * Skor Brier multi-kelas-binér: p untuk outcome 'benar'.
 * brier = (p - y)^2, y ∈ {0,1}. PARTIAL → y=0.5.
 */
function brierScore(probability, resolution) {
    const p = clamp01(probability);
    const y =
        resolution === RESOLUTIONS.CORRECT ? 1 :
        resolution === RESOLUTIONS.INCORRECT ? 0 : 0.5;
    return (p - y) * (p - y);
}

/** Apakah prediksi kedaluwarsa pada nowMs? */
function isExpired(prediction, nowMs) {
    return prediction.status === "OPEN" &&
        nowMs - prediction.createdAtMs > prediction.horizonMs;
}

function structured(v) {
    return v && typeof v === "object"
        ? JSON.parse(JSON.stringify(v)) : v;
}

module.exports = { newPrediction, RESOLUTIONS, brierScore, isExpired };
