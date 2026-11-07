/**
 * REDUCER AKSIKULAR ACC (§47) — murni, deterministik, idempoten.
 * (state, envelope, ctx) → state'. Tidak ada IO di sini.
 *
 * Tipe tak dikenal tidak pernah sampai ke sini (disaring ContinuityCore).
 * Provenance salah untuk sebuah handler → no-op ber-diagnostik,
 * bukan fail-open.
 */

const epistemics = require("../self/epistemics");
const affectEngine = require("../affect/engine");
const workspaceMod = require("../workspace/GlobalWorkspace");
const Predictions = require("../prediction/Predictions");

const COMMITMENT_SOURCES = new Set([
    "USER_EXPLICIT", "SYSTEM_POLICY", "MISSION_ACCEPTED", "DERIVED_NONAUTHORITATIVE"
]);

function withSelf(state, mutator) {
    const next = clone(state);
    next.self = mutator(next.self);
    return next;
}

const HANDLERS = {

    /* ---------------------------- CONTINUITY --------------------------- */

    IDENTITY_INITIALIZED(state, env) {
        if (state.identity.identityId) return state;      // sekali saja (§9)
        const next = clone(state);
        next.identity = {
            identityId: env.payload.identityId,
            continuityId: env.payload.continuityId,
            continuityEpochId: env.payload.epochId,
            constitutionVersion: env.payload.constitutionVersion ?? 1,
            createdAt: env.timestamp,
            lineage: []
        };
        return next;
    },

    BOOT_EPOCH_CREATED(state, env) {
        const next = clone(state);
        next.boots = [...next.boots,
            { bootId: env.payload.bootId, startedAt: env.timestamp }].slice(-50);
        return next;
    },

    CONTINUITY_RESTORED(state, env) {
        // Restorasi valid TIDAK mengubah identitas — hanya mencatat (§8).
        const next = clone(state);
        next.restores = [...(next.restores ?? []),
            { at: env.timestamp,
              fromSnapshotSeq: env.payload.fromSnapshotSeq ?? null }].slice(-50);
        return next;
    },

    CONTINUITY_EPOCH_CREATED(state, env) {
        const next = clone(state);
        const previous = {
            continuityId: next.identity.continuityId,
            epochId: next.identity.continuityEpochId,
            reason: String(env.payload.reason ?? "").slice(0, 200)
        };
        next.identity = {
            ...next.identity,
            continuityId: env.payload.newContinuityId,
            continuityEpochId: env.payload.newEpochId,
            lineage: [...(next.identity.lineage ?? []), previous]
        };
        return next;
    },

    CONSTITUTION_VERSION_CHANGED(state, env) {
        if (env.source !== "operator") return ignored(state, "constitution bukan operator");
        const next = clone(state);
        const v = Number(env.payload.version);
        if (Number.isFinite(v)) next.identity.constitutionVersion = v;
        return next;
    },

    SUBSTRATE_CHANGED(state, env) {
        if (env.provenance !== "SYSTEM_EVENT") {
            return ignored(state, "substrate bukan event sistem");
        }
        const d = structured(env.payload.descriptor ?? {});
        if (!d.modelId && !d.provider) return ignored(state, "deskriptor substrate kosong");
        const next = clone(state);
        next.substrate = {
            current: d,
            epochs: [...(next.substrate?.epochs ?? []),
                { epochId: d.substrateEpochId, descriptor: d, at: env.timestamp }].slice(-50)
        };
        return next;
    },

    /* ----------------------------- KOMITMEN ---------------------------- */

    COMMITMENT_ADDED(state, env) {
        const p = env.payload ?? {};
        if (!COMMITMENT_SOURCES.has(p.source)) {
            // §11: MODEL_HYPOTHESIS dsb tidak pernah komitmen otoritatif.
            return ignored(state, `sumber komitmen tidak sah: ${p.source}`);
        }
        if (!p.commitmentId || !p.statement) return ignored(state, "komitmen tanpa id/statement");
        const next = clone(state);
        next.commitments.active[p.commitmentId] = {
            statement: String(p.statement).slice(0, 300),
            source: p.source,
            priority: clampNum(p.priority ?? 0.5),
            status: "ACTIVE",
            createdAt: env.timestamp,
            eventId: env.eventId,
            supersedes: p.supersedes ?? null
        };
        return next;
    },

    COMMITMENT_COMPLETED(state, env) {
        const id = env.payload?.commitmentId;
        const next = clone(state);
        if (!next.commitments.active[id]) {
            return ignored(state, `komitmen tidak dikenal: ${id}`);
        }
        delete next.commitments.active[id];
        next.commitments.completedCount += 1;
        return next;
    },

    /* ------------------ OBSERVASI RUNTIME → AFFECT/WORKSPACE ----------- */

    TOOL_SUCCEEDED: observationHandler,
    TOOL_FAILED: observationHandler,
    PROVIDER_DEGRADED: observationHandler,
    RESOURCE_PRESSURE: observationHandler,

    INTEROCEPTIVE_SAMPLE(state, env) {
        if (env.provenance !== "SYSTEM_SENSOR") {
            return ignored(state, "sampel interoseptif non-sensor");
        }
        const m = env.payload?.metric;
        if (!m || typeof m !== "string") return ignored(state, "metrik tanpa nama");
        const next = clone(state);
        next.interoception.metrics[m.slice(0, 120)] = {
            value: Number.isFinite(env.payload.value) ? env.payload.value : null,
            state: ["VALUE", "STALE", "UNKNOWN", "ERROR"].includes(env.payload.state)
                ? env.payload.state : "UNKNOWN",
            unit: env.payload.unit ?? null,
            timestamp: env.timestamp,
            eventId: env.eventId
        };
        return next;
    },

    /* ------------------------- KLAIM / HIPOTESIS ----------------------- */

    USER_CLAIM_RECEIVED(state, env) {
        // §98: klaim user TIDAK PERNAH menulis field otoritatif.
        const p = env.payload ?? {};
        if (!p.field) return ignored(state, "klaim tanpa field");
        return withSelf(state, self =>
            epistemics.recordClaimOrHypothesis(
                self, "USER_CLAIM",
                String(p.field).slice(0, 80), p.value,
                { eventId: env.eventId, at: env.timestamp,
                  confidence: env.confidence }));
    },

    MODEL_PROPOSAL_RECEIVED(state, env) {
        // §42/§99: output model = MODEL_HYPOTHESIS; field otoritatif
        // tidak disentuh langsung — hanya daftar hipotesis + kontradiksi.
        const claims = Array.isArray(env.payload?.claims)
            ? env.payload.claims.slice(0, 20) : [];
        return withSelf(state, self => {
            let working = self;
            for (const c of claims) {
                if (!c || typeof c !== "object" || !c.field) continue;
                working = epistemics.recordClaimOrHypothesis(
                    working, "MODEL_HYPOTHESIS",
                    String(c.field).slice(0, 80), c.value,
                    { eventId: env.eventId, at: env.timestamp,
                      confidence: clampNum(c.confidence ?? env.confidence) });
            }
            return working;
        });
    },

    SELF_STATE_UPDATED(state, env) {
        // Satu-satunya pintu penulisan field otoritatif self — producer
        // 'acc.core', provenance SELF_STATE/SYSTEM_SENSOR/SYSTEM_EVENT.
        const p = env.payload ?? {};
        if (!p.field) return ignored(state, "self-update tanpa field");
        return withSelf(state, self =>
            epistemics.setSelfField(self,
                String(p.field).slice(0, 80), p.value,
                { provenance: env.provenance,
                  eventId: env.eventId, at: env.timestamp }).next);
    },

    EXPERIENCE_RECORDED(state, env, ctx) {
        const p = env.payload ?? {};
        const experience = p.experience ?? {};
        const experienceId = experience.experienceId;
        const significance = clampNum(p.significance);

        if (!experienceId) {
            return ignored(state, "pengalaman tanpa experienceId");
        }

        const next = clone(state);

        next.autobiography.significantCount += 1;
        next.autobiography.recent = [
            ...(next.autobiography?.recent ?? []),
            {
                experienceId,
                significance,
                at: experience.at ?? env.timestamp
            }
        ].slice(-(ctx.config.experience.recentBufferSize ?? 100));

        return next;
    },

    MEMORY_ACTIVATED(state, env, ctx) {
        // B1-FIX (red-team): handler membaca ctx.config tetapi signature
        // lama tidak menerima ctx -> ReferenceError saat jalur ini
        // benar-benar dipakai. Buffer aktivasi kini PUNYA kunci konfig
        // sendiri (autobiography.activationBufferSize) - bukan meminjam
        // buffer pengalaman - dengan fallback deterministik.
        const p = env.payload ?? {};
        if (!p.experienceId) return ignored(state, "aktivasi tanpa experienceId");
        const bufferSize = Math.max(1,
            ctx?.config?.autobiography?.activationBufferSize ?? 100);
        const next = clone(state);
        next.autobiography.activations = [
            ...(next.autobiography?.activations ?? []),
            { experienceId: p.experienceId,
              reason: String(p.reason ?? "").slice(0, 200),
              relevance: clampNum(p.relevance ?? 0),
              at: env.timestamp }
        ].slice(-bufferSize);
        return next;
    },

    /* ------------------------------ PREDIKSI --------------------------- */

    PREDICTION_OPENED(state, env) {
        const p = env.payload?.prediction;
        if (!p?.predictionId) return ignored(state, "prediksi tanpa id");
        const next = clone(state);
        next.predictions.open[p.predictionId] = structured(p);
        return next;
    },

    PREDICTION_RESOLVED_CORRECT: resolutionHandler("RESOLVED_CORRECT"),
    PREDICTION_RESOLVED_INCORRECT: resolutionHandler("RESOLVED_INCORRECT")
};

