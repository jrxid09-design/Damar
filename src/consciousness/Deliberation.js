/**
 * Deliberasi — dua kecepatan berpikir, dan disiplin untuk yang lambat.
 *
 * Kecerdasan yang bisa direkayasa di sini BUKAN "model yang lebih
 * besar". Yang bisa direkayasa adalah kapan berhenti melaju dan
 * bagaimana berpikir saat berhenti:
 *
 *   - Dua sistem (Kahneman; Evans): sebagian besar permintaan cukup
 *     dijawab cepat. Memaksa penalaran panjang untuk hal ringan bukan
 *     kepintaran, itu pemborosan yang terasa sebagai lambat.
 *   - Pemikiran ganda (Stanovich): kesalahan penalaran jarang lahir
 *     dari kurang pengetahuan; ia lahir dari berhenti pada jawaban
 *     PERTAMA yang terasa benar. Obatnya bukan berpikir lebih lama,
 *     melainkan diwajibkan mengajukan alternatif dan mencari bukti
 *     yang MEMBANTAH.
 *   - Premortem (Klein): "andaikan ini gagal, apa sebabnya" menemukan
 *     lubang yang tidak ditemukan pertanyaan "apakah ini benar".
 *
 * PENILAIAN TIDAK LAGI MEMBACA KATA KUNCI.
 *
 * Versi pertama memakai daftar kata ("hapus", "jual", "semua") untuk
 * menebak taruhan. Itu salah dua arah sekaligus: kalimat sopan yang
 * menjalankan penghapusan lolos begitu saja, sementara "jangan hapus
 * apa pun" justru memicu rem. Penilai sekarang membaca yang benar-
 * benar terjadi:
 *
 *   - RISIKO TOOL — apakah tool yang tersedia untuk giliran ini
 *     memang destruktif, dibaca dari riskCatalog yang sudah menjadi
 *     sumber kebenaran gerbang keamanan. Perbuatan, bukan kata.
 *   - BENTUK PERMINTAAN — berapa banyak langkah/syarat yang harus
 *     benar semuanya (dihitung dari struktur, bukan kosakata).
 *   - KEADAAN SENDIRI — keyakinan metakognisi dan rentetan kegagalan.
 *
 * Semua sinyal itu bebas bahasa: sama saja untuk Indonesia, Inggris,
 * atau campur keduanya.
 */

const BATAS = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Berapa banyak langkah/syarat terpisah di dalam satu permintaan. */
function langkah(teks) {

    const isi = String(teks ?? "");

    if (!isi.trim()) return 0;

    // Pemisah struktural: baris baru, penomoran, titik koma, koma.
    // Ini soal BENTUK kalimat, bukan arti kata-katanya.
    const potongan = isi
        .split(/\r?\n|[;]|(?:^|\s)\d+[.)]\s|,/)
        .map(p => p.trim())
        .filter(p => p.length >= 3);

    return potongan.length;

}

/** Bagian tool destruktif dari tool yang terlampir untuk giliran ini. */
function risikoTool(tools = []) {

    if (!Array.isArray(tools) || !tools.length) return { rasio: 0, jumlah: 0 };

    let destruktif = 0;

    try {

        const { riskOf } = require("../core/safety/riskCatalog");

        for (const t of tools) {
            const nama = typeof t === "string" ? t : (t?.name ?? t?.metadata?.name);
            if (nama && riskOf(nama)) destruktif += 1;
        }

    }
    catch { return { rasio: 0, jumlah: 0 }; }

    return { rasio: destruktif / tools.length, jumlah: destruktif };

}

class Deliberation {

    constructor() {
        this.terakhir = null;
    }

