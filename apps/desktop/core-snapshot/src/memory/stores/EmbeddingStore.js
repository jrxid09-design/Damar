const { database } = require("../db");

/**
 * Penyimpanan vektor embedding.
 *
 * SQLite di sini tanpa ekstensi vektor, jadi vektor disimpan
 * sebagai BLOB Float32 dan kemiripan dihitung di JS. Agar itu
 * murah, norma tiap vektor ikut disimpan sehingga cosine cukup
 * satu dot product dibagi perkalian norma yang sudah diketahui.
 */
class EmbeddingStore {

    toBlob(vector) {

        const array = Float32Array.from(vector);

        return Buffer.from(array.buffer, array.byteOffset, array.byteLength);

    }

    fromBlob(blob) {

        // Buffer dari SQLite belum tentu selaras 4-byte, jadi
        // disalin dulu sebelum dibaca sebagai Float32Array.
        const copy = Buffer.from(blob);

        return new Float32Array(
            copy.buffer,
            copy.byteOffset,
            copy.byteLength / 4
        );

    }

    norm(vector) {

        let sum = 0;

        for (const value of vector) {
            sum += value * value;
        }

        return Math.sqrt(sum);

    }

    async put(ownerKind, ownerId, model, vector) {

        const norm = this.norm(vector);

        await database.run(
            `INSERT INTO embeddings (owner_kind, owner_id, model, dim, vector, norm)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner_kind, owner_id, model) DO UPDATE SET
                dim = excluded.dim,
                vector = excluded.vector,
                norm = excluded.norm,
                created_at = datetime('now')`,
            [ownerKind, ownerId, model, vector.length, this.toBlob(vector), norm]
        );

    }

    async putMany(ownerKind, model, entries = []) {

        if (entries.length === 0) {
            return 0;
        }

        await database.transaction(async () => {

            for (const { id, vector } of entries) {
                await this.put(ownerKind, id, model, vector);
            }

        });

        return entries.length;

    }

    async get(ownerKind, ownerId, model) {

        const row = await database.get(
            `SELECT vector, norm, dim FROM embeddings
             WHERE owner_kind = ? AND owner_id = ? AND model = ?`,
            [ownerKind, ownerId, model]
        );

        if (!row) {
            return null;
        }

        return {
            vector: this.fromBlob(row.vector),
            norm: row.norm,
            dim: row.dim
        };

    }

    /** Ambil vektor untuk sekumpulan id sekaligus. */
    async getMany(ownerKind, ids, model) {

        if (ids.length === 0) {
            return new Map();
        }

        const rows = await database.all(
            `SELECT owner_id, vector, norm FROM embeddings
             WHERE owner_kind = ? AND model = ?
               AND owner_id IN (${ids.map(() => "?").join(",")})`,
            [ownerKind, model, ...ids]
        );

        return new Map(
            rows.map(row => [
                row.owner_id,
                { vector: this.fromBlob(row.vector), norm: row.norm }
            ])
        );

    }

    /**
     * Cosine similarity. Norma yang sudah dihitung sebelumnya
     * dilewatkan agar tidak dihitung ulang tiap perbandingan.
     */
    cosine(a, b, normA = null, normB = null) {

        const length = Math.min(a.length, b.length);

        let dot = 0;

        for (let i = 0; i < length; i++) {
            dot += a[i] * b[i];
        }

        const denominator =
            (normA ?? this.norm(a)) * (normB ?? this.norm(b));

        if (denominator === 0) {
            return 0;
        }

        return dot / denominator;

    }

    async count(ownerKind = null, model = null) {

        const where = [];
        const params = [];

        if (ownerKind) {
            where.push("owner_kind = ?");
            params.push(ownerKind);
        }

        if (model) {
            where.push("model = ?");
            params.push(model);
        }

        const row = await database.get(
            `SELECT COUNT(*) AS total FROM embeddings
             ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
            params
        );

        return row?.total ?? 0;

    }

    /** Hapus semua vektor sebuah model — dipakai saat ganti model. */
    async clearModel(model) {

        const result = await database.run(
            "DELETE FROM embeddings WHERE model = ?",
            [model]
        );

        return result.changes;

    }

}

module.exports = new EmbeddingStore();
