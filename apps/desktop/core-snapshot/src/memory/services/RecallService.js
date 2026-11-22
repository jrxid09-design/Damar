const { database } = require("../db");

const MemoryStore = require("../stores/MemoryStore");
const EntityStore = require("../stores/EntityStore");
const EmbeddingStore = require("../stores/EmbeddingStore");
const EmbeddingService = require("./EmbeddingService");

const { toMatchQuery, truncate } = require("../util/text");

/**
 * Pencarian memori.
 *
 * Dua jalur dipakai bersama karena masing-masing punya titik buta:
 *
 *   - Kata kunci (FTS5) unggul untuk nama, plat nomor, kode error,
 *     nama file — hal yang harus cocok persis.
 *   - Vektor unggul untuk parafrase: "berapa daya maksimal UPS"
 *     harus menemukan "beban maksimum UPS 540 watt" meski tidak
 *     ada satu pun kata yang sama.
 *
 * Kandidat dari kedua jalur digabung, lalu diberi skor akhir yang
 * juga memperhitungkan kebaruan, kepentingan, dan keterkaitan
 * entitas — sebuah memori tua tapi penting tidak boleh kalah dari
 * memori baru yang sepele.
 */
class RecallService {

    constructor() {

        this.weights = {
            keyword: 0.9,
            vector: 1.15,
            importance: 0.55,
            recency: 0.5,
            entity: 0.7,
            pinned: 0.6
        };

        /** Paruh waktu peluruhan kebaruan, dalam hari. */
        this.recencyHalfLife = 21;

    }

