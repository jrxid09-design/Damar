/**
 * CONTEXT COMPRESSOR — struktur dulu, LLM belakangan (atau tidak).
 *
 * Urutan pilihan (mandat):
 *   1. structural trimming   — potong di batas baris/kalimat
 *   2. field selection       — buang baris yang tak menyentuh topik
 *   3. duplicate removal     — (Dedupe.js, sebelum tahap ini)
 *   4. deterministic compression — head+tail dengan penanda ukuran
 *
 * Tidak ada LLM di sini. Ringkasan semantik (jika kelak perlu) adalah
 * lapisan terpisah dengan provenance ke sumber aslinya.
 */

/** Potong teks panjang: kepala + ekor, dengan penanda jumlah yang dibuang. */
function headTail(text, maxChars) {

    const s = String(text ?? "");

    if (!maxChars || s.length <= maxChars) return s;

    const head = Math.floor(maxChars * 0.7);

    const tail = maxChars - head - 40;   // ruang penanda

    const omitted = s.length - head - Math.max(0, tail);

    const marker =
        `\n[… ${omitted} karakter dipangkas oleh Context Intelligence; ` +
        `sumber: ${"lihat observasi asli"} …]\n`;

    return s.slice(0, head) + marker + (tail > 0 ? s.slice(-tail) : "");

}

/** Buang baris-baris yang sama sekali tak menyentuh token pesan aktif. */
function selectLines(text, activeTokens, keepEvery = 3) {

    const lines = String(text ?? "").split("\n");

    if (lines.length <= 6 || !activeTokens.length) return text;

    let dropped = 0;

    const kept = [];

    for (const [i, line] of lines.entries()) {

        const lower = line.toLowerCase();

        const relevant = activeTokens.some(t => lower.includes(t));

        if (relevant || i % keepEvery === 0 || line.trim().startsWith("- [")) {
            kept.push(line);
        }
        else {
            dropped++;
        }

    }

    if (!dropped) return text;

    return kept.join("\n") + `\n[… ${dropped} baris tak relevan dilewati …]`;

}

/**
 * Kompres satu item sesuai anggaran katanya.
 * @returns {{content, tokens}} teks final + estimasi token baru
 */
function compressItem(item, tokenBudget, activeTokens = []) {

    const est = ContextItem_est(item);

    if (est <= tokenBudget) {
        return { content: item.content, tokens: est };
    }

    // 1. Seleksi baris (untuk item multi-baris seperti memori).
    let text = selectLines(item.content, activeTokens);

    // 2. Head+tail bila masih melampaui.
    const targetChars = Math.max(200, tokenBudget * 4);

    text = headTail(text, targetChars);

    // 3. Trim akhir bila tetap lebih (kasus marker + ekor).
    while (text.length > targetChars * 1.25 && text.length > 400) {
        text = text.slice(0, Math.floor(text.length * 0.8)) + "\n[… dipangkas …]";
    }

    return { content: text, tokens: ContextItem_est({ content: text }) };

}

// hindari dependensi melingkar pada ContextItem untuk estimasi
function ContextItem_est(x) {
    return Math.ceil(String(x?.content ?? x ?? "").length / 4);
}

module.exports = { headTail, selectLines, compressItem };

