/**
 * Presence Runtime V0 — mesin lifecycle inti.
 *
 * Sifat:
 *  - Transisi eksplisit lewat graf legal (fail closed), tanpa setState bebas.
 *  - Atomik: validasi penuh -> commit sekali -> baru beri tahu observer.
 *    Transisi yang ditolak tidak mengubah satu byte pun.
 *  - Generasi kanon: peristiwa telat dari lifecycle lama ditolak
 *    (STALE_GENERATION) dan tidak bermutasi.
 *  - Semua waktu dari jam terinjeksi; semua struktur berbatas.
 *
 * Presence BUKAN otoritas, kognisi, aktuation, izin resource, atau
 * autentikasi pengguna. Status hanya merepresentasikan keadaan.
 */

const {
    LIFECYCLE,
    ACTIVITY_MODE,
    ACTIVITY_PRESENTATION_PRECEDENCE,
    DEGRADED_REASON,
    HEALTH,
    RESOURCE_PRESSURE_LEVEL,
    CAUSE,
    TRANSITIONS,
    ALIVE_STATES,
    FACT_TYPE,
    HOST_EVENT
} = require("./states");
const { DEFAULT_PRESENCE_CONFIG, validatePresenceConfig } = require("./config");
const { createSystemClock } = require("./clock");
const {
    PRODUCER_KIND,
    registerProducer,
    isGenuineProducer,
    createPresenceGenerationId
} = require("./identity");
const { ActivityToken, isGenuineActivityToken } = require("./activityToken");
const { PresenceJournal } = require("./journal");
const { DedupeLedger } = require("./facts");

const DECISION_CODES = Object.freeze({
    OK_COMMITTED: "OK_COMMITTED",
    OK_NOOP: "OK_NOOP",
    OK_RECORDED: "OK_RECORDED",
    OK_ALREADY_COMPLETED: "OK_ALREADY_COMPLETED",
    REJECTED_INVALID_TRANSITION: "REJECTED_INVALID_TRANSITION",
    REJECTED_INVALID_CAUSE: "REJECTED_INVALID_CAUSE",
    REJECTED_INVALID_PRODUCER: "REJECTED_INVALID_PRODUCER",
    REJECTED_UNREGISTERED_PRODUCER: "REJECTED_UNREGISTERED_PRODUCER",
    REJECTED_TERMINAL_STATE: "REJECTED_TERMINAL_STATE",
    REJECTED_INVALID_STATE: "REJECTED_INVALID_STATE",
    REJECTED_INVALID_ACTIVITY_MODE: "REJECTED_INVALID_ACTIVITY_MODE",
    REJECTED_FORGED_TOKEN: "REJECTED_FORGED_TOKEN",
    REJECTED_STALE_GENERATION: "REJECTED_STALE_GENERATION",
    REJECTED_EXPIRED_TOKEN: "REJECTED_EXPIRED_TOKEN",
    REJECTED_INTERRUPTED_TOKEN: "REJECTED_INTERRUPTED_TOKEN",
    REJECTED_BOUND_EXCEEDED: "REJECTED_BOUND_EXCEEDED",
    REJECTED_UNKNOWN_TARGET: "REJECTED_UNKNOWN_TARGET",
    REJECTED_UNKNOWN_WAIT: "REJECTED_UNKNOWN_WAIT",
    REJECTED_DUPLICATE_FACT: "REJECTED_DUPLICATE_FACT",
    REJECTED_CONFLICTING_FACT: "REJECTED_CONFLICTING_FACT",
    REJECTED_UNKNOWN_FACT_TYPE: "REJECTED_UNKNOWN_FACT_TYPE",
    REJECTED_INVALID_ARGUMENT: "REJECTED_INVALID_ARGUMENT"
});

const PRECEDENCE_RANK = new Map(
    ACTIVITY_PRESENTATION_PRECEDENCE.map((mode, index) => [mode, index])
);

function boundedText(value, max = 200) {
    if (value === undefined || value === null) return null;
    return String(value).slice(0, max);
}

class PresenceRuntime {

    constructor({ clock = createSystemClock(), config = {} } = {}) {
        this._clock = clock;
        this._config = validatePresenceConfig(config);
        this._generationCounter = 0;
        this._generation = null;
        this._state = LIFECYCLE.OFFLINE;
        this._bootedAtMs = null;
        this._summoned = false;
        this._activities = new Map();
        this._ownerWaits = new Map();
        this._degradedReasons = new Map();
        this._resourcePressure = RESOURCE_PRESSURE_LEVEL.UNKNOWN;
        this._subscribers = new Map();
        this._diagnostics = [];
        this._counters = {
            transitionsCommitted: 0,
            transitionsRejected: 0,
            activitiesStarted: 0,
            activitiesCompleted: 0,
            activitiesExpired: 0,
            activitiesInterrupted: 0,
            ownerWaitsOpened: 0,
            ownerWaitsResolved: 0,
            degradationsReported: 0,
            staleGenerationRejected: 0,
            forgedTokensRejected: 0,
            duplicatesIgnored: 0,
            conflictsDetected: 0,
            subscriberErrorsIsolated: 0,
            interruptionRecommendations: 0
        };
        this._journal = new PresenceJournal(this._config.maxHistory);
        this._ledger = new DedupeLedger(this._config.maxDedupeLedger);
        this._registeredProducerIds = new Set();
        this._coreProducer = this.registerProducer(PRODUCER_KIND.CORE, "presence-core");
        this._destroyed = false;
        this._advanceGenerationLocked("initial");
    }

