const { database } = require("../db");
const { hash, truncate } = require("../util/text");

const TYPES = new Set([
    "episodic", "semantic", "preference", "procedural"
]);

/**
 * Penyimpanan memori. Kelas ini murni soal baris dan indeks —
 * penilaian relevansi ada di RecallService.
 */
class MemoryStore {

    /**
     * Simpan satu memori.
     *
     * Duplikat isi tidak menghasilkan baris baru melainkan
     * *menguatkan* yang lama: kejadian yang berulang justru harus
     * naik kepentingannya, bukan menumpuk sebagai salinan.
     */
    async insert({
        type = "episodic",
        content,
        summary = null,
        source = "system",
        sourceRef = null,
        importance = 0.5,
        confidence = 1,
        occurredAt = null,
        validUntil = null,
        sensitive = false,
        pinned = false,
        metadata = {},
        documentId = null
    }) {

        if (!content || !String(content).trim()) {
            throw new Error("Isi memori tidak boleh kosong.");
        }

        const normalizedType = TYPES.has(type) ? type : "episodic";

        const text = String(content).trim();

        // Hash memasukkan tipe dan sumber agar fakta yang sama dari
        // sensor dan dari percakapan tetap dibedakan.
        const contentHash = hash(`${normalizedType}|${source}|${text}`);

        const existing = await database.get(
            "SELECT * FROM memories WHERE content_hash = ?",
            [contentHash]
        );

        if (existing) {

            await database.run(
                `UPDATE memories SET
                    importance = min(1.0, importance + 0.05),
                    recall_count = recall_count + 1,
                    occurred_at = ?,
                    valid_until = coalesce(?, valid_until)
                 WHERE id = ?`,
                [
                    occurredAt ?? existing.occurred_at,
                    validUntil,
                    existing.id
                ]
            );

            // Dibaca ulang agar nilai importance yang dikembalikan
            // adalah hasil penguatan, bukan nilai sebelumnya.
            return { ...(await this.get(existing.id)), reinforced: true };

        }

        const result = await database.run(
            `INSERT INTO memories
                (type, content, summary, source, source_ref, importance,
                 confidence, occurred_at, valid_until, sensitive, pinned,
                 metadata, document_id, content_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                normalizedType,
                text,
                summary ?? (text.length > 320 ? truncate(text, 220) : null),
                source,
                sourceRef,
                clamp(importance),
                clamp(confidence),
                occurredAt ?? new Date().toISOString(),
                validUntil,
                sensitive ? 1 : 0,
                pinned ? 1 : 0,
                JSON.stringify(metadata ?? {}),
                documentId,
                contentHash
            ]
        );

        return { ...(await this.get(result.lastID)), reinforced: false };

    }

    async get(id) {

        const row = await database.get(
            "SELECT * FROM memories WHERE id = ?",
            [id]
        );

        return row ? this.hydrate(row) : null;

    }

    async linkEntities(memoryId, links = []) {

        for (const link of links) {

            const entityId = typeof link === "object" ? link.entityId : link;

            const role = typeof link === "object" ? (link.role ?? "mentions") : "mentions";

            if (!entityId) {
                continue;
            }

            await database.run(
                `INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role)
                 VALUES (?, ?, ?)`,
                [memoryId, entityId, role]
            );

        }

    }

    async entitiesOf(memoryId) {

        return database.all(
            `SELECT e.id, e.kind, e.name, me.role
             FROM memory_entities me
             JOIN entities e ON e.id = me.entity_id
             WHERE me.memory_id = ?`,
            [memoryId]
        );

    }

    /** Catat bahwa memori terpakai — dipakai saat konsolidasi. */
    async markRecalled(ids = []) {

        if (ids.length === 0) {
            return;
        }

        await database.run(
            `UPDATE memories
             SET recall_count = recall_count + 1,
                 last_recalled_at = datetime('now')
             WHERE id IN (${ids.map(() => "?").join(",")})`,
            ids
        );

    }

    /**
     * Ganti sebuah fakta dengan versi baru.
     *
     * Yang lama tidak dihapus, hanya ditandai digantikan — riwayat
     * "dulu benar, sekarang tidak" sering lebih berguna daripada
     * sekadar nilai terakhir.
     */
    async supersede(oldId, newId) {

        await database.run(
            "UPDATE memories SET superseded_by = ? WHERE id = ?",
            [newId, oldId]
        );

    }

    async update(id, patch = {}) {

        const current = await this.get(id);

        if (!current) {
            throw new Error(`Memori ${id} tidak ditemukan.`);
        }

        await database.run(
            `UPDATE memories SET
                content = ?, summary = ?, type = ?, importance = ?,
                confidence = ?, valid_until = ?, sensitive = ?, pinned = ?,
                metadata = ?
             WHERE id = ?`,
            [
                patch.content ?? current.content,
                patch.summary ?? current.summary,
                patch.type ?? current.type,
                patch.importance != null ? clamp(patch.importance) : current.importance,
                patch.confidence != null ? clamp(patch.confidence) : current.confidence,
                patch.validUntil !== undefined ? patch.validUntil : current.validUntil,
                (patch.sensitive ?? current.sensitive) ? 1 : 0,
                (patch.pinned ?? current.pinned) ? 1 : 0,
                JSON.stringify(patch.metadata ?? current.metadata),
                id
            ]
        );

        return this.get(id);

    }

    async remove(id) {

        const result = await database.run(
            "DELETE FROM memories WHERE id = ?",
            [id]
        );

        return result.changes > 0;

    }

    /**
     * Penelusuran biasa (bukan pencarian relevansi) untuk halaman
     * Memory di Console: filter, urut waktu, halaman.
     */
    async list({
        type = null,
        source = null,
        entityId = null,
        since = null,
        until = null,
        includeSuperseded = false,
        includeExpired = false,
        pinnedOnly = false,
        limit = 50,
        offset = 0
    } = {}) {

        const where = [];
        const params = [];

        if (type) {
            where.push("m.type = ?");
            params.push(type);
        }

        if (source) {
            where.push("m.source = ?");
            params.push(source);
        }

        if (since) {
            where.push("m.occurred_at >= ?");
            params.push(since);
        }

        if (until) {
            where.push("m.occurred_at <= ?");
            params.push(until);
        }

        if (!includeSuperseded) {
            where.push("m.superseded_by IS NULL");
        }

        if (!includeExpired) {
            where.push("(m.valid_until IS NULL OR m.valid_until > datetime('now'))");
        }

        if (pinnedOnly) {
            where.push("m.pinned = 1");
        }

        if (entityId) {
            where.push(
                "m.id IN (SELECT memory_id FROM memory_entities WHERE entity_id = ?)"
            );
            params.push(entityId);
        }

        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const rows = await database.all(
            `SELECT m.* FROM memories m
             ${clause}
             ORDER BY m.pinned DESC, m.occurred_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const totalRow = await database.get(
            `SELECT COUNT(*) AS total FROM memories m ${clause}`,
            params
        );

        const items = rows.map(row => this.hydrate(row));

        await this.attachEntities(items);

        return {
            total: totalRow?.total ?? 0,
            items
        };

    }

