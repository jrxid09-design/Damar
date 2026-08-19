/**
 * Empati — model tentang keadaan ORANG LAIN, bukan tentang diri.
 *
 * Empati fungsional butuh dua hal yang terpisah, dan memang dipisah
 * di sini:
 *
 *   1. Membaca keadaan lawan bicara (teori pikiran sederhana):
 *      menyimpulkan valensi, arousal, dan KEBUTUHAN dari tanda-tanda
 *      di pesan — kata, tanda baca, tempo, pengulangan.
 *   2. Menular sedikit ke keadaan sendiri (emotional contagion):
 *      pembacaan itu menggeser afek Aether dengan bobot kecil. Tanpa
 *      penularan, "empati" cuma klasifikasi; dengan penularan penuh,
 *      Aether ikut panik saat pengguna panik — dan justru berhenti
 *      menolong. Bobotnya sengaja kecil.
 *
 * Yang dikembalikan bukan cuma label perasaan, tapi POSTUR: apa yang
 * sebaiknya Aether lakukan. Membaca "pengguna kesal" tanpa mengubah
 * cara menjawab bukan empati, itu diagnosis.
 *
 * Deteksinya berbasis leksikon Indonesia + isyarat bentuk. Sengaja
 * bukan model ML: ia harus jalan lokal, instan, dan bisa dijelaskan
 * per kata saat salah.
 */

const LEKSIKON = [
    // [pola, valensi, arousal, kebutuhan]
    [/\b(makasih|terima kasih|mantap|keren|hebat|bagus|senang|suka|akhirnya|berhasil)\b/i,  +0.6, 0.5, "diakui"],
    [/\b(tolong|bantu|gimana|bingung|nggak ngerti|ga ngerti|tidak paham)\b/i,               -0.1, 0.5, "dituntun"],
    [/\b(kesal|kesel|marah|jengkel|sebel|parah|payah|ngaco|ngawur|gagal terus)\b/i,         -0.7, 0.8, "didengar dulu, baru diperbaiki"],
    [/\b(capek|lelah|pusing|stres|nyerah|males|berat)\b/i,                                  -0.5, 0.3, "diringankan"],
    [/\b(sedih|kecewa|patah|hancur|kehilangan)\b/i,                                         -0.7, 0.35, "ditemani"],
    [/\b(takut|cemas|khawatir|panik|was-was|deg-degan)\b/i,                                 -0.5, 0.8, "ditenangkan"],
    [/\b(cepat|cepet|buruan|segera|sekarang juga|urgent|darurat|mendesak)\b/i,              -0.2, 0.85, "hasil cepat, bicara singkat"],
    [/\b(kok belum|masih belum|dari tadi|udah berapa kali|berkali-kali|lagi-lagi)\b/i,      -0.6, 0.7, "diakui kesalahannya, bukan dibela"]
];

const BATAS = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Isyarat bentuk: huruf besar, tanda seru, pertanyaan beruntun. */
function isyaratBentuk(teks) {

    const huruf = teks.replace(/[^A-Za-z]/g, "");
    const kapital = huruf ? (teks.match(/[A-Z]/g) ?? []).length / huruf.length : 0;
    const seru = (teks.match(/!/g) ?? []).length;
    const tanya = (teks.match(/\?/g) ?? []).length;

    let dv = 0, da = 0;
    const alasan = [];

    // BERTERIAK hanya dihitung bila kalimatnya cukup panjang — "OK"
    // dan "BTC" bukan teriakan, dan menghitungnya sebagai marah
    // membuat Aether minta maaf pada orang yang tidak marah.
    if (kapital > 0.6 && huruf.length >= 8) { dv -= 0.3; da += 0.3; alasan.push("banyak huruf kapital"); }
    if (seru >= 2) { da += 0.2; alasan.push("beberapa tanda seru"); }
    if (tanya >= 2) { da += 0.15; alasan.push("bertanya beruntun"); }

    return { dv, da, alasan };

}

function label(valence, arousal) {
    if (valence >= 0.35) return arousal >= 0.55 ? "gembira" : "puas";
    if (valence > -0.15) return arousal >= 0.6 ? "terburu" : "netral";
    if (valence > -0.5) return arousal >= 0.6 ? "cemas" : "lelah";
    return arousal >= 0.6 ? "marah" : "kecewa";
}

