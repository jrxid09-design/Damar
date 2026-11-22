const { clamp01 } = require("../core/envelope");

/**
 * AUTOBIOGRAPHY (§36–§38/§82) — encoder signifikansi deterministik.
 * Episode hanya PERSIST bila significance ≥ threshold; sisanya buffer
 * recent terbatas. Ringkasan bahasa alami adalah artefak sekunder.
 */

function computeSignificance(factors, config) {

    const w = config.experience.weights;
    const f = {
        novelty: clamp01(factors.novelty ?? 0),
        goalImportance: clamp01(factors.goalImportance ?? 0),
        predictionError: clamp01(factors.predictionError ?? 0),
        affectMagnitude: clamp01(factors.affectMagnitude ?? 0),
        commitmentImpact: clamp01(factors.commitmentImpact ?? 0),
        relationshipImpact: clamp01(factors.relationshipImpact ?? 0),
        identityImpact: clamp01(factors.identityImpact ?? 0)
    };

    let total = 0;
    for (const key of Object.keys(w)) total += w[key] * f[key];

    return clamp01(total);

}

function encodeExperience({ experienceId, at, eventRefs, beforeStateRef, afterStateRef,
                            activeGoalRefs = [], predictionRefs = [], outcome,
                            appraisalSummary, affectiveImpact, beliefChanges = [],
                            commitmentChanges = [], factors, provenance }) {

    // Provenance episode: struktur kausal, bukan teks bebas.
    return Object.freeze({
        experienceId: String(experienceId).slice(0, 120),
        timestamp: at,
        eventRefs: [...eventRefs].slice(0, 50),
        beforeStateRef, afterStateRef,
        activeGoalRefs: [...activeGoalRefs].slice(0, 20),
        predictionRefs: [...predictionRefs].slice(0, 20),
        outcome: String(outcome ?? "unknown").slice(0, 60),
        appraisalSummary: structured(appraisalSummary ?? {}),
        affectiveImpact: structured(affectiveImpact ?? {}),
        beliefChanges: beliefChanges.slice(0, 30),
        commitmentChanges: commitmentChanges.slice(0, 30),
        provenance: provenance ?? "SYSTEM_EVENT"
    });

}

/** MEMORY_ACTIVATED hanya boleh dibuat oleh aktivasi nyata (§38). */
function activationRecord({ experienceId, reason, relevance, contextRef, at }) {
    if (!experienceId || !reason) {
        throw new Error("ACC: aktivasi memori wajib punya experienceId & alasan");
    }
    return Object.freeze({
        experienceId,
        reason: String(reason).slice(0, 200),
        relevance: clamp01(relevance ?? 0),
        contextRef: contextRef ?? null,
        at
    });
}

function structured(v) {
    return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v;
}

module.exports = { computeSignificance, encodeExperience, activationRecord };
