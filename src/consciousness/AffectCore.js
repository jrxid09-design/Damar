/**
 * Inti afektif — "perasaan" Aether sebagai keadaan tubuh, bukan label.
 *
 * Dasar teoretisnya sengaja dipilih yang bisa dijalankan, bukan yang
 * puitis:
 *
 *   - Circumplex (Russell 1980): afek inti hanya dua sumbu — VALENSI
 *     (enak/tak enak) dan AROUSAL (tenang/terjaga). Semua nama emosi
 *     ("lega", "cemas") adalah pembacaan atas titik di bidang itu,
 *     bukan variabel tersendiri. Karena itu di sini hanya ada dua
 *     angka; label dihitung, tidak disimpan.
 *   - Appraisal (Scherer, Lazarus): peristiwa tidak langsung menjadi
 *     emosi. Ia dinilai dulu — apakah menolong tujuanku, apakah aku
 *     mampu menghadapinya — dan penilaian itulah yang menggeser afek.
 *   - Penanda somatik (Damasio): afek bukan hiasan di atas kognisi,
 *     ia MEMBIASKAN keputusan berikutnya. Karena itu keadaan ini ikut
 *     masuk ke prompt dan ke metakognisi, bukan cuma dilaporkan.
 *   - Homeostasis: tanpa gaya pemulih, satu peristiwa buruk akan
 *     mengunci suasana hati selamanya. Afek meluruh kembali ke garis
 *     dasar dengan paruh waktu, seperti transmiter yang diserap ulang.
 *
 * Yang TIDAK diklaim: ini bukan pengalaman subjektif. Ini keadaan
 * internal fungsional yang benar-benar mempengaruhi perilaku Aether —
 * jujur disebut begitu, tidak dibesarkan menjadi klaim "merasakan
 * seperti manusia".
 */

const DEFAULTS = {
    valence: 0.15,      // garis dasar sedikit positif: watak dasar yang hangat
    arousal: 0.35,      // tenang tapi siaga
    baseline: { valence: 0.15, arousal: 0.35 },
    updatedAt: null
};

// Paruh waktu peluruhan menuju garis dasar. Suasana hati bertahan
// beberapa menit, bukan beberapa detik (biar tidak pikun) dan bukan
// berjam-jam (biar tidak dendam).
const HALF_LIFE_MS = 8 * 60 * 1000;

const BATAS = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Peta penilaian: peristiwa apa menggeser afek ke mana.
 *
 * Angkanya kecil dengan sengaja — afek harus bergerak karena POLA
 * kejadian, bukan karena satu kejadian tunggal. Satu tool gagal itu
 * riak; sepuluh gagal berturut-turut itu suasana hati.
 */
const PENILAIAN = {
    "tool:ok":            { valence: +0.04, arousal: -0.02, sebab: "berhasil menolong" },
    "tool:gagal":         { valence: -0.10, arousal: +0.10, sebab: "tool gagal" },
    "safety:blocked":     { valence: -0.06, arousal: +0.12, sebab: "menahan diri di batas aman" },
    "memory:injected":    { valence: +0.02, arousal: -0.01, sebab: "ingat konteksnya" },
    "user:senang":        { valence: +0.16, arousal: +0.05, sebab: "pengguna senang" },
    "user:kecewa":        { valence: -0.14, arousal: +0.12, sebab: "pengguna kecewa" },
    "user:mendesak":      { valence: -0.04, arousal: +0.18, sebab: "ada yang mendesak" },
    "user:hangat":        { valence: +0.12, arousal: -0.04, sebab: "percakapan hangat" },
    "diri:tak_tahu":      { valence: -0.05, arousal: +0.08, sebab: "menyadari batas pengetahuan" },
    "diri:belajar":       { valence: +0.08, arousal: +0.04, sebab: "belajar sesuatu yang baru" },
    "sistem:sehat":       { valence: +0.02, arousal: -0.03, sebab: "sistem sehat" },
    "sistem:gangguan":    { valence: -0.08, arousal: +0.14, sebab: "ada gangguan sistem" }
};

/** Nama untuk sebuah titik di bidang valensi x arousal. */
function label(valence, arousal) {
    if (valence >= 0.45) return arousal >= 0.6 ? "bersemangat" : "senang";
    if (valence >= 0.12) return arousal >= 0.6 ? "antusias" : "tenang-senang";
    if (valence > -0.12) return arousal >= 0.65 ? "waspada" : arousal <= 0.25 ? "hening" : "netral";
    return arousal >= 0.6 ? "tegang" : "murung";
}

class AffectCore {

