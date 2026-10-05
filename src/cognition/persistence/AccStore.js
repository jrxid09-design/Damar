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
    let memoryTxTail = Promise.resolve();
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

        // R2 atomic primitive (contract: see transact in createSqliteAccStore).
        // Writes are staged and applied only when work() resolves; a throw discards them.
        transact(work) {
            const run = async () => {
                const staged = new Map();
                const tx = {
                    async getKv(key) { return staged.has(key) ? staged.get(key) : (kv.has(key) ? kv.get(key) : null); },
                    async putKv(key, value) { staged.set(key, value); }
                };
                const out = await work(tx);
                for (const [key, value] of staged) kv.set(key, value);
                return out;
            };
            const next = memoryTxTail.then(run);
            memoryTxTail = next.then(() => {}, () => {});
            return next;
        },

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
        // Bentuk baris HARUS identik dengan backend sqlite: payload
        // BERSARANG, bukan disebar. Dulu memory menyebarkannya sehingga
        // `row.payload` undefined di sini tetapi terisi di sqlite — dua
        // backend dengan semantik berbeda untuk read-model yang sama.
        async listSubstrateEpochs() {
            return [...substrateEpochs.entries()].map(([epoch_id, v]) =>
                ({ epoch_id, payload: v }));
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
                        confidence, schema_version, epistemic_class,
                        payload, prev_hash, hash)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [row.eventId, row.type, row.occurredAt, row.monotonic,
                     row.source, row.provenance, row.subject, row.sessionId,
                     row.correlationId, row.confidence,
                     row.schemaVersion ?? null, row.epistemicClass ?? null,
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
                        confidence, schema_version AS schemaVersion,
                        epistemic_class AS epistemicClass,
                        payload, prev_hash AS prevHash, hash
                   FROM acc_event_journal ORDER BY seq DESC LIMIT 1`);
        },

        async eventsAfterSeq(afterSeq = 0) {
            const rows = await database.all(
                `SELECT seq, event_id AS eventId, type, occurred_at AS occurredAt,
                        monotonic, source, provenance, subject,
                        session_id AS sessionId, correlation_id AS correlationId,
                        confidence, schema_version AS schemaVersion,
                        epistemic_class AS epistemicClass,
                        payload, prev_hash AS prevHash, hash
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

        // R2 atomic mutation primitive. work(tx) receives { getKv, putKv } bound to one
        // BEGIN IMMEDIATE transaction: the write lock is taken up front, so two
        // PROCESSES sharing this database file serialize here (busy_timeout waits;
        // BEGIN is retried a bounded number of times). A throw in work() rolls back
        // every write it made, so callers never leave a record without its index
        // entry or the reverse. R3: the whole span owns the connection (Database
        // exclusive). Every other operation on this connection, including appendEvent
        // and putKv from other subsystems, waits until COMMIT or ROLLBACK, so none of
        // them can join this transaction and be rolled back with it.
        transact(work) {
            return database.exclusive(async () => {
                await beginImmediate(database);
                try {
                    const out = await work({
                        async getKv(key) {
                            const row = await database.get("SELECT value FROM acc_kv WHERE key = ?", [key]);
                            return row ? JSON.parse(row.value) : null;
                        },
                        async putKv(key, value) {
                            await database.run(
                                `INSERT INTO acc_kv (key, value) VALUES (?, ?)
                                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                                [key, JSON.stringify(value)]);
                        }
                    });
                    await database.run("COMMIT");
                    return out;
                }
                catch (error) {
                    try { await database.run("ROLLBACK"); }
                    catch { /* keep the original error */ }
                    throw error;
                }
            });
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

const BEGIN_ATTEMPTS = 8;

async function beginImmediate(database) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await database.run("BEGIN IMMEDIATE");
            return;
        }
        catch (error) {
            const busy = error?.code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked/i.test(String(error?.message ?? ""));
            if (!busy) throw error;
            if (attempt >= BEGIN_ATTEMPTS) {
                throw Object.assign(new Error("ACC_TRANSACTION_BUSY: write lock not acquired"), { code: "ACC_TRANSACTION_BUSY" });
            }
            await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
        }
    }
}

function parsePayload(row) {
    return { ...row, payload: safeParse(row.payload) };
}

function safeParse(text) {
    try { return JSON.parse(text); }
    catch { return {}; }
}

module.exports = { createSqliteAccStore, createMemoryAccStore };
