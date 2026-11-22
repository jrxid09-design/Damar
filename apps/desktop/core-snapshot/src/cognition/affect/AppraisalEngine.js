const { clamp01 } = require("../core/envelope");

/**
 * APPRAISAL (§19/§72) — aturan deterministik per kelas event.
 * Surpris kegagalan alat diboboti reliabilitas read-view ToolStats
 * (dibaca, tidak pernah ditulis ACC).
 */

function appraise(envelope, context = {}) {

    const type = envelope.type;
    const payload = envelope.payload ?? {};
    const impactCfg = context.config.appraisalImpact;
    const base = impactCfg.rules[type] ?? {};

    const appraisal = {
        eventId: envelope.eventId,
        novelty: clamp01(payload.novelty ?? defaultNovelty(type)),
        expectedness: clamp01(payload.expectedness ?? 0.5),
        goalRelevance: clamp01(payload.goalRelevance ?? defaultGoalRelevance(type)),
        goalCongruence: clamp01(payload.goalCongruence ?? 0.5) * 2 - 1,
        controllability: clamp01(payload.controllability ?? 0.5),
        certainty: clamp01(envelope.confidence),
        resourceImpact: clamp01(payload.resourceImpact ?? 0),
        predictionSurprise: 0,
        affectImpact: {},
        evidenceRefs: [envelope.eventId]
    };

    // Salin dampak dasar lalu terapkan multiplikator reliabilitas.
    const impact = { ...base };

    if (type === "TOOL_FAILED" || type === "TOOL_SUCCEEDED") {
        const reliability = clamp01(
            context.toolReliability?.(payload.tool) ?? 0.5);
        const reliable = reliability >= impactCfg.reliableThreshold;

        if (type === "TOOL_FAILED") {
            const mult = reliable
                ? impactCfg.reliableFailureMultiplier      // andal gagal → surpris tinggi
                : impactCfg.unreliableFailureMultiplier;   // eksperimental gagal → biasa
            appraisal.predictionSurprise =
                clamp01((payload.expectedFailure ? 0.1 : reliability));
            appraisal.predictionSurprise =
                clamp01(appraisal.predictionSurprise * mult);
            impact.predictionError =
                (impact.predictionError ?? 0) *
                (0.5 + appraisal.predictionSurprise);
        } else {
            appraisal.predictionSurprise =
                reliable ? 0.05 : 0.2;                     // sukses eksperimental = menyenangkan
        }
    }

    if (type === "PROVIDER_DEGRADED") {
        appraisal.predictionSurprise = clamp01(payload.surprise ?? 0.5);
    }

    appraisal.affectImpact = impact;
    return appraisal;
}

function defaultNovelty(type) {
    switch (type) {
        case "SUBSTRATE_CHANGED": return 0.8;
        case "COMMITMENT_ADDED": return 0.6;
        case "PROVIDER_DEGRADED": return 0.7;
        case "TOOL_FAILED": return 0.5;
        default: return 0.3;
    }
}

function defaultGoalRelevance(type) {
    switch (type) {
        case "COMMITMENT_ADDED":
        case "PREDICTION_RESOLVED_INCORRECT":
        case "TOOL_FAILED": return 0.8;
        case "RESOURCE_PRESSURE": return 0.6;
        default: return 0.4;
    }
}

module.exports = { appraise };
