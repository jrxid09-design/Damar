const engine = require("./core/MemoryEngine");

/**
 * buildMemory — ingatan Aether tentang dirinya sendiri.
 *
 * `bugMemory` sudah menyimpan pengalaman memperbaiki bug. Yang belum
 * ada adalah ingatan tentang **bagaimana Aether dibangun dan
 * dikonfigurasi**: keputusan arsitektur, alasan di baliknya, dan cara
 * membuktikannya benar. Tanpa itu Aether tidak bisa menjawab
 * "kenapa kamu begini?" dan tidak punya pijakan untuk memulihkan
 * dirinya sendiri — ia hanya tahu keadaan sekarang, bukan sebabnya.
 *
 * Yang disimpan di sini adalah PENGETAHUAN, bukan peristiwa.
 * Peristiwa mentah (setiap panggilan tool) sudah punya tempatnya di
 * `core/safety/auditTrail`; memasukkannya ke memori semantik hanya
 * akan menenggelamkan recall sampai pengetahuan yang berguna tak
 * lagi bisa ditemukan.
 *
 * Bagian paling berharga adalah `why`. Perubahan berkas bisa dibaca
 * ulang dari git kapan saja; alasan sebuah keputusan diambil hanya
 * ada saat keputusan itu dibuat, dan hilang selamanya bila tidak
 * ditulis.
 *
 * Memakai jalur yang sama dengan bugMemory (MemoryEngine, tipe
 * "skills" = milik Aether Core, bukan proposal), supaya tidak ada
 * dua sistem memori yang harus dijaga selaras.
 */

const KIND = "build";

class BuildMemory {

    /**
     * Simpan satu keputusan atau perubahan rekayasa.
     *
     * @param {object} entry
     * @param {string} entry.area          bagian Aether, mis. "keselamatan"
     * @param {string} entry.change        apa yang berubah
     * @param {string} entry.why           mengapa — bagian yang tak bisa dibaca dari git
     * @param {string[]} [entry.files]     berkas utama yang tersentuh
     * @param {string} [entry.verification] bagaimana dibuktikan benar
     * @param {string} [entry.risks]        yang masih tersisa
     */
    async record({ area, change, why, files = [], verification, risks } = {}) {

        if (!change || !why) {
            return { ok: false, note: "`change` dan `why` wajib — catatan tanpa alasan tidak berguna saat dibaca ulang" };
        }

        const daftar = Array.isArray(files) ? files.filter(Boolean) : [];

        const content = [
            area && `Area: ${area}`,
            `Perubahan: ${change}`,
            `Alasan: ${why}`,
            daftar.length && `Berkas: ${daftar.join(", ")}`,
            verification && `Dibuktikan: ${verification}`,
            risks && `Risiko tersisa: ${risks}`
        ].filter(Boolean).join("\n");

        const res = await engine.remember(
            content,
            {
                type: "skills",
                entities: daftar,
                metadata: {
                    kind: KIND,
                    area: area || null,
                    files: daftar
                }
            },
            engine.context({ writer: "build-journal" })
        );

        return { ok: true, id: res?.id ?? res?.memoryId ?? null };

    }

    /**
     * Ingat bagaimana sesuatu dibangun.
     *
     * TIDAK mengklaim kecocokan. Pencarian semantik selalu
     * mengembalikan sesuatu: kueri omong kosong pun memperoleh
     * catatan berskor tinggi bila kebetulan mengandung kata umum.
     * Ambang apa pun tidak dapat memisahkannya dengan andal, jadi
     * yang dilakukan di sini adalah membuang derau yang jelas lalu
     * MELAPORKAN seberapa kuat kecocokannya — biar model dan pemilik
     * yang menilai, bukan angka yang berpura-pura pasti.
     */
    async recall(topic, { limit = 5 } = {}) {

        const r = await engine.recall(topic, { limit: limit * 3 });

        const items = Array.isArray(r) ? r : (r?.items || r?.results || []);

        const hits = items.filter(it => it.metadata?.kind === KIND);

        return {
            ok: true,
            count: hits.length,
            confidence: confidenceOf(hits[0]),
            note: hits.length
                ? "Catatan berikut MUNGKIN relevan — BACA isinya dan pastikan benar-benar menjawab yang ditanyakan. " +
                  "Pencarian memori tidak menjamin kecocokan; bila tidak ada yang nyambung, katakan tidak tahu."
                : "Tidak ada catatan rekayasa. Katakan tidak tahu, jangan menebak.",
            notes: hits.slice(0, limit).map(ringkas)
        };

    }

}

/**
 * TIDAK ada penyaringan relevansi. Ini disengaja, setelah dua
 * percobaan gagal:
 *
 *   1. Ambang skor total 1,7 — diambil dari korpus yang sudah
 *      terisi. Gagal pada pemasangan baru: skor total memuat
 *      komponen yang bergeser mengikuti isi korpus, sehingga
 *      kecocokan yang SAH pun jatuh di bawah ambang.
 *   2. Syarat keywordScore > 0 — gagal juga, dan sebaliknya:
 *      pencarian kata memakai BM25, dan istilah yang muncul di
 *      semua dokumen ber-IDF nol. Di basis data berisi satu
 *      catatan, kecocokan teks yang PERSIS memberi keywordScore
 *      tepat 0,000.
 *
 * Skor vektor pun tumpang tindih: catatan relevan terukur 0,506–
 * 0,807 sementara kueri omong kosong mencapai 0,548. Tidak ada satu
 * angka yang memisahkan keduanya di tumpukan ini.
 *
 * Maka yang dilakukan adalah melaporkan apa adanya: seluruh catatan
 * bertanda `build` dikembalikan bersama skornya dan peringatan
 * eksplisit untuk memeriksa isinya. Menyaring dengan ambang yang
 * tidak dapat dipertanggungjawabkan hanya memindahkan kesalahan ke
 * tempat yang lebih sulit dilihat.
 */

/** Perkiraan kasar, dan disebut demikian — bukan jaminan. */
function confidenceOf(teratas) {

    if (!teratas) return "tidak ada";

    const kw = teratas.keywordScore ?? 0;
    const vec = teratas.vectorScore ?? 0;

    if (kw >= 0.6 || vec >= 0.75) return "kuat";
    if (kw >= 0.3 || vec >= 0.6) return "sedang";

    return "lemah";

}

/**
 * Dinilai dari kecocokan KATA, bukan skor gabungan.
 *
 * Skor gabungan memuat komponen vektor yang bergeser seiring isi
 * korpus, sehingga ambang absolut apa pun akan salah membaca
 * memori yang masih sedikit — kecocokan langsung pun terbaca
 * "lemah" pada pemasangan baru.
 */

/** Bentuk ringkas untuk model — isi penuh, skor ikut agar dapat dinilai. */
function ringkas(item) {
    return {
        id: item.id,
        area: item.metadata?.area ?? null,
        content: item.content,
        files: item.metadata?.files ?? [],
        score: Number((item.score ?? 0).toFixed(2)),
        kata: Number((item.keywordScore ?? 0).toFixed(2)),
        makna: Number((item.vectorScore ?? 0).toFixed(2)),
        at: item.occurredAt ?? item.createdAt ?? null
    };
}

module.exports = new BuildMemory();
module.exports.KIND = KIND;
