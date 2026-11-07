const crypto = require("node:crypto");

const { makeEnvelope, digest, canonicalJson } = require("../core/envelope");
const { HANDLERS, ignored } = require("./reducers");
const epistemics = require("../self/epistemics");
const affectEngine = require("../affect/engine");
const workspaceMod = require("../workspace/GlobalWorkspace");
const { appraise } = require("../affect/AppraisalEngine");

/**
 * CONTINUITY CORE (§8–§9/§46–§53) — pemilik state ACC.
 *
 * Event-sourced: append jurnal → reducer murni → state → snapshot.
 * Single-writer dalam satu instance; urutan kebenaran = seq jurnal.
 */

function emptyState() {
    return {
        schemaVersion: 1,
        identity: {
            identityId: null, continuityId: null,
            continuityEpochId: null, constitutionVersion: 1,
            createdAt: null, lineage: []
        },
        boots: [],
        restores: [],
        substrate: { current: null, epochs: [] },
        self: epistemics.emptySelf(),
        affect: null,                    // diisi config saat init
        interoception: { metrics: {} },
        workspace: workspaceMod.emptyWorkspace(),
        meta: {
            stats: {
                brierSum: 0, brierN: 0,
                predictionReliability: null,
                failureStreak: 0
            }
        },
        predictions: { open: {}, resolvedCount: 0, correctCount: 0 },
        autobiography: { activations: [], recent: [], significantCount: 0 },
        commitments: { active: {}, completedCount: 0 },
        diagnostics: { unknownEvents: 0, ignored: [], appliedCount: 0 }
    };
}

class ContinuityCore {

    constructor({ store, clock, config }) {

        this.store = store;
        this.clock = clock;
        this.config = config;
        this.state = emptyState();
        this.state.affect = affectEngine.emptyAffect(config);

        this.bootId = `boot-${crypto.randomUUID()}`;
        this.seenEventIds = new Set();
        this.journalSeq = 0;
        this.prevHash = null;
        this.eventsSinceSnapshot = 0;

        // WATERMARK PROJEKSI (§46/§48): seq tertinggi yang read-model
        // derivatifnya SUDAH tertulis durabel. Hanya maju SESUDAH mirror
        // sukses, sehingga crash di antara commit kanonik dan projeksi
        // meninggalkan jejak "kotor" yang terbaca saat boot berikutnya.
        this.projectionSeq = 0;

    }

    /** Muat snapshot + replay; buat identitas bila baru (§49–§50). */
    async initialize() {

        const snap = await this.store.latestSnapshot();

        if (snap) {
            this.state = snap.state;
            this.journalSeq = snap.seqUpTo;
            this.prevHash = (await this.store.lastJournalRow())?.hash ?? null;
        }

        // Replay event setelah snapshot — deterministik (§50).
        const events = await this.store.eventsAfterSeq(this.journalSeq);
        for (const row of events) {
            this.applyPersisted(row);
            this.journalSeq = Math.max(this.journalSeq, row.seq);
            this.prevHash = row.hash ?? this.prevHash;
        }

        // REKONSILIASI READ-MODEL (§46/§48) — SEBELUM feed apa pun.
        //
        // Jurnal adalah sumber kebenaran; tabel prediksi/komitmen/
        // pengalaman/substrat hanyalah turunan. Bila watermark tertinggal
        // dari ujung jurnal, ada projeksi yang gagal/hilang setelah commit
        // kanonik — diperbaiki dengan memutar ulang jurnal lewat reducer
        // dan mirror yang SAMA.
        //
        // Harus dijalankan sebelum feed identitas/boot: feed baru akan
        // memajukan watermark, dan itu akan menutupi rentang kotor.
        const journalEnd = (await this.store.lastJournalRow())?.seq ?? this.journalSeq;
        this.projectionSeq = await this.readProjectionWatermark();

        if (this.projectionSeq < journalEnd) {
            await this.reconcileProjections();
        }

        // Identitas belum ada → inisialisasi SEKALI (§9).
        if (!this.state.identity.identityId) {
            await this.feed(makeEnvelopeSafe({
                type: "IDENTITY_INITIALIZED",
                source: "acc.continuity",
                provenance: "SYSTEM_EVENT",
                payload: {
                    identityId: `idn-${crypto.randomUUID()}`,
                    continuityId: `cnt-${crypto.randomUUID()}`,
                    epochId: `epc-${crypto.randomUUID()}`
                },
                clock: this.clock
            }));
        }

        // Boot epoch baru SETIAP runtime boot; identitas tidak berubah.
        await this.feed(makeEnvelopeSafe({
            type: "BOOT_EPOCH_CREATED",
            source: "acc.continuity",
            provenance: "SYSTEM_EVENT",
            payload: { bootId: this.bootId },
            clock: this.clock
        }));

        // Snapshot awal bila belum ada (mempercepat load berikutnya).
        if (!snap) await this.snapshot();

        return this;

    }

