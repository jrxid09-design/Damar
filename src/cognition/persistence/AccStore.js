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

const { TransactionGate, CODES, dbError } = require("../../memory/db/Database");

const MEMORY_BACKEND = "memory";
const SQLITE_BACKEND = "sqlite";

/* ----------------------------- memory ---------------------------------- */

/**
 * `faults` adalah seam uji (default no-op): memaksa kegagalan ROLLBACK/COMMIT
 * agar paritas poison dengan SQLite bisa dibuktikan. Memory tidak punya
 * ROLLBACK sungguhan; yang disimulasikan adalah langkah yang bisa gagal.
 */
function createMemoryAccStore({ spanDeadlineMs, faults = {} } = {}) {

    const journal = [];            // baris naik sesuai seq
    const byEventId = new Map();
    const kv = new Map();
    const snapshots = [];
    const predictions = new Map();
    const experiences = new Map();
    const commitments = new Map();
    const substrateEpochs = new Map();

    // R5: kontrak kepemilikan sama dengan SQLite (lihat Database/TransactionGate).
    // Tidak ada SQL, jadi settle tidak pernah menemukan transaksi tersisa.
    const gate = new TransactionGate({
        open: async () => null,
        settle: async () => false,
        spanDeadlineMs
    });

    const api = {
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

        async putKv(key, value) { if (value === null || value === undefined) kv.delete(key); else kv.set(key, value); },
        async getKv(key) { return kv.has(key) ? kv.get(key) : null; },

        // R2 atomic primitive (contract: see transact in createSqliteAccStore).
        // R5: only operations made through `tx` belong to the span; unscoped calls inside it are
        // rejected and outside calls queue behind it, exactly as with SQLite. Writes are staged and
        // applied in one closing step after work() resolves; a throw discards them.
        // R6: the closing step runs only while the span is still open (a span that expired during
        // work() never applies its writes), and a failing commit or rollback poisons the instance,
        // exactly as the SQLite Database does.
        transact(work) {
            return gate.exclusive(async span => {
                const staged = new Map();
                const tx = {
                    getKv: key => span.enqueue(async () => (staged.has(key) ? staged.get(key) : (kv.has(key) ? kv.get(key) : null))),
                    putKv: (key, value) => span.enqueue(async () => { staged.set(key, value ?? null); })
                };
                let out;
                try {
                    out = await work(tx);
                }
                catch (error) {
                    if (span.beginFinish()) {
                        try {
                            if (faults.rollback) faults.rollback();
                        }
                        catch (rollbackError) {
                            await gate.poison(rollbackError);
                            throw Object.assign(dbError(CODES.ROLLBACK_FAILED, `ROLLBACK failed after callback error (${error?.message ?? "unknown"}). Transaction outcome unknown, so it is not reported as rolled back. Database instance poisoned; create a new Database instance`, rollbackError), { callbackError: error });
                        }
                    }
                    throw error;
                }
                if (!span.beginFinish()) {
                    throw dbError(CODES.EXPIRED, "span ended before COMMIT; staged writes discarded");
                }
                try {
                    await span.enqueue(async () => {
                        if (faults.commit) faults.commit();
                        for (const [key, value] of staged) {
                            if (value === null) kv.delete(key); else kv.set(key, value);
                        }
                    }, { closing: true });
                }
                catch (error) {
                    await gate.poison(error);
                    throw dbError(CODES.COMMIT_FAILED, "COMMIT did not complete; the outcome is unverified, so the write is not acknowledged. Database instance poisoned; create a new Database instance", error);
                }
                return out;
            });
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

    return guardUnscoped(api, gate);
}

/**
 * R5: setiap operasi unscoped memory lewat gerbang, sama seperti `Database.run`:
 * ditolak dari dalam span hidup, dan mengantre di belakang span lain.
 */
function guardUnscoped(api, gate) {
    for (const key of Object.keys(api)) {
        const fn = api[key];
        if (key === "transact" || typeof fn !== "function") continue;
        api[key] = (...args) => gate.unscoped(() => fn.apply(api, args));
    }
    return api;
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

        // putKv(key, null) deletes the row: a missing key and a null value read the same,
        // so a retired key leaves no dead row behind (bounded persistent representation).
        async putKv(key, value) {
            if (value === null || value === undefined) {
                await database.run("DELETE FROM acc_kv WHERE key = ?", [key]);
                return;
            }
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
        // entry or the reverse. R4: membership is explicit. Only operations made through
        // the transaction capability `tx` belong to this span. Async context does not
        // confer ownership, so appendEvent and putKv from other subsystems never join it:
        // called inside the span they fail before touching the database, and called from
        // outside they wait until COMMIT or ROLLBACK. R5: Database owns BEGIN/COMMIT/ROLLBACK
        // and verifies no transaction survives span exit.
        transact(work) {
            return database.transaction(tx => work({
                async getKv(key) {
                    const row = await tx.get("SELECT value FROM acc_kv WHERE key = ?", [key]);
                    return row ? JSON.parse(row.value) : null;
                },
                async putKv(key, value) {
                    if (value === null || value === undefined) {
                        await tx.run("DELETE FROM acc_kv WHERE key = ?", [key]);
                        return;
                    }
                    await tx.run(
                        `INSERT INTO acc_kv (key, value) VALUES (?, ?)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                        [key, JSON.stringify(value)]);
                }
            })).catch(error => {
                if (error?.code !== "TX_BEGIN_BUSY") throw error;
                throw Object.assign(new Error("ACC_TRANSACTION_BUSY: write lock not acquired"), { code: "ACC_TRANSACTION_BUSY" });
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

function parsePayload(row) {
    return { ...row, payload: safeParse(row.payload) };
}

function safeParse(text) {
    try { return JSON.parse(text); }
    catch { return {}; }
}

module.exports = { createSqliteAccStore, createMemoryAccStore };
