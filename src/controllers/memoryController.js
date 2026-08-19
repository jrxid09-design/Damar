const response = require("../utils/response");

const MemoryService = require("../memory/services/MemoryService");
const DocumentService = require("../memory/services/DocumentService");
const EntityStore = require("../memory/stores/EntityStore");
const EmbeddingService = require("../memory/services/EmbeddingService");
const MemoryEngine = require("../memory/core/MemoryEngine");

class MemoryController {

    async stats(req, res, next) {

        try {
            return response.success(res, "Memory stats", await MemoryService.stats());
        }
        catch (error) {
            next(error);
        }

    }

    async list(req, res, next) {

        try {

            const result = await MemoryService.list({
                type: req.query.type ?? null,
                source: req.query.source ?? null,
                entityId: req.query.entityId ? Number(req.query.entityId) : null,
                since: req.query.since ?? null,
                until: req.query.until ?? null,
                pinnedOnly: req.query.pinned === "true",
                includeSuperseded: req.query.includeSuperseded === "true",
                limit: Math.min(Number(req.query.limit ?? 50), 200),
                offset: Number(req.query.offset ?? 0)
            });

            return response.success(res, "Memories", result);

        }
        catch (error) {
            next(error);
        }

    }

    async get(req, res, next) {

        try {

            const memory = await MemoryService.get(Number(req.params.id));

            if (!memory) {
                return response.error(res, "Memori tidak ditemukan.", 404);
            }

            return response.success(res, "Memory", memory);

        }
        catch (error) {
            next(error);
        }

    }

    async recall(req, res, next) {

        try {

            const { query, limit, types, entityIds, includeDocuments } = req.body ?? {};

            if (!query && !entityIds?.length) {
                return response.error(res, "Field 'query' wajib diisi.", 400);
            }

            const result = await MemoryService.recall(query, {
                limit: Math.min(Number(limit ?? 10), 50),
                types: types ?? null,
                entityIds: entityIds ?? null,
                includeDocuments: includeDocuments !== false
            });

            return response.success(res, "Recall result", result);

        }
        catch (error) {
            next(error);
        }

    }