    // ------------------------------------------------------------- generasi

    _advanceGenerationLocked(reason) {
        this._generationCounter += 1;
        this._generation = createPresenceGenerationId(this._generationCounter);
        const previousState = this._state;
        const now = this._clock.nowMs();
        for (const record of this._activities.values()) {
            if (record.status === "live") {
                record.status = "interrupted";
                record.endedAtMs = now;
                this._counters.activitiesInterrupted += 1;
            }
        }
        this._activities.clear();
        this._ownerWaits.clear();
        this._degradedReasons.clear();
        this._resourcePressure = RESOURCE_PRESSURE_LEVEL.UNKNOWN;
        this._summoned = false;
        this._state = LIFECYCLE.OFFLINE;
        this._journal.append({
            generation: this._generation,
            from: previousState,
            to: LIFECYCLE.OFFLINE,
            cause: CAUSE.GENERATION_ADVANCED,
            producerId: this._coreProducer.id,
            timestampMs: now,
            reason
        });
        this._notify({
            type: "GENERATION_ADVANCED",
            generation: this._generation,
            from: previousState,
            to: LIFECYCLE.OFFLINE,
            timestampMs: now
        });
    }

    /** Mulai generasi baru (mis. restart runtime): aktivitas nonterminal
     * lama menjadi INTERRUPTED; tidak ada resume otomatis (P26). */
    startNewGeneration(reason = "restart") {
        this._advanceGenerationLocked(boundedText(reason, 120));
        return { ok: true, code: DECISION_CODES.OK_COMMITTED, generation: this._generation };
    }

    get generation() {
        return this._generation;
    }

    get lifecycleState() {
        return this._state;
    }

    // ------------------------------------------------------------ produsen

    registerProducer(kind, label = "") {
        const identity = registerProducer(kind, label);
        this._registeredProducerIds.add(identity.id);
        return identity;
    }

    _assertTrustedProducer(producer) {
        if (!isGenuineProducer(producer)) {
            return DECISION_CODES.REJECTED_INVALID_PRODUCER;
        }
        if (!this._registeredProducerIds.has(producer.id)) {
            return DECISION_CODES.REJECTED_UNREGISTERED_PRODUCER;
        }
        return null;
    }

    // ---------------------------------------------------------- transisi

    _sweepExpired(now = this._clock.nowMs()) {
        let liveExpired = false;
        for (const record of this._activities.values()) {
            if (
                record.status === "live" &&
                record.expiresAtMs !== null &&
                now > record.expiresAtMs
            ) {
                record.status = "expired";
                record.endedAtMs = now;
                this._counters.activitiesExpired += 1;
                this._journal.append({
                    generation: this._generation,
                    from: this._state,
                    to: this._state,
                    activity: record.mode,
                    cause: CAUSE.ACTIVITY_COMPLETED,
                    producerId: null,
                    timestampMs: now,
                    reason: "expired"
                });
                liveExpired = true;
            }
        }
        if (liveExpired && this._state === LIFECYCLE.ACTIVE && this._liveActivityCount() === 0) {
            this._applyTransition({
                to: LIFECYCLE.DORMANT,
                cause: CAUSE.ACTIVITY_COMPLETED,
                producerId: null,
                reason: "activity-expired"
            });
            return;
        }
        for (const wait of this._ownerWaits.values()) {
            if (wait.expiresAtMs !== null && now > wait.expiresAtMs) {
                this._ownerWaits.delete(wait.waitId);
                this._counters.ownerWaitsResolved += 1;
                this._exitWaitingIfNeeded(CAUSE.OWNER_DECISION_RESOLVED, "owner-wait-expired");
            }
        }
    }

    _liveActivityCount() {
        let count = 0;
        for (const record of this._activities.values()) {
            if (record.status === "live") count += 1;
        }
        return count;
    }

    _derivedResumeTarget() {
        if (this._liveActivityCount() > 0) return LIFECYCLE.ACTIVE;
        if (this._ownerWaits.size > 0) return LIFECYCLE.WAITING_FOR_OWNER;
        if (this._summoned) return LIFECYCLE.AWAKE;
        return LIFECYCLE.DORMANT;
    }

    _applyTransition({ to, cause, producerId = null, reason = null, activity = null }) {
        const from = this._state;
        const now = this._clock.nowMs();

        if (!Object.prototype.hasOwnProperty.call(LIFECYCLE, to)) {
            this._counters.transitionsRejected += 1;
            return { ok: false, code: DECISION_CODES.REJECTED_UNKNOWN_TARGET, from, to };
        }
        if (!TRANSITIONS.has(from, to)) {
            this._counters.transitionsRejected += 1;
            return {
                ok: false,
                code: DECISION_CODES.REJECTED_INVALID_TRANSITION,
                from,
                to
            };
        }
        if (!TRANSITIONS.causesFor(from, to).has(cause)) {
            this._counters.transitionsRejected += 1;
            return {
                ok: false,
                code: DECISION_CODES.REJECTED_INVALID_CAUSE,
                from,
                to,
                cause
            };
        }

        // Commit sekali — sebelum titik ini tidak ada mutasi.
        this._state = to;
        this._counters.transitionsCommitted += 1;
        const record = this._journal.append({
            generation: this._generation,
            from,
            to,
            activity,
            cause,
            producerId,
            timestampMs: now,
            reason
        });
        this._notify({
            type: "TRANSITION",
            sequence: record.sequence,
            generation: this._generation,
            from,
            to,
            cause,
            activity,
            timestampMs: now
        });
        return { ok: true, code: DECISION_CODES.OK_COMMITTED, from, to, sequence: record.sequence };
    }

