/**
 * ACC repository (§46/§47/§48).
 *
 * Dua backend dengan semantik identik:
 *   - sqlite : memakai wrapper `Database` yang sudah ada (koneksi sama
 *              dengan konvensi repo). Skema datang dari migrasi
 *              008_acc.sql (dijalankan oleh pemilik koneksi).
 *   - memory : in-process, deterministik, untuk unit test cepat.
 *
 * Jurnal APPEND-ONLY; duplikasi eventId ditolak level storage (UNIQUE)
 * maupun level reducer (set dedupe) — §102.
 */

const MEMORY_BACKEND = "memory";
const SQLITE_BACKEND = "sqlite";

/* ----------------------------- memory ---------------------------------- */

function createMemoryAccStore() {

    const journal = [];            // baris naik sesuai seq
    const byEventId = new Map();
    const kv = new Map();
    const snapshots = [];
    const predictions = new Map();
    const experiences = new Map();
    const commitments = new Map();
    const substrateEpochs = new Map();

    return {
        backend: MEMORY_BACKEND,

        async appendEvent(row) {
            if (byEventId.has(row.eventId)) {
                const existing = byEventId.get(row.eventId);
                return { duplicate: true, seq: existing.seq };
            }
            const seq = journal.length + 1;
            const stored = Object.freeze({ ...row, seq });
            journal.push(stored);
            byEventId.set(row.eventId, stored);
            return { duplicate: false, seq };
        },

        async lastJournalRow() {
            return journal.length ? journal[journal.length - 1] : null;
        },

        async eventsAfterSeq(afterSeq = 0) {
            return journal.filter(r => r.seq > afterSeq);
        },

        async allEvents() {
            return [...journal];
        },

        async putKv(key, value) { kv.set(key, value); },
        async getKv(key) { return kv.has(key) ? kv.get(key) : null; },

        async saveSnapshot(snap) {
            snapshots.push(Object.freeze({ ...snap, id: snapshots.length + 1 }));
        },
        async latestSnapshot() {
            return snapshots.length ? snapshots[snapshots.length - 1] : null;
        },

        async upsertPrediction(predictionId, status, payload) {
            predictions.set(predictionId, { status, payload });
        },
        async getPrediction(predictionId) {
            return predictions.get(predictionId) ?? null;
        },
        async listPredictions() {
            return [...predictions.entries()].map(([prediction_id, v]) =>
                ({ prediction_id, ...v }));
        },

        async upsertExperience(experienceId, significance, payload) {
            experiences.set(experienceId, { significance, payload });
        },
        async listExperiences() {
            return [...experiences.entries()].map(([experience_id, v]) =>
                ({ experience_id, ...v }));
        },

        async upsertCommitment(commitmentId, status, payload) {
            commitments.set(commitmentId, { status, payload });
        },
        async listCommitments() {
            return [...commitments.entries()].map(([commitment_id, v]) =>
                ({ commitment_id, ...v }));
        },

        async upsertSubstrateEpoch(epochId, payload) {
            substrateEpochs.set(epochId, payload);
        },
        async listSubstrateEpochs() {
            return [...substrateEpochs.entries()].map(([epoch_id, v]) =>
                ({ epoch_id, ...v }));
        }
    };
}

/* ----------------------------- sqlite ---------------------------------- */