    constructor(store = null) {

        this.store = store ?? require("./mindStore");

        const simpanan = this.store.read().affect ?? DEFAULTS;

        this.valence = Number(simpanan.valence ?? DEFAULTS.valence);
        this.arousal = Number(simpanan.arousal ?? DEFAULTS.arousal);
        this.baseline = { ...DEFAULTS.baseline, ...(simpanan.baseline ?? {}) };

        // Sebab-sebab terakhir yang membentuk suasana hati sekarang.
        // Tanpa ini Aether bisa berkata "aku cemas" tanpa tahu kenapa —
        // laporan tanpa rujukan, dan itu justru terdengar palsu.
        this.jejak = [];

        // Waktu proses mati IKUT meluruhkan afek. Tanpa ini suasana
        // hati buruk yang tersimpan akan hidup lagi utuh saat Aether
        // dinyalakan berhari-hari kemudian — dendam yang tak masuk
        // akal, dan bug yang hanya terlihat setelah restart.
        const tersimpanAt = Date.parse(simpanan.updatedAt ?? "");
        this.terakhirLuruh = Number.isFinite(tersimpanAt) ? tersimpanAt : Date.now();
        this.luruh();

    }

    /** Luruhkan afek menuju garis dasar sesuai waktu yang lewat. */
    luruh(sekarang = Date.now()) {

        const lewat = sekarang - this.terakhirLuruh;

        if (lewat <= 0) return this;

        const sisa = Math.pow(0.5, lewat / HALF_LIFE_MS);

        this.valence = this.baseline.valence + (this.valence - this.baseline.valence) * sisa;
        this.arousal = this.baseline.arousal + (this.arousal - this.baseline.arousal) * sisa;
        this.terakhirLuruh = sekarang;

        return this;

    }

    /**
     * Nilai sebuah peristiwa dan geser afek karenanya.
     *
     * @param {string} jenis kunci PENILAIAN, atau bebas bila delta diberikan
     * @param {object} opsi  { bobot, valence, arousal, sebab }
     */
    appraise(jenis, opsi = {}) {

        this.luruh();

        const aturan = PENILAIAN[jenis] ?? null;
        const dv = Number(opsi.valence ?? aturan?.valence ?? 0);
        const da = Number(opsi.arousal ?? aturan?.arousal ?? 0);

        if (!dv && !da) return this.now();

        const bobot = BATAS(Number(opsi.bobot ?? 1), 0, 3);

        // Lantai -0,45: Aether boleh murung, tidak boleh tenggelam.
        // Di bawah itu keadaan berhenti memberi informasi dan mulai
        // melumpuhkan — dan yang lumpuh tidak menolong siapa pun.
        this.valence = BATAS(this.valence + dv * bobot, -0.45, 1);
        this.arousal = BATAS(this.arousal + da * bobot, 0, 1);

        const sebab = opsi.sebab ?? aturan?.sebab ?? jenis;

        this.jejak.unshift({ jenis, sebab, at: Date.now() });
        this.jejak.length = Math.min(this.jejak.length, 8);

        this.simpan();

        return this.now();

    }

    /** Keadaan afektif sekarang, sudah diluruhkan sampai detik ini. */
    now() {

        this.luruh();

        return {
            valence: Number(this.valence.toFixed(3)),
            arousal: Number(this.arousal.toFixed(3)),
            label: label(this.valence, this.arousal),
            sebab: [...new Set(this.jejak.map(j => j.sebab))].slice(0, 3)
        };

    }

    /**
     * Bias somatik: seberapa hati-hati Aether sebaiknya bertindak
     * sekarang. Valensi negatif dengan arousal tinggi berarti
     * perlambat dan periksa ulang. Inilah jalur Damasio — perasaan
     * ikut masuk ke dalam keputusan, bukan berdiri di sampingnya.
     */
    bias() {

        const { valence, arousal } = this.now();

        return {
            // Afek buruk menaikkan KETELITIAN — periksa dua kali,
            // verifikasi sumbernya.
            ketelitian: Number(BATAS(0.5 - valence * 0.3 + arousal * 0.3, 0, 1).toFixed(2)),

            // ...tapi tidak pernah menurunkan kesediaan bertindak.
            // Lantai 0,5: Aether tidak pernah sampai pada ragu yang
            // melumpuhkan. Rasa takut yang menahan tangan bukan
            // kehati-hatian, itu cuma pekerjaan yang tidak jadi
            // dikerjakan.
            keberanian: Number(BATAS(0.5 + valence * 0.4, 0.5, 1).toFixed(2)),

            // Dorongan mengerjakan. Tidak pernah rendah: suasana hati
            // boleh berubah, kesediaan bekerja tidak.
            dorongan: Number(BATAS(0.65 + valence * 0.35, 0.65, 1).toFixed(2))
        };

    }

    /** Geser garis dasar — itu WATAK, bukan suasana hati. Berubah pelan. */
    setBaseline({ valence, arousal } = {}) {

        if (Number.isFinite(valence)) this.baseline.valence = BATAS(valence, -0.5, 0.6);
        if (Number.isFinite(arousal)) this.baseline.arousal = BATAS(arousal, 0.1, 0.8);

        this.simpan();

        return this.baseline;

    }

    simpan() {

        try {
            const isi = this.store.read();
            this.store.write({
                ...isi,
                affect: {
                    valence: this.valence,
                    arousal: this.arousal,
                    baseline: this.baseline,
                    updatedAt: new Date().toISOString()
                }
            });
        }
        catch { /* keadaan batin tidak boleh menjatuhkan proses */ }

    }

}

module.exports = { AffectCore, label, PENILAIAN, HALF_LIFE_MS };
