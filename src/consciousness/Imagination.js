/**
 * Imagination — reaktivasi percept & simulasi internal (Haikonen).
 *
 * Haikonen: imajinasi adalah reaktivasi/composisi percept yang sudah
 * dipelajari TANPA stimulus eksternal. Ini dasar dari prediksi dan
 * antisipasi: sistem membayangkan "apa yang mungkin terjadi" lalu
 * menilainya sebelum bertindak (Aleksander: anticipation).
 *
 * Modul ini menyimpan "percept" (representasi internal dari pengalaman)
 * dan memungkinkan: menyimpan percept, mengaktifkan ulang (recall),
 * mengomposisi (gabung beberapa percept jadi skenario), dan menandai
 * hasil sebagai bayangan (simulated), bukan fakta.
 *
 * Yang TIDAK diklaim: "gambar mental" di sini adalah struktur data
 * yang bisa dikomposisi & diprediksi — bukan pengalaman visual subjektif.
 */

class Imagination {

    constructor({ kapasitas = 200 } = {}) {
        this.kapasitas = kapasitas;
        this.percept = new Map();   // nama → { nama, isi, at, kuat }
        this.skenario = [];         // hasil komposisi (bayangan)
        this.urutan = 0;
    }

    /**
     * Simpan sebuah percept (pengalaman terinternalisasi).
     * Penguatan Hebbian-lite: percept yang sama diaktifkan berulang
     * jadi lebih kuat (lebih mudah dipanggil).
     */
    simpan(nama, isi) {

        const kunci = String(nama ?? "").slice(0, 80);

        const ada = this.percept.get(kunci);

        if (ada) {
            ada.kuat = Math.min(ada.kuat + 1, 10);
            ada.isi = isi;
            ada.at = Date.now();
            return ada;
        }

        const item = { nama: kunci, isi, at: Date.now(), kuat: 1 };

        this.percept.set(kunci, item);

        if (this.percept.size > this.kapasitas) {
            // Buang yang paling lemah & tertua.
            const terlama = [...this.percept.entries()]
                .sort((a, b) => (a[1].kuat - b[1].kuat) || (a[1].at - b[1].at))[0];
            if (terlama) this.percept.delete(terlama[0]);
        }

        return item;

    }

    /** Aktifkan ulang percept (recall) tanpa stimulus eksternal. */
    ingat(nama) {

        const kunci = String(nama ?? "").slice(0, 80);

        const item = this.percept.get(kunci);

        if (item) {
            item.kuat = Math.min(item.kuat + 1, 10);
            item.at = Date.now();
        }

        return item ? { ...item } : null;

    }

    /**
     * Komposisi: gabungkan beberapa percept jadi satu skenario bayangan.
     * Ini ANTISIPASI — membayangkan konsekuensi sebelum bertindak.
     *
     * @returns {object} skenario { id, nama, dari, at }
     */
    bayangkan(namaSkenario, dariNama = []) {

        const skenario = {
            id: ++this.urutan,
            nama: String(namaSkenario ?? "").slice(0, 80),
            dari: (dariNama ?? []).map(n => String(n).slice(0, 80)),
            at: Date.now(),
            simulated: true // TANDA JUJUR: ini bayangan, bukan fakta.
        };

        this.skenario.unshift(skenario);
        this.skenario.length = Math.min(this.skenario.length, 50);

        return skenario;

    }

    /** Bayangan terbaru (skenario simulasi), yang jelas bertanda simulated. */
    bayangan(maks = 5) {
        return this.skenario.slice(0, maks).map(s => ({ ...s }));
    }

    /** Ringkasan untuk prompt: apa yang sedang "dibayangkan". */
    ringkas(maks = 2) {

        const s = this.skenario.slice(0, maks);

        if (!s.length) return null;

        return s.map(x => `[bayangan] ${x.nama}`).join("; ");

    }

}

module.exports = { Imagination };