    /**
     * Satu-satunya pintu transisi eksternal. Gagal tertutup: keputusan
     * deterministik dikembalikan, state tetap byte-per-byte sama.
     */
    requestTransition({ to, cause, producer, reason = null }) {
        this._assertNotDestroyed();
        this._sweepExpired();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) {
            this._counters.transitionsRejected += 1;
            return { ok: false, code: rejection };
        }
        return this._applyTransition({
            to,
            cause,
            producerId: producer.id,
            reason: boundedText(reason)
        });
    }

    // ------------------------------------------------------- summon/dismiss

    /** Summon: DORMANT -> AWAKE. Idempoten saat sudah bangun. */
    summon(producer, reason = null) {
        this._assertNotDestroyed();
        this._sweepExpired();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };

        if (
            this._state === LIFECYCLE.AWAKE ||
            this._state === LIFECYCLE.ACTIVE ||
            this._state === LIFECYCLE.WAITING_FOR_OWNER
        ) {
            return { ok: true, code: DECISION_CODES.OK_NOOP, state: this._state };
        }
        const result = this._applyTransition({
            to: LIFECYCLE.AWAKE,
            cause: CAUSE.USER_SUMMON,
            producerId: producer.id,
            reason: boundedText(reason)
        });
        if (result.ok) this._summoned = true;
        return result;
    }

    /** Dismiss: AWAKE/ACTIVE/WAITING -> DORMANT. TIDAK mematikan runtime:
     * DORMANT = hidup tapi tak mengganggu; OFFLINE = runtime mati. */
    dismiss(producer, reason = null) {
        this._assertNotDestroyed();
        this._sweepExpired();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };

        if (this._state === LIFECYCLE.DORMANT) {
            this._summoned = false;
            return { ok: true, code: DECISION_CODES.OK_NOOP, state: this._state };
        }
        if (
            this._state !== LIFECYCLE.AWAKE &&
            this._state !== LIFECYCLE.ACTIVE &&
            this._state !== LIFECYCLE.WAITING_FOR_OWNER
        ) {
            this._counters.transitionsRejected += 1;
            return {
                ok: false,
                code: DECISION_CODES.REJECTED_INVALID_STATE,
                state: this._state
            };
        }
        const result = this._applyTransition({
            to: LIFECYCLE.DORMANT,
            cause: CAUSE.USER_DISMISS,
            producerId: producer.id,
            reason: boundedText(reason)
        });
        if (!result.ok) {
            return result;
        }
        this._summoned = false;
        return result;
    }

    // ----------------------------------------------------------- aktivitas

    /**
     * Mulai aktivitas kanon di dalam ACTIVE (P7). Mengembalikan token
     * opaque; penyelesaian butuh token asli. Token palsu/generasi lama/
     * kedaluwarsa gagal tanpa mutasi.
     */
    beginActivity(mode, { producer = null, ttlMs = null, reason = null } = {}) {
        this._assertNotDestroyed();
        this._sweepExpired();

        if (!Object.prototype.hasOwnProperty.call(ACTIVITY_MODE, mode) || mode === ACTIVITY_MODE.IDLE) {
            return { ok: false, code: DECISION_CODES.REJECTED_INVALID_ACTIVITY_MODE, mode };
        }
        if (producer !== null && !isGenuineProducer(producer)) {
            return { ok: false, code: DECISION_CODES.REJECTED_INVALID_PRODUCER };
        }
        if (this._activities.size >= this._config.maxActivities) {
            return {
                ok: false,
                code: DECISION_CODES.REJECTED_BOUND_EXCEEDED,
                bound: "maxActivities"
            };
        }

        const now = this._clock.nowMs();
        const effectiveTtl =
            ttlMs === null || ttlMs === undefined ? this._config.activityTtlMs : ttlMs;
        if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) {
            return { ok: false, code: DECISION_CODES.REJECTED_INVALID_ARGUMENT };
        }
        const expiresAtMs = now + effectiveTtl;

        // AWAKE dipromosikan ke ACTIVE secara internal (ACTIVITY_STARTED).
        if (this._state === LIFECYCLE.AWAKE) {
            const promoted = this._applyTransition({
                to: LIFECYCLE.ACTIVE,
                cause: CAUSE.ACTIVITY_STARTED,
                producerId: producer ? producer.id : null,
                reason: boundedText(reason)
            });
            if (!promoted.ok) return promoted;
        }

        // Akuntansi aktivitas terpisah dari presentasi (P8): aktivitas
        // tetap bisa dimulai saat WAITING/DEGRADED/RECOVERING — presentasi
        // ditentukan oleh precedence, bukan oleh urutan kedatangan.
        const eligible = [
            LIFECYCLE.ACTIVE,
            LIFECYCLE.WAITING_FOR_OWNER,
            LIFECYCLE.DEGRADED,
            LIFECYCLE.RECOVERING
        ].includes(this._state);
        if (!eligible) {
            return {
                ok: false,
                code: DECISION_CODES.REJECTED_INVALID_STATE,
                state: this._state
            };
        }

        const token = new ActivityToken({
            mode,
            generation: this._generation,
            startedAtMs: now,
            expiresAtMs
        });
        this._activities.set(token.id, {
            token,
            mode,
            status: "live",
            startedAtMs: now,
            expiresAtMs,
            endedAtMs: null
        });
        this._counters.activitiesStarted += 1;
        this._journal.append({
            generation: this._generation,
            from: this._state,
            to: this._state,
            activity: mode,
            cause: CAUSE.ACTIVITY_STARTED,
            producerId: producer ? producer.id : null,
            timestampMs: now,
            reason: boundedText(reason)
        });
        this._notify({
            type: "ACTIVITY_STARTED",
            generation: this._generation,
            activity: mode,
            activeActivityCount: this._liveActivityCount(),
            timestampMs: now
        });
        return { ok: true, code: DECISION_CODES.OK_COMMITTED, token };
    }

    /**
     * Selesaikan aktivitas dengan token asli. Double-completion idempoten.
     * Aktivitas kedaluwarsa tidak bisa dihidupkan ulang.
     */
    endActivity(token, { reason = null } = {}) {
        this._assertNotDestroyed();
        this._sweepExpired();

        if (!isGenuineActivityToken(token)) {
            this._counters.forgedTokensRejected += 1;
            return { ok: false, code: DECISION_CODES.REJECTED_FORGED_TOKEN };
        }
        if (token.generation !== this._generation) {
            this._counters.staleGenerationRejected += 1;
            return { ok: false, code: DECISION_CODES.REJECTED_STALE_GENERATION };
        }
        const record = this._activities.get(token.id);
        if (!record || record.token !== token) {
            return { ok: false, code: DECISION_CODES.REJECTED_FORGED_TOKEN };
        }
        if (record.status === "completed") {
            return { ok: true, code: DECISION_CODES.OK_ALREADY_COMPLETED };
        }
        if (record.status === "expired") {
            return { ok: false, code: DECISION_CODES.REJECTED_EXPIRED_TOKEN };
        }
        if (record.status === "interrupted") {
            return { ok: false, code: DECISION_CODES.REJECTED_INTERRUPTED_TOKEN };
        }

        const now = this._clock.nowMs();
        record.status = "completed";
        record.endedAtMs = now;
        this._counters.activitiesCompleted += 1;
        this._journal.append({
            generation: this._generation,
            from: this._state,
            to: this._state,
            activity: record.mode,
            cause: CAUSE.ACTIVITY_COMPLETED,
            producerId: null,
            timestampMs: now,
            reason: boundedText(reason)
        });

        if (this._state === LIFECYCLE.ACTIVE && this._liveActivityCount() === 0) {
            return this._applyTransition({
                to: LIFECYCLE.DORMANT,
                cause: CAUSE.ACTIVITY_COMPLETED,
                producerId: null,
                reason: boundedText(reason)
            });
        }
        this._notify({
            type: "ACTIVITY_COMPLETED",
            generation: this._generation,
            activity: record.mode,
            activeActivityCount: this._liveActivityCount(),
            timestampMs: now
        });
        return { ok: true, code: DECISION_CODES.OK_COMMITTED };
    }

    /**
     * Rekomendasi interupsi inersia (fondasi barge-in, P9). Presence TIDAK
     * menghentikan apa pun — hanya mengekspos rekomendasi kepada consumer.
     */
    recommendInterruption(token, { producer = null, reason = null } = {}) {
        this._assertNotDestroyed();
        if (!isGenuineActivityToken(token)) {
            this._counters.forgedTokensRejected += 1;
            return { ok: false, code: DECISION_CODES.REJECTED_FORGED_TOKEN };
        }
        if (token.generation !== this._generation) {
            this._counters.staleGenerationRejected += 1;
            return { ok: false, code: DECISION_CODES.REJECTED_STALE_GENERATION };
        }
        const record = this._activities.get(token.id);
        if (!record || record.status !== "live") {
            return { ok: false, code: DECISION_CODES.OK_NOOP };
        }
        this._counters.interruptionRecommendations += 1;
        const now = this._clock.nowMs();
        this._pushDiagnostic(`INTERRUPTION_RECOMMENDED:${record.mode}`);
        this._journal.append({
            generation: this._generation,
            from: this._state,
            to: this._state,
            activity: record.mode,
            cause: CAUSE.INTERACTION_RECEIVED,
            producerId: producer ? producer.id : null,
            timestampMs: now,
            reason: `barge-in-recommendation:${boundedText(reason, 100) ?? ""}`
        });
        this._notify({
            type: "INTERRUPTION_RECOMMENDED",
            generation: this._generation,
            activity: record.mode,
            activityId: token.id,
            timestampMs: now
        });
        return { ok: true, code: DECISION_CODES.OK_RECORDED };
    }

    // -------------------------------------------------------- owner waits

    /**
     * Tunggu keputusan pemilik (P11). approvalRequestId/interactionId
     * opaque — presence tidak memeriksa semantik approval. Bounded;
     * melebihi batas gagal tertutup tanpa eviction senyap.
     */
    beginOwnerWait({ producer, approvalRequestId = null, interactionId = null, reason = null, ttlMs = null } = {}) {
        this._assertNotDestroyed();
        this._sweepExpired();

        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };
        if (this._ownerWaits.size >= this._config.maxOwnerWaits) {
            return {
                ok: false,
                code: DECISION_CODES.REJECTED_BOUND_EXCEEDED,
                bound: "maxOwnerWaits"
            };
        }

        const now = this._clock.nowMs();
        const effectiveTtl =
            ttlMs === null || ttlMs === undefined ? this._config.ownerWaitTtlMs : ttlMs;
        if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) {
            return { ok: false, code: DECISION_CODES.REJECTED_INVALID_ARGUMENT };
        }

        if (this._state === LIFECYCLE.DORMANT) {
            const woke = this._applyTransition({
                to: LIFECYCLE.AWAKE,
                cause: CAUSE.OWNER_DECISION_REQUIRED,
                producerId: producer.id,
                reason: boundedText(reason)
            });
            if (!woke.ok) return woke;
        }
        if (this._state === LIFECYCLE.AWAKE) {
            const entered = this._applyTransition({
                to: LIFECYCLE.WAITING_FOR_OWNER,
                cause: CAUSE.OWNER_DECISION_REQUIRED,
                producerId: producer.id,
                reason: boundedText(reason)
            });
            if (!entered.ok) return entered;
        }
        // Selain jalur DORMANT/AWAKE>WAITING, tunggu tetap DICATAT di
        // state apa pun yang hidup (mis. DEGRADED): akuntansi owner wait
        // terpisah dari transisi state, dan presentasi mendahulukan
        // WAITING_FOR_OWNER selama ada tunggu aktif.
        void LIFECYCLE.RECOVERING;

        this._counters.ownerWaitsOpened += 1;
        const waitId = `owner-wait-${String(this._counters.ownerWaitsOpened).padStart(6, "0")}`;
        this._ownerWaits.set(waitId, Object.freeze({
            waitId,
            approvalRequestId: boundedText(approvalRequestId),
            interactionId: boundedText(interactionId),
            reason: boundedText(reason),
            producerId: producer.id,
            createdAtMs: now,
            expiresAtMs: now + effectiveTtl
        }));
        return { ok: true, code: DECISION_CODES.OK_COMMITTED, waitId };
    }

    /**
     * Selesaikan SATU tunggu. Menyelesaikan satu permintaan tidak pernah
     * menghapus tunggu lain yang tak berkaitan.
     */
    resolveOwnerWait(waitId, { producer, outcome = null } = {}) {
        this._assertNotDestroyed();
        this._sweepExpired();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };

        if (!this._ownerWaits.has(waitId)) {
            return { ok: false, code: DECISION_CODES.REJECTED_UNKNOWN_WAIT, waitId };
        }
        this._ownerWaits.delete(waitId);
        this._counters.ownerWaitsResolved += 1;

        if (this._ownerWaits.size === 0 && this._state === LIFECYCLE.WAITING_FOR_OWNER) {
            const target = this._liveActivityCount() > 0
                ? LIFECYCLE.ACTIVE
                : LIFECYCLE.AWAKE;
            return this._applyTransition({
                to: target,
                cause: CAUSE.OWNER_DECISION_RESOLVED,
                producerId: producer.id,
                reason: boundedText(outcome)
            });
        }
        return { ok: true, code: DECISION_CODES.OK_COMMITTED, remaining: this._ownerWaits.size };
    }

    _exitWaitingIfNeeded(cause, reasonNote) {
        if (this._state !== LIFECYCLE.WAITING_FOR_OWNER || this._ownerWaits.size > 0) {
            return;
        }
        const target = this._liveActivityCount() > 0 ? LIFECYCLE.ACTIVE : LIFECYCLE.AWAKE;
        this._applyTransition({
            to: target,
            cause,
            producerId: this._coreProducer.id,
            reason: reasonNote
        });
    }

    // ------------------------------------------------------------- degraded

    /**
     * Laporkan degradasi (P12). Presence hanya MEREPRESENTASIKAN kegagalan,
     * tidak menyelesaikannya. Alasan dedupe per (kind, detail); bounded.
     */
    reportDegradation({ producer, kind, detail = null, cause = CAUSE.DEPENDENCY_UNAVAILABLE } = {}) {
        this._assertNotDestroyed();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };

        if (!Object.prototype.hasOwnProperty.call(DEGRADED_REASON, kind)) {
            return { ok: false, code: DECISION_CODES.REJECTED_INVALID_ARGUMENT, kind };
        }
        const key = `${kind}|${boundedText(detail, 120) ?? ""}`;
        if (this._degradedReasons.has(key)) {
            return { ok: true, code: DECISION_CODES.OK_NOOP };
        }
        if (this._degradedReasons.size >= this._config.maxDegradedReasons) {
            return {
                ok: false,
                code: DECISION_CODES.REJECTED_BOUND_EXCEEDED,
                bound: "maxDegradedReasons"
            };
        }
        if (this._state === LIFECYCLE.FAILED) {
            return { ok: false, code: DECISION_CODES.REJECTED_TERMINAL_STATE };
        }

        const now = this._clock.nowMs();
        this._degradedReasons.set(key, Object.freeze({ kind, detail: boundedText(detail, 120), sinceMs: now }));
        this._counters.degradationsReported += 1;
        this._pushDiagnostic(`DEGRADED:${key}`);

        if ([LIFECYCLE.DORMANT, LIFECYCLE.AWAKE, LIFECYCLE.ACTIVE, LIFECYCLE.WAITING_FOR_OWNER]
            .includes(this._state)) {
            return this._applyTransition({
                to: LIFECYCLE.DEGRADED,
                cause,
                producerId: producer.id,
                reason: kind
            });
        }
        return { ok: true, code: DECISION_CODES.OK_RECORDED, state: this._state };
    }

    /** Hapus satu alasan degradasi. Saat kosong, kembali ke state resume
     * yang diturunkan dari fakta hidup (deterministik, konvergen). */
    clearDegradation({ kind, detail = null, producer } = {}) {
        this._assertNotDestroyed();
        this._sweepExpired();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };

        const key = `${kind}|${boundedText(detail, 120) ?? ""}`;
        if (!this._degradedReasons.has(key)) {
            return { ok: false, code: DECISION_CODES.REJECTED_UNKNOWN_TARGET, key };
        }
        this._degradedReasons.delete(key);

        if (this._degradedReasons.size === 0 && this._state === LIFECYCLE.DEGRADED) {
            return this._applyTransition({
                to: this._derivedResumeTarget(),
                cause: CAUSE.DEGRADATION_CLEARED,
                producerId: producer.id,
                reason: "all-degraded-reasons-cleared"
            });
        }
        return { ok: true, code: DECISION_CODES.OK_COMMITTED, remaining: this._degradedReasons.size };
    }

    /**
     * Tekanan resource (P15): presence hanya mencatat level dan boleh
     * merepresentasikannya sebagai alasan DEGRADED. Presence tidak pernah
     * melakukan throttling dan tidak pernah memberi admission resource.
     */
    setResourcePressure(level, producer) {
        this._assertNotDestroyed();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };
        if (!Object.prototype.hasOwnProperty.call(RESOURCE_PRESSURE_LEVEL, level)) {
            return { ok: false, code: DECISION_CODES.REJECTED_INVALID_ARGUMENT, level };
        }

        const previous = this._resourcePressure;
        this._resourcePressure = level;
        if ((level === RESOURCE_PRESSURE_LEVEL.HIGH || level === RESOURCE_PRESSURE_LEVEL.CRITICAL) &&
            !this._hasDegradedKind(DEGRADED_REASON.RESOURCE_PRESSURE)) {
            return this.reportDegradation({
                producer,
                kind: DEGRADED_REASON.RESOURCE_PRESSURE,
                detail: null,
                cause: CAUSE.RESOURCE_PRESSURE
            });
        }
        if (
            (level === RESOURCE_PRESSURE_LEVEL.NORMAL ||
                level === RESOURCE_PRESSURE_LEVEL.ELEVATED ||
                level === RESOURCE_PRESSURE_LEVEL.UNKNOWN) &&
            this._hasDegradedKind(DEGRADED_REASON.RESOURCE_PRESSURE)
        ) {
            return this.clearDegradation({
                kind: DEGRADED_REASON.RESOURCE_PRESSURE,
                detail: null,
                producer
            });
        }
        return { ok: true, code: DECISION_CODES.OK_RECORDED, previous, level };
    }

    _hasDegradedKind(kind) {
        for (const entry of this._degradedReasons.values()) {
            if (entry.kind === kind) return true;
        }
        return false;
    }

    // ------------------------------------------------------------- recovery

    requestRecovery(producer, reason = null) {
        return this._recoveryOp(producer, CAUSE.RECOVERY_STARTED, LIFECYCLE.RECOVERING, reason);
    }

    completeRecovery(producer, reason = null) {
        // Recovery Capsule melaporkan pulih penuh: alasan degradasi lama
        // tidak lagi jujur dipertahankan — presence menghapusnya saat commit.
        this._degradedReasons.clear();
        return this._recoveryOp(producer, CAUSE.RECOVERY_COMPLETED, LIFECYCLE.DORMANT, reason);
    }

    degradeRecovery(producer, reason = null) {
        // Pulih sebagian: pastikan representasi tetap DEGRADED dengan
        // alasan eksplisit (RECOVERY_REQUIRED) bila belum ada.
        if (this._degradedReasons.size === 0 && this._state !== LIFECYCLE.FAILED) {
            this._degradedReasons.set(`${DEGRADED_REASON.RECOVERY_REQUIRED}|`, Object.freeze({
                kind: DEGRADED_REASON.RECOVERY_REQUIRED,
                detail: null,
                sinceMs: this._clock.nowMs()
            }));
            this._pushDiagnostic(`DEGRADED:${DEGRADED_REASON.RECOVERY_REQUIRED}|`);
        }
        return this._recoveryOp(producer, CAUSE.RECOVERY_DEGRADED, LIFECYCLE.DEGRADED, reason);
    }

    failRecovery(producer, reason = null) {
        return this._recoveryOp(producer, CAUSE.RECOVERY_FAILED, LIFECYCLE.FAILED, reason);
    }

    _recoveryOp(producer, cause, to, reason) {
        this._assertNotDestroyed();
        this._sweepExpired();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };
        return this._applyTransition({
            to,
            cause,
            producerId: producer.id,
            reason: boundedText(reason)
        });
    }

    // ------------------------------------------------------ boot/shutdown

    boot(producer = null) {
        this._assertNotDestroyed();
        const actor = producer ?? this._coreProducer;
        const rejection = this._assertTrustedProducer(actor);
        if (rejection) return { ok: false, code: rejection };
        const result = this._applyTransition({
            to: LIFECYCLE.BOOTING,
            cause: CAUSE.PROCESS_START,
            producerId: actor.id
        });
        if (result.ok && this._bootedAtMs === null) {
            this._bootedAtMs = this._clock.nowMs();
        }
        return result;
    }

    markInitializing(producer = null) {
        return this._transitionCore(producer, LIFECYCLE.INITIALIZING, CAUSE.INITIALIZATION_STARTED);
    }

    markInitializationComplete(producer = null) {
        return this._transitionCore(producer, LIFECYCLE.DORMANT, CAUSE.INITIALIZATION_COMPLETE);
    }

    reportFatalFailure(producer, reason = null) {
        this._assertNotDestroyed();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };
        return this._applyTransition({
            to: LIFECYCLE.FAILED,
            cause: CAUSE.FATAL_FAILURE,
            producerId: producer.id,
            reason: boundedText(reason)
        });
    }

    requestShutdown(producer, reason = null) {
        this._assertNotDestroyed();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };
        return this._applyTransition({
            to: LIFECYCLE.SHUTTING_DOWN,
            cause: CAUSE.SHUTDOWN_REQUEST,
            producerId: producer.id,
            reason: boundedText(reason)
        });
    }

    confirmOffline(producer = null) {
        return this._transitionCore(producer, LIFECYCLE.OFFLINE, CAUSE.PROCESS_EXIT);
    }

    _transitionCore(producer, to, cause) {
        this._assertNotDestroyed();
        const actor = producer ?? this._coreProducer;
        const rejection = this._assertTrustedProducer(actor);
        if (rejection) return { ok: false, code: rejection };
        return this._applyTransition({ to, cause, producerId: actor.id });
    }

    // ---------------------------------------------------------------- fakta

    /**
     * Pintu masuk fakta ternormalisasi dari port integrasi (P14/P17).
     * Fakta tepercaya hanya dari identitas produsen terdaftar. Konten
     * payload tidak bisa meningkatkan kepercayaan.
     */
    ingestFact({ id, type, content = {}, producer }) {
        this._assertNotDestroyed();
        const rejection = this._assertTrustedProducer(producer);
        if (rejection) return { ok: false, code: rejection };

        if (typeof id !== "string" || id.length === 0 || id.length > 200) {
            return { ok: false, code: DECISION_CODES.REJECTED_INVALID_ARGUMENT };
        }
        if (!Object.prototype.hasOwnProperty.call(FACT_TYPE, type)) {
            return { ok: false, code: DECISION_CODES.REJECTED_UNKNOWN_FACT_TYPE, type };
        }

        const classification = this._ledger.classify(id, { type, content });
        if (classification === "DUPLICATE") {
            this._counters.duplicatesIgnored += 1;
            return { ok: false, code: DECISION_CODES.REJECTED_DUPLICATE_FACT, classification };
        }
        if (classification === "CONFLICT") {
            this._counters.conflictsDetected += 1;
            this._pushDiagnostic(`FACT_CONFLICT:${id}`);
            return { ok: false, code: DECISION_CODES.REJECTED_CONFLICTING_FACT, classification };
        }

        return this._routeFact({ type, content, producer });
    }

    _routeFact({ type, content, producer }) {
        switch (type) {
            case FACT_TYPE.RESOURCE_PRESSURE_REPORTED: {
                const level = content && content.level;
                const result = this.setResourcePressure(level, producer);
                return { ...result, factRouted: true };
            }
            case FACT_TYPE.RECOVERY_EVENT: {
                const outcome = content && content.outcome;
                if (outcome === "STARTED") return { ...this.requestRecovery(producer), factRouted: true };
                if (outcome === "COMPLETE") return { ...this.completeRecovery(producer), factRouted: true };
                if (outcome === "DEGRADED") return { ...this.degradeRecovery(producer), factRouted: true };
                if (outcome === "FAILED") return { ...this.failRecovery(producer), factRouted: true };
                return { ok: true, code: DECISION_CODES.OK_RECORDED, factRouted: false };
            }
            case FACT_TYPE.HOST_EVENT: {
                const event = content && content.event;
                if (event === HOST_EVENT.SHUTDOWN_REQUESTED) {
                    return { ...this.requestShutdown(producer, "host-event"), factRouted: true };
                }
                return { ok: true, code: DECISION_CODES.OK_RECORDED, factRouted: false };
            }
            case FACT_TYPE.INTERACTION_RECEIVED: {
                if (this._state === LIFECYCLE.DORMANT) {
                    return {
                        ...this._applyTransition({
                            to: LIFECYCLE.AWAKE,
                            cause: CAUSE.INTERACTION_RECEIVED,
                            producerId: producer.id
                        }),
                        factRouted: true
                    };
                }
                if (this._state === LIFECYCLE.AWAKE) {
                    return {
                        ...this._applyTransition({
                            to: LIFECYCLE.ACTIVE,
                            cause: CAUSE.INTERACTION_RECEIVED,
                            producerId: producer.id
                        }),
                        factRouted: true
                    };
                }
                return { ok: true, code: DECISION_CODES.OK_RECORDED, factRouted: false };
            }
            default:
                return { ok: true, code: DECISION_CODES.OK_RECORDED, factRouted: false };
        }
    }

    // ------------------------------------------------------------ observer

    /**
     * Berlangganimutasi status (P22). Kegagalan subscriber terisolasi.
     * Duplikat listener yang sama ditolak eksplisit. Batas subscriber
     * ditegakkan. Unsubscribe idempoten.
     */
    subscribe(listener) {
        this._assertNotDestroyed();
        if (typeof listener !== "function") {
            throw new TypeError("PRESENCE_LISTENER_INVALID");
        }
        if (this._subscribers.has(listener)) {
            throw new Error("PRESENCE_DUPLICATE_SUBSCRIBER");
        }
        if (this._subscribers.size >= this._config.maxSubscribers) {
            throw new Error("PRESENCE_MAX_SUBSCRIBERS");
        }
        this._subscribers.set(listener, true);
        let unsubscribed = false;
        return () => {
            if (unsubscribed) return false;
            unsubscribed = true;
            return this._subscribers.delete(listener);
        };
    }

    _notify(event) {
        if (this._subscribers.size === 0) return;
        const frozenEvent = Object.freeze({ ...event });
        for (const listener of [...this._subscribers.keys()]) {
            try {
                listener(frozenEvent);
            }
            catch (error) {
                this._counters.subscriberErrorsIsolated += 1;
                this._pushDiagnostic(`SUBSCRIBER_ERROR:${error && error.message ? error.message : "unknown"}`);
            }
        }
    }

    _pushDiagnostic(text) {
        this._diagnostics.push(`${this._generation}:${text}`.slice(0, 240));
        if (this._diagnostics.length > this._config.maxDiagnostics) {
            this._diagnostics.splice(0, this._diagnostics.length - this._config.maxDiagnostics);
        }
    }

    _assertNotDestroyed() {
        if (this._destroyed) {
            throw new Error("PRESENCE_RUNTIME_DESTROYED");
        }
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._subscribers.clear();
    }

    // -------------------------------------------------------------- status

    _computePresentation() {
        if (this._state === LIFECYCLE.FAILED) return LIFECYCLE.FAILED;
        if (this._state === LIFECYCLE.RECOVERING) return LIFECYCLE.RECOVERING;
        if (this._ownerWaits.size > 0) return LIFECYCLE.WAITING_FOR_OWNER;
        if (this._degradedReasons.size > 0 || this._state === LIFECYCLE.DEGRADED) {
            return LIFECYCLE.DEGRADED;
        }
        if (this._state === LIFECYCLE.ACTIVE) {
            let best = ACTIVITY_MODE.IDLE;
            for (const record of this._activities.values()) {
                if (record.status !== "live") continue;
                if (PRECEDENCE_RANK.get(record.mode) < PRECEDENCE_RANK.get(best)) {
                    best = record.mode;
                }
            }
            return best;
        }
        return this._state;
    }

    _computeHealth() {
        if (this._state === LIFECYCLE.FAILED) return HEALTH.FAILED;
        if (this._state === LIFECYCLE.RECOVERING) return HEALTH.RECOVERING;
        if (this._degradedReasons.size > 0 || this._state === LIFECYCLE.DEGRADED) {
            return HEALTH.DEGRADED;
        }
        if (
            this._state === LIFECYCLE.OFFLINE ||
            this._state === LIFECYCLE.BOOTING ||
            this._state === LIFECYCLE.INITIALIZING ||
            this._state === LIFECYCLE.SHUTTING_DOWN
        ) {
            return HEALTH.UNKNOWN;
        }
        return HEALTH.HEALTHY;
    }

    /** Snapshot immutable untuk UI/Observatory/tray/watchdog (P21). */
    getPresenceStatus() {
        this._assertNotDestroyed();
        this._sweepExpired();
        const now = this._clock.nowMs();
        const degradedReasons = [...this._degradedReasons.keys()].sort().map((key) => {
            const entry = this._degradedReasons.get(key);
            return Object.freeze({ kind: entry.kind, detail: entry.detail, sinceMs: entry.sinceMs });
        });
        const lastRecord = this._journal.snapshot()[this._journal.size - 1] || null;
        return Object.freeze({
            generation: this._generation,
            lifecycleState: this._state,
            activityPresentation: this._computePresentation(),
            health: this._computeHealth(),
            summoned: this._summoned,
            activeActivityCount: this._liveActivityCount(),
            waitingOwnerCount: this._ownerWaits.size,
            degradedReasons: Object.freeze(degradedReasons),
            resourcePressure: this._resourcePressure,
            uptimeMs: this._bootedAtMs === null ? null : Math.max(0, now - this._bootedAtMs),
            lastTransition: lastRecord
                ? Object.freeze({
                    from: lastRecord.from,
                    to: lastRecord.to,
                    cause: lastRecord.cause,
                    timestampMs: lastRecord.timestampMs
                })
                : null,
            recentDiagnostics: Object.freeze([...this._diagnostics])
        });
    }

    /** Counter diagnostik terpisah dari snapshot state murni: penolakan
     * tetap menaikkan counter tanpa mengubah state byte-per-byte. */
    getCounters() {
        return Object.freeze({ ...this._counters });
    }

    getJournal() {
        return this._journal.snapshot();
    }

    get config() {
        return this._config;
    }
}

module.exports = {
    PresenceRuntime,
    DECISION_CODES,
    createPresenceRuntime(options = {}) {
        return new PresenceRuntime(options);
    }
};
