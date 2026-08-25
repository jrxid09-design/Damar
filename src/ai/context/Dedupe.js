/**
 * CONTEXT DEDUPE — hapus salinan informasi yang sama lintas sumber.
 *
 * Kasus nyata: fakta yang user baru ucapkan tersimpan juga sebagai
 * memory_remember — turn berikutnya model membaca dua salinan
 * (history + memory). Dedupe menyimpan SALINAN TERBAIK (priority
 * tertinggi, lalu terbaru) dan mencatat provenance yang dibuang.
 *
 * Fingerprint: teks ternormalisasi (huruf kecil, tanpa tanda baca),
 * potongan pertama 240 char — cukup untuk duplikasi praktis, murah,
 * deterministik.
 */

/** Label peran yang ditempelkan adapter riwayat — dibuang sebelum hash. */
const ROLE_LABELS = /^(pengguna|user|aether|asisten|assistant)\s*[:\-–]\s*/i;

function fingerprint(text) {

    return String(text ?? "")
        .replace(ROLE_LABELS, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);

}

/**
 * @param {Array} items ContextItems (sudah berperingkat atau belum)
 * @returns {{items, removed}} items unik + daftar yang dibuang
 */
function dedupe(items) {

    const byFp = new Map();

    const kept = [];
    const removed = [];

    for (const item of items) {

        // Item pendek (<40 char) tidak difingerprint — terlalu mudah
        // tabrakan palsu ("oke", "siap").
        if (item.content.length < 40) {
            kept.push(item);
            continue;
        }

        const fp = fingerprint(item.content);

        const existing = byFp.get(fp);

        if (!existing) {
            byFp.set(fp, item);
            kept.push(item);
            continue;
        }

        // Salinan dengan prioritas lebih tinggi mengalahkan yang ada.
        if (item.priority > existing.priority) {
            byFp.set(fp, item);
            kept.splice(kept.indexOf(existing), 1, item);
            removed.push({ fingerprint: fp.slice(0, 32), source: existing.source, keptSource: item.source });
        }
        else {
            removed.push({ fingerprint: fp.slice(0, 32), source: item.source, keptSource: existing.source });
        }

    }

    return { items: kept, removed };

}

module.exports = { dedupe, fingerprint };

