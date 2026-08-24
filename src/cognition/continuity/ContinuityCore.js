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

        // Identitas belum ada → inisialisasi SEKALI (§9).
        if (!this.state.identity.identityId) {
            await this.append("IDENTITY_INITIALIZED", "acc.continuity",
                "SYSTEM_EVENT", {
                    identityId: `idn-${crypto.randomUUID()}`,
                    continuityId: `cnt-${crypto.randomUUID()}`,
                    epochId: `epc-${crypto.randomUUID()}`
                }, {});
        }

        // Boot epoch baru SETIAP runtime boot; identitas tidak berubah.
        await this.append("BOOT_EPOCH_CREATED", "acc.continuity",
            "SYSTEM_EVENT", { bootId: this.bootId }, {});

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

        let working = this.preApply(envelope);

        // Reducer murni per tipe.
        const handler = HANDLERS[envelope.type];
        let next;
        if (!handler) {
            // Tidak akan terjadi (makeEnvelope memfilter), tetapi tetap
            // aman: diagnostik saja — tidak mutasi otoritatif (§100).
            next = ignored(working, `tipe tanpa handler: ${envelope.type}`);
            next.diagnostics.unknownEvents += 1;
        } else {
            const appraisal = appraise(envelope, {
                config: this.config,
                toolReliability: ctx_toolReliability
            });
            next = handler(working, envelope,
                { config: this.config, nowMs, appraisal });
            this._lastAppraisal = appraisal;
        }

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
        await this.mirror(envelope, next);

        return { applied: true, eventId: envelope.eventId };

    }

    /** Rekonstruksi dari baris jurnal saat load/replay (tanpa re-append). */
    applyPersisted(row) {

        if (this.seenEventIds.has(row.eventId)) return false;   // idempoten

        const env = {
            eventId: row.eventId, type: row.type,
            timestamp: row.occurredAt, monotonic: row.monotonic,
            source: row.source, provenance: row.provenance,
            subject: row.subject ?? null, sessionId: row.sessionId ?? null,
            correlationId: row.correlationId ?? null,
            confidence: row.confidence ?? 1,
            payload: row.payload ?? {}
        };

        const handler = HANDLERS[env.type];

        // Jalur replay memakai pre-decay yang SAMA dengan jalur live
        // (berbasis rantai timestamp event) → determinisme penuh (§50).
        let working = this.preApply(env);

        let next;
        if (!handler) {
            next = ignored(working,
                `tipe tanpa handler (persisted): ${env.type}`);
            next.diagnostics.unknownEvents += 1;
        } else {
            const appraisal = appraise(env, {
                config: this.config,
                toolReliability: ctx_toolReliability
            });
            next = handler(working, env,
                { config: this.config,
                  nowMs: Date.parse(env.timestamp) || this.clock.nowMs(),
                  appraisal });
        }

        this.commit(next);
        this.seenEventIds.add(row.eventId);
        return true;

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
    preApply(envelope) {

        const prevIso = this.state.meta.lastAffectAt ?? null;
        const prevMs = prevIso ? Date.parse(prevIso) : NaN;
        const curMs = Date.parse(envelope.timestamp);

        const working = cloneState(this.state);

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

    async append type, source, provenance, payload, envelopeFields = {}) {

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