/* ---------------------------------------------------------------------- */

function observationHandler(state, env, ctx) {

    const appraisal = ctx.appraisal ?? {};

    let next = clone(state);

    // 1. AFFECT via appraisal deterministik (§19–20).
    next.affect = affectEngine.applyImpact(next.affect, appraisal.affectImpact);

    // 2. Trajektori kegagalan (observasi, bukan emosi — §79).
    if (env.type === "TOOL_FAILED") next.meta.stats.failureStreak += 1;
    if (env.type === "TOOL_SUCCEEDED") next.meta.stats.failureStreak = 0;

    // 3. Kompetisi workspace (§26).
    const magnitude = Object.values(appraisal.affectImpact ?? {})
        .reduce((acc, v) => Math.max(acc, Math.abs(Number(v) || 0)), 0);

    next.workspace = workspaceMod.admit(
        next.workspace,
        {
            key: `${env.type}:${env.subject ?? env.eventId}`,
            novelty: appraisal.novelty,
            urgency: env.type === "RESOURCE_PRESSURE" ? 0.9 :
                     env.type === "PROVIDER_DEGRADED" ? 0.7 : 0.4,
            goalRelevance: appraisal.goalRelevance,
            predictionError: appraisal.predictionSurprise,
            affectMagnitude: magnitude,
            homeostaticRelevance: env.type === "RESOURCE_PRESSURE" ? 0.9 : 0.1,
            confidence: env.confidence,
            evidenceRefs: [env.eventId],
            createdAtMs: ctx.nowMs
        },
        ctx.config,
        ctx.nowMs);

    return next;
}

