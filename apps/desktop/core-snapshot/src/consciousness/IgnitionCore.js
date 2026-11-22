/**
 * IgnitionCore — transisi "menyala" nonlinier (Dehaene C1).
 *
 * GlobalWorkspace yang ada sudah menyaring dengan ambang salience,
 * tetapi pemilihan itu LINIER: setiap kejadian dinilai sendiri-sendiri.
 * Dehaene menekankan bahwa akses sadar bersifat ALL-OR-NONE: aktivitas
 * di bawah ambang tetap lokal (subliminal), dan begitu melewati ambang
 * ia "menyala" (ignite) lalu menyebar luas, bertahan (reverberation),
 * dan memicu "P3" — penanda late-latency akses sadar.
 *
 * Modul ini MENAMBAH tiga hal di atas GlobalWorkspace:
 *   1. Amplifikasi nonlinier — penguatan di atas ambang, bukan linear.
 *   2. Latency / sustained marker — isi yang menyala diberi "usia" dan
 *      dinyatakan tetap aktif selama denyut reverberation (metastabil).
 *   3. Ignition trace — catatan menyala, sehingga "apa yang menyala
 *      barusan" bisa dibedakan dari "apa yang masih bergema".
 *
 * Yang TIDAK diklaim: "menyala" bukan pengalaman subjektif. Ini model
 * akses-kesadaran fungsional (broadcasting global), persis yang
 * dipakai Dehaene dkk. untuk menilai arsitektur mesin.
 */

const BATAS = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Waktu gema (reverberation) sebuah isi yang sudah menyala, dalam ms.
// Di bawah ini aktivitas "bertahan"; lewat ini ia meluruh menjadi
// tak-aktif (paralel aktivitas metastabil di korteks).
const GEMA_MS = 3000;

class IgnitionCore {

    constructor({ ambang = 0.5, penguatan = 1.6, gema = GEMA_MS } = {}) {

        this.ambang = ambang;
        this.penguatan = penguatan;
        this.gema = gema;

        /** Isi yang sedang menyala/bergema: { ringkas, salience, at }. */
        this.aktif = [];

        /** Jejak nyala terakhir (untuk laporan & introspeksi). */
        this.jejak = [];

    }

    /**
     * Uji sebuah kandidat: apakah ia "menyala"?
     *
     * @param {number} salience skor salience kandidat (0..1)
     * @returns {object} { ignited, amplified, latency }
     *   ignited = true bila melewati ambang (all-or-none)
     *   amplified = salience setelah penguatan nonlinier
     */
    uji(salience) {

        const s = Number(salience);

        if (!(s >= this.ambang)) {
            return { ignited: false, amplified: s, latency: null };
        }

        // Amplifikasi nonlinier: di atas ambang, penguatan melonjak
        // (mendekati 1) — meniru ledakan aktivitas global saat ignite.
        const amplified = BATAS(s * this.penguatan, 0, 1);

        return { ignited: true, amplified: Number(amplified.toFixed(2)), latency: Date.now() };

    }

    /**
     * Nyalakan sebuah isi (bila lolos ambang) dan pertahankan gemanya.
     *
     * @returns {object|null} isi yang menyala, atau null
     */
    nyalakan({ type, payload = {}, salience = 0 }) {

        const hasil = this.uji(salience);

        if (!hasil.ignited) return null;

        const isi = {
            type: String(type ?? "tak-bernama"),
            ringkas: String(payload?.ringkas ?? payload?.message ?? type ?? "").slice(0, 80),
            salience: hasil.amplified,
            at: hasil.latency
        };

        // Peristiwa sejenis menggema-menguatkan yang sudah aktif.
        const sama = this.aktif.find(a => a.type === isi.type && a.ringkas === isi.ringkas);

        if (sama) {
            sama.salience = BATAS(sama.salience + 0.05, 0, 1);
            sama.at = hasil.latency;
        }
        else {
            this.aktif.push(isi);
        }

        this.jejak.unshift({ ...isi, ignitedAt: hasil.latency });
        this.jejak.length = Math.min(this.jejak.length, 50);

        // Buang yang sudah lewat masa gema.
        this.luruh(hasil.latency);

        return isi;

    }

    /** Buang isi aktif yang sudah melewati masa gema. */
    luruh(sekarang = Date.now()) {

        this.aktif = this.aktif.filter(a => (sekarang - a.at) < this.gema);

        return this.aktif;

    }

    /** Isi yang sedang menyala/bergema sekarang. */
    isiAktif() {
        this.luruh();
        return this.aktif.map(a => ({ ...a }));
    }

    /** Apa yang menyala paling baru (untuk "P3"-analog, late marker). */
    terakhir() {
        return this.jejak[0] ?? null;
    }

    /** Ringkasan untuk prompt. */
    ringkasan(maks = 2) {

        const isi = this.isiAktif();

        if (!isi.length) return null;

        return isi
            .slice(0, maks)
            .map(a => a.ringkas)
            .join("; ");

    }

}

module.exports = { IgnitionCore, GEMA_MS };
