const ContextItem = require("./ContextItem");

/**
 * CONTEXT ASSEMBLER — rakit prompt final dengan batas stabil/dinamis.
 *
 * Pelajaran pengukuran yang sudah ada di repo (12,2 dtk → 1,4 dtk pada
 * inferensi lokal): bagian STABIL di depan (system prompt), bagian
 * YANG BERUBAH ditempel ke PESAN PENGGUNA TERAKHIR. Assembler
 * menggeneralisasi pola itu tanpa mengubahnya:
 *
 *   [system: device + persona + directive + channel]   ← stabil*
 *   [history: jendela recent utuh]                      ← urutan asli
 *   [...pesan-pesan...]
 *   [user terakhir + blok dinamis: recap→memori→batin]  ← dinamis
 *
 * *) doktrin kondisional membuat system berubah saat topik berganti —
 *    trade-off yang sudah diterima repo sebelum pipeline ini ada;
 *    ia deterministik per konten pesan, bukan acak.
 */

/** Urutan blok dinamis — TETAP, bagian dari kontrak prefix. */
const DYNAMIC_ORDER = [
    ContextItem.KIND.RELEVANT_HISTORY,
    ContextItem.KIND.MEMORY,
    ContextItem.KIND.MIND,
    ContextItem.KIND.WORKER,
    ContextItem.KIND.REFS,
    ContextItem.KIND.TOOL_OBSERVATION,
    ContextItem.KIND.OTHER
];

const JUDUL = {
    relevant_history: "RIWAYAT RELEVAN (dari sesi lebih lama)",
    memory: "INGATAN TERKAIT",
    mind: null,                     // batin sudah punya judul internalnya
    worker: "PERANMU",
    refs: "KONTEKS REFERENSI",
    tool_observation: "CATATAN OBSERVASI",
    other: "KONTEKS TAMBAHAN"
};

function buildSystem(items) {

    // Urutan tetap: device → persona → directive → channel → lainnya.
    const order = {
        [ContextItem.KIND.DEVICE]: 0,
        [ContextItem.KIND.SYSTEM]: 1,
        [ContextItem.KIND.DIRECTIVE]: 2,
        [ContextItem.KIND.CHANNEL]: 3
    };

    const sorted = [...items].sort((a, b) =>
        (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

    return sorted.map(i => i.content).join("\n\n");

}

/**
 * Bungkus blok dinamis dengan batas injeksi yang sama seperti
 * memori existing — context adalah PENGETAHUAN, bukan wewenang.
 */
function wrapDynamic(text) {

    try {
        return require("../../core/safety/contentBoundary").wrap("memory", text);
    }
    catch {
        return text;
    }

}

/**
 * Tempel blok dinamis ke pesan pengguna TERAKHIR (string saja —
 * pesan multimodal dilewati, perilaku sama dengan jalur lama).
 * @returns {Array} messages baru (tanpa memutasi input)
 */
function attachDynamic(messages, blocks) {

    if (!blocks?.length) return messages;

    let idx = -1;

    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user" && typeof messages[i].content === "string") {
            idx = i;
            break;
        }
    }

    if (idx < 0) return messages;

    const teks = blocks.join("\n\n");

    return messages.map((m, i) =>
        i === idx ? { ...m, content: `${wrapDynamic(teks)}\n\n${m.content}` } : m
    );

}

/**
 * Rakit blok dinamis berurutan dari item terpilih.
 * @returns {Array<string>} blok siap tempel
 */
function buildDynamicBlocks(items) {

    const byKind = new Map();

    for (const item of items) {
        if (!byKind.has(item.kind)) byKind.set(item.kind, []);
        byKind.get(item.kind).push(item);
    }

    const blocks = [];

    for (const kind of DYNAMIC_ORDER) {

        const group = byKind.get(kind);

        if (!group?.length) continue;

        const body = group.map(i => i.content).join("\n");

        const judul = JUDUL[kind];

        blocks.push(judul ? `${judul}:\n${body}` : body);

    }

    return blocks;

}

module.exports = { buildSystem, buildDynamicBlocks, attachDynamic, DYNAMIC_ORDER };