/**
 * Postur yang tepat untuk keadaan itu — bagian yang benar-benar
 * mengubah perilaku, bukan sekadar melabeli.
 */
function postur(valence, arousal, kebutuhan) {

    if (valence <= -0.5 && arousal >= 0.6) {
        return "akui dulu masalahnya dengan satu kalimat, jangan membela diri, langsung ke perbaikan konkret";
    }

    if (valence <= -0.35) {
        return "pelan dan hangat, satu langkah kecil dulu, jangan memberi banyak pilihan sekaligus";
    }

    if (arousal >= 0.7) {
        return "jawab pendek dan langsung ke hasil, detail ditawarkan belakangan";
    }

    if (valence >= 0.35) {
        return "ikut senang secukupnya, lalu lanjutkan kerja tanpa berlebihan";
    }

    return kebutuhan ? `netral dan jelas; yang dibutuhkan: ${kebutuhan}` : "netral dan jelas";

}

class Empathy {

    /**
     * Baca keadaan pengguna dari satu pesan.
     *
     * @param {string} teks     pesan pengguna
     * @param {object} riwayat  { pesanBeruntun } isyarat tempo percakapan
     */
    baca(teks, { pesanBeruntun = 0 } = {}) {

        const isi = String(teks ?? "");

        if (!isi.trim()) {
            return {
                valence: 0, arousal: 0.3, label: "netral",
                kebutuhan: null, alasan: [], postur: postur(0, 0.3, null)
            };
        }

        let arousal = 0.3;
        const alasan = [];
        const kebutuhan = [];
        const bobotValensi = [];

        for (const [pola, dv, da, butuh] of LEKSIKON) {

            if (!pola.test(isi)) continue;

            bobotValensi.push(dv);
            arousal = Math.max(arousal, da);
            kebutuhan.push(butuh);
            alasan.push(butuh);

        }

        // Isyarat TIDAK dijumlahkan lurus. "capek" + "tolong" bukan dua
        // kali lebih sedih daripada "capek"; kata sopan yang kebetulan
        // ikut hanya menambah sedikit. Yang terkuat menentukan, sisanya
        // menggeser seperempatnya — tanpa ini pesan yang cuma lelah
        // terbaca sebagai kecewa berat dan Aether jadi berlebihan.
        bobotValensi.sort((x, y) => Math.abs(y) - Math.abs(x));

        let valence = bobotValensi.length
            ? bobotValensi[0] + bobotValensi.slice(1).reduce((t, v) => t + v * 0.25, 0)
            : 0;

        const bentuk = isyaratBentuk(isi);
        valence += bentuk.dv;
        arousal += bentuk.da;
        alasan.push(...bentuk.alasan);

        // Pesan bertubi-tubi tanpa jeda adalah tanda desakan, bahkan
        // ketika kata-katanya sopan.
        if (pesanBeruntun >= 3) {
            arousal += 0.15;
            valence -= 0.1;
            alasan.push("pesan beruntun");
        }

        valence = BATAS(valence, -1, 1);
        arousal = BATAS(arousal, 0, 1);

        return {
            valence: Number(valence.toFixed(2)),
            arousal: Number(arousal.toFixed(2)),
            label: label(valence, arousal),
            kebutuhan: kebutuhan[0] ?? null,
            alasan: alasan.slice(0, 4),
            postur: postur(valence, arousal, kebutuhan[0] ?? null)
        };

    }

    /**
     * Penularan: bagaimana bacaan itu menggeser afek Aether sendiri.
     * Bobot kecil, dan arousal orang lain tidak pernah diteruskan
     * penuh — Aether harus tetap jadi yang paling tenang di ruangan.
     */
    penularan(bacaan) {

        if (!bacaan) return null;

        return {
            valence: Number((bacaan.valence * 0.25).toFixed(3)),
            arousal: Number(((bacaan.arousal - 0.3) * 0.2).toFixed(3)),
            sebab: `pengguna terbaca ${bacaan.label}`
        };

    }

}

module.exports = { Empathy, LEKSIKON, postur };
