const { database } = require("../db");
const { normalize, toMatchQuery } = require("../util/text");

const KINDS = new Set([
    "person", "vehicle", "room", "device", "project",
    "place", "organization", "file", "pet", "other"
]);

/**
 * Penyimpanan entitas: orang, kendaraan, ruangan, perangkat,
 * project — "siapa/apa" yang dirujuk memori.
 *
 * Inti dari kelas ini adalah resolusi: satu hal nyata boleh punya
 * banyak sebutan ("ayah", "Pak Budi", "bapak"), dan semuanya harus
 * bermuara ke satu baris.
 */
class EntityStore {

    async create({
        kind = "other",
        name,
        description = null,
        attributes = {},
        importance = 0.5,
        confidence = 1,
        aliases = [],
        occurredAt = null
    }) {

        if (!name || !String(name).trim()) {
            throw new Error("Nama entitas wajib diisi.");
        }

        const normalizedKind = KINDS.has(kind) ? kind : "other";

        const normalized = normalize(name);

        const now = occurredAt ?? new Date().toISOString();

        const result = await database.run(
            `INSERT INTO entities
                (kind, name, normalized, description, attributes,
                 importance, confidence, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(kind, normalized) DO UPDATE SET
                last_seen_at = excluded.last_seen_at,
                updated_at   = datetime('now'),
                description  = coalesce(entities.description, excluded.description)`,
            [
                normalizedKind,
                String(name).trim(),
                normalized,
                description,
                JSON.stringify(attributes ?? {}),
                importance,
                confidence,
                now,
                now
            ]
        );

        // ON CONFLICT ... DO UPDATE tidak mengembalikan lastID yang
        // bisa diandalkan, jadi baris dibaca ulang lewat kunci unik.
        const entity = await this.findExact(normalizedKind, normalized);

        for (const alias of aliases) {
            await this.addAlias(entity.id, alias);
        }

        return entity;

    }

    async findExact(kind, normalized) {

        const row = await database.get(
            `SELECT * FROM entities WHERE kind = ? AND normalized = ?`,
            [kind, normalized]
        );

        return row ? this.hydrate(row) : null;

    }

    async get(id) {

        const row = await database.get(
            "SELECT * FROM entities WHERE id = ?",
            [id]
        );

        if (!row) {
            return null;
        }

        // Ikuti rantai penggabungan agar id lama tetap valid.
        if (row.merged_into) {
            return this.get(row.merged_into);
        }

        return this.hydrate(row);

    }

    async addAlias(entityId, alias, source = null) {

        const normalized = normalize(alias);

        if (!normalized) {
            return null;
        }

        await database.run(
            `INSERT INTO entity_aliases (entity_id, alias, normalized, source)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(entity_id, normalized) DO NOTHING`,
            [entityId, String(alias).trim(), normalized, source]
        );

        return normalized;

    }

    /**
     * Cari entitas dari sebuah sebutan.
     *
     * Urutan pencarian sengaja dari yang paling pasti ke paling
     * longgar: nama persis -> alias persis -> full-text. Tanpa
     * urutan ini, "Vario" bisa lebih dulu cocok ke memori lain
     * yang kebetulan menyebutnya.
     */
    async resolve(mention, { kind = null } = {}) {

        const normalized = normalize(mention);

        if (!normalized) {
            return null;
        }

        const exact = await database.get(
            `SELECT * FROM entities
             WHERE normalized = ? ${kind ? "AND kind = ?" : ""}
               AND merged_into IS NULL
             ORDER BY importance DESC LIMIT 1`,
            kind ? [normalized, kind] : [normalized]
        );

        if (exact) {
            return this.hydrate(exact);
        }

        const viaAlias = await database.get(
            `SELECT e.* FROM entity_aliases a
             JOIN entities e ON e.id = a.entity_id
             WHERE a.normalized = ? ${kind ? "AND e.kind = ?" : ""}
               AND e.merged_into IS NULL
             ORDER BY e.importance DESC LIMIT 1`,
            kind ? [normalized, kind] : [normalized]
        );

        if (viaAlias) {
            return this.hydrate(viaAlias);
        }

        const match = toMatchQuery(mention, { prefix: false });

        if (!match) {
            return null;
        }

        const fuzzy = await database.get(
            `SELECT e.* FROM entities_fts f
             JOIN entities e ON e.id = f.rowid
             WHERE entities_fts MATCH ? ${kind ? "AND e.kind = ?" : ""}
               AND e.merged_into IS NULL
             ORDER BY bm25(entities_fts) LIMIT 1`,
            kind ? [match, kind] : [match]
        );

        return fuzzy ? this.hydrate(fuzzy) : null;

    }

    /** Temukan bila ada, buat bila belum ada. */
    async resolveOrCreate(mention, options = {}) {

        const found = await this.resolve(mention, { kind: options.kind });

        if (found) {

            await this.touch(found.id, options.occurredAt);

            return found;

        }

        return this.create({ name: mention, ...options });

    }

    /** Tandai entitas baru saja terlihat/disebut. */
    async touch(id, at = null) {

        await database.run(
            `UPDATE entities
             SET last_seen_at = ?, updated_at = datetime('now')
             WHERE id = ?`,
            [at ?? new Date().toISOString(), id]
        );

    }

