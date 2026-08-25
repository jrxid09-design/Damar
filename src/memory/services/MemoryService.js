const { initialize, database } = require("../db");

const MemoryStore = require("../stores/MemoryStore");
const EntityStore = require("../stores/EntityStore");
const DocumentStore = require("../stores/DocumentStore");
const EmbeddingStore = require("../stores/EmbeddingStore");

const EmbeddingService = require("./EmbeddingService");
const RecallService = require("./RecallService");

const telemetry = require("../../services/telemetryService");

const { truncate } = require("../util/text");

/**
 * Muka depan lapisan memori.
 *
 * Semua bagian lain Aether — controller HTTP, tool AI, kelak
 * penerima event CCTV/sensor — cukup bicara ke kelas ini dan tidak
 * perlu tahu soal FTS, vektor, atau resolusi entitas.
 */
class MemoryService {

    constructor() {

        this.started = false;

        this.backfillTimer = null;

    }

    async start({ backfillInterval = 60000 } = {}) {

        if (this.started) {
            return this;
        }

        await initialize();

        this.started = true;

        // Embedding diisi di latar belakang: memori yang masuk saat
        // Endpoint embedding mati tetap tercatat, vektornya menyusul.
        this.backfillTimer = setInterval(() => {

            EmbeddingService.backfill().catch(error => {
                telemetry.warn(`[memory] backfill gagal: ${error.message}`);
            });

        }, backfillInterval);

        this.backfillTimer.unref?.();

        telemetry.info("[memory] lapisan memori siap");

        return this;

    }

    stop() {

        if (this.backfillTimer) {
            clearInterval(this.backfillTimer);
            this.backfillTimer = null;
        }

        this.started = false;

        return this;

    }

    /**
     * Catat satu memori.
     *
     * `entities` boleh berisi nama ("ayah", "Garasi") — nama akan
     * di-resolve atau dibuat, sehingga pemanggil tidak perlu tahu
     * id internal.
     */
    async remember({
        content,
        type = "episodic",
        source = "system",
        sourceRef = null,
        importance = 0.5,
        confidence = 1,
        occurredAt = null,
        validUntil = null,
        sensitive = false,
        pinned = false,
        metadata = {},
        documentId = null,
        entities = [],
        supersedes = null
    }) {

        await this.start();

        const memory = await MemoryStore.insert({
            type, content, source, sourceRef, importance, confidence,
            occurredAt, validUntil, sensitive, pinned, metadata, documentId
        });

        const linked = [];

        for (const mention of entities) {

            const spec = typeof mention === "string"
                ? { name: mention }
                : mention;

            if (!spec?.name) {
                continue;
            }

            const entity = await EntityStore.resolveOrCreate(spec.name, {
                kind: spec.kind,
                attributes: spec.attributes,
                occurredAt: occurredAt ?? undefined
            });

            await MemoryStore.linkEntities(memory.id, [{
                entityId: entity.id,
                role: spec.role ?? "mentions"
            }]);

            linked.push(entity);

        }

        if (supersedes) {
            await MemoryStore.supersede(supersedes, memory.id);
        }

        // Coba embed langsung; kalau endpoint mati, backfill yang urus.
        if (!memory.reinforced) {
            await EmbeddingService.embedMemory(memory).catch(() => false);
        }

        telemetry.publish("memory:remembered", {
            id: memory.id,
            type: memory.type,
            source: memory.source,
            reinforced: memory.reinforced,
            preview: truncate(memory.content, 90)
        });

        return { ...memory, entities: linked };

    }

    async recall(query, options = {}) {

        await this.start();

        return RecallService.recall(query, options);

    }

