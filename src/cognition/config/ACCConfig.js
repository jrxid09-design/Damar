/**
 * ACC C0 — konfigurasi terpusat dan feature flag.
 *
 * AETHER_ACC = "off" (default) | "shadow".
 * OFF: nol komputasi state di atas inisialisasi opsional — tanpa perubahan
 * perilaku, prompt, tool selection, routing.
 * SHADOW: observasi/persist/appraise/workspace/witness/predict/encode,
 * TANPA mengubah keputusan produksi sedikit pun.
 *
 * Semua koefisien transisi ada DI SINI (versioned) — tidak ada tuning
 * konstanta yang tersebar di file sumber. Deterministik; randomness
 * tidak dipakai reducer inti.
 */

const MODES = Object.freeze(["off", "shadow"]);

const DEFAULTS = Object.freeze({
    schemaVersion: 1,

    /** Batas workspace (§28). */
    workspace: Object.freeze({
        capacity: 7,
        ttlMs: 30 * 60_000,
        habituationDecayPerHour: 0.5,     // penalti repetisi meluruh
        repetitionPenalty: 0.35,
        agingBonusMax: 0.25,
        agingBonusPerHour: 0.08,
        starvationFeedWindow: 12          // wajib terpilih dalam N feed
    }),

    /** Bobot salience §27 — versioned. */
    salienceWeights: Object.freeze({
        version: 1,
        novelty: 0.22,
        urgency: 0.20,
        goalRelevance: 0.18,
        predictionError: 0.16,
        affectMagnitude: 0.10,
        homeostaticRelevance: 0.09,
        confidence: 0.05
    }),

    /** Affect §18/§20-21 — baseline + half-life per timescale. */
    affect: Object.freeze({
        version: 1,
        baseline: Object.freeze({
            valence: 0, arousal: 0.1, confidence: 0.5, uncertainty: 0.5,
            frustration: 0, caution: 0.2, curiosity: 0.3, goalPressure: 0,
            consistencyPressure: 0, resourcePressure: 0, predictionError: 0,
            selfConsistency: 0.8
        }),
        // half-life (ms) per kelompok timescale:
        halfLifeMs: Object.freeze({
            fast: 30_000,                 // surprise/arousal spikes
            medium: 20 * 60_000,          // frustration/caution/curiosity/uncertainty
            slow: 6 * 60 * 60_000         // calibrated confidence/trust/selfConsistency
        }),
        dimensionScale: Object.freeze({
            // dimensi → timescale peluruhan menuju baseline
            valence: "medium", arousal: "fast", confidence: "slow",
            uncertainty: "medium", frustration: "medium", caution: "medium",
            curiosity: "medium", goalPressure: "fast",
            consistencyPressure: "slow", resourcePressure: "medium",
            predictionError: "fast", selfConsistency: "slow"
        })
    }),

    /** Appraisal → dampak affect (deterministik, versioned). */
    appraisalImpact: Object.freeze({
        version: 1,
        // eventClass → {dim: delta} — clamp01 diterapkan reducer.
        rules: Object.freeze({
            TOOL_FAILED: {
                predictionError: +0.30, frustration: +0.20,
                caution: +0.15, uncertainty: +0.15, valence: -0.20,
                arousal: +0.20
            },
            TOOL_SUCCEEDED: {
                predictionError: -0.10, frustration: -0.10,
                valence: +0.10, confidence: +0.05
            },
            PROVIDER_DEGRADED: {
                uncertainty: +0.20, caution: +0.20, resourcePressure: +0.15,
                arousal: +0.15, valence: -0.10
            },
            RESOURCE_PRESSURE: {
                resourcePressure: +0.40, caution: +0.10, arousal: +0.10
            },
            COMMITMENT_ADDED: { goalPressure: +0.25, curiosity: +0.10 },
            COMMITMENT_COMPLETED: { goalPressure: -0.30, valence: +0.25, confidence: +0.10 },
            PREDICTION_RESOLVED_CORRECT: { confidence: +0.15, predictionError: -0.25, valence: +0.10 },
            PREDICTION_RESOLVED_INCORRECT: { predictionError: +0.35, uncertainty: +0.20, caution: +0.15, valence: -0.15 },
            SUBSTRATE_CHANGED: { uncertainty: +0.25, curiosity: +0.20, arousal: +0.15 }
        }),
        // Pengali surpris berbasis reliabilitas alat (ToolStats read-view):
        reliableFailureMultiplier: 1.5,
        unreliableFailureMultiplier: 0.6,
        reliableThreshold: 0.8
    }),

    /** Significance pengalaman §82 — versioned. */
    experience: Object.freeze({
        version: 1,
        threshold: 0.35,
        weights: Object.freeze({
            novelty: 0.20, goalImportance: 0.20, predictionError: 0.25,
            affectMagnitude: 0.15, commitmentImpact: 0.10,
            relationshipImpact: 0.05, identityImpact: 0.05
        }),
        recentBufferSize: 200
    }),

    /** Interoception §24. */
    interoception: Object.freeze({
        staleAfterMs: 60_000,
        resourcePressureThresholds: Object.freeze({ memFreeFracLow: 0.15 })
    }),

    /** Metacognition §32 — ambang → enum rekomendasi. */
    metacognition: Object.freeze({
        uncertaintySeekEvidence: 0.65,
        contradictionReplan: 2,
        failureStreakReplan: 3,
        resourcePressureAskUser: 0.75
    }),

    /** Recurrence §44-45. */
    recurrence: Object.freeze({
        maxCycles: 8,
        maxWallClockMs: 5_000,
        epsilon: 1e-3,
        repeatedStateLimit: 2
    }),

    /** Autobiography activations buffer (B1-FIX). */
    autobiography: Object.freeze({
        activationBufferSize: 100
    }),

    /** Retention §83. */
    retention: Object.freeze({
        journalCompactionKeepEvents: 5000
    })
});

function createACCConfig(env = process.env, overrides = {}) {

    const rawMode = String(env.AETHER_ACC ?? "off").toLowerCase();

    const mode = MODES.includes(rawMode) ? rawMode : "off";

    return deepFreeze({
        mode,
        schemaVersion: DEFAULTS.schemaVersion,
        ...DEFAULTS,
        ...overrides
    });

}

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

module.exports = { createACCConfig, DEFAULTS, MODES };