    async remember(req, res, next) {

        try {

            const { content } = req.body ?? {};

            if (!content) {
                return response.error(res, "Field 'content' wajib diisi.", 400);
            }

            const memory = await MemoryService.remember({
                ...req.body,
                source: req.body.source ?? "manual"
            });

            return response.success(res, "Memori disimpan", memory, 201);

        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    async update(req, res, next) {

        try {
            return response.success(
                res,
                "Memori diperbarui",
                await MemoryService.update(Number(req.params.id), req.body ?? {})
            );
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    async forget(req, res, next) {

        try {

            const removed = await MemoryService.forget(Number(req.params.id));

            if (!removed) {
                return response.error(res, "Memori tidak ditemukan.", 404);
            }

            return response.success(res, "Memori dihapus", { id: Number(req.params.id) });

        }
        catch (error) {
            next(error);
        }

    }

    async consolidate(req, res, next) {

        try {
            return response.success(
                res,
                "Konsolidasi selesai",
                await MemoryService.consolidate({
                    dryRun: req.query.dryRun === "true"
                })
            );
        }
        catch (error) {
            next(error);
        }

    }

    // ---- Entitas -------------------------------------------------

    async entities(req, res, next) {

        try {

            const entities = await EntityStore.list({
                kind: req.query.kind ?? null,
                query: req.query.query ?? null,
                limit: Math.min(Number(req.query.limit ?? 100), 300),
                offset: Number(req.query.offset ?? 0)
            });

            const detailed = [];

            for (const entity of entities) {

                detailed.push({
                    ...entity,
                    aliases: await EntityStore.aliases(entity.id)
                });

            }

            return response.success(res, "Entities", {
                total: detailed.length,
                entities: detailed
            });

        }
        catch (error) {
            next(error);
        }

    }

    async entity(req, res, next) {

        try {

            const entity = await EntityStore.get(Number(req.params.id));

            if (!entity) {
                return response.error(res, "Entitas tidak ditemukan.", 404);
            }

            const memories = await MemoryService.list({
                entityId: entity.id,
                limit: 50
            });

            return response.success(res, "Entity", {
                ...entity,
                aliases: await EntityStore.aliases(entity.id),
                relations: await EntityStore.relations(entity.id),
                memories: memories.items
            });

        }
        catch (error) {
            next(error);
        }

    }

    async createEntity(req, res, next) {

        try {

            const { name } = req.body ?? {};

            if (!name) {
                return response.error(res, "Field 'name' wajib diisi.", 400);
            }

            return response.success(
                res,
                "Entitas disimpan",
                await EntityStore.create(req.body),
                201
            );

        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    async updateEntity(req, res, next) {

        try {
            return response.success(
                res,
                "Entitas diperbarui",
                await EntityStore.update(Number(req.params.id), req.body ?? {})
            );
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    async removeEntity(req, res, next) {

        try {
            return response.success(res, "Entitas dihapus", {
                removed: await EntityStore.remove(Number(req.params.id))
            });
        }
        catch (error) {
            next(error);
        }

    }

    // ---- Dokumen ---------------------------------------------------

    async documents(req, res, next) {

        try {
            return response.success(res, "Documents", await DocumentService.list({
                query: req.query.query ?? null,
                limit: Math.min(Number(req.query.limit ?? 50), 200),
                offset: Number(req.query.offset ?? 0)
            }));
        }
        catch (error) {
            next(error);
        }

    }

    async documentChunks(req, res, next) {

        try {

            const document = await DocumentService.get(Number(req.params.id));

            if (!document) {
                return response.error(res, "Dokumen tidak ditemukan.", 404);
            }

            return response.success(res, "Document chunks", {
                document,
                chunks: await DocumentService.chunks(document.id, {
                    limit: Math.min(Number(req.query.limit ?? 50), 200),
                    offset: Number(req.query.offset ?? 0)
                })
            });

        }
        catch (error) {
            next(error);
        }

    }

    /**
     * Ingest berjalan sinkron terhadap permintaan. Untuk folder
     * besar ini bisa lama — batas maxFiles dan timeout klien yang
     * menjaganya, dan Console menampilkan spinner selama berjalan.
     */
    async ingest(req, res, next) {

        try {

            const { path: target, text, uri, title, directory } = req.body ?? {};

            if (text) {

                return response.success(res, "Teks dibaca", await DocumentService.ingestText({
                    uri: uri ?? `manual:${Date.now()}`,
                    title: title ?? "Catatan manual",
                    content: text
                }), 201);

            }

            if (directory) {

                return response.success(
                    res,
                    "Folder dibaca",
                    await DocumentService.ingestDirectory(directory),
                    201
                );

            }

            if (!target) {
                return response.error(
                    res,
                    "Sertakan salah satu dari 'path', 'directory', atau 'text'.",
                    400
                );
            }

            return response.success(
                res,
                "Dokumen dibaca",
                await DocumentService.ingestFile(target, { title }),
                201
            );

        }

        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    /**
     * Upload berkas dari Console/CLI ke sesi percakapan.
     *
     * Terima base64 (bukan multipart — konsisten dengan jalur vision).
     * Berkas disimpan ke downloads/chat-uploads/ lalu:
     *   - gambar → URL data URI dikembalikan agar bisa dilampirkan
     *     ke pesan chat & dianalisis vision;
     *   - dokumen teks (pdf/docx/md/…) → di-ingest ke memori dokumen,
     *     hasilnya bisa dirujuk Aether dalam percakapan.
     */
    async upload(req, res, next) {

        try {

            const { name = "berkas", data: base64, mimeType } = req.body ?? {};

            if (!base64) {
                return response.error(res, "Field 'data' (base64) wajib diisi.", 400);
            }

            const buffer = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ""), "base64");

            if (buffer.length === 0) {
                return response.error(res, "Berkas kosong.", 400);
            }

            if (buffer.length > 20 * 1024 * 1024) {
                return response.error(res, "Berkas terlalu besar (maks 20 MB).", 413);
            }

            const safeName = String(name).replace(/[^\w.\-() ]+/g, "_").slice(0, 120) || "berkas";
            const fs = require("node:fs");
            const path = require("node:path");

            const dir = path.join(process.cwd(), "downloads", "chat-uploads");
            fs.mkdirSync(dir, { recursive: true });

            const target = path.join(dir, `${Date.now()}-${safeName}`);
            fs.writeFileSync(target, buffer);

            const ext = path.extname(safeName).toLowerCase();
            const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
            const mime = mimeType ?? (isImage ? `image/${ext === ".jpg" ? "jpeg" : ext.slice(1)}` : "application/octet-stream");

            // Dokumen teks → langsung masuk memori dokumen agar bisa
            // dirujuk Aether. Gagal ingest tidak fatal: berkas tetap ada.
            let ingested = null;
            if (!isImage) {
                try {
                    ingested = await DocumentService.ingestFile(target, { title: safeName });
                }
                catch (error) {
                    ingested = { error: error.message };
                }
            }

            return response.success(res, "Berkas diterima", {
                name: safeName,
                path: target,
                size: buffer.length,
                mime,
                kind: isImage ? "image" : "document",
                // Gambar kecil → data URI untuk lampiran chat.
                dataUri: isImage && buffer.length <= 3 * 1024 * 1024
                    ? `data:${mime};base64,${buffer.toString("base64")}`
                    : null,
                ingested
            }, 201);

        }
        catch (error) {
            return next(error);
        }

    }

    async removeDocument(req, res, next) {

        try {
            return response.success(res, "Dokumen dihapus", {
                removed: await DocumentService.remove(Number(req.params.id))
            });
        }
        catch (error) {
            next(error);
        }

    }

    // ---- Embedding --------------------------------------------------

    async embeddingStatus(req, res, next) {

        try {
            return response.success(res, "Embedding status", await EmbeddingService.status());
        }
        catch (error) {
            next(error);
        }

    }

    async backfill(req, res, next) {

        try {
            return response.success(
                res,
                "Backfill dijalankan",
                await EmbeddingService.backfill({ maxBatches: 20 })
            );
        }
        catch (error) {
            next(error);
        }

    }

    // ---- Governance (proposal memori ask-tier) --------------------

    async proposals(req, res, next) {
        try {
            return response.success(res, "Proposal memori", {
                items: await MemoryEngine.pending({
                    limit: Math.min(Number(req.query.limit ?? 100), 300)
                })
            });
        }
        catch (error) {
            next(error);
        }
    }

    async approveProposal(req, res, next) {
        try {
            return response.success(res, "Proposal disetujui",
                await MemoryEngine.approve(Number(req.params.id), { actor: req.body?.actor ?? "user" }));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    async rejectProposal(req, res, next) {
        try {
            return response.success(res, "Proposal ditolak",
                await MemoryEngine.reject(Number(req.params.id), {
                    actor: req.body?.actor ?? "user", reason: req.body?.reason ?? null
                }));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    async audit(req, res, next) {
        try {
            return response.success(res, "Audit memori", {
                items: await MemoryEngine.auditLog({
                    limit: Math.min(Number(req.query.limit ?? 100), 300)
                })
            });
        }
        catch (error) {
            next(error);
        }
    }

}

module.exports = new MemoryController();
