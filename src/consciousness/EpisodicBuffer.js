/**
 * EpisodicBuffer — buffer temporal + serial bottleneck (Dehaene/GWT).
 *
 * GlobalWorkspace menahan 7 slot; tetapi kesadaran juga SERIAL: hanya
 * satu isi yang bisa "berada di tengah panggung" dalam satu waktu,
 * dan isi itu ditahan sebentar (ratusan ms) sebelum digantikan isi
 * berikutnya. Inilah bottleneck serial — ciri khas akses sadar.
 *
 * Modul ini memodelkan dua hal:
 *   1. Buffer kapasitas-kecil yang menahan isi paling menonjol.
 *   2. Bottleneck serial — isi diproses SATU PER SATU, dan jejak urutan
 *      (apa yang masuk panggung lebih dulu) tercatat sebagai "aliran".
 *
 * Yang TIDAK diklaim: urutan ini bukan "aliran kesadaran" fenomenal;
 * ini antrian akses yang bisa diaudit — berguna untuk tahu apa yang
 * diperhatikan sistem, dalam urutan apa.
 */

const BATAS = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Kapasitas buffer — kecil, meniru bottleneck (bukan 7 slot workspace,
// melainkan 1 fokus + sedikit konteks).
const KAPASITAS = 3;

class EpisodicBuffer {

    constructor({ kapasitas = KAPASITAS } = {}) {
        this.kapasitas = kapasitas;
        this.buffer = [];
        this.aliran = [];     // jejak urutan akses
    }

    /**
     * Masukkan satu isi ke panggung serial.
     *
     * @param {object} isi { ringkas, salience }
     * @returns {object} isi yang kini memegang fokus
     */
    dorong(isi) {

        const item = {
            ringkas: String(isi?.ringkas ?? isi?.type ?? "").slice(0, 80),
            salience: Number(isi?.salience ?? 0),
            at: Date.now()
        };

        // Fokus = item terbaru yang paling menonjol. Bottleneck serial:
        // yang lain antre di belakang.
        this.buffer.unshift(item);
        this.buffer.length = Math.min(this.buffer.length, this.kapasitas);

        this.aliran.push({ ...item });
        this.aliran.length = Math.min(this.aliran.length, 200);

        return item;

    }

    /** Isi fokus sekarang (paling depan). */
    fokus() {
        return this.buffer[0] ?? null;
    }

    /** Seluruh isi buffer, fokus dulu. */
    isi() {
        return this.buffer.map(b => ({ ...b }));
    }

    /** Jejak urutan akses terakhir (serial trace). */
    jejak(maks = 10) {
        return this.aliran.slice(-maks).reverse();
    }

    kosongkan() {
        this.buffer = [];
        this.aliran = [];
        return this;
    }

}

module.exports = { EpisodicBuffer, KAPASITAS };