function resolutionHandler(resolution) {
    return (state, env) => {

        const id = env.payload?.predictionId;
        const open = state.predictions?.open?.[id];
        if (!open) return ignored(state, `resolusi tanpa prediksi terbuka: ${id}`);

        const next = clone(state);

        delete next.predictions.open[id];
        next.predictions.resolvedCount += 1;
        if (resolution === "RESOLVED_CORRECT") next.predictions.correctCount += 1;

        // Kalibrasi Brier (§33/§64).
        next.meta.stats.brierSum +=
            Predictions.brierScore(open.probability, resolution);
        next.meta.stats.brierN += 1;

        // Self-field turunan (INFERENCE boleh menulis self):
        const reliability =
            next.predictions.correctCount / Math.max(1, next.predictions.resolvedCount);
        next.meta.stats.predictionReliability = reliability;

        return withSelf(next, self =>
            epistemics.setSelfField(self, "predictionReliability", reliability,
                { provenance: "INFERENCE",
                  eventId: env.eventId, at: env.timestamp }).next);
    };
}

function ignored(state, reason) {
    const next = clone(state);
    next.diagnostics.ignored =
        [...next.diagnostics.ignored,
         { reason: String(reason).slice(0, 160) }].slice(-100);
    return next;
}

function clampNum(n) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;
}

function structured(v) {
    return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v;
}

function clone(state) {
    return JSON.parse(JSON.stringify(state));
}

module.exports = { HANDLERS, observationHandler, ignored, clone, clampNum };