    /**
     * Satu event masuk: dedupe → appraisal → decay waktu → reducer
     * murni → append jurnal (source of truth) → mirror persistence
     * prediksi/komitmen/pengalaman signifikan.
     */
    async feed(envelope) {

        if (this.seenEventIds.has(envelope.eventId)) {
            return { applied: false, reason: "duplicate" };       // §102
        }

        // Reducer murni per tipe — SATU jalur yang sama dengan replay &
        // rekonsiliasi projeksi (tidak ada aturan bisnis terduplikasi).
        const { working, next, appraisal } = this.reduceFrom(this.state, envelope);
        if (appraisal) this._lastAppraisal = appraisal;

        // Append jurnal DULU (sumber kebenaran), lalu commit state.
        const appended = await this.append(
            envelope.type, envelope.source, envelope.provenance,
            structuredCopyOf(envelope.payload),
            {
                eventId: envelope.eventId,
                occurredAt: envelope.timestamp,
                monotonic: envelope.monotonic,
                subject: envelope.subject,
                sessionId: envelope.sessionId,
                correlationId: envelope.correlationId,
                confidence: envelope.confidence
            });

        if (appended.duplicate) {
            this.seenEventIds.add(envelope.eventId);
            return { applied: false, reason: "duplicate" };
        }

        this.commit(next);
        this.seenEventIds.add(envelope.eventId);

        // Mirror tabel kueri (prediksi/komitmen/pengalaman).
        //
        // §Prinsip 8: kegagalan projeksi SESUDAH commit kanonik tidak boleh
        // merusak kontinuitas — dan tidak boleh dilaporkan seolah event-nya
        // gagal. Jurnal + state kanonik sudah durabel; melempar di sini
        // mendorong pemanggil me-retry dan menggandakan event kanonik.
        // Jadi: laporkan applied=true DENGAN diagnostik projeksi kotor,
        // catat ke telemetri, dan biarkan boot berikutnya memperbaikinya.
        const projection =
            await this.projectSafely(envelope, working, next, appended.seq);

        return { applied: true, eventId: envelope.eventId, projection };

    }

    /**
     * Reducer bersama LIVE / REPLAY / REKONSILIASI.
     *
     * Satu-satunya tempat handler dipilih dan appraisal dihitung, supaya
     * jalur langsung dan jalur rebuild tidak pernah menyimpang (§50).
     */
    reduceFrom(baseState, env, label = "") {

        const working = this.preApply(env, baseState);
        const handler = HANDLERS[env.type];

        if (!handler) {
            // Tidak akan terjadi (makeEnvelope memfilter), tetapi tetap
            // aman: diagnostik saja — tidak mutasi otoritatif (§100).
            const next = ignored(working,
                `tipe tanpa handler${label}: ${env.type}`);
            next.diagnostics.unknownEvents += 1;
            return { working, next, appraisal: null };
        }

        const appraisal = appraise(env, {
            config: this.config,
            toolReliability: ctx_toolReliability
        });

        const next = handler(working, env, {
            config: this.config,
            nowMs: eventTimeMs(env, this.clock),
            appraisal
        });

        return { working, next, appraisal };

    }

    /**
     * Tulis read-model tanpa pernah membatalkan kebenaran kanonik.
     * Watermark HANYA maju setelah mirror benar-benar sukses.
     */
    async projectSafely(envelope, beforeState, nextState, seq) {

        try {
            await this.mirror(envelope, beforeState, nextState);
        }
        catch (error) {
            const message = String(error?.message ?? error);
            try {
                require("../../services/telemetryService").warn(
                    `[acc] projeksi read-model gagal (${envelope.type}, seq ${seq}) — ` +
                    `state kanonik tetap utuh; perbaikan otomatis saat boot: ${message}`);
            }
            catch { /* telemetri opsional — tak boleh menutupi kegagalan */ }
            return { ok: false, dirty: true, error: message };
        }

        await this.advanceProjectionWatermark(seq);
        return { ok: true, dirty: false };

    }