    /**
     * Rangkai memori relevan menjadi blok teks siap tempel ke
     * system prompt.
     *
     * Dibatasi jumlah karakter, bukan jumlah item, karena yang
     * langka adalah konteks model — bukan barisnya.
     */
    async buildContext(query, {
        limit = 8,
        maxChars = 1800,
        includeDocuments = true
    } = {}) {

        const result = await this.recall(query, { limit, includeDocuments });

        const lines = [];

        let used = 0;

        for (const item of result.items) {

            // Jurnal rekayasa TIDAK ikut disuntikkan ke percakapan
            // biasa. Catatan itu panjang, teknis, dan tersedia
            // sesuai permintaan lewat tool `build_recall`. Terbukti
            // mengganggu: sapaan "Halo" menarik catatan tentang
            // sebuah berkas sumber — konteks yang tak berguna bagi
            // pengguna, dibayar dengan token yang di mesin lokal
            // langsung menjadi detik.
            if (item.metadata?.kind === "build") {
                continue;
            }


            const when = (item.occurredAt ?? "").slice(0, 16).replace("T", " ");

            const who = item.entities.length
                ? ` [${item.entities.map(entity => entity.name).join(", ")}]`
                : "";

            // Asal-usul ikut, supaya Aether dapat membedakan apa yang
            // DIKATAKAN pengguna dari apa yang ia simpulkan sendiri.
            // Medannya sudah lama ada di basis data, tetapi tidak
            // pernah sampai ke model — sehingga catatan hasil
            // kesimpulan terbaca sama meyakinkannya dengan fakta
            // yang disampaikan langsung.
            //
            // Ditulis singkat: pada mesin lokal tiap token dibayar
            // dengan waktu, jadi hanya yang BUKAN dari pengguna yang
            // diberi penanda.
            const line = `- (${item.type}, ${when}${asalUsul(item)})${who} ${item.content}`;

            if (used + line.length > maxChars) {
                break;
            }

            lines.push(line);

            used += line.length;

        }

        const documentLines = [];

        for (const doc of result.documents ?? []) {

            const line = `- [${doc.title ?? doc.uri}${
                doc.heading ? ` › ${doc.heading}` : ""
            }] ${doc.excerpt}`;

            if (used + line.length > maxChars) {
                break;
            }

            documentLines.push(line);

            used += line.length;

        }

        const sections = [];

        if (lines.length) {
            sections.push(`Memori relevan:\n${lines.join("\n")}`);
        }

        if (documentLines.length) {
            sections.push(`Kutipan dokumen:\n${documentLines.join("\n")}`);
        }

        return {
            text: sections.join("\n\n"),
            memoryCount: lines.length,
            documentCount: documentLines.length,
            entities: result.entities,
            strategies: result.strategies
        };

    }

    async forget(id) {

        await this.start();

        const removed = await MemoryStore.remove(id);

        if (removed) {

            await database.run(
                "DELETE FROM embeddings WHERE owner_kind = 'memory' AND owner_id = ?",
                [id]
            );

            telemetry.publish("memory:forgotten", { id });

        }

        return removed;

    }

    /**
     * Fakta berubah — catat penggantinya TANPA menghapus sejarah
     * (§17, §269, Konstitusi Pasal 7.3).
     *
     * Menimpa memori lama adalah cara termudah dan paling salah:
     * ia menghapus kemampuan menjawab "apa yang benar bulan lalu?".
     * Di sini yang lama tetap ada, hanya ditandai sudah digantikan
     * dan diberi batas masa berlaku.
     *
     * RecallService sudah menyaring `superseded_by IS NULL` dan
     * `valid_until` — jadi begitu ditandai, memori lama otomatis
     * berhenti muncul di pengambilan biasa, tetapi tetap dapat
     * ditelusuri saat menanyakan sejarah.
     *
     * @param {number} oldId memori yang tidak lagi berlaku
     * @param {number} newId memori yang menggantikannya
     * @param {object} [opts]
     * @param {string} [opts.at] kapan pergantian berlaku (ISO)
     */
    async supersede(oldId, newId, { at = null } = {}) {

        await this.start();

        const when = at ?? new Date().toISOString();

        const previous = await MemoryStore.get(oldId);

        if (!previous) {
            return { superseded: false, reason: `memori ${oldId} tidak ditemukan` };
        }

        await database.run(
            `UPDATE memories
                SET superseded_by = ?,
                    valid_until   = COALESCE(valid_until, ?)
              WHERE id = ?`,
            [newId, when, oldId]
        );

        // Rantai dua arah supaya sejarah dapat ditelusuri maju
        // maupun mundur tanpa memindai seluruh tabel.
        await database.run(
            `UPDATE memories
                SET supersedes = ?,
                    valid_from = COALESCE(valid_from, ?)
              WHERE id = ?`,
            [oldId, when, newId]
        );

        telemetry.publish("memory:superseded", { oldId, newId, at: when });

        return { superseded: true, oldId, newId, at: when };

    }

    /**
     * Riwayat sebuah fakta: rantai memori yang saling menggantikan,
     * dari yang paling awal sampai yang berlaku sekarang.
     */
    async history(id, { limit = 20 } = {}) {

        await this.start();

        const chain = [];
        let cursor = await MemoryStore.get(id);

        // MemoryStore.hydrate memakai camelCase; memakai nama kolom
        // mentah di sini membuat rantai diam-diam berhenti di satu
        // simpul — persis bug yang tertangkap saat diuji.
        while (cursor?.supersedes && chain.length < limit) {
            const prev = await MemoryStore.get(cursor.supersedes);
            if (!prev) break;
            chain.unshift(prev);
            cursor = prev;
        }

        const current = await MemoryStore.get(id);
        if (current) chain.push(current);

        // Maju ke yang berlaku sekarang.
        cursor = current;
        while (cursor?.supersededBy && chain.length < limit) {
            const next = await MemoryStore.get(cursor.supersededBy);
            if (!next) break;
            chain.push(next);
            cursor = next;
        }

        return chain;

    }

