const { database } = require("../db");
const memory = require("../services/MemoryService");
const store = require("../stores/MemoryStore");
const edges = require("../graph/EdgeStore");

/**
 * Governor (subsistem 7) — gerbang persetujuan memori.
 *
 * Tulis ber-tier "ask" tidak langsung di-commit melainkan menjadi
 * PROPOSAL. Pengguna menyetujui/menolak; approve barulah meng-commit ke
 * substrat (LTM/KG). Setiap langkah dicatat di memory_audit.
 *
 * Ini penegak aturan: "Aether tak pernah mengubah memori jangka panjang
 * ask-tier tanpa persetujuan eksplisit."
 */
class Governor {

    async propose({ kind, payload, memoryType = null, writer = "aether", role = "superadmin", reason = null }) {
        const res = await database.run(
            `INSERT INTO memory_proposals (kind, payload, memory_type, writer, role, reason)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [kind, JSON.stringify(payload ?? {}), memoryType, writer, role, reason]
        );
        await this._audit("propose", writer, res.lastID, { kind, memoryType });
        return { proposal: await this.get(res.lastID), status: "pending" };
    }

    async get(id) {
        const row = await database.get("SELECT * FROM memory_proposals WHERE id = ?", [id]);
        return row ? this._hydrate(row) : null;
    }

    async pending({ limit = 100 } = {}) {
        const rows = await database.all(
            "SELECT * FROM memory_proposals WHERE status = 'pending' ORDER BY id DESC LIMIT ?",
            [limit]
        );
        return rows.map(r => this._hydrate(r));
    }

    async approve(id, { actor = "user" } = {}) {
        const p = await this.get(id);
        if (!p) throw new Error(`Proposal ${id} tidak ada.`);
        if (p.status !== "pending") throw new Error(`Proposal ${id} sudah ${p.status}.`);

        const committedId = await this._commit(p);
        const now = new Date().toISOString();
        await database.run(
            "UPDATE memory_proposals SET status='approved', decided_at=?, decided_by=?, committed_id=? WHERE id=?",
            [now, actor, committedId, id]
        );
        await this._audit("approve", actor, id, { committedId, kind: p.kind });
        return { ...(await this.get(id)) };
    }

    async reject(id, { actor = "user", reason = null } = {}) {
        const p = await this.get(id);
        if (!p) throw new Error(`Proposal ${id} tidak ada.`);
        if (p.status !== "pending") throw new Error(`Proposal ${id} sudah ${p.status}.`);
        const now = new Date().toISOString();
        await database.run(
            "UPDATE memory_proposals SET status='rejected', decided_at=?, decided_by=?, reason=coalesce(?,reason) WHERE id=?",
            [now, actor, reason, id]
        );
        await this._audit("reject", actor, id, { reason });
        return { ...(await this.get(id)) };
    }

    /** Batalkan memori yang sudah ter-commit: lupakan lunak (bukan hapus). */
    async rollback(memoryId, { actor = "user" } = {}) {
        await store.update(memoryId, { validUntil: new Date().toISOString() });
        await this._audit("rollback", actor, memoryId, {});
        return true;
    }

    async audit({ limit = 100 } = {}) {
        const rows = await database.all(
            "SELECT * FROM memory_audit ORDER BY id DESC LIMIT ?", [limit]
        );
        return rows.map(r => ({ ...r, detail: safeJson(r.detail) }));
    }

    // ---- internal -------------------------------------------------

    async _commit(p) {
        if (p.kind === "memory") {
            const saved = await memory.remember(p.payload);
            await this._audit("commit", "governor", saved.id, { from: p.id });
            return saved.id;
        }
        if (p.kind === "edge") {
            const saved = await edges.link(p.payload);
            return saved.id;
        }
        if (p.kind === "update") {
            await store.update(p.payload.id, p.payload.patch || {});
            return p.payload.id;
        }
        if (p.kind === "forget") {
            await store.update(p.payload.id, { validUntil: new Date().toISOString() });
            return p.payload.id;
        }
        throw new Error(`Jenis proposal tak dikenal: ${p.kind}`);
    }

    async _audit(action, actor, target, detail) {
        await database.run(
            "INSERT INTO memory_audit (action, actor, target, detail) VALUES (?, ?, ?, ?)",
            [action, actor, String(target ?? ""), JSON.stringify(detail ?? {})]
        );
    }

    _hydrate(row) {
        return {
            id: row.id, kind: row.kind, payload: safeJson(row.payload),
            memoryType: row.memory_type, writer: row.writer, role: row.role,
            status: row.status, reason: row.reason, committedId: row.committed_id,
            createdAt: row.created_at, decidedAt: row.decided_at, decidedBy: row.decided_by
        };
    }

}

function safeJson(v) { try { return JSON.parse(v ?? "{}"); } catch { return {}; } }

module.exports = new Governor();