    /** Rekonstruksi dari baris jurnal saat load/replay (tanpa re-append). */
    applyPersisted(row) {

        if (this.seenEventIds.has(row.eventId)) return false;   // idempoten

        const env = envelopeFromRow(row);

        // Jalur replay memakai pre-decay yang SAMA dengan jalur live
        // (berbasis rantai timestamp event) → determinisme penuh (§50).
        const { next } = this.reduceFrom(this.state, env, " (persisted)");

        this.commit(next);
        this.seenEventIds.add(row.eventId);
        return true;

    }

    /* ------------------------ projeksi (read model) --------------------- */

    async readProjectionWatermark() {
        try {
            const raw = await this.store.getKv(PROJECTION_SEQ_KEY);
            const seq = Number(raw);
            return Number.isFinite(seq) && seq > 0 ? seq : 0;
        }
        catch { return 0; }          // tak terbaca → anggap kotor (fail-safe)
    }

    /**
     * Watermark maju HANYA secara berurutan (seq berikutnya persis).
     *
     * Kalau ia boleh melompat, satu event yang projeksinya gagal akan
     * "tertutup" oleh event berikutnya yang memang tidak punya projeksi
     * (mis. TOOL_FAILED, atau event yang di-IGNORE reducer) — lubangnya
     * hilang dari pandangan dan tidak pernah diperbaiki saat boot.
     */
    async advanceProjectionWatermark(seq) {
        if (!Number.isFinite(seq)) return;
        if (seq !== this.projectionSeq + 1) return;     // ada lubang → tetap kotor
        await this.setProjectionWatermark(seq);
    }

    /** Set absolut — dipakai rekonsiliasi yang memutar jurnal dari awal. */
    async setProjectionWatermark(seq) {
        if (!Number.isFinite(seq) || seq <= this.projectionSeq) return;
        await this.store.putKv(PROJECTION_SEQ_KEY, seq);
        this.projectionSeq = seq;
    }

    /**
     * REBUILD READ-MODEL DARI SEJARAH EVENT PENUH.
     *
     * Kenapa dari NOL dan bukan dari snapshot/state kanonik saat ini:
     *   - COMMITMENT_COMPLETED menghapus entri dari `commitments.active`
     *     dan PREDICTION_RESOLVED_* menghapus dari `predictions.open`;
     *     state hidup TIDAK lagi memuat lifecycle yang sudah selesai.
     *   - `autobiography.recent` adalah ring buffer berukuran terbatas.
     *   - snapshot bisa lebih BARU daripada event yang projeksinya gagal,
     *     sehingga replay-setelah-snapshot tidak akan menyentuhnya.
     * Hanya jurnal penuh yang memuat seluruh riwayat, dan mirror yang
     * dipakai adalah mirror yang sama dengan jalur live — tidak ada
     * aturan bisnis kedua. Semua tulisan projeksi berupa upsert, jadi
     * pengulangan bersifat idempoten.
     *
     * INVARIAN KERAS: pemadatan (compaction) jurnal TIDAK BOLEH membuang
     * riwayat yang masih dibutuhkan rebuild ini, kecuali ada projection
     * checkpoint terverifikasi yang mampu merekonstruksi lifecycle
     * selesai/teresolusi tanpa event tersebut. Lihat
     * docs/architecture/ACC-C0.md §6.
     */
    async reconcileProjections() {

        const events = await this.store.allEvents();
        if (!events.length) return { ok: true, reconciled: 0, throughSeq: 0 };

        let scratch = emptyState();
        scratch.affect = affectEngine.emptyAffect(this.config);

        let lastSeq = 0;
        let count = 0;

        for (const row of events) {

            const env = envelopeFromRow(row);
            const { working, next } = this.reduceFrom(scratch, env, " (rebuild)");

            try {
                await this.mirror(env, working, next);
            }
            catch (error) {
                const message = String(error?.message ?? error);
                try {
                    require("../../services/telemetryService").warn(
                        `[acc] rekonsiliasi projeksi berhenti di seq ${row.seq}: ${message}`);
                }
                catch { /* telemetri opsional */ }
                // Watermark TIDAK dimajukan → boot berikutnya mencoba lagi.
                return { ok: false, reconciled: count, throughSeq: lastSeq, error: message };
            }

            scratch = next;
            lastSeq = Math.max(lastSeq, Number(row.seq) || lastSeq);
            count += 1;

        }

        await this.setProjectionWatermark(lastSeq);
        return { ok: true, reconciled: count, throughSeq: lastSeq };

    }