    /**
     * Lampirkan entitas ke sekumpulan memori dengan satu query.
     *
     * Tanpa ini daftar memori kehilangan konteks "siapa/di mana",
     * dan mengambilnya per baris akan jadi N+1 query.
     */
    async attachEntities(items = []) {

        if (items.length === 0) {
            return items;
        }

        const ids = items.map(item => item.id);

        const rows = await database.all(
            `SELECT me.memory_id, e.id, e.kind, e.name, me.role
             FROM memory_entities me
             JOIN entities e ON e.id = me.entity_id
             WHERE me.memory_id IN (${ids.map(() => "?").join(",")})`,
            ids
        );

        const grouped = new Map();

        for (const row of rows) {

            if (!grouped.has(row.memory_id)) {
                grouped.set(row.memory_id, []);
            }

            grouped.get(row.memory_id).push({
                id: row.id,
                kind: row.kind,
                name: row.name,
                role: row.role
            });

        }

        for (const item of items) {
            item.entities = grouped.get(item.id) ?? [];
        }

        return items;

    }

    /** Memori yang belum punya embedding — antrean backfill. */
    async withoutEmbedding(model, limit = 100) {

        return database.all(
            `SELECT m.id, m.content, m.summary FROM memories m
             LEFT JOIN embeddings e
                ON e.owner_kind = 'memory' AND e.owner_id = m.id AND e.model = ?
             WHERE e.id IS NULL
             ORDER BY m.pinned DESC, m.importance DESC, m.id DESC
             LIMIT ?`,
            [model, limit]
        );

    }

    async stats() {

        const byType = await database.all(
            `SELECT type, COUNT(*) AS total FROM memories
             WHERE superseded_by IS NULL GROUP BY type ORDER BY total DESC`
        );

        const bySource = await database.all(
            `SELECT source, COUNT(*) AS total FROM memories
             WHERE superseded_by IS NULL GROUP BY source ORDER BY total DESC`
        );

        const totals = await database.get(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END) AS superseded,
                SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) AS pinned,
                SUM(CASE WHEN sensitive = 1 THEN 1 ELSE 0 END) AS sensitive,
                MIN(occurred_at) AS oldest,
                MAX(occurred_at) AS newest
             FROM memories`
        );

        return {
            total: totals?.total ?? 0,
            superseded: totals?.superseded ?? 0,
            pinned: totals?.pinned ?? 0,
            sensitive: totals?.sensitive ?? 0,
            oldest: totals?.oldest ?? null,
            newest: totals?.newest ?? null,
            byType,
            bySource
        };

    }

    hydrate(row) {

        return {
            id: row.id,
            type: row.type,
            content: row.content,
            summary: row.summary,
            source: row.source,
            sourceRef: row.source_ref,
            importance: row.importance,
            confidence: row.confidence,
            occurredAt: row.occurred_at,
            createdAt: row.created_at,
            lastRecalledAt: row.last_recalled_at,
            recallCount: row.recall_count,
            validUntil: row.valid_until,
            supersededBy: row.superseded_by,
            // Provenance epistemik & masa berlaku (§13, §20).
            // Tanpa dipetakan di sini, kolomnya ada di basis data
            // tetapi tak pernah sampai ke kode yang memakainya.
            kind: row.kind ?? "observation",
            validFrom: row.valid_from,
            lastVerified: row.last_verified,
            supersedes: row.supersedes,
            sensitive: row.sensitive === 1,
            pinned: row.pinned === 1,
            documentId: row.document_id,
            metadata: parseJson(row.metadata)
        };

    }

}

function clamp(value, min = 0, max = 1) {

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return min;
    }

    return Math.max(min, Math.min(max, number));

}

function parseJson(value) {

    try {
        return JSON.parse(value ?? "{}");
    }
    catch {
        return {};
    }

}

module.exports = new MemoryStore();
module.exports.TYPES = TYPES;