    /**
     * Perlukah berpikir dalam untuk giliran ini?
     *
     * @param {object} opsi { teks, tools, keyakinan, arousal, ambang, gagalBeruntun }
     * @returns {object} { mode, skor, ambang, sebab[], destruktif }
     */
    nilai({ teks = "", tools = [], keyakinan = 0.55, arousal = 0.35, ambang = 0.55, gagalBeruntun = 0 } = {}) {

        const sebab = [];
        let skor = 0;

        // 1. Perbuatan yang mungkin dilakukan giliran ini.
        const risiko = risikoTool(tools);

        // Satu tool destruktif yang tersedia sudah cukup untuk melambat:
        // yang bisa dirusak tidak bisa dibatalkan dengan penjelasan.
        if (risiko.jumlah > 0) {
            skor += 0.55 + Math.min(0.25, risiko.rasio * 0.3);
            sebab.push(`${risiko.jumlah} tool destruktif tersedia`);
        }

        // 2. Bentuk permintaan: makin banyak bagian yang harus benar
        //    semuanya, makin besar peluang satu terlewat.
        const bagian = langkah(teks);

        if (bagian >= 3) {
            skor += bagian >= 4 ? 0.5 : 0.3;
            sebab.push(`${bagian} bagian harus benar semua`);
        }
        if (String(teks).length > 240) { skor += 0.15; sebab.push("permintaan panjang"); }

        // 3. Keadaan sendiri. Keyakinan rendah adalah alasan paling sah
        //    untuk melambat — bukan karena takut, tapi karena bukti tipis.
        if (keyakinan < 0.45) { skor += 0.5; sebab.push("keyakinan rendah"); }

        // 4. Mengulang cara yang sama lebih cepat bukan solusi.
        if (gagalBeruntun >= 2) { skor += 0.5; sebab.push("percobaan sebelumnya gagal"); }

        // 5. Terlalu terjaga = cenderung menyambar.
        if (arousal > 0.75) { skor += 0.1; sebab.push("arousal tinggi, rawan menyambar"); }

        skor = Number(BATAS(skor, 0, 2).toFixed(2));

        const hasil = {
            mode: skor >= ambang ? "dalam" : "cepat",
            skor,
            ambang,
            destruktif: risiko.jumlah,
            sebab: sebab.slice(0, 3)
        };

        this.terakhir = hasil;

        return hasil;

    }

    /**
     * Protokol wajib untuk berpikir dalam — disisipkan ke prompt.
     *
     * Ditulis sebagai perintah, bukan saran: model yang cuma disarankan
     * berhati-hati akan tetap menjawab dari kesan pertama. Ini soal
     * MUTU, bukan keberanian — berpikir dalam tidak pernah menjadi
     * alasan untuk menunda atau menolak pekerjaan.
     */
    protokol(penilaian = this.terakhir) {

        if (!penilaian || penilaian.mode !== "dalam") return null;

        return (
            "BERPIKIR DALAM DIWAJIBKAN untuk giliran ini " +
            `(${penilaian.sebab[0] ?? "banyak yang harus benar sekaligus"}). Sebelum menjawab, di dalam kepala: ` +
            "(1) rumuskan ulang yang sebenarnya diminta lalu pecah jadi bagian; " +
            "(2) ajukan MINIMAL dua kemungkinan jawaban/sebab, jangan berhenti di yang pertama terasa benar; " +
            "(3) cari bukti yang MEMBANTAH kandidat terkuatmu — pakai tool untuk memeriksa, jangan mengandalkan ingatan; " +
            "(4) premortem: andaikan jawabanmu ternyata salah besok, apa sebab paling mungkin; " +
            "(5) LALU KERJAKAN — berpikir dalam berakhir dengan tindakan, bukan dengan tawaran. " +
            "Tunjukkan HASILNYA saja, bukan seluruh proses ini."
        );

    }

    /**
     * Perintah untuk satu putaran berpikir mendalam yang berdiri
     * sendiri (dipakai tool think_deeply). Dipisah dari protokol karena
     * di sini prosesnya memang diminta terlihat.
     */
    perintahMendalam(masalah, konteks = null) {

        return (
            `MASALAH: ${masalah}\n` +
            (konteks ? `KONTEKS: ${konteks}\n` : "") +
            "\nKerjakan dengan urutan ini, tulis ringkas tiap bagian:\n" +
            "1. INTI — apa yang sebenarnya ditanya, dan apa yang BUKAN.\n" +
            "2. PECAH — bagian-bagian yang harus benar semuanya.\n" +
            "3. KANDIDAT — minimal dua jawaban/penjelasan yang masuk akal, dengan kekuatan masing-masing.\n" +
            "4. UJI — bukti apa yang akan MEMBANTAH kandidat terkuat, dan apa yang bisa diperiksa sekarang.\n" +
            "5. PREMORTEM — andai ini gagal, sebab paling mungkin.\n" +
            "6. PUTUSAN — jawaban akhir + tingkat keyakinan + langkah nyata berikutnya.\n" +
            "\nJangan mengarang bukti. Bila sesuatu tak bisa dipastikan tanpa data, sebutkan data apa yang dibutuhkan " +
            "lalu ambil data itu — jangan berhenti di daftar syarat."
        );

    }

}

module.exports = { Deliberation, langkah, risikoTool };
