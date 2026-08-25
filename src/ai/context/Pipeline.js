const telemetry = require("../../services/telemetryService");

const ContextItem = require("./ContextItem");
const Budget = require("../tools/Budget");
const sources = require("./sources");
const Relevance = require("./Relevance");
const Dedupe = require("./Dedupe");
const ContextBudget = require("./ContextBudget");
const Compressor = require("./Compressor");
const Assembler = require("./Assembler");
const refs = require("./refs");

/**
 * CONTEXT INTELLIGENCE PIPELINE — satu jalur context untuk semua kanal.
 *
 * Menjawab: "informasi apa yang benar-benar perlu diketahui model
 * pada giliran ini?" — deterministik, beranggaran, dedupe, dan
 * cache-friendly. Tool Intelligence tetap subsystem terpisah; pipeline
 * ini hanya menyediakan pesan final + telemetri.
 *
 * Batas masuk (anti-explosion, menutup jalur tanpa batas lama):
 *   MAX_INPUT_MESSAGES   40  pesan
 *   MAX_MESSAGE_CHARS    6000 per pesan (paste raksasa dipangkas di gerbang)
 *   RECENT_MESSAGES       8  jendela recent utuh
 */

const LIMITS = {
    MAX_INPUT_MESSAGES: Number(process.env.AETHER_CONTEXT_MAX_MESSAGES) || 40,
    MAX_MESSAGE_CHARS: Number(process.env.AETHER_CONTEXT_MAX_MSG_CHARS) || 6000,
    RECENT_MESSAGES: Number(process.env.AETHER_CONTEXT_RECENT) || 8,
    RECENT_CHARS: 4000            // pengaman ekstra untuk satu pesan recent
};

/** Sanitasi input: batasi jumlah & ukuran — di SINI jalur liar ditutup. */
function sanitize(messages = []) {

    let trimmed = Array.isArray(messages) ? messages : [];

    const droppedCount = Math.max(0, trimmed.length - LIMITS.MAX_INPUT_MESSAGES);

    if (droppedCount > 0) trimmed = trimmed.slice(-LIMITS.MAX_INPUT_MESSAGES);

    trimmed = trimmed.map(m => ({
        ...m,
        content: typeof m.content === "string" && m.content.length > LIMITS.MAX_MESSAGE_CHARS
            ? Compressor.headTail(m.content, LIMITS.MAX_MESSAGE_CHARS)
            : m.content
    }));

    // Pesan tool/assistant kosong di ujung tidak berguna — rapikan.
    while (trimmed.length && !String(trimmed[trimmed.length - 1].content ?? "").trim()) {
        trimmed.pop();
    }

    return { messages: trimmed, droppedCount };

}

/**
 * Seleksi context untuk satu giliran.
 *
 * @param {object} input
 *   messages     array percakapan dari kanal (user/assistant)
 *   channel      "telegram"|"whatsapp"|...
 *   role         peran (untuk visibilitas kelak; saat ini passthrough)
 *   worker       {id,label} bila konteks untuk worker AgentHub
 *   contextRefs  ["project:x", ...] — port Colony
 *   includeMind  bool (default true; voice mungkin ingin hemat)
 *   memoryFn     injeksi adapter memori (default adapter asli; dipakai
 *                benchmark/test untuk korpus deterministik)
 *   mindFn       injeksi adapter batin (idem)
 * @returns {{messages, systemContent, diagnostics}}
 */
