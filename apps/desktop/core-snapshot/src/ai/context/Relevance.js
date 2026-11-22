const ContextItem = require("./ContextItem");

/**
 * CONTEXT RELEVANCE — penilai relevansi deterministik.
 *
 * Tanpa LLM: kecocokan leksikal/entity terhadap pesan aktif,
 * penguat referensi eksplisit ("kemarin", "yang tadi", nama proyek),
 * dan penyusut kedaluwarsa berbucket. Skor integer-ish; seri diputus
 * urutan asli (stabil).
 *
 * Mandatory TIDAK dinilai — ia selalu lolos pagar anggaran.
 */

/** Referensi eksplisit yang menandai context lama DIBUTUHKAN. */
const REFERENCE_MARKERS = [
    "kemarin", "semalam", "minggu lalu", "yang tadi", "tadi pagi",
    "sebelumnya", "lanjutkan", "lanjutin", "seperti dulu", "proyek",
    "project", "yang lalu", "waktu itu", "yang kita bahas"
];

/** Penyusut per jarak pesan (bucket) — deterministik, tanpa Date.now. */
const RECENCY_DECAY = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

function tokenize(text) {
    return String(text ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length >= 4);
}

/**
 * @param {ContextItem} item
 * @param {object} input
 *   activeText   pesan pengguna terakhir
 *   historyIndex jarak pesan dari ujung (0 = terbaru) untuk RELEVANT_HISTORY
 */
function score(item, { activeText = "", historyIndex = -1 } = {}) {

    if (item.mandatory) return Number.MAX_SAFE_INTEGER;

    const text = String(activeText ?? "").toLowerCase();

    let value = 0;

    // 1. Kecocokan leksikal token ≥4 huruf.
    const tokens = new Set(tokenize(item.content));
    let hits = 0;

    for (const t of tokenize(text)) {
        if (tokens.has(t)) hits++;
    }

    value += Math.min(hits, 6) * 3;

    // 2. Token panjang dari pesan yang muncul UTUH di context.
    for (const w of tokenize(text).filter(w => w.length >= 6)) {
        if (item.content.toLowerCase().includes(w)) value += 2;
    }

    // 3. Referensi eksplisit menaikkan history/memory lama.
    if (item.kind === ContextItem.KIND.RELEVANT_HISTORY ||
        item.kind === ContextItem.KIND.MEMORY) {

        for (const marker of REFERENCE_MARKERS) {
            if (text.includes(marker)) {
                value += 6;
                break;
            }
        }

    }

    // 4. Recency bucket — hanya untuk kandidat history.
    if (item.kind === ContextItem.KIND.RELEVANT_HISTORY && historyIndex >= 0) {
        value *= RECENCY_DECAY[Math.min(historyIndex, RECENCY_DECAY.length - 1)];
    }

    // 5. Prioritas sumber sebagai pengikat (bukan penentu utama).
    value += item.priority / 100;

    return Math.round(value * 100) / 100;

}

/**
 * Beri skor seluruh kandidat non-mandatory, urutkan stabil.
 *
 * `exemptKinds`: jenis yang TIDAK boleh dibuang ambang ini — ia
 * sudah lolos alasan pemilihan di sumbernya (retrieval memori,
 * referensi eksplisit, keadaan batin). Ranking tetap mengurutkan;
 * anggaran yang membatasi.
 */
function rank(items, input = {}) {

    const AMBANG = input.threshold ?? 3;

    const exempt = new Set(input.exemptKinds ?? [
        ContextItem.KIND.MEMORY,
        ContextItem.KIND.REFS,
        ContextItem.KIND.MIND
    ]);

    const scored = items.map((item, index) => ({

        item,

        index,

        score: item.mandatory
            ? Number.MAX_SAFE_INTEGER
            : score(item, { ...input, historyIndex: input.historyIndices?.get(item.id) ?? -1 })

    }));

    return scored

        .map(s => ({ ...s, item: { ...s.item, relevance: s.score === Number.MAX_SAFE_INTEGER ? 999 : s.score } }))

        .sort((a, b) =>
            b.score - a.score ||
            a.index - b.index)

        .filter(s => s.item.mandatory || exempt.has(s.item.kind) || s.score > AMBANG);

}

module.exports = { rank, score, REFERENCE_MARKERS };