    async update(id, patch = {}) {

        const current = await this.get(id);

        if (!current) {
            throw new Error(`Entitas ${id} tidak ditemukan.`);
        }

        const attributes = patch.attributes
            ? { ...current.attributes, ...patch.attributes }
            : current.attributes;

        await database.run(
            `UPDATE entities SET
                name = ?, normalized = ?, description = ?, attributes = ?,
                importance = ?, confidence = ?, updated_at = datetime('now')
             WHERE id = ?`,
            [
                patch.name ?? current.name,
                normalize(patch.name ?? current.name),
                patch.description ?? current.description,
                JSON.stringify(attributes),
                patch.importance ?? current.importance,
                patch.confidence ?? current.confidence,
                id
            ]
        );

        return this.get(id);

    }

    /**
     * Gabungkan dua entitas yang ternyata sama.
     *
     * Yang kalah tidak dihapus melainkan diarahkan ke pemenang,
     * sehingga memori lama yang menunjuk id lama tetap terbaca.
     */
    async merge(loserId, winnerId) {

        if (loserId === winnerId) {
            return this.get(winnerId);
        }

        return database.transaction(async db => {

            const loser = await db.get(
                "SELECT * FROM entities WHERE id = ?",
                [loserId]
            );

            if (!loser) {
                throw new Error(`Entitas ${loserId} tidak ditemukan.`);
            }

            await db.run(
                `INSERT INTO entity_aliases (entity_id, alias, normalized, source)
                 VALUES (?, ?, ?, 'merge')
                 ON CONFLICT(entity_id, normalized) DO NOTHING`,
                [winnerId, loser.name, loser.normalized]
            );

            await db.run(
                `INSERT INTO entity_aliases (entity_id, alias, normalized, source)
                 SELECT ?, alias, normalized, 'merge' FROM entity_aliases
                 WHERE entity_id = ?
                 ON CONFLICT(entity_id, normalized) DO NOTHING`,
                [winnerId, loserId]
            );

            // OR IGNORE karena satu memori bisa sudah terkait ke
            // kedua entitas dengan peran yang sama.
            await db.run(
                `INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role)
                 SELECT memory_id, ?, role FROM memory_entities WHERE entity_id = ?`,
                [winnerId, loserId]
            );

            await db.run(
                "DELETE FROM memory_entities WHERE entity_id = ?",
                [loserId]
            );

            await db.run(
                "UPDATE entities SET merged_into = ?, updated_at = datetime('now') WHERE id = ?",
                [winnerId, loserId]
            );

            return this.get(winnerId);

        });

    }

    async relate(fromId, toId, relation, attributes = {}) {

        await database.run(
            `INSERT INTO entity_relations (from_id, to_id, relation, attributes)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
                attributes = excluded.attributes`,
            [fromId, toId, relation, JSON.stringify(attributes ?? {})]
        );

    }

    async relations(entityId) {

        const rows = await database.all(
            `SELECT r.relation, r.attributes,
                    r.from_id, r.to_id,
                    f.name AS from_name, f.kind AS from_kind,
                    t.name AS to_name,   t.kind AS to_kind
             FROM entity_relations r
             JOIN entities f ON f.id = r.from_id
             JOIN entities t ON t.id = r.to_id
             WHERE r.from_id = ? OR r.to_id = ?`,
            [entityId, entityId]
        );

        return rows.map(row => ({
            relation: row.relation,
            attributes: parseJson(row.attributes),
            direction: row.from_id === entityId ? "outgoing" : "incoming",
            from: { id: row.from_id, name: row.from_name, kind: row.from_kind },
            to: { id: row.to_id, name: row.to_name, kind: row.to_kind }
        }));

    }

    async list({ kind = null, query = null, limit = 100, offset = 0 } = {}) {

        const where = ["merged_into IS NULL"];
        const params = [];

        if (kind) {
            where.push("kind = ?");
            params.push(kind);
        }

        if (query) {
            where.push("(normalized LIKE ? OR id IN (SELECT entity_id FROM entity_aliases WHERE normalized LIKE ?))");
            params.push(`%${normalize(query)}%`, `%${normalize(query)}%`);
        }

        const rows = await database.all(
            `SELECT * FROM entities
             WHERE ${where.join(" AND ")}
             ORDER BY importance DESC, last_seen_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        return rows.map(row => this.hydrate(row));

    }

    async aliases(entityId) {

        const rows = await database.all(
            "SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias",
            [entityId]
        );

        return rows.map(row => row.alias);

    }

    async remove(id) {

        const result = await database.run(
            "DELETE FROM entities WHERE id = ?",
            [id]
        );

        return result.changes > 0;

    }

    async stats() {

        const rows = await database.all(
            `SELECT kind, COUNT(*) AS total FROM entities
             WHERE merged_into IS NULL GROUP BY kind ORDER BY total DESC`
        );

        const total = rows.reduce((sum, row) => sum + row.total, 0);

        return { total, byKind: rows };

    }

    hydrate(row) {

        return {
            id: row.id,
            kind: row.kind,
            name: row.name,
            normalized: row.normalized,
            description: row.description,
            attributes: parseJson(row.attributes),
            importance: row.importance,
            confidence: row.confidence,
            firstSeenAt: row.first_seen_at,
            lastSeenAt: row.last_seen_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };

    }

}

function parseJson(value) {

    try {
        return JSON.parse(value ?? "{}");
    }
    catch {
        return {};
    }

}

module.exports = new EntityStore();
module.exports.KINDS = KINDS;