async function select({
    messages = [],
    channel = null,
    role = null,
    worker = null,
    contextRefs = [],
    includeMind = true,
    aiRuntime = null,
    memoryFn = null,
    mindFn = null,
    contextTokens = null
} = {}) {

    const started = Date.now();

    try {

        // ---- 1. Sanitasi + pemisahan recent vs older -----------------
        const { messages: clean, droppedCount } = sanitize(messages);

        const recentCount = Math.min(LIMITS.RECENT_MESSAGES, clean.length);

        const recent = clean.slice(clean.length - recentCount);

        const lastUser = [...clean].reverse().find(m => m.role === "user");

        const activeText = typeof lastUser?.content === "string" ? lastUser.content : "";

        const activeTokens = activeText.toLowerCase()
            .split(/[^a-z0-9]+/).filter(w => w.length >= 4);

        // ---- 2. Kandidat dari adapter --------------------------------
        const stableItems = aiRuntime ? sources.stableParts(aiRuntime) : [];
        const doctrineItems = sources.doctrine(activeText);
        const channelItems = aiRuntime ? sources.channelBlock(aiRuntime, channel) : [];
        const olderCandidates = sources.olderHistory(clean, recentCount);

        // Adapter hasil injeksi (benchmark/test) dinormalisasi ke
        // ContextItem — bentuk mentah {text,...} tidak boleh bocor
        // ke hilir sebagai pseudo-array.
        const adaptMemoryBlock = async () => {

            const fn = memoryFn ?? sources.memoryItems;

            const res = await fn(activeText);

            if (Array.isArray(res)) return res;              // sudah items

            if (!res?.text) return [];

            return [ContextItem.create({
                source: "memory",
                kind: ContextItem.KIND.MEMORY,
                content: String(res.text),
                priority: 50,
                compressible: true,
                provenance: `memory:${res.memoryCount ?? "?"}`
            })];

        };

        const adaptMindBlock = () => {

            const fn = mindFn ?? sources.mindItem;

            const res = fn();

            if (Array.isArray(res)) return res;

            if (!res?.content && !res?.text) return [];

            return [ContextItem.create({
                source: "mind",
                kind: ContextItem.KIND.MIND,
                content: String(res.content ?? res.text),
                priority: 40,
                compressible: true
            })];

        };

        const [memoryCand] = await Promise.all([
            adaptMemoryBlock(),
            Promise.resolve()
        ]);

        const mindCand = includeMind ? adaptMindBlock() : [];

        const resolvedRefs = await refs.resolve(contextRefs);

        const refItems = resolvedRefs.items.map(r => ContextItem.create({
            source: r.source,
            kind: ContextItem.KIND.REFS,
            content: r.content,
            priority: r.priority,
            mandatory: r.mandatory,
            provenance: r.provenance
        }));

        const candidates = [
            ...olderCandidates,
            ...memoryCand,
            ...mindCand,
            ...refItems
        ];

        // ---- 3. Relevansi (non-mandatory saja yang dinilai) ----------
        const historyIndices = new Map(
            olderCandidates.map((c, i) => [c.id, i])
        );

        const ranked = Relevance.rank(candidates, {
            activeText,
            historyIndices,
            threshold: 3
        }).map(r => r.item);

        // ---- 4. Dedupe lintas sumber ----------------------------------
        const { items: unique, removed } = Dedupe.dedupe(ranked);

        // ---- 5. Anggaran ----------------------------------------------
        const systemDraft = Assembler.buildSystem([...stableItems, ...doctrineItems, ...channelItems]);
        const stableTokens = ContextItem.estimateTextTokens(systemDraft);

        const { dynamicBudget, allocations } = ContextBudget.compute({
            // H6 Round-3: window AKTIF dari pemanggil (model nyata);
            // env hanya fallback di dalam compute, dan tak boleh memperbesar.
            contextTokens,
            stableTokens,
            maxTools: Number(process.env.AETHER_TOOL_BUDGET) || undefined
        });

        // ---- 6. Isi kategori dengan anggaran + kompresi ---------------
        const selected = [];
        const perKind = {};

        for (const item of unique) {

            const cap = allocations[item.kind]
                ?? allocations.other
                ?? Math.floor(dynamicBudget * 0.2);

            const used = perKind[item.kind] ?? 0;

            if (!item.mandatory && used >= cap) continue;

            const roomLeft = Math.max(120, cap - used);

            const { content, tokens } = item.compressible
                ? Compressor.compressItem(item, Math.min(roomLeft, item.tokenEstimate || Infinity), activeTokens)
                : { content: item.content, tokens: item.tokenEstimate };

            selected.push({ ...item, content, tokenEstimate: tokens });

            perKind[item.kind] = used + tokens;

        }

        const dynamicTokens = Object.values(perKind).reduce((a, b) => a + b, 0);

        // ---- 7. Rakit ---------------------------------------------------
        const systemContent = systemDraft;

        // INVARIANT WINDOW (H6 Round-2): system + riwayat + blok dinamis
        // + cadangan output/margin TIDAK BOLEH melampaui window AKTIF.
        // Diukur pada estimasi serialized final, bukan anggaran kategori.
        const winProfile = Budget.profileFor(contextTokens
            ?? (Number(process.env.AETHER_MODEL_CONTEXT_TOKENS) || undefined));

        const hardCapCtx = winProfile.contextTokens - 1024 - 512;

        // H6: bisa diturunkan oleh pemangkasan riwayat recent di bawah.
        let historyTokens = ContextItem.estimateTextTokens(
            recent.map(m => m.content).join("\n"));

        const estBlocks = (blks) => blks.reduce(
            (sum, b) => sum + ContextItem.estimateTextTokens(b), 0);

        let blocks = Assembler.buildDynamicBlocks(selected);

        let overflowTrimmed = 0;

        while (stableTokens + historyTokens + estBlocks(blocks) > hardCapCtx
               && blocks.length > 0) {
            // Buang blok dinamis terakhir dulu (urutan kontrak dibalik:
            // batin → memori → recap riwayat).
            blocks.pop();
            overflowTrimmed++;
        }

        // H6 Round-3: blok dinamis habis belum tentu cukup — riwayat
        // recent JUGA bagian window. Pangkas dari pesan TERTUA: kompres
        // dulu, buang bila masih muat. Pesan terakhir tidak pernah
        // dibuang (minimal satu pesan harus tersisa untuk giliran ini).
        let historyTrimmed = 0;

        while (stableTokens + historyTokens + estBlocks(blocks) > hardCapCtx
               && recent.length > 1) {

            const oldest = recent[0];

            const text = typeof oldest.content === "string"
                ? oldest.content : "";

            if (text.length > 240) {
                const compressed = Compressor.headTail(text, Math.floor(text.length / 4));
                const before = ContextItem.estimateTextTokens(text);
                const after = ContextItem.estimateTextTokens(compressed);
                recent[0] = { ...oldest, content: compressed };
                historyTokens = Math.max(0, historyTokens - (before - after));
            }
            else {
                historyTokens = Math.max(0,
                    historyTokens - ContextItem.estimateTextTokens(text));
                recent.shift();
                historyTrimmed++;
            }

        }

        const finalMessages = Assembler.attachDynamic(recent, blocks);

        // ---- 8. Diagnostik + telemetri (tanpa raw sensitif) ------------
        const diagnostics = {
            candidatesConsidered: candidates.length,
            itemsSelected: selected.length,
            historyDroppedOlder: Math.max(0, clean.length - recent.length - olderCandidates.length),
            inputMessagesDropped: droppedCount,
            dedupedRemoved: removed.length,
            budget: {
                window: ContextBudget.compute({
                    contextTokens,
                    stableTokens: 0,
                    maxTools: 0
                }).dynamicBudget + stableTokens,
                dynamicBudget,
                allocations
            },
            tokensBefore: ContextItem.estimateTextTokens(clean.map(m => m.content).join("\n"))
                + ContextItem.estimateTextTokens(memoryCand.map(i => i.content).join("\n")),
            tokensAfter: stableTokens + historyTokens + estBlocks(blocks),
            reductionPct: null,
            breakdown: {
                system: stableTokens,
                recentHistory: ContextItem.estimateTextTokens(recent.map(m => m.content).join("\n")),
                dynamic: dynamicTokens,
                byKind: perKind
            },
            unresolvedRefs: resolvedRefs.unresolved,
            channel,
            role,
            windowHardCap: hardCapCtx,
            overflowTrimmed,
            overflowHistoryTrimmed: historyTrimmed,
            selectionMs: Date.now() - started
        };

        diagnostics.reductionPct = diagnostics.tokensBefore > 0
            ? Math.max(0, Math.round((1 - diagnostics.tokensAfter / diagnostics.tokensBefore) * 100))
            : 0;

        telemetry.publish("context:selection", {
            candidates: diagnostics.candidatesConsidered,
            selected: diagnostics.itemsSelected,
            tokensBefore: diagnostics.tokensBefore,
            tokensAfter: diagnostics.tokensAfter,
            reductionPct: diagnostics.reductionPct,
            breakdown: diagnostics.breakdown,
            dedupedRemoved: removed.length,
            inputMessagesDropped: droppedCount,
            selectionMs: diagnostics.selectionMs,
            channel
        });

        return { messages: finalMessages, systemContent, diagnostics };

    }
    catch (error) {

        // Kegagalan pipeline TIDAK boleh menjatuhkan chat — degradasi
        // ke jalur minimal. Batas anti-explosion TETAP berlaku: pesan
        // disanitasi walau seleksi gagal (bounds bukan fitur, ia pagar).
        telemetry.warn(`[context] pipeline gagal, degradasi: ${error.message}`);

        const { messages: safe } = sanitize(messages);

        return {
            messages: safe,
            systemContent: null,
            diagnostics: {
                degraded: true,
                error: error.message,
                selectionMs: Date.now() - started
            }
        };

    }

}

module.exports = { select, sanitize, LIMITS, refs };