    /** Operasi eksplisit komitmen (§11) — sumber divalidasi reducer. */
    async addCommitment({ commitmentId, statement, source, priority = 0.5 }) {
        return this.feed(makeEnvelopeSafe({
            type: "COMMITMENT_ADDED",
            source: source === "USER_EXPLICIT" ? "operator" :
                    source === "MISSION_ACCEPTED" ? "mission" : "system_policy",
            provenance: "SYSTEM_EVENT",
            payload: { commitmentId, statement, source, priority },
            clock: this.clock
        }));
    }

    async completeCommitment(commitmentId) {
        return this.feed(makeEnvelopeSafe({
            type: "COMMITMENT_COMPLETED",
            source: "system_policy", provenance: "SYSTEM_EVENT",
            payload: { commitmentId },
            clock: this.clock
        }));
    }

    /** Reset kontinuitas DESTRUKTIF-EKSPLISIT: epoch baru, lineage dicatat. */
    async createContinuityEpoch(reason) {
        return this.feed(makeEnvelopeSafe({
            type: "CONTINUITY_EPOCH_CREATED",
            source: "operator", provenance: "SYSTEM_EVENT",
            payload: {
                newContinuityId: `cnt-${crypto.randomUUID()}`,
                newEpochId: `epc-${crypto.randomUUID()}`,
                reason
            },
            clock: this.clock
        }));
    }

    observeSubstrateChange(descriptor) {

        const d = require("../substrate/SubstrateRouter")
            .normalizeDescriptor(descriptor);

        return this.feed(makeEnvelopeSafe({
            type: "SUBSTRATE_CHANGED",
            source: "acc.substrate", provenance: "SYSTEM_EVENT",
            payload: { descriptor: d },
            clock: this.clock
        }));

    }

    /* ------------------------------ snapshot ---------------------------- */

    async snapshot() {
        await this.store.saveSnapshot({
            createdAt: this.clock.nowIso(),
            seqUpTo: this.journalSeq,
            state: cloneState(this.state)
        });
        this.eventsSinceSnapshot = 0;
    }

    async maybeSnapshot() {
        if (this.eventsSinceSnapshot >= this.config.retention.journalCompactionKeepEvents / 5) {
            await this.snapshot();
        }
    }

    /**
     * Pra-aplikasi bersama LIVE & REPLAY: decay affect berbasis SELISIH
     * TIMESTAMP EVENT sebelumnya (bukan wall-clock) sehingga hasil
     * rekonstruksi identik dengan eksekusi langsung (§21+§50).
     */
    preApply(envelope, baseState = this.state) {

        const prevIso = baseState.meta.lastAffectAt ?? null;
        const prevMs = prevIso ? Date.parse(prevIso) : NaN;
        const curMs = Date.parse(envelope.timestamp);

        const working = cloneState(baseState);

        const dt = Number.isFinite(prevMs) && Number.isFinite(curMs)
            ? Math.max(0, curMs - prevMs) : 0;

        if (dt > 0) {
            working.affect =
                affectEngine.decay(working.affect, this.config, dt);
        }

        working.meta.lastAffectAt = envelope.timestamp;
        return working;

    }

    /* ------------------------------- utils ------------------------------ */

