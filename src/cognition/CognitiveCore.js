const crypto = require("node:crypto");

const { createACCConfig } = require("./config/ACCConfig");
const { realClock } = require("./core/clock");
const { makeEnvelope } = require("./core/envelope");
const { ContinuityCore } = require("./continuity/ContinuityCore");
const { createSqliteAccStore, createMemoryAccStore } = require("./persistence/AccStore");
const { InteroceptiveBus, defaultProcessAdapters } = require("./interoception/InteroceptiveBus");
const Witness = require("./witness/WitnessModel");
const ExperienceEncoder = require("./autobiography/ExperienceEncoder");

/**
 * COGNITIVE CORE (§43–§45/§59) — orkestrator shadow-only.
 *
 * DAMAR_ACC=off  → semua metode no-op (nol jejak, §109).
 * DAMAR_ACC=shadow → observasi/persist/appraise/workspace/witness/
 *                     predict/encode. TIDAK PERNAH: memilih tool,
 *                     mengubah permission/capabilitySet/role, mengeksekusi
 *                     aksi, mengubah routing/safety (§4 spesifikasi).
 */

class CognitiveCore {

    constructor({ config, store, clock } = {}) {

        this.config = config ?? createACCConfig();
        this.clock = clock ?? realClock();

        this.continuity = new ContinuityCore({
            store: store ?? createMemoryAccStore(),
            clock: this.clock,
            config: this.config
        });

        this.interoception = new InteroceptiveBus({
            config: this.config, clock: this.clock
        });

        // Lab-only switch (§59): TIDAK dibekukan agar harness ablasi
        // dapat menonaktifkan modul satu per satu dalam eksperimen.
        this.ablation = {
            self: true, affect: true, appraisal: true,
            interoception: true, workspace: true, witness: true,
            prediction: true, metacognition: true,
            autobiography: true, recurrence: true
        };
        this.pending = [];

        this.initialized = false;

    }

    /** Off → nol perilaku; dipanggil pun tidak melakukan apa pun. */
    async initialize() {
        if (this.config.mode === "off" || this.initialized) return this;
        await this.continuity.initialize();
        this.initialized = true;
        return this;
    }

    /** Mode akses read-only untuk integrator/diagnostik. */
    get mode() { return this.config.mode; }

    /**
     * feedShadow — satu siklus kognitif SHADOW (§43): OBSERVE → APPRAISE
     * → SELF/AFFECT → WORKSPACE → WITNESS → META → (opsional) EXPERIENCE.
     * Tidak ada eksekusi aksi; kembalikan jejak kausal ringkas (§66).
     */
    async feedShadow(envelope) {

        if (this.config.mode !== "shadow") return null;

        const before = cloneState(this.continuity.state);
        const prevTop = before.workspace?.items?.[0]?.key ?? null;

        const applied = await this.continuity.feed(envelope);
        if (!applied.applied) {
            return { applied: false, reason: applied.reason };
        }

        const after = this.continuity.state;
        // CATATAN DETERMINISME: sweep TTL/habituation HANYA view-level;
        // state kanonik dibangun murni dari jurnal agar replay identik.

        // WITNESS terstruktur (§29) — diff sebelum/sesudah.
        const witness = this.ablation.witness
            ? Witness.buildWitness({
                witnessId: `wit-${crypto.randomUUID()}`,
                at: envelope.timestamp,
                prev: before, next: after,
                appraisal: this.continuity._lastAppraisal
              })
            : null;

        // META rekomendasi enum (§32) — hanya rekomendasi.
        const meta = this.ablation.metacognition
            ? Witness.recommend(after, this.config)
            : null;

        // AUTOBIOGRAPHY: signifikansi episode (§36/§82).
        let experience = null;
        if (this.ablation.autobiography) {
            experience = await this.encodeExperienceIfSignificant({
                at: envelope.timestamp, before, after,
                appraisal: this.continuity._lastAppraisal,
                eventType: envelope.type
            });
        }

        await this.continuity.maybeSnapshot();

        return {
            applied: true,
            witness, meta, experience,
            attentionTopChanged:
                (after.workspace?.items?.[0]?.key ?? null) !== prevTop
        };

    }

