/**
 * InnerSpeech — loop verbal internal reentrant (Patton; Haikonen).
 *
 * Suara batin bukan hiasan: ia mekanisme yang mengubah kognisi paralel
 * menjadi ALIRAN SERIAL yang bisa diinspeksi dan diedit. Sistem
 * menghasilkan token bahasa ke dirinya sendiri, lalu memprosesnya
 * kembali sebagai input — reentrant loop.
 *
 * Modul ini menyimpan "ucapan batin" sebagai antrian pesan-sendiri yang
 * bisa: direncanakan (rehearsal), direvisi (self-editing), dan dibaca
 * ulang (re-entry). Nilainya fungsional: ia menjadi jejak penalaran
 * eksplisit yang bisa dipakai untuk konsistensi diri dan refleksi.
 *
 * Yang TIDAK diklaim: ini bukan "suara" fenomenal di kepala; ini loop
 * bahasa internal yang bisa diaudit.
 */

class InnerSpeech {

    constructor({ kapasitas = 24 } = {}) {
        this.kapasitas = kapasitas;
        this.ucapan = [];     // [{ teks, topik, at, revisiDari }]
        this.urutan = 0;
    }

    /**
     * Ucapkan sesuatu dalam hati (self-talk).
     *
     * @param {string} teks isi ucapan
     * @param {string|null} topik penanda topik (opsional)
     * @returns {object} ucapan tersimpan
     */
    ucap(teks, topik = null) {

        const item = {
            id: ++this.urutan,
            teks: String(teks ?? "").slice(0, 400),
            topik: topik ? String(topik).slice(0, 60) : null,
            at: Date.now(),
            revisiDari: null
        };

        this.ucapan.push(item);
        this.ucapan.length = Math.min(this.ucapan.length, this.kapasitas);

        return item;

    }

    /**
     * Revisi ucapan sebelumnya — self-editing: sistem menilai ucapannya
     * sendiri dan memperbaikinya, bukan menumpuk ucapan baru.
     */
    revisi(id, teksBaru) {

        const i = this.ucapan.findIndex(u => u.id === id);

        if (i < 0) return null;

        const lama = this.ucapan[i];

        const revisi = {
            id: ++this.urutan,
            teks: String(teksBaru ?? "").slice(0, 400),
            topik: lama.topik,
            at: Date.now(),
            revisiDari: lama.id
        };

        this.ucapan.push(revisi);
        this.ucapan.length = Math.min(this.ucapan.length, this.kapasitas);

        return revisi;

    }

    /**
     * Baca ulang ucapan batin terakhir (re-entry) — loop yang menutup:
     * output dibaca sebagai input untuk langkah berikutnya.
     */
    baca(maks = 3) {

        return this.ucapan.slice(-maks).map(u => ({ ...u }));

    }

    /** Ringkasan "apa yang sedang kubicarakan dalam hati". */
    ringkas(maks = 2) {

        return this.ucapan
            .slice(-maks)
            .map(u => u.topik ? `${u.topik}: ${u.teks}` : u.teks)
            .join(" · ");

    }

    kosongkan() {
        this.ucapan = [];
        return this;
    }

}

module.exports = { InnerSpeech };