    /**
     * Derived read-model projection.
     *
     * TEMPORARY C0 guard:
     * event tanpa projection boleh no-op; event yang memang membutuhkan
     * projection gagal eksplisit sampai kontrak projection selesai.
     */
    async mirror(envelope, beforeState, nextState) {

        if (envelope.type === "COMMITMENT_ADDED") {
            const id = envelope.payload?.commitmentId;
            const projected = id
                ? nextState.commitments?.active?.[id]
                : null;

            if (!id || !projected) {
                return { projected: false, required: false };
            }

            await this.store.upsertCommitment(
                id,
                "ACTIVE",
                structuredCopyOf(projected)
            );

            return { projected: true, kind: "commitment" };
        }

        if (envelope.type === "COMMITMENT_COMPLETED") {
            const id = envelope.payload?.commitmentId;

            const wasActive = id
                ? beforeState.commitments?.active?.[id]
                : null;

            const stillActive = id
                ? nextState.commitments?.active?.[id]
                : null;

            // Projection hanya mengikuti transisi canonical ACTIVE -> selesai.
            // Unknown/ignored completion tidak boleh membuat read-model hantu.
            if (!id || !wasActive || stillActive) {
                return { projected: false, required: false };
            }

            await this.store.upsertCommitment(
                id,
                "COMPLETED",
                {
                    commitmentId: id,
                    ...structuredCopyOf(wasActive),
                    status: "COMPLETED",
                    completedAt: envelope.timestamp,
                    completionEventId: envelope.eventId
                }
            );

            return { projected: true, kind: "commitment" };
        }

        if (envelope.type === "SUBSTRATE_CHANGED") {
            const descriptor = nextState.substrate?.current;
            const epochId = descriptor?.substrateEpochId;

            // B2-FIX (red-team): canonical epochs adalah RING berkapasitas
            // 50. Guard lama membandingkan PANJANG array; setelah ring
            // penuh, panjang tidak pernah tumbuh sehingga SETIAP epoch
            // valid baru berhenti terproyeksi secara diam-diam.
            //
            // Guard transisi yang benar (bebas kapasitas):
            //   - reducer harus mendorong epoch BARU sebagai elemen
            //     TERAKHIR dengan epochId milik event ini, dan
            //   - elemen terakhir SEBELUMNYA tidak boleh ber-id sama
            //     (event ignored/duplikat tidak menciptakan ghost).
            const beforeEpochs =
                beforeState.substrate?.epochs ?? [];
            const afterEpochs =
                nextState.substrate?.epochs ?? [];
            const beforeLast =
                beforeEpochs.length ? beforeEpochs[beforeEpochs.length - 1] : null;
            const canonicalEpoch =
                afterEpochs.length ? afterEpochs[afterEpochs.length - 1] : null;

            if (
                !descriptor ||
                !epochId ||
                !canonicalEpoch ||
                canonicalEpoch.epochId !== epochId ||
                (beforeLast && beforeLast.epochId === epochId)
            ) {
                return { projected: false, required: false };
            }

            await this.store.upsertSubstrateEpoch(
                epochId,
                {
                    descriptor: structuredCopyOf(descriptor),
                    at: canonicalEpoch.at ?? envelope.timestamp,
                    eventId: envelope.eventId
                }
            );

            return { projected: true, kind: "substrate" };
        }

        if (envelope.type === "PREDICTION_OPENED") {
            const prediction = envelope.payload?.prediction;
            const id = prediction?.predictionId;

            if (!id || !nextState.predictions?.open?.[id]) {
                return { projected: false, required: false };
            }

            await this.store.upsertPrediction(
                id,
                "OPEN",
                structuredCopyOf(prediction)
            );

            return { projected: true, kind: "prediction" };
        }

        if (
            envelope.type === "PREDICTION_RESOLVED_CORRECT" ||
            envelope.type === "PREDICTION_RESOLVED_INCORRECT"
        ) {
            const id = envelope.payload?.predictionId;

            const wasOpen = id
                ? beforeState.predictions?.open?.[id]
                : null;

            const stillOpen = id
                ? nextState.predictions?.open?.[id]
                : null;

            // Projection hanya boleh mengikuti transisi canonical OPEN -> resolved.
            // Stale read-model tidak boleh menentukan validitas resolusi.
            if (!id || !wasOpen || stillOpen) {
                return { projected: false, required: false };
            }

            const status = envelope.type === "PREDICTION_RESOLVED_CORRECT"
                ? "RESOLVED_CORRECT"
                : "RESOLVED_INCORRECT";

            await this.store.upsertPrediction(
                id,
                status,
                {
                    ...structuredCopyOf(wasOpen),
                    status,
                    resolvedAt: envelope.timestamp,
                    resolutionEventId: envelope.eventId
                }
            );

            return { projected: true, kind: "prediction" };
        }

        if (envelope.type === "EXPERIENCE_RECORDED") {
            const experience = envelope.payload?.experience;
            const id = experience?.experienceId;

            const beforeCount =
                beforeState.autobiography?.significantCount ?? 0;

            const afterCount =
                nextState.autobiography?.significantCount ?? 0;

            const canonical =
                [...(nextState.autobiography?.recent ?? [])]
                    .reverse()
                    .find(item => item.experienceId === id);

            // Projection hanya mengikuti pengalaman yang benar-benar diterima
            // reducer. Significance berasal dari canonical state yang sudah
            // dinormalisasi/clamp, bukan payload mentah.
            if (
                !id ||
                afterCount !== beforeCount + 1 ||
                !canonical
            ) {
                return { projected: false, required: false };
            }

            await this.store.upsertExperience(
                id,
                canonical.significance,
                structuredCopyOf(experience)
            );

            return { projected: true, kind: "experience" };
        }

        return { projected: false, required: false };

    }