    /**
     * @param {string} query
     * @param {object} options
     * @param {number} [options.limit]
     * @param {string[]} [options.types]
     * @param {number[]} [options.entityIds]
     * @param {boolean} [options.includeSensitive]
     * @param {boolean} [options.includeDocuments]
     */
    async recall(query, options = {}) {

        const {
            limit = 8,
            types = null,
            sources = null,
            entityIds = null,
            since = null,
            until = null,
            includeSensitive = false,
            includeDocuments = true,
            candidatePool = 120
        } = options;

        const text = String(query ?? "").trim();

        if (!text && !entityIds?.length) {
            return { query: text, items: [], strategies: [] };
        }

        const strategies = [];

        /** @type {Map<number, object>} */
        const candidates = new Map();

        // --- Jalur 1: kata kunci -------------------------------
        const keywordHits = await this.keywordSearch(text, {
            types, sources, since, until, includeSensitive, limit: candidatePool
        });

        if (keywordHits.length) {
            strategies.push("keyword");
        }

        for (const hit of keywordHits) {
            candidates.set(hit.id, {
                ...hit,
                keywordScore: hit.keywordScore,
                vectorScore: 0
            });
        }

        // --- Jalur 2: entitas ----------------------------------
        // Entitas yang disebut di query ikut menarik memori yang
        // terkait, meski kata-katanya tidak cocok.
        const mentioned = await this.mentionedEntities(text, entityIds);

        if (mentioned.length) {

            strategies.push("entity");

            const related = await this.byEntities(
                mentioned.map(entity => entity.id),
                { types, includeSensitive, limit: candidatePool }
            );

            for (const hit of related) {

                const existing = candidates.get(hit.id);

                if (existing) {
                    existing.entityHits = hit.entityHits;
                }
                else {
                    candidates.set(hit.id, {
                        ...hit,
                        keywordScore: 0,
                        vectorScore: 0
                    });
                }

            }

        }

        // --- Jalur 3: vektor -----------------------------------
        const queryVector = text ? await EmbeddingService.embedOne(text) : null;

        if (queryVector) {

            strategies.push("vector");

            await this.applyVectorScores(candidates, queryVector, {
                types, sources, includeSensitive, since, until,
                pool: candidatePool
            });

        }

        // --- Skoring akhir -------------------------------------
        const now = Date.now();

        const scored = [...candidates.values()]
            .map(item => ({
                ...item,
                score: this.score(item, now)
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        // Catat pemakaian agar konsolidasi tahu mana yang berguna.
        await MemoryStore.markRecalled(scored.map(item => item.id));

        const results = await this.decorate(scored);

        let documents = [];

        if (includeDocuments && text) {
            documents = await this.searchDocuments(text, queryVector, {
                limit: Math.max(2, Math.ceil(limit / 2))
            });
        }

        return {
            query: text,
            strategies,
            entities: mentioned,
            items: results,
            documents
        };

    }

    // ---- Jalur pencarian --------------------------------------

    async keywordSearch(text, {
        types, sources, since, until, includeSensitive, limit
    }) {

        const match = toMatchQuery(text);

        if (!match) {
            return [];
        }

        const where = ["m.superseded_by IS NULL"];
        const params = [match];

        where.push("(m.valid_until IS NULL OR m.valid_until > datetime('now'))");

        if (!includeSensitive) {
            where.push("m.sensitive = 0");
        }

        if (types?.length) {
            where.push(`m.type IN (${types.map(() => "?").join(",")})`);
            params.push(...types);
        }

        if (sources?.length) {
            where.push(`m.source IN (${sources.map(() => "?").join(",")})`);
            params.push(...sources);
        }

        if (since) {
            where.push("m.occurred_at >= ?");
            params.push(since);
        }

        if (until) {
            where.push("m.occurred_at <= ?");
            params.push(until);
        }

        const rows = await database.all(
            `SELECT m.*, bm25(memories_fts) AS rank
             FROM memories_fts
             JOIN memories m ON m.id = memories_fts.rowid
             WHERE memories_fts MATCH ?
               AND ${where.join(" AND ")}
             ORDER BY rank
             LIMIT ?`,
            [...params, limit]
        );

        return rows.map(row => ({
            ...MemoryStore.hydrate(row),
            // bm25 SQLite bernilai negatif, makin kecil makin cocok.
            // Dipetakan ke 0..1 agar sebanding dengan cosine.
            keywordScore: rankToScore(row.rank)
        }));

    }

    async mentionedEntities(text, entityIds) {

        const found = [];

        if (entityIds?.length) {

            for (const id of entityIds) {

                const entity = await EntityStore.get(id);

                if (entity) {
                    found.push(entity);
                }

            }

            return found;

        }

        if (!text) {
            return found;
        }

        // Cocokkan potongan n-gram terhadap nama/alias. Frasa lebih
        // panjang dicoba lebih dulu supaya "Honda Vario" menang
        // atas "Honda" saja.
        const words = text.split(/\s+/).filter(Boolean);

        const seen = new Set();

        for (let size = Math.min(4, words.length); size >= 1; size--) {

            for (let start = 0; start + size <= words.length; start++) {

                const phrase = words.slice(start, start + size).join(" ");

                if (phrase.length < 3) {
                    continue;
                }

                const entity = await this.exactEntity(phrase);

                if (entity && !seen.has(entity.id)) {
                    seen.add(entity.id);
                    found.push(entity);
                }

            }

        }

        return found;

    }

    /**
     * Sengaja hanya nama/alias persis. Pencocokan fuzzy di sini
     * membuat hampir setiap kata menarik entitas acak dan mengotori
     * hasil recall.
     */
    async exactEntity(phrase) {

        const { normalize } = require("../util/text");

        const normalized = normalize(phrase);

        if (!normalized) {
            return null;
        }

        const row = await database.get(
            `SELECT e.* FROM entities e
             WHERE e.merged_into IS NULL AND e.normalized = ?
             UNION
             SELECT e.* FROM entities e
             JOIN entity_aliases a ON a.entity_id = e.id
             WHERE e.merged_into IS NULL AND a.normalized = ?
             LIMIT 1`,
            [normalized, normalized]
        );

        return row ? EntityStore.hydrate(row) : null;

    }

    async byEntities(entityIds, { types, includeSensitive, limit }) {

        if (entityIds.length === 0) {
            return [];
        }

        const where = ["m.superseded_by IS NULL"];
        const params = [...entityIds];

        if (!includeSensitive) {
            where.push("m.sensitive = 0");
        }

        if (types?.length) {
            where.push(`m.type IN (${types.map(() => "?").join(",")})`);
            params.push(...types);
        }

        const rows = await database.all(
            `SELECT m.*, COUNT(DISTINCT me.entity_id) AS entity_hits
             FROM memory_entities me
             JOIN memories m ON m.id = me.memory_id
             WHERE me.entity_id IN (${entityIds.map(() => "?").join(",")})
               AND ${where.join(" AND ")}
             GROUP BY m.id
             ORDER BY entity_hits DESC, m.occurred_at DESC
             LIMIT ?`,
            [...params, limit]
        );

        return rows.map(row => ({
            ...MemoryStore.hydrate(row),
            entityHits: row.entity_hits
        }));

    }

    /**
     * Beri skor vektor pada kandidat yang sudah ada, sekaligus
     * menarik kandidat baru yang hanya ditemukan lewat kemiripan.
     *
     * Tanpa ekstensi vektor di SQLite, pencarian dilakukan dengan
     * memindai vektor memori aktif. Untuk skala satu rumah
     * (puluhan ribu baris) ini masih di bawah beberapa milidetik;
     * bila kelak membengkak, di sinilah tempat memasang indeks ANN.
     */
    async applyVectorScores(candidates, queryVector, {
        types, sources, includeSensitive, since, until, pool
    }) {

        const where = ["m.superseded_by IS NULL"];
        const params = [EmbeddingService.model];

        where.push("(m.valid_until IS NULL OR m.valid_until > datetime('now'))");

        if (!includeSensitive) {
            where.push("m.sensitive = 0");
        }

        if (types?.length) {
            where.push(`m.type IN (${types.map(() => "?").join(",")})`);
            params.push(...types);
        }

        if (sources?.length) {
            where.push(`m.source IN (${sources.map(() => "?").join(",")})`);
            params.push(...sources);
        }

        if (since) {
            where.push("m.occurred_at >= ?");
            params.push(since);
        }

        if (until) {
            where.push("m.occurred_at <= ?");
            params.push(until);
        }

        const rows = await database.all(
            `SELECT m.*, e.vector, e.norm
             FROM embeddings e
             JOIN memories m ON m.id = e.owner_id
             WHERE e.owner_kind = 'memory' AND e.model = ?
               AND ${where.join(" AND ")}
             ORDER BY m.occurred_at DESC
             LIMIT ?`,
            [...params, Math.max(pool * 8, 500)]
        );

        const query = Float32Array.from(queryVector);

        const queryNorm = EmbeddingStore.norm(query);

        const scored = rows.map(row => ({
            row,
            similarity: EmbeddingStore.cosine(
                query,
                EmbeddingStore.fromBlob(row.vector),
                queryNorm,
                row.norm
            )
        }));

        scored.sort((a, b) => b.similarity - a.similarity);

        for (const { row, similarity } of scored.slice(0, pool)) {

            // Di bawah ambang ini kemiripan lebih sering kebetulan
            // daripada bermakna, dan hanya menambah bising.
            if (similarity < 0.35) {
                continue;
            }

            const existing = candidates.get(row.id);

            if (existing) {
                existing.vectorScore = similarity;
            }
            else {
                candidates.set(row.id, {
                    ...MemoryStore.hydrate(row),
                    keywordScore: 0,
                    vectorScore: similarity
                });
            }

        }

    }

    async searchDocuments(text, queryVector, { limit = 4 } = {}) {

        const match = toMatchQuery(text);

        const results = new Map();

        if (match) {

            const rows = await database.all(
                `SELECT c.id, c.content, c.heading, c.ordinal,
                        d.id AS document_id, d.title, d.uri,
                        bm25(chunks_fts) AS rank
                 FROM chunks_fts
                 JOIN document_chunks c ON c.id = chunks_fts.rowid
                 JOIN documents d ON d.id = c.document_id
                 WHERE chunks_fts MATCH ?
                 ORDER BY rank
                 LIMIT ?`,
                [match, limit * 4]
            );

            for (const row of rows) {
                results.set(row.id, {
                    ...row,
                    keywordScore: rankToScore(row.rank),
                    vectorScore: 0
                });
            }

        }

        if (queryVector) {

            const rows = await database.all(
                `SELECT c.id, c.content, c.heading, c.ordinal,
                        d.id AS document_id, d.title, d.uri,
                        e.vector, e.norm
                 FROM embeddings e
                 JOIN document_chunks c ON c.id = e.owner_id
                 JOIN documents d ON d.id = c.document_id
                 WHERE e.owner_kind = 'chunk' AND e.model = ?
                 LIMIT 4000`,
                [EmbeddingService.model]
            );

            const query = Float32Array.from(queryVector);
            const queryNorm = EmbeddingStore.norm(query);

            const ranked = rows
                .map(row => ({
                    row,
                    similarity: EmbeddingStore.cosine(
                        query,
                        EmbeddingStore.fromBlob(row.vector),
                        queryNorm,
                        row.norm
                    )
                }))
                .filter(entry => entry.similarity >= 0.35)
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, limit * 4);

            for (const { row, similarity } of ranked) {

                const existing = results.get(row.id);

                if (existing) {
                    existing.vectorScore = similarity;
                }
                else {
                    results.set(row.id, {
                        ...row,
                        keywordScore: 0,
                        vectorScore: similarity
                    });
                }

            }

        }

        return [...results.values()]
            .map(item => ({
                chunkId: item.id,
                documentId: item.document_id,
                title: item.title,
                uri: item.uri,
                heading: item.heading,
                ordinal: item.ordinal,
                excerpt: truncate(item.content, 400),
                score: Number(
                    (item.keywordScore * this.weights.keyword +
                     item.vectorScore * this.weights.vector).toFixed(4)
                )
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

    }

    // ---- Skoring -----------------------------------------------

    score(item, now = Date.now()) {

        const w = this.weights;

        const ageDays =
            (now - new Date(item.occurredAt ?? item.createdAt).getTime()) /
            86400000;

        // Peluruhan eksponensial: setelah satu paruh waktu, bobot
        // kebaruan tinggal separuh.
        const recency = Math.pow(0.5, Math.max(0, ageDays) / this.recencyHalfLife);

        const entityBoost = Math.min(1, (item.entityHits ?? 0) / 2);

        const total =
            (item.keywordScore ?? 0) * w.keyword +
            (item.vectorScore ?? 0) * w.vector +
            (item.importance ?? 0.5) * w.importance +
            recency * w.recency +
            entityBoost * w.entity +
            (item.pinned ? w.pinned : 0);

        return Number(total.toFixed(4));

    }

    async decorate(items) {

        const results = [];

        for (const item of items) {

            results.push({
                ...item,
                entities: await MemoryStore.entitiesOf(item.id),
                scoring: {
                    keyword: Number((item.keywordScore ?? 0).toFixed(4)),
                    vector: Number((item.vectorScore ?? 0).toFixed(4)),
                    entityHits: item.entityHits ?? 0,
                    total: item.score
                }
            });

        }

        return results;

    }

}

/**
 * bm25 SQLite: 0 berarti tidak cocok, makin negatif makin cocok.
 * Dipetakan ke 0..1 supaya bisa dijumlahkan dengan cosine.
 */
function rankToScore(rank) {

    const magnitude = Math.abs(Number(rank) || 0);

    return magnitude / (magnitude + 1.5);

}

module.exports = new RecallService();