    async encodeExperienceIfSignificant({ at, before, after, appraisal, eventType }) {

        const factors = {
            novelty: appraisal?.novelty ?? 0,
            goalImportance: appraisal?.goalRelevance ?? 0,
            predictionError: Math.max(
                appraisal?.predictionSurprise ?? 0,
                after.affect.predictionError ?? 0),
            affectMagnitude: maxDelta(before.affect, after.affect),
            commitmentImpact:
                String(eventType ?? "").startsWith("COMMITMENT_") ? 1 : 0,
            relationshipImpact: 0,
            identityImpact:
                eventType === "SUBSTRATE_CHANGED" ||
                eventType === "CONTINUITY_EPOCH_CREATED" ? 0.9 : 0
        };

        const significance =
            ExperienceEncoder.computeSignificance(factors, this.config);

        if (significance < this.config.experience.threshold) {
            return null;   // bukan pengalaman autobiografis
        }

        const experienceId = `exp-${crypto.randomUUID()}`;
        const encoded = ExperienceEncoder.encodeExperience({
            experienceId, at,
            eventRefs: [appraisal?.eventId].filter(Boolean),
            beforeStateRef: digestOf(before),
            afterStateRef: digestOf(after),
            outcome: "observed",
            appraisalSummary: {
                novelty: factors.novelty,
                goalRelevance: factors.goalImportance,
                predictionSurprise: appraisal?.predictionSurprise ?? 0
            },
            affectiveImpact: maxDeltaMap(before.affect, after.affect),
            factors,
            provenance: "SYSTEM_EVENT"
        });

        await this.continuity.feed(makeEnvelope({
            type: "EXPERIENCE_RECORDED",
            source: "acc.autobiography",
            provenance: "SYSTEM_EVENT",
            payload: {
                experience: encoded,
                significance
            },
            clock: this.clock
        }));

        return { experienceId, significance, encoded };

    }

    /** Prediksi terbuka + resolusi deterministik (§34). */
    async openPrediction(spec) {

        if (this.config.mode !== "shadow") return null;

        const Predictions = require("./prediction/Predictions");
        const prediction = Predictions.newPrediction({
            ...spec,
            predictionId: `prd-${crypto.randomUUID()}`,
            createdAtMs: this.clock.nowMs()
        });

        // Projeksi read-model ditulis SATU tempat saja: ContinuityCore.mirror
        // (jalur yang sama dipakai rekonsiliasi saat boot). Tulisan kedua di
        // sini dulu menimpa payload mirror dengan bentuk yang lebih miskin,
        // sehingga hasil live berbeda dari hasil rebuild.
        await this.continuity.feed(makeEnvelope({
            type: "PREDICTION_OPENED",
            source: "acc.prediction", provenance: "SYSTEM_EVENT",
            payload: { prediction }, clock: this.clock
        }));

        return prediction;

    }

    async resolvePrediction(predictionId, correct) {

        if (this.config.mode !== "shadow") return null;

        const open = this.continuity.state.predictions.open[predictionId];
        if (!open) return null;

        const type = correct
            ? "PREDICTION_RESOLVED_CORRECT"
            : "PREDICTION_RESOLVED_INCORRECT";

        // Mirror di ContinuityCore sudah menulis transisi OPEN -> RESOLVED_*
        // beserta resolvedAt/resolutionEventId. Tulisan ulang di sini akan
        // mengembalikan payload ke bentuk pra-resolusi (status "OPEN").
        return await this.continuity.feed(makeEnvelope({
            type, source: "acc.prediction", provenance: "SYSTEM_EVENT",
            payload: { predictionId }, clock: this.clock
        }));

    }

