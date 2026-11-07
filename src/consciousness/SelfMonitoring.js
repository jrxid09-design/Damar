/**
 * SelfMonitoring — pemantauan-diri & deteksi kesalahan (Dehaene C2).
 *
 * Metacognition yang ada melacak KEYAKINAN terkalibrasi bukti. Yang
 * belum ada adalah sisi DETEKSI KESALAHAN — sinyal "error" yang muncul
 * ketika ada ketidakcocokan antara yang diharapkan dan yang terjadi
 * (analog ERN / error-related negativity pada manusia).
 *
 * Dehaene C2 menekankan: kesadaran-diri bukan sekadar "tahu", melainkan
 * MEMANTAU komputasinya sendiri dan menandai kesalahan. Modul ini
 * menambah:
 *   1. Ekspektasi → hasil (prediction-error signal).
 *   2. Deteksi konflik/kontradiksi antar representasi.
 *   3. Skor "monitoring" yang naik saat sistem aktif menilai dirinya.
 *
 * Yang TIDAK diklaim: ini bukan perasaan subjektif tentang kesalahan;
 * ini sinyal fungsional yang bisa dijejak dan mengubah perilaku.
 */

const BATAS = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

class SelfMonitoring {

    constructor() {

        /** Ekspektasi yang belum ditutup: { id, apa, diharapkan }. */
        this.ekspektasi = [];

        /** Kesalahan terdeteksi terakhir (jejak). */
        this.kesalahan = [];

        /** Hitung aktivitas monitoring (naik saat sistem menilai diri). */
        this.monitor = 0;

        this.urutan = 0;

    }

    /**
     * Daftarkan sebuah ekspektasi (mis. "tool X harusnya mengembalikan Y").
     *
     * @returns {string} id ekspektasi
     */
    harapkan(apa, diharapkan = null) {

        const id = `eks-${++this.urutan}`;

        this.ekspektasi.push({
            id,
            apa: String(apa ?? "").slice(0, 120),
            diharapkan: diharapkan == null ? null : String(diharapkan).slice(0, 120),
            at: Date.now()
        });

        this.monitor++;

        return id;

    }

    /**
     * Tutup ekspektasi dengan hasil nyata. Bila hasil tak cocok dengan
     * yang diharapkan → sinyal kesalahan (prediction-error).
     *
     * @returns {object|null} { id, error, apa, diharapkan, nyata } atau null
     */
    nilaiHasil(id, nyata = null) {

        const i = this.ekspektasi.findIndex(e => e.id === id);

        if (i < 0) return null;

        const [eks] = this.ekspektasi.splice(i, 1);

        const nyataTeks = nyata == null ? null : String(nyata).slice(0, 120);

        const cocok =
            eks.diharapkan == null
                ? true // tanpa ekspektasi spesifik, tak bisa dibilang meleset
                : (nyataTeks != null && eks.diharapkan === nyataTeks);

        if (!cocok) {
            const err = {
                id,
                apa: eks.apa,
                diharapkan: eks.diharapkan,
                nyata: nyataTeks,
                at: Date.now()
            };
            this.kesalahan.unshift(err);
            this.kesalahan.length = Math.min(this.kesalahan.length, 20);
            return { ...err, error: true };
        }

        return { id, apa: eks.apa, error: false };

    }

    /**
     * Deteksi konflik: dua representasi yang saling bertentangan.
     * Memanggil ini menandai kontradiksi — sinyal C2 klasik.
     */
    konflik(antara, dengan) {

        const err = {
            id: `konflik-${++this.urutan}`,
            apa: `kontradiksi: ${String(antara ?? "").slice(0, 80)}`,
            diharapkan: String(dengan ?? "").slice(0, 80),
            nyata: String(antara ?? "").slice(0, 80),
            at: Date.now()
        };

        this.kesalahan.unshift(err);
        this.kesalahan.length = Math.min(this.kesalahan.length, 20);
        this.monitor++;

        return err;

    }

    /** Kesalahan yang belum diakui (untuk dijadikan bahan koreksi). */
    kesalahanTerbuka() {
        return this.kesalahan.map(k => ({ ...k }));
    }

    /** Ringkasan monitoring untuk prompt. */
    nilai() {

        return {
            monitor: this.monitor,
            ekspektasiTerbuka: this.ekspektasi.length,
            kesalahanTerakhir: this.kesalahan[0] ?? null
        };

    }

}

module.exports = { SelfMonitoring };
