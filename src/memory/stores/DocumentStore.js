const { database } = require("../db");
const { hash } = require("../util/text");

/**
 * Penyimpanan dokumen yang sudah di-ingest beserta potongannya.
 *
 * Dokumen disimpan sebagai chunk, bukan satu blok, karena yang
 * dirujuk saat menjawab pertanyaan adalah bagian yang relevan —
 * memasukkan seluruh manual UPS ke prompt tidak mungkin.
 */
class DocumentStore {

    async findByHash(contentHash) {

        const row = await database.get(
            "SELECT * FROM documents WHERE content_hash = ?",
            [contentHash]
        );

        return row ? this.hydrate(row) : null;

    }

    async create({
        uri,
        title = null,
        mediaType = null,
        byteSize = null,
        content = "",
        metadata = {}
    }) {

        const contentHash = hash(content);

        const existing = await this.findByHash(contentHash);

        if (existing) {
            return { ...existing, alreadyIngested: true };
        }

        const result = await database.run(
            `INSERT INTO documents
                (uri, title, media_type, byte_size, content_hash,
                 char_count, status, metadata)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [
                uri,
                title,
                mediaType,
                byteSize,
                contentHash,
                content.length,
                JSON.stringify(metadata ?? {})
            ]
        );

        return { ...(await this.get(result.lastID)), alreadyIngested: false };

    }

    async get(id) {

        const row = await database.get(
            "SELECT * FROM documents WHERE id = ?",
            [id]
        );

        return row ? this.hydrate(row) : null;

    }

    async addChunks(documentId, chunks = []) {

        if (chunks.length === 0) {
            return 0;
        }

        await database.transaction(async db => {

            for (const chunk of chunks) {

                await db.run(
                    `INSERT INTO document_chunks
                        (document_id, ordinal, content, heading, char_start, char_end)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(document_id, ordinal) DO UPDATE SET
                        content = excluded.content,
                        heading = excluded.heading`,
                    [
                        documentId,
                        chunk.ordinal,
                        chunk.content,
                        chunk.heading ?? null,
                        chunk.start ?? null,
                        chunk.end ?? null
                    ]
                );

            }

            await db.run(
                `UPDATE documents SET chunk_count = ?, status = 'ready' WHERE id = ?`,
                [chunks.length, documentId]
            );

        });

        return chunks.length;

    }

    async markFailed(documentId, error) {

        await database.run(
            "UPDATE documents SET status = 'failed', error = ? WHERE id = ?",
            [String(error).slice(0, 500), documentId]
        );

    }

    async chunks(documentId, { limit = 200, offset = 0 } = {}) {

        return database.all(
            `SELECT * FROM document_chunks
             WHERE document_id = ? ORDER BY ordinal LIMIT ? OFFSET ?`,
            [documentId, limit, offset]
        );

    }

    async chunksWithoutEmbedding(model, limit = 100) {

        return database.all(
            `SELECT c.id, c.content FROM document_chunks c
             LEFT JOIN embeddings e
                ON e.owner_kind = 'chunk' AND e.owner_id = c.id AND e.model = ?
             WHERE e.id IS NULL
             ORDER BY c.id
             LIMIT ?`,
            [model, limit]
        );

    }

    async list({ query = null, limit = 50, offset = 0 } = {}) {

        const where = [];
        const params = [];

        if (query) {
            where.push("(lower(title) LIKE ? OR lower(uri) LIKE ?)");
            params.push(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`);
        }

        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const rows = await database.all(
            `SELECT * FROM documents ${clause}
             ORDER BY ingested_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const totalRow = await database.get(
            `SELECT COUNT(*) AS total FROM documents ${clause}`,
            params
        );

        return {
            total: totalRow?.total ?? 0,
            items: rows.map(row => this.hydrate(row))
        };

    }

    async remove(id) {

        const result = await database.run(
            "DELETE FROM documents WHERE id = ?",
            [id]
        );

        return result.changes > 0;

    }

    async stats() {

        const row = await database.get(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(chunk_count), 0) AS chunks,
                    COALESCE(SUM(char_count), 0) AS chars
             FROM documents WHERE status = 'ready'`
        );

        return {
            total: row?.total ?? 0,
            chunks: row?.chunks ?? 0,
            characters: row?.chars ?? 0
        };

    }

    hydrate(row) {

        return {
            id: row.id,
            uri: row.uri,
            title: row.title,
            mediaType: row.media_type,
            byteSize: row.byte_size,
            contentHash: row.content_hash,
            charCount: row.char_count,
            chunkCount: row.chunk_count,
            status: row.status,
            error: row.error,
            ingestedAt: row.ingested_at,
            metadata: parseJson(row.metadata)
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

module.exports = new DocumentStore();
