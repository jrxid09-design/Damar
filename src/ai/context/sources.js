/**
 * CONTEXT SOURCES — adapter ke sistem yang SUDAH ADA.
 *
 * Pipeline context TIDAK memiliki memori kedua, session store kedua,
 * atau project database. Semua kandidat diambil lewat adapter:
 *
 *   system/device  → aiRuntimeService.systemPrompt (potongan stabil)
 *   doctrine       → prompts/doctrines (kondisional per topik)
 *   channel        → aiRuntimeService.channelPrompt
 *   history        → array messages yang dikirim kanal (satu-satunya
 *                    sumber riwayat; SQLite session tetap pemilik data)
 *   memory         → MemoryService.buildContext (existing retrieval)
 *   mind           → consciousness.stateOfMind (existing)
 *   refs           → registry resolver tipis (port Colony/Lab)
 *
 * Setiap adapter WAJIB tahan gagal: sumber opsional yang mati hanya
 * mengurangi kandidat, tidak pernah menjatuhkan giliran.
 */

const ContextItem = require("./ContextItem");

/** Ambil potongan stabil dari system prompt service tanpa mengubahnya. */
function stableParts(aiRuntime) {

    const items = [];

    try {

        const full = String(aiRuntime.systemPrompt ?? "");

        // Baris perangkat adalah paragraf pertama sebelum "\n\n" —
        // ia stabil dan wajib; sisanya persona/aturan.
        const splitAt = full.indexOf("\n\n");

        if (splitAt > 0) {
            items.push(ContextItem.create({
                source: "device",
                kind: ContextItem.KIND.DEVICE,
                content: full.slice(0, splitAt),
                priority: 100,
                mandatory: true,
                stable: true,
                compressible: false
            }));
            items.push(ContextItem.create({
                source: "persona",
                kind: ContextItem.KIND.SYSTEM,
                content: full.slice(splitAt + 2),
                priority: 90,
                mandatory: true,
                stable: true,
                compressible: false
            }));
        }
        else {
            items.push(ContextItem.create({
                source: "persona",
                kind: ContextItem.KIND.SYSTEM,
                content: full,
                priority: 90,
                mandatory: true,
                stable: true,
                compressible: false
            }));
        }

    }
    catch { /* systemPrompt kosong: jangan jatuh */ }

    return items;

}

function doctrine(lastUserText) {

    try {
        const { doctrineFor } = require("../../prompts/doctrines");
        const text = doctrineFor(String(lastUserText ?? ""));
        if (!text) return [];
        return [ContextItem.create({
            source: "doctrine",
            kind: ContextItem.KIND.DIRECTIVE,
            content: text,
            priority: 70,
            mandatory: true,        // doktrin menuntun perilaku — jangan dibuang anggaran
            stable: false
        })];
    }
    catch {
        return [];
    }

}

function channelBlock(aiRuntime, channel) {

    try {
        const text = aiRuntime.channelPrompt(channel);
        if (!text) return [];
        return [ContextItem.create({
            source: "channel",
            kind: ContextItem.KIND.CHANNEL,
            content: text,
            priority: 80,
            mandatory: true,
            stable: false
        })];
    }
    catch {
        return [];
    }

}

/**
 * Kandidat RELEVANT_HISTORY dari riwayat yang lebih tua daripada
 * jendela recent. Pemilik data tetap session store kanal.
 */
function olderHistory(messages, recentCount) {

    const older = messages.slice(0, Math.max(0, messages.length - recentCount));

    return older
        .filter(m => typeof m.content === "string" && m.content.trim())
        .map(m => ContextItem.create({
            source: "history",
            kind: ContextItem.KIND.RELEVANT_HISTORY,
            content: `${m.role === "assistant" ? "Aether" : "Pengguna"}: ${m.content}`,
            relevance: 0,          // diisi Relevance
            priority: 20,
            compressible: true,
            metadata: { role: m.role }
        }));

}

/** Adapter memori — existing MemoryService.buildContext. */
async function memoryItems(lastUserText) {

    if (!lastUserText) return [];

    try {

        const memory = require("../../memory/services/MemoryService");

        const context = await memory.buildContext(lastUserText, {
            limit: 8,
            maxChars: 2400
        });

        if (!context?.text) return [];

        // Blok jadi SATU item beralasan: retrieval existing sudah
        // memilih & membungkus dengan batas eksplisitnya sendiri;
        // pipeline memberinya relevansi + anggaran.
        return [ContextItem.create({
            source: "memory",
            kind: ContextItem.KIND.MEMORY,
            content: context.text,
            priority: 50,
            compressible: true,
            provenance: `memory:${context.memoryCount}catatan+${context.documentCount}dok`,
            metadata: {
                memoryCount: context.memoryCount,
                documentCount: context.documentCount
            }
        })];

    }
    catch {
        return [];   // memori mati → degradasi, bukan kegagalan
    }

}

/** Adapter keadaan batin — consciousness existing. */
function mindItem() {

    try {
        const mind = require("../../consciousness");
        const blok = mind.stateOfMind();
        if (!blok) return [];
        return [ContextItem.create({
            source: "mind",
            kind: ContextItem.KIND.MIND,
            content: blok,
            priority: 40,
            compressible: true
        })];
    }
    catch {
        return [];
    }

}

module.exports = {
    stableParts,
    doctrine,
    channelBlock,
    olderHistory,
    memoryItems,
    mindItem
};

