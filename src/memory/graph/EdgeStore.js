const { database } = require("../db");

/**
 * EdgeStore — sisi (relasi) Knowledge Graph, bi-temporal.
 *
 * link()   — buat/gantikan sisi hidup untuk sebuah triple.
 * unlink() — akhiri masa berlaku sisi hidup (valid_to = now), tak dihapus.
 * neighbors() — sisi hidup di sekitar sebuah simpul.
 *
 * "Menggantikan" = tutup versi lama (valid_to/superseded_at now) lalu
 * sisipkan versi baru, sehingga riwayat "dulu begini" tetap ada.
 */
class EdgeStore {

    async link({ subject, predicate, object, confidence = 1.0, source = "damar", metadata = {} }) {
        if (!subject || !predicate || !object) {
            throw new Error("Sisi butuh subject, predicate, dan object.");
        }
        const now = new Date().toISOString();
        // Tutup sisi hidup lama untuk triple ini (kalau ada) — kepercayaan/
        // sumber bisa berubah, riwayatnya disimpan.
        await database.run(
            `UPDATE memory_edges SET valid_to = ?, superseded_at = ?
             WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL`,
            [now, now, subject, predicate, object]
        );
        const res = await database.run(
            `INSERT INTO memory_edges (subject, predicate, object, confidence, source, metadata, valid_from, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [subject, predicate, object, confidence, source, JSON.stringify(metadata ?? {}), now, now]
        );
        return this.get(res.lastID);
    }

    async unlink({ subject, predicate, object }) {
        const now = new Date().toISOString();
        const res = await database.run(
            `UPDATE memory_edges SET valid_to = ?, superseded_at = ?
             WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL`,
            [now, now, subject, predicate, object]
        );
        return res.changes > 0;
    }

    async get(id) {
        const row = await database.get("SELECT * FROM memory_edges WHERE id = ?", [id]);
        return row ? this.hydrate(row) : null;
    }

    /** Sisi hidup di sekitar node. direction: out|in|both. */
    async neighbors(node, { direction = "both", limit = 100 } = {}) {
        const live = "valid_to IS NULL";
        let where, params;
        if (direction === "out") { where = `subject = ? AND ${live}`; params = [node]; }
        else if (direction === "in") { where = `object = ? AND ${live}`; params = [node]; }
        else { where = `(subject = ? OR object = ?) AND ${live}`; params = [node, node]; }
        const rows = await database.all(
            `SELECT * FROM memory_edges WHERE ${where} ORDER BY confidence DESC, id DESC LIMIT ?`,
            [...params, limit]
        );
        return rows.map(r => this.hydrate(r));
    }

    async all({ includeExpired = false, limit = 500 } = {}) {
        const clause = includeExpired ? "" : "WHERE valid_to IS NULL";
        const rows = await database.all(
            `SELECT * FROM memory_edges ${clause} ORDER BY id DESC LIMIT ?`, [limit]
        );
        return rows.map(r => this.hydrate(r));
    }

    hydrate(row) {
        let metadata = {};
        try { metadata = JSON.parse(row.metadata ?? "{}"); } catch { /* abaikan */ }
        return {
            id: row.id, subject: row.subject, predicate: row.predicate, object: row.object,
            confidence: row.confidence, source: row.source, metadata,
            validFrom: row.valid_from, validTo: row.valid_to,
            recordedAt: row.recorded_at, supersededAt: row.superseded_at
        };
    }

}

module.exports = new EdgeStore();
