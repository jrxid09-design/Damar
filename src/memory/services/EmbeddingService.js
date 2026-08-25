const HttpClient = require("../../plugins/http/services/HttpClient");

const EmbeddingStore = require("../stores/EmbeddingStore");
const MemoryStore = require("../stores/MemoryStore");
const DocumentStore = require("../stores/DocumentStore");

const telemetry = require("../../services/telemetryService");

/**
 * Menghasilkan embedding lewat endpoint kompatibel (POST {model, input}
 * → {embeddings}) — diatur via AETHER_EMBED_URL + AETHER_EMBED_MODEL.
 *
 * Titik desain terpenting: endpoint ini OPSIONAL dan sering tidak
 * tersedia. Karena itu embedding diperlakukan sebagai peningkatan
 * kualitas, bukan syarat: memori tetap tersimpan dan tetap bisa
 * dicari lewat kata kunci, lalu vektornya diisi belakangan begitu
 * endpoint hidup. Tanpa konfigurasi, layanan ini netral (status
 * "tidak dikonfigurasi") dan pencarian memori jalan tanpa vektor.
 */
class EmbeddingService {

    constructor() {

        this.model =
            process.env.AETHER_EMBED_MODEL ?? null;

        this.baseUrl = (
            process.env.AETHER_EMBED_URL ?? ""
        ).replace(/\/+$/, "") || null;

        /** Status terakhir, supaya UI bisa menjelaskan kenapa kosong. */
        this.available = this.baseUrl ? null : false;

        this.lastError = this.baseUrl ? null : "endpoint embedding belum dikonfigurasi";

        this.lastCheckedAt = null;

        /** Cache in-process untuk teks query yang berulang. */
        this.cache = new Map();

        this.cacheLimit = 200;

        this.backfilling = false;

    }

    get configured() {
        return Boolean(this.baseUrl && this.model);
    }

    setModel(model) {

        if (model && model !== this.model) {
            this.model = model;
            this.cache.clear();
            this.available = null;
        }

        return this.model;

    }

    /**
     * Hasilkan embedding untuk satu atau banyak teks.
     * Mengembalikan null (bukan melempar) bila layanan tak tersedia,
     * agar pemanggil bisa lanjut tanpa vektor.
     */
    async embed(input) {

        if (!this.configured) {
            this.available = false;
            this.lastError = "endpoint embedding belum dikonfigurasi";
            return null;
        }

        const list = Array.isArray(input) ? input : [input];

        const cleaned = list.map(text => String(text ?? "").trim()).filter(Boolean);

        if (cleaned.length === 0) {
            return null;
        }

        const response = await HttpClient.post(
            `${this.baseUrl}/embeddings`,
            {
                body: { model: this.model, input: cleaned },
                timeout: 60000
            }
        );

        this.lastCheckedAt = new Date().toISOString();

        if (!response.success) {

            this.available = false;

            this.lastError =
                response.data?.error ??
                response.error ??
                response.statusText ??
                "tidak terjangkau";

            return null;

        }

        // Bentuk OpenAI-compatible: { data: [{ embedding: [...] }] }.
        // Bentuk { embeddings: [[...]] } tetap diterima untuk kompatibilitas.
        const vectors = response.data?.embeddings
            ?? (Array.isArray(response.data?.data)
                ? response.data.data.map(d => d.embedding)
                : null);

        if (!Array.isArray(vectors) || vectors.length === 0) {

            this.available = false;
            this.lastError = "respons embedding kosong";

            return null;

        }

        this.available = true;
        this.lastError = null;

        return vectors;

    }

    async embedOne(text) {

        const key = `${this.model}::${text}`;

        if (this.cache.has(key)) {
            return this.cache.get(key);
        }

        const vectors = await this.embed(text);

        const vector = vectors?.[0] ?? null;

        if (vector) {

            // Cache sederhana bergaya FIFO; query berulang jauh
            // lebih umum daripada variasi tak terbatas.
            if (this.cache.size >= this.cacheLimit) {
                this.cache.delete(this.cache.keys().next().value);
            }

            this.cache.set(key, vector);

        }

        return vector;

    }

    /** Coba beri embedding satu memori; diam saja bila gagal. */
    async embedMemory(memory) {

        const vector = await this.embedOne(
            memory.summary ? `${memory.summary}\n${memory.content}` : memory.content
        );

        if (!vector) {
            return false;
        }

        await EmbeddingStore.put("memory", memory.id, this.model, vector);

        return true;

    }

    /**
     * Isi embedding yang tertinggal.
     *
     * Dipanggil berkala oleh MemoryService; sekali jalan dibatasi
     * agar tidak memonopoli CPU saat inferensi chat berjalan.
     */
    async backfill({ batch = 32, maxBatches = 4 } = {}) {

        if (this.backfilling) {
            return { skipped: true, reason: "sedang berjalan" };
        }

        this.backfilling = true;

        let memories = 0;
        let chunks = 0;

        try {

            for (let round = 0; round < maxBatches; round++) {

                const pending = await MemoryStore.withoutEmbedding(this.model, batch);

                if (pending.length === 0) {
                    break;
                }

                const vectors = await this.embed(
                    pending.map(row =>
                        row.summary ? `${row.summary}\n${row.content}` : row.content)
                );

                if (!vectors) {
                    // Endpoint mati di tengah jalan: hentikan, sisanya
                    // akan terambil pada percobaan berikutnya.
                    return {
                        memories,
                        chunks,
                        stopped: true,
                        reason: this.lastError
                    };
                }

                await EmbeddingStore.putMany(
                    "memory",
                    this.model,
                    pending.map((row, index) => ({
                        id: row.id,
                        vector: vectors[index]
                    })).filter(entry => entry.vector)
                );

                memories += pending.length;

            }

            for (let round = 0; round < maxBatches; round++) {

                const pending = await DocumentStore.chunksWithoutEmbedding(
                    this.model,
                    batch
                );

                if (pending.length === 0) {
                    break;
                }

                const vectors = await this.embed(
                    pending.map(row => row.content)
                );

                if (!vectors) {
                    return {
                        memories,
                        chunks,
                        stopped: true,
                        reason: this.lastError
                    };
                }

                await EmbeddingStore.putMany(
                    "chunk",
                    this.model,
                    pending.map((row, index) => ({
                        id: row.id,
                        vector: vectors[index]
                    })).filter(entry => entry.vector)
                );

                chunks += pending.length;

            }

            if (memories || chunks) {

                telemetry.info(
                    `[memory] embedding terisi: ${memories} memori, ${chunks} chunk`
                );

            }

            return { memories, chunks, stopped: false };

        }

        finally {
            this.backfilling = false;
        }

    }

    async status() {

        const pendingMemories = await MemoryStore.withoutEmbedding(this.model, 1);

        const pendingChunks = await DocumentStore.chunksWithoutEmbedding(this.model, 1);

        return {
            model: this.model,
            baseUrl: this.baseUrl,
            available: this.available,
            lastError: this.lastError,
            lastCheckedAt: this.lastCheckedAt,
            vectors: await EmbeddingStore.count(),
            pending: {
                memories: pendingMemories.length > 0,
                chunks: pendingChunks.length > 0
            }
        };

    }

}

module.exports = new EmbeddingService();
