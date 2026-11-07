/**
 * WITNESS (§29/§30/§55) + METACOGNITION (§32/§33).
 * Witness hanya melihat fakta terstruktur — BUKAN chain-of-thought.
 */

const { structuredCopy } = require("../core/envelope");

/** Diff state → perubahan terstruktur dengan sebab (eventIds). */
function observeChanges(prev, next, causeEventId, at) {

    const changes = [];

    // Field otoritatif self
    for (const [name, entry] of Object.entries(next.self?.fields ?? {})) {
        const before = prev?.self?.fields?.[name]?.value;
        if (!deepEq(before, entry.value)) {
            changes.push({
                area: "self", field: name,
                from: before ?? null, to: structuredCopy(entry.value),
                causes: [causeEventId]
            });
        }
    }

    // Affect
    if (prev?.affect && next.affect) {
        for (const [dim, value] of Object.entries(next.affect)) {
            const before = prev.affect[dim];
            if (Math.abs((value ?? 0) - (before ?? 0)) > 1e-6) {
                changes.push({
                    area: "affect", field: dim,
                    from: before ?? null, to: value,
                    causes: [causeEventId]
                });
            }
        }
    }

    // Workspace top berubah
    const prevTop = prev?.workspace?.items?.[0]?.key ?? null;
    const nextTop = next.workspace?.items?.[0]?.key ?? null;
    if (prevTop !== nextTop) {
        changes.push({
            area: "workspace", field: "attentionTop",
            from: prevTop, to: nextTop,
            causes: [causeEventId]
        });
    }

    return changes;

}

function buildWitness({ witnessId, at, prev, next, appraisal, extraContradictions = [] }) {

    const observed = observeChanges(prev, next, appraisal?.eventId, at);

    return Object.freeze({
        witnessId,
        timestamp: at,
        currentStateRefs: {
            selfFields: Object.keys(next.self?.fields ?? {}),
            affectDims: Object.keys(next.affect ?? {}),
            workspaceKeys: (next.workspace?.items ?? []).map(i => i.key)
        },
        observedChanges: observed,
        contradictions: [
            ...(next.self?.contradictions ?? []),
            ...extraContradictions
        ],
        evidenceRefs: observed.flatMap(c => c.causes),
        confidence: observed.length ? 0.96 : 0.9
    });

}

/* --------------------------- METACOGNITION ------------------------------ */

const RECOMMENDATIONS = [
    "CONTINUE", "SEEK_EVIDENCE", "REPLAN", "DELEGATE", "ASK_USER", "STOP"
];

/**
 * Rekomendasi TERBATAS-ENUM (§32). C0: rekomendasi saja — tidak dieksekusi.
 */
function recommend(state, config) {

    const m = config.metacognition;
    const affect = state.affect ?? {};
    const self = state.self ?? {};

    if ((affect.resourcePressure ?? 0) >= m.resourcePressureAskUser) {
        return { recommendation: "ASK_USER", reason: "resourcePressure tinggi" };
    }

    if ((self.contradictions?.length ?? 0) >= m.contradictionReplan) {
        return { recommendation: "REPLAN", reason: "kontradiksi menumpuk" };
    }

    if ((state.meta?.stats?.failureStreak ?? 0) >= m.failureStreakReplan) {
        return { recommendation: "REPLAN", reason: "kegagalan beruntun" };
    }

    if ((affect.uncertainty ?? 0) >= m.uncertaintySeekEvidence) {
        return { recommendation: "SEEK_EVIDENCE", reason: "uncertainty di atas ambang" };
    }

    return { recommendation: "CONTINUE", reason: "dalam ambang" };

}

function deepEq(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

module.exports = { observeChanges, buildWitness, recommend, RECOMMENDATIONS };