    async append(type, source, provenance, payload, envelopeFields = {}) {

        const prevHash = this.prevHash;
        const occurredAt = envelopeFields.occurredAt ?? this.clock.nowIso();

        const row = {
            eventId: envelopeFields.eventId ?? crypto.randomUUID(),
            type, occurredAt,
            monotonic: envelopeFields.monotonic ?? Date.now(),
            source, provenance,
            subject: envelopeFields.subject ?? null,
            sessionId: envelopeFields.sessionId ?? null,
            correlationId: envelopeFields.correlationId ?? null,
            confidence: envelopeFields.confidence ?? 1,
            payload,
            prevHash,
            hash: null
        };

        // Rantai hash §51: deteksi korupsi/kecelakaan, BUKAN klaim
        // anti-tamper terhadap attacker lokal ber-privilese.
        row.hash = sha256Row(row);

        const result = await this.store.appendEvent(row);
        if (!result.duplicate) {
            this.prevHash = row.hash;
            this.journalSeq = Math.max(this.journalSeq, result.seq);
            this.eventsSinceSnapshot += 1;
        }
        return result;

    }

    commit(nextState) {
        this.state = nextState;
        this.state.diagnostics.appliedCount += 1;
    }

    /** Digest SEMANTIK (bebas field volatil seperti bootId). */
    semanticDigest() {
        const s = cloneState(this.state);
        delete s.boots;
        delete s.restores;
        delete s.diagnostics;
        return digest(s);
    }

    /** Verifikasi rantai jurnal (§51). */
    async verifyJournalIntegrity() {

        const events = await this.store.allEvents();
        let prev = null;
        let position = 0;

        for (const row of events) {
            const expected = sha256Row({ ...row, prevHash: prev });
            if (row.prevHash !== prev || row.hash !== expected) {
                return { ok: false, corruptAtSeq: row.seq, position };
            }
            prev = row.hash;
            position += 1;
        }

        return { ok: true, length: position };

    }

}

/* ---------------------------------------------------------------------- */

// Read-view reliabilitas alat — DISET oleh integrator (ToolStats adapter).
let ctx_toolReliability = () => 0.5;
function setToolReliabilitySource(fn) {
    if (typeof fn === "function") ctx_toolReliability = fn;
}

function sha256Row(row) {
    const material = canonicalJson({
        eventId: row.eventId, type: row.type,
        occurredAt: row.occurredAt, monotonic: row.monotonic,
        source: row.source, provenance: row.provenance,
        subject: row.subject ?? null,
        sessionId: row.sessionId ?? null,
        correlationId: row.correlationId ?? null,
        confidence: row.confidence ?? 1,
        payload: row.payload ?? {},
        prevHash: row.prevHash ?? null
    });
    return require("../core/envelope").sha256(material);
}

/** Envelope dengan clock core (untuk operasi internal). */
function makeEnvelopeSafe(spec) {
    return makeEnvelope(spec);
}

/** Kunci watermark projeksi di acc_kv (sama di backend memory & sqlite). */
const PROJECTION_SEQ_KEY = "acc.projection.appliedSeq";

/** Baris jurnal → envelope replay (bentuk tunggal untuk semua jalur). */
function envelopeFromRow(row) {
    return {
        eventId: row.eventId, type: row.type,
        timestamp: row.occurredAt, monotonic: row.monotonic,
        source: row.source, provenance: row.provenance,
        subject: row.subject ?? null, sessionId: row.sessionId ?? null,
        correlationId: row.correlationId ?? null,
        confidence: row.confidence ?? 1,
        payload: row.payload ?? {}
    };
}

function eventTimeMs(env, clock) {
    const parsed = Date.parse(env?.timestamp);
    return Number.isFinite(parsed) ? parsed : clock.nowMs();
}

function structuredCopyOf(v) {
    return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : {};
}

function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
}

module.exports = {
    ContinuityCore, emptyState,
    setToolReliabilitySource, _internal: { sha256Row }
};
