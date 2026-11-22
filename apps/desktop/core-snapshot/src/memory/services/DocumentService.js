const path = require("node:path");
const fs = require("node:fs/promises");

const DocumentStore = require("../stores/DocumentStore");
const EmbeddingStore = require("../stores/EmbeddingStore");
const EmbeddingService = require("./EmbeddingService");

const extractors = require("../ingest/extractors");
const Chunker = require("../ingest/Chunker");

const { initialize } = require("../db");
const telemetry = require("../../services/telemetryService");

/**
 * Memasukkan dokumen ke dalam memori.
 *
 * Alurnya: ekstrak teks -> pecah jadi chunk -> simpan -> embed.
 * Embedding boleh gagal (endpoint mati) tanpa membatalkan ingest;
 * dokumen tetap bisa dicari lewat kata kunci dan vektornya
 * menyusul lewat backfill.
 */
class DocumentService {

    constructor() {

        this.chunker = new Chunker();

    }

    /** Ingest satu berkas dari disk. */
    async ingestFile(filePath, { title = null, metadata = {} } = {}) {

        await initialize();

        const absolute = path.resolve(filePath);

        await fs.access(absolute);

        const extracted = await extractors.extract(absolute);

        return this.ingestText({
            uri: absolute,
            title: title ?? extracted.title,
            mediaType: extracted.mediaType,
            byteSize: extracted.byteSize,
            content: extracted.content,
            metadata: { ...(extracted.metadata ?? {}), ...metadata }
        });

    }

    /** Ingest teks yang sudah ada di tangan (paste, hasil scrape, dst). */
    async ingestText({
        uri,
        title = null,
        content,
        mediaType = "text",
        byteSize = null,
        metadata = {}
    }) {

        await initialize();

        if (!content || !String(content).trim()) {
            throw new Error("Dokumen kosong — tidak ada teks yang bisa diambil.");
        }

        const document = await DocumentStore.create({
            uri,
            title,
            mediaType,
            byteSize: byteSize ?? Buffer.byteLength(content, "utf8"),
            content,
            metadata
        });

        if (document.alreadyIngested) {

            telemetry.info(`[memory] dokumen sudah pernah dibaca: ${uri}`);

            return { ...document, chunks: document.chunkCount, skipped: true };

        }

        try {

            const chunks = this.chunker.chunk(content);

            if (chunks.length === 0) {
                throw new Error("Tidak ada potongan teks yang dihasilkan.");
            }

            await DocumentStore.addChunks(document.id, chunks);

            const stored = await DocumentStore.chunks(document.id, { limit: 10000 });

            const embedded = await this.embedChunks(stored);

            telemetry.info(
                `[memory] dokumen dibaca: ${title ?? uri} — ` +
                `${chunks.length} potongan, ${embedded} ter-embed`
            );

            telemetry.publish("memory:document", {
                id: document.id,
                title: title ?? uri,
                chunks: chunks.length,
                embedded
            });

            return {
                ...(await DocumentStore.get(document.id)),
                chunks: chunks.length,
                embedded,
                skipped: false
            };

        }

        catch (error) {

            await DocumentStore.markFailed(document.id, error.message);

            throw error;

        }

    }

    async embedChunks(chunks) {

        if (chunks.length === 0) {
            return 0;
        }

        const vectors = await EmbeddingService.embed(
            chunks.map(chunk => chunk.content)
        );

        if (!vectors) {
            // Endpoint embedding tak tersedia — backfill yang akan mengisinya.
            return 0;
        }

        return EmbeddingStore.putMany(
            "chunk",
            EmbeddingService.model,
            chunks
                .map((chunk, index) => ({ id: chunk.id, vector: vectors[index] }))
                .filter(entry => entry.vector)
        );

    }

    /**
     * Ingest seluruh isi folder.
     *
     * Berkas yang tidak didukung dilewati dengan alasan tercatat,
     * bukan menggagalkan seluruh proses — satu PDF rusak di antara
     * ratusan berkas tidak boleh membatalkan sisanya.
     */
    async ingestDirectory(directory, {
        recursive = true,
        maxFiles = 500,
        maxBytes = 25 * 1024 * 1024,
        metadata = {}
    } = {}) {

        await initialize();

        const root = path.resolve(directory);

        const results = { ingested: [], skipped: [], failed: [] };

        const walk = async (current, depth) => {

            if (results.ingested.length + results.failed.length >= maxFiles) {
                return;
            }

            const entries = await fs.readdir(current, { withFileTypes: true });

            for (const entry of entries) {

                const full = path.join(current, entry.name);

                if (entry.isDirectory()) {

                    if (recursive && !isIgnoredDirectory(entry.name)) {
                        await walk(full, depth + 1);
                    }

                    continue;

                }

                if (!extractors.isSupported(full)) {
                    results.skipped.push({ file: full, reason: "format tidak didukung" });
                    continue;
                }

                const stat = await fs.stat(full);

                if (stat.size > maxBytes) {
                    results.skipped.push({ file: full, reason: "berkas terlalu besar" });
                    continue;
                }

                try {

                    const document = await this.ingestFile(full, { metadata });

                    if (document.skipped) {
                        results.skipped.push({ file: full, reason: "sudah pernah dibaca" });
                    }
                    else {
                        results.ingested.push({ file: full, chunks: document.chunks });
                    }

                }

                catch (error) {
                    results.failed.push({ file: full, error: error.message });
                }

            }

        };

        await walk(root, 0);

        return results;

    }

    async list(options) {

        await initialize();

        return DocumentStore.list(options);

    }

    async get(id) {

        await initialize();

        return DocumentStore.get(id);

    }

    async chunks(id, options) {

        await initialize();

        return DocumentStore.chunks(id, options);

    }

    async remove(id) {

        await initialize();

        return DocumentStore.remove(id);

    }

}

function isIgnoredDirectory(name) {

    return [
        "node_modules", ".git", ".svn", "dist", "build",
        "__pycache__", ".venv", "venv", ".cache", "data"
    ].includes(name) || name.startsWith(".");

}

module.exports = new DocumentService();