function createSqliteAccStore(database) {

    return {
        backend: SQLITE_BACKEND,

        async appendEvent(row) {
            try {
                await database.run(
                    `INSERT INTO acc_event_journal
                       (event_id, type, occurred_at, monotonic, source,
                        provenance, subject, session_id, correlation_id,
                        confidence, payload, prev_hash, hash)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [row.eventId, row.type, row.occurredAt, row.monotonic,
                     row.source, row.provenance, row.subject, row.sessionId,
                     row.correlationId, row.confidence,
                     JSON.stringify(row.payload ?? {}), row.prevHash, row.hash]
                );
                const got = await database.get(
                    "SELECT seq FROM acc_event_journal WHERE event_id = ?",
                    [row.eventId]);
                return { duplicate: false, seq: got.seq };
            }
            catch (error) {
                // UNIQUE constraint pada event_id → duplikat (§102).
                if (/UNIQUE/i.test(String(error.message ?? ""))) {
                    const got = await database.get(
                        "SELECT seq FROM acc_event_journal WHERE event_id = ?",
                        [row.eventId]);
                    return { duplicate: true, seq: got?.seq ?? null };
                }
                throw error;
            }
        },

        async lastJournalRow() {
            return await database.get(
                `SELECT seq, event_id AS eventId, type, occurred_at AS occurredAt,
                        monotonic, source, provenance, subject,
                        session_id AS sessionId, correlation_id AS correlationId,
                        confidence, payload, prev_hash AS prevHash, hash
                   FROM acc_event_journal ORDER BY seq DESC LIMIT 1`);
        },

        async eventsAfterSeq(afterSeq = 0) {
            const rows = await database.all(
                `SELECT seq, event_id AS eventId, type, occurred_at AS occurredAt,
                        monotonic, source, provenance, subject,
                        session_id AS sessionId, correlation_id AS correlationId,
                        confidence, payload, prev_hash AS prevHash, hash
                   FROM acc_event_journal WHERE seq > ? ORDER BY seq ASC`,
                [afterSeq]);
            return rows.map(parsePayload);
        },

        async allEvents() {
            return this.eventsAfterSeq(0);
        },

        async putKv(key, value) {
            await database.run(
                `INSERT INTO acc_kv (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                [key, JSON.stringify(value)]);
        },

        async getKv(key) {
            const row = await database.get(
                "SELECT value FROM acc_kv WHERE key = ?", [key]);
            return row ? JSON.parse(row.value) : null;
        },

        async saveSnapshot(snap) {
            await database.run(
                "INSERT INTO acc_snapshot (created_at, seq_up_to, state) VALUES (?,?,?)",
                [snap.createdAt, snap.seqUpTo, JSON.stringify(snap.state)]);
        },

        async latestSnapshot() {
            const row = await database.get(
                `SELECT id, created_at AS createdAt, seq_up_to AS seqUpTo, state
                   FROM acc_snapshot ORDER BY id DESC LIMIT 1`);
            if (!row) return null;
            return { ...row, state: JSON.parse(row.state) };
        },

        async upsertPrediction(predictionId, status, payload) {
            await database.run(
                `INSERT INTO acc_prediction (prediction_id, status, payload)
                 VALUES (?,?,?)
                 ON CONFLICT(prediction_id) DO UPDATE
                   SET status = excluded.status, payload = excluded.payload`,
                [predictionId, status, JSON.stringify(payload)]);
        },
        async getPrediction(predictionId) {
            const row = await database.get(
                "SELECT status, payload FROM acc_prediction WHERE prediction_id = ?",
                [predictionId]);
            return row ? { status: row.status, payload: JSON.parse(row.payload) } : null;
        },
        async listPredictions() {
            const rows = await database.all(
                "SELECT prediction_id, status, payload FROM acc_prediction");
            return rows.map(r => ({
                prediction_id: r.prediction_id,
                status: r.status,
                payload: JSON.parse(r.payload)
            }));
        },

        async upsertExperience(experienceId, significance, payload) {
            await database.run(
                `INSERT INTO acc_experience (experience_id, significance, payload)
                 VALUES (?,?,?)
                 ON CONFLICT(experience_id) DO UPDATE
                   SET significance = excluded.significance,
                       payload = excluded.payload`,
                [experienceId, significance, JSON.stringify(payload)]);
        },
        async listExperiences() {
            const rows = await database.all(
                "SELECT experience_id, significance, payload FROM acc_experience");
            return rows.map(r => ({
                experience_id: r.experience_id,
                significance: r.significance,
                payload: JSON.parse(r.payload)
            }));
        },

        async upsertCommitment(commitmentId, status, payload) {
            await database.run(
                `INSERT INTO acc_commitment (commitment_id, status, payload)
                 VALUES (?,?,?)
                 ON CONFLICT(commitment_id) DO UPDATE
                   SET status = excluded.status, payload = excluded.payload`,
                [commitmentId, status, JSON.stringify(payload)]);
        },
        async listCommitments() {
            const rows = await database.all(
                "SELECT commitment_id, status, payload FROM acc_commitment");
            return rows.map(r => ({
                commitment_id: r.commitment_id,
                status: r.status,
                payload: JSON.parse(r.payload)
            }));
        },

        async upsertSubstrateEpoch(epochId, payload) {
            await database.run(
                `INSERT INTO acc_substrate_epoch (epoch_id, payload)
                 VALUES (?,?)
                 ON CONFLICT(epoch_id) DO UPDATE SET payload = excluded.payload`,
                [epochId, JSON.stringify(payload)]);
        },
        async listSubstrateEpochs() {
            const rows = await database.all(
                "SELECT epoch_id, payload FROM acc_substrate_epoch ORDER BY rowid ASC");
            return rows.map(r => ({ epoch_id: r.epoch_id, payload: JSON.parse(r.payload) }));
        }
    };
}

function parsePayload(row) {
    return { ...row, payload: safeParse(row.payload) };
}

function safeParse(text) {
    try { return JSON.parse(text); }
    catch { return {}; }
}

module.exports = { createSqliteAccStore, createMemoryAccStore };