    /** Antrian observasi untuk siklus rekuren (§43–§44). */
    enqueue(envelope) {
        if (this.config.mode !== "shadow") return 0;
        this.pending.push(envelope);
        return this.pending.length;
    }

    /**
     * Siklus rekuren TERBATAS: drain antrian sampai anggaran habis,
     * state konvergen (delta < epsilon), atau state berulang terdeteksi.
     * Tidak ada while(true); tidak ada eksekusi aksi.
     */
    async runRecurrence({ maxCycles = null } = {}) {

        if (this.config.mode !== "shadow") return { cycles: 0, digests: [], stopped: "off" };

        const cfg = this.config.recurrence;
        const budget = Math.min(
            maxCycles ?? cfg.maxCycles, cfg.maxCycles);

        const startedMs = this.clock.nowMs();
        const digests = [];
        let cycles = 0;
        let stopped = "budget";

        while (cycles < budget && this.pending.length > 0) {

            if (this.clock.nowMs() - startedMs > cfg.maxWallClockMs) {
                stopped = "wallclock";
                break;
            }

            const env = this.pending.shift();
            await this.feedShadow(env);
            cycles += 1;

            const d = this.continuity.semanticDigest();

            // Konvergensi: perubahan di bawah epsilon dihitung stabil
            // (digest identik karena delta mikro tidak mengubah nilai
            // yang tersimpan pada presisi state).
            if (digests.length && digests[digests.length - 1] === d) {
                stopped = "converged";
                digests.push(d);
                break;
            }

            const repeats = digests.slice(-cfg.repeatedStateLimit)
                .filter(x => x === d).length;
            digests.push(d);
            if (repeats >= cfg.repeatedStateLimit) {
                stopped = "repeated-state";
                break;
            }
        }

        if (this.pending.length === 0 && stopped === "budget") stopped = "drained";

        return { cycles, digests, stopped };

    }

    /** Interosepsi tick: kumpulkan sampel → feed. */
    async interoceive() {
        if (this.config.mode !== "shadow") return [];
        const envelopes = this.interoception.collect();
        for (const env of envelopes) await this.feedShadow(env);
        return envelopes;
    }

    /** Snapshot developer read-only (§67). */
    diagnosticsSnapshot() {

        if (this.config.mode === "off") return null;

        const s = this.continuity.state;
        return {
            identity: s.identity && {
                identityId: s.identity.identityId,
                continuityEpochId: s.identity.continuityEpochId
            },
            substrate: s.substrate?.current ?? null,
            selfFields: Object.fromEntries(
                Object.entries(s.self?.fields ?? {})
                    .map(([k, v]) => [k, v.value])),
            contradictions: s.self?.contradictions?.length ?? 0,
            affect: s.affect,
            interoceptionMetrics:
                Object.fromEntries(Object.entries(s.interoception.metrics)
                    .map(([k, v]) => [k, v.state])),
            workspaceKeys: (s.workspace?.items ?? []).map(i => i.key),
            openPredictions: Object.keys(s.predictions.open ?? {}),
            metaStats: s.meta?.stats ?? {},
            significantExperiences: s.autobiography?.significantCount ?? 0,
            journalPosition: this.continuity.journalSeq
        };
    }

}

/* ---------------------------------------------------------------------- */

function maxDelta(a, b) {
    if (!a || !b) return 0;
    let max = 0;
    for (const key of Object.keys(b)) {
        max = Math.max(max, Math.abs((b[key] ?? 0) - (a[key] ?? 0)));
    }
    return max;
}

function maxDeltaMap(a, b) {
    const out = {};
    if (!a || !b) return out;
    for (const key of Object.keys(b)) {
        const d = Math.abs((b[key] ?? 0) - (a[key] ?? 0));
        if (d > 1e-6) out[key] = Number(d.toFixed(4));
    }
    return out;
}
function digestOf(state) {
    return require("./core/envelope").digest(state);
}

function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

module.exports = { CognitiveCore };