    /** Tandai memori masih benar hari ini (§16). */
    async markVerified(id) {

        await this.start();

        await database.run(
            "UPDATE memories SET last_verified = ? WHERE id = ?",
            [new Date().toISOString(), id]
        );

        return MemoryStore.get(id);

    }

    async update(id, patch) {

        await this.start();

        const memory = await MemoryStore.update(id, patch);

        // Isi berubah berarti vektor lama tidak lagi mewakili.
        if (patch.content) {

            await database.run(
                "DELETE FROM embeddings WHERE owner_kind = 'memory' AND owner_id = ?",
                [id]
            );

            await EmbeddingService.embedMemory(memory).catch(() => false);

        }

        return memory;

    }

    async list(options) {

        await this.start();

        return MemoryStore.list(options);

    }

    async get(id) {

        await this.start();

        const memory = await MemoryStore.get(id);

        if (!memory) {
            return null;
        }

        return {
            ...memory,
            entities: await MemoryStore.entitiesOf(id)
        };

    }

    /**
     * Perawatan berkala.
     *
     * Tujuannya menjaga memori tetap berguna, bukan sekadar kecil:
     * fakta kedaluwarsa ditandai, memori tak penting yang tak pernah
     * dipanggil meluruh, dan sisanya dibiarkan.
     */
    async consolidate({ dryRun = false, decayAfterDays = 90 } = {}) {

        await this.start();

        const expired = await database.all(
            `SELECT id FROM memories
             WHERE valid_until IS NOT NULL
               AND valid_until <= datetime('now')
               AND superseded_by IS NULL
               AND pinned = 0`
        );

        const stale = await database.all(
            `SELECT id FROM memories
             WHERE pinned = 0
               AND sensitive = 0
               AND recall_count = 0
               AND importance < 0.35
               AND type = 'episodic'
               AND occurred_at < datetime('now', ?)`,
            [`-${Number(decayAfterDays)} days`]
        );

        if (dryRun) {

            return {
                dryRun: true,
                expired: expired.length,
                stale: stale.length
            };

        }

        let removed = 0;

        for (const row of stale) {

            if (await this.forget(row.id)) {
                removed++;
            }

        }

        // Memori kedaluwarsa tidak dihapus — ia tetap fakta historis
        // yang sah, hanya tidak lagi dipakai sebagai keadaan kini.
        // Penurunan importance membuatnya tenggelam secara alami.
        if (expired.length) {

            await database.run(
                `UPDATE memories
                 SET importance = max(0.05, importance - 0.2)
                 WHERE id IN (${expired.map(() => "?").join(",")})`,
                expired.map(row => row.id)
            );

        }

        telemetry.info(
            `[memory] konsolidasi: ${removed} dihapus, ${expired.length} kedaluwarsa diturunkan`
        );

        return { removed, expired: expired.length };

    }

    async stats() {

        await this.start();

        return {
            memories: await MemoryStore.stats(),
            entities: await EntityStore.stats(),
            documents: await DocumentStore.stats(),
            embeddings: await EmbeddingService.status(),
            database: require("../db").file
        };

    }

}

/**
 * Penanda asal-usul untuk satu baris memori (§13, §276).
 *
 * Aether menyimpan `source`, `confidence`, dan `lastVerified` sejak
 * lama, tetapi tak satu pun sampai ke model. Akibatnya sesuatu yang
 * DISIMPULKAN Aether terbaca sama meyakinkannya dengan sesuatu yang
 * DIKATAKAN pengguna — dan ketika ditanya, ia tidak punya bahan
 * untuk membedakannya.
 *
 * Sengaja hemat: yang berasal dari pengguna tidak diberi penanda
 * sama sekali, karena itulah keadaan normal dan setiap token yang
 * ditambahkan di sini dibayar dengan waktu di mesin lokal.
 */
function asalUsul(item) {

    const bagian = [];

    const sumber = String(item.source ?? "").toLowerCase();

    // Kosong / "user" / "owner" = disampaikan pengguna: tanpa penanda.
    if (sumber && !/^(user|owner|pengguna)$/.test(sumber)) {
        bagian.push(sumber === "coding-brain" ? "catatan Aether" : sumber);
    }

    // Keyakinan di bawah penuh berarti ini kesimpulan, bukan kutipan.
    const yakin = Number(item.confidence);
    if (Number.isFinite(yakin) && yakin < 0.9) {
        bagian.push(`perkiraan ${yakin.toFixed(1)}`);
    }

    return bagian.length ? `, ${bagian.join(", ")}` : "";

}

module.exports = new MemoryService();
module.exports.asalUsul = asalUsul;
