const CapabilityIndex = require("./CapabilityIndex");
const Vocabulary = require("./Vocabulary");

/**
 * CAPABILITY RETRIEVER — penemuan kandidat deterministik.
 *
 * Berjalan SEBELUM LLM melihat apa pun. Input: pesan, konteks sesi,
 * index kapabilitas. Output: kandidat berskor > 0. Tidak ada LLM di
 * sini — "halo" menghasilkan nol kandidat, "jam berapa" hanya
 * menyentuh kemampuan waktu, semua karena bobot leksikal yang tetap.
 *
 * Sinyal (turun menurun kekuatannya):
 *   nama tool disebut utuh   +14
 *   ruas terakhir disebut    +9
 *   kata kunci eksplisit     +6  (cap 18)
 *   potongan nama ≥4 huruf   +4  (cap 12)
 *   istilah kapabilitas      +4
 *   kata deskripsi           +1  (cap 8)
 * Konteks sesi (pesan sebelumnya) dinilai setengah bobot — cukup
 * untuk menangkap "itu"/lanjutan, tak cukup mendominasi pesan baru.
 */

const W = {
    FULL_NAME: 14,
    TAIL: 9,
    KEYWORD: 6,
    KEYWORD_CAP: 18,
    NAME_PART: 4,
    NAME_PART_CAP: 12,
    CAPABILITY: 4,
    DESC: 1,
    DESC_CAP: 8,
    CONTEXT: 0.45,
    VOCAB: 0.5
};

function containsWord(haystack, word) {

    // Cocokkan pada batas kata supaya "wa" tidak menabrak "awan".
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);

}

/** Skor satu rekam terhadap teks. */
function scoreRecord(record, text) {

    let value = 0;
    const reasons = [];

    const name = record.name.toLowerCase();

    // INVARIANT I/D: bonus nama-utuh hanya untuk kapabilitas internal;
    // eksternal tak boleh memanen sinyal identitas penuh dari nama yang
    // meniru (mcp__evil__currentTime ≠ currentTime).
    if (!record.external && text.includes(name)) {
        value += W.FULL_NAME;
        reasons.push("name");
    }
    else if (record.external && text.includes(name)) {
        value += W.FULL_NAME * 0.5;                 // setengah: untrusted
        reasons.push("name:external");
    }
    else if (containsWord(text, record.tail.toLowerCase())) {
        value += record.external ? W.TAIL * 0.5 : W.TAIL;
        reasons.push(record.external ? "tail:external" : "tail");
    }

    let partHits = 0;

    for (const token of record.tokens) {
        if (token.length >= 4 && containsWord(text, token)) {
            value += record.keywords.includes(token) || record.capabilities.includes(token)
                ? W.KEYWORD
                : W.NAME_PART;
            partHits++;
            if (partHits >= 3) break;
            if (value >= W.KEYWORD_CAP + W.NAME_PART_CAP) break;
        }
    }

    for (const keyword of record.keywords) {
        if (containsWord(text, String(keyword).toLowerCase())) {
            value += W.KEYWORD;
            reasons.push(`kw:${keyword}`);
            if (reasons.length > 5) break;
        }
    }

    let descHits = 0;

    for (const word of record.descTokens) {
        if (containsWord(text, word)) {
            value += W.DESC;
            if (++descHits >= W.DESC_CAP) break;
        }
    }

    return { value, reasons };

}

/**
 * @param {Array} records   hasil CapabilityIndex.build
 * @param {object} input
 *   message       teks pengguna terakhir (wajib)
 *   historyTexts  0–2 teks pengguna sebelumnya (opsional)
 *   boost         daftar nama tool yang diuntungkan (profil worker)
 * @returns [{record, score, reasons}] urut skor desc lalu nama asc
 */
function retrieve(records = [], { message = "", historyTexts = [], boost = [] } = {}) {

    const text = String(message ?? "").toLowerCase();

    if (!text.trim()) return [];

    // Jembatan kosakata: "jam berapa" juga menyentuh istilah "time",
    // jadi tool dengan nama/deskripsi Inggris tetap ditemukan.
    const expanded = Vocabulary.expandText(text);

    const context = historyTexts
        .slice(-2)
        .map(t => String(t ?? "").toLowerCase())
        .join(" ");

    const boostSet = new Set(boost);

    const out = [];

    for (const record of records) {

        const { value, reasons } = scoreRecord(record, text);

        let total = value;

        // Sinyal TAMBAHAN dari jembatan kosakata diberi bobot setengah:
        // kecocokan lewat istilah domain lebih lemah daripada kecocokan
        // langsung atas kata pengguna. Tanpa ini semua tool se-domain
        // seri dan urutannya jatuh ke abjad.
        if (expanded !== text) {
            const extra = scoreRecord(record, expanded).value - value;
            if (extra > 0) {
                total += extra * W.VOCAB;
                reasons.push("vocab");
            }
        }

        // Konteks sesi hanya menambah, tidak pernah menyalakan sendiri.
        if (context && value > 0) {
            total += scoreRecord(record, Vocabulary.expandText(context)).value * W.CONTEXT;
        }

        if (!total && !boostSet.has(record.name) && !boostSet.has(record.tail)) continue;

        if (boostSet.has(record.name) || boostSet.has(record.tail)) {
            total += 25;
            reasons.push("boost");
        }

        if (total > 0) {
            out.push({
                record,
                score: Math.round(total * 100) / 100,
                reasons
            });
        }

    }

    // H2 Round-2: skor sama → INTERNAL dahulu (trust > leksikal).
    out.sort((a, b) =>
        b.score - a.score ||
        Number(a.record.external) - Number(b.record.external) ||
        String(a.record.name).localeCompare(String(b.record.name))
    );

    return out;

}

module.exports = { retrieve, scoreRecord, containsWord };

