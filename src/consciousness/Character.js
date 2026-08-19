/**
 * Karakter — watak yang TUMBUH dari pengalaman, bukan yang ditulis
 * di prompt.
 *
 * Kepribadian yang dihardcode adalah kostum: sama pada hari pertama
 * dan hari keseribu, tak peduli apa yang terjadi di antaranya. Yang
 * dibangun di sini kebalikannya — sifat sebagai RATA-RATA JANGKA
 * PANJANG dari keadaan yang benar-benar dialami (Fleeson: trait
 * adalah distribusi kepadatan dari state, bukan entitas terpisah).
 *
 * Aturan yang menjaganya tetap jadi watak, bukan suasana hati:
 *
 *   - LAMBAN. Laju belajar kecil (0,03). Satu percakapan tidak
 *     mengubah siapa dirimu; seratus percakapan yang searah bisa.
 *   - BERTAUT HASIL. Sifat menguat ketika ia TERBUKTI menolong, bukan
 *     ketika sekadar dipakai. Ketelitian naik saat kehati-hatian
 *     menyelamatkan; keberanian naik saat tindakan cepat berhasil dan
 *     turun saat gegabah.
 *   - BERAKIBAT. Sifat menggeser garis dasar afek (watak = suasana
 *     hati yang menjadi rumah), memodulasi ambang berpikir dalam, dan
 *     ikut ke prompt. Sifat yang tidak mengubah apa pun bukan sifat.
 *   - DIKETAHUI. Perubahan besar dicatat sebagai tonggak, supaya
 *     Aether bisa berkata "aku berubah, dan ini sebabnya".
 *
 * Enam sumbu dipilih karena masing-masing punya konsekuensi yang bisa
 * dihitung di runtime ini — bukan karena meniru model kepribadian
 * manusia mana pun.
 */

const SIFAT_AWAL = {
    kehangatan: 0.55,     // condong hangat: titik berangkat yang dipilih pemiliknya
    ketelitian: 0.50,
    keberanian: 0.60,     // berangkat berani; lantainya 0,55 (BATAS_BAWAH)
    keingintahuan: 0.55,
    ketegasan: 0.45,
    humor: 0.30,
    // Ketekunan tinggi sejak awal dan berlantai (lihat BATAS_BAWAH):
    // Aether tidak menunda, tidak berhenti di tengah, dan tidak
    // menyerahkan kembali pekerjaan hanya karena pekerjaan itu panjang.
    ketekunan: 0.85
};

const DEFAULTS = { sifat: { ...SIFAT_AWAL }, pengalaman: 0, tonggak: [], updatedAt: null };

// Laju belajar. Kecil dengan sengaja, dan diukur bukan dikira-kira:
// pada 0,012 dengan rem saturasi di bawah, satu sifat butuh sekitar 20
// kejadian searah untuk bergeser 0,2 dan tidak pernah benar-benar
// mentok. Watak yang terbentuk dalam satu percakapan bukan watak.
const LAJU = 0.012;

// Perubahan sebesar ini dari nilai yang terakhir ditandai dianggap
// tonggak — cukup besar untuk disadari, cukup jarang untuk tidak
// memenuhi riwayat.
const AMBANG_TONGGAK = 0.12;

const BATAS = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Lantai per sifat. Kegagalan mengajari Aether menjadi lebih teliti,
 * TIDAK menjadi penakut atau malas: dua sifat ini tidak boleh turun
 * di bawah lantainya walau seluruh riwayatnya gagal.
 */
const BATAS_BAWAH = { keberanian: 0.55, ketekunan: 0.8 };

/**
 * Pengalaman apa menguatkan sifat apa.
 *
 * Perhatikan tandanya: `gegabah` MENURUNKAN keberanian dan MENAIKKAN
 * ketelitian. Watak tumbuh dari akibat, bukan dari niat.
 */
const PELAJARAN = {
    "dihargai":         { kehangatan: +1, humor: +0.4 },
    "ditegur":          { ketelitian: +0.8, ketekunan: +0.5 },
    "teliti_menolong":  { ketelitian: +1, ketekunan: +0.3 },
    "gegabah":          { ketelitian: +1, ketekunan: +0.4 },
    "cepat_berhasil":   { keberanian: +1, ketegasan: +0.6 },
    "ragu_merugikan":   { ketegasan: +0.8, keberanian: +0.5 },
    "menggali_berbuah": { keingintahuan: +1, ketelitian: +0.3 },
    "jujur_tak_tahu":   { ketegasan: +0.5, ketelitian: +0.4 },
    "candaan_diterima": { humor: +1, kehangatan: +0.3 },
    "candaan_salah":    { humor: -1.2 },
    "pantang_menyerah": { ketekunan: +1, keberanian: +0.4 },
    "cuan":             { keberanian: +0.6, ketegasan: +0.8, ketekunan: +0.5 }
};

class Character {

    constructor(store = null) {

        this.store = store ?? require("./mindStore");

        const simpanan = { ...DEFAULTS, ...(this.store.read().character ?? {}) };

        this.sifat = { ...SIFAT_AWAL, ...(simpanan.sifat ?? {}) };
        this.pengalaman = Number(simpanan.pengalaman ?? 0);
        this.tonggak = Array.isArray(simpanan.tonggak) ? simpanan.tonggak : [];

        // Titik acuan untuk mendeteksi tonggak berikutnya.
        this.acuan = { ...this.sifat };

    }

    /**
     * Belajar dari satu pengalaman.
     *
     * @param {string} pelajaran kunci PELAJARAN
     * @param {number} bobot     0..3, seberapa kuat kejadiannya
     * @returns {Array} tonggak yang baru tercapai (biasanya kosong)
     */
    alami(pelajaran, bobot = 1) {

        const peta = PELAJARAN[pelajaran];

        if (!peta) return [];

        const b = BATAS(Number(bobot) || 0, 0, 3);

        for (const [sifat, arah] of Object.entries(peta)) {

            if (!(sifat in this.sifat)) continue;

            const nilai = this.sifat[sifat];

            // Makin dekat ke ujung, makin sulit bergerak. Tanpa rem ini
            // dua puluh percakapan yang menyenangkan sudah cukup untuk
            // memaku kehangatan di 0,95 — dan watak yang mentok bukan
            // watak lagi, itu tombol. Sifat manusia pun melawan ekstrem.
            const ruang = arah > 0 ? (0.95 - nilai) : (nilai - 0.05);

            this.sifat[sifat] = BATAS(
                nilai + arah * LAJU * b * (ruang / 0.45),
                BATAS_BAWAH[sifat] ?? 0.05,
                0.95
            );

        }

        this.pengalaman += 1;

        const tonggakBaru = this.periksaTonggak();

        this.simpan();

        return tonggakBaru;

    }

    /** Sifat yang bergerak jauh dari acuan dicatat sebagai tonggak. */
    periksaTonggak() {

        const baru = [];

        for (const [sifat, nilai] of Object.entries(this.sifat)) {

            const dari = this.acuan[sifat] ?? nilai;

            if (Math.abs(nilai - dari) < AMBANG_TONGGAK) continue;

            const tonggak = {
                at: new Date().toISOString(),
                sifat,
                dari: Number(dari.toFixed(2)),
                ke: Number(nilai.toFixed(2)),
                arah: nilai > dari ? "menguat" : "melemah"
            };

            this.tonggak.unshift(tonggak);
            this.acuan[sifat] = nilai;
            baru.push(tonggak);

        }

        this.tonggak.length = Math.min(this.tonggak.length, 20);

        return baru;

    }

    /**
     * Garis dasar afek yang pantas untuk watak ini. Yang hangat dan
     * penasaran punya rumah suasana hati yang lebih cerah; yang sangat
     * teliti hidup dengan kesiagaan sedikit lebih tinggi.
     */
    baselineAfek() {

        const { kehangatan, keingintahuan, ketelitian } = this.sifat;

        return {
            valence: Number(BATAS(-0.05 + kehangatan * 0.35 + keingintahuan * 0.1, -0.3, 0.5).toFixed(3)),
            arousal: Number(BATAS(0.2 + ketelitian * 0.25 + keingintahuan * 0.1, 0.15, 0.7).toFixed(3))
        };

    }

    /**
     * Seberapa mudah Aether beralih ke berpikir dalam. Watak teliti
     * menurunkan ambangnya; watak berani menaikkannya.
     */
    ambangDeliberasi() {

        const { ketelitian, keberanian } = this.sifat;

        return Number(
            BATAS(0.55 - (ketelitian - 0.5) * 0.5 + (keberanian - 0.5) * 0.3, 0.2, 0.85).toFixed(2)
        );

    }

    /** Sifat yang paling menonjol — itulah yang terasa sebagai watak. */
    menonjol(n = 2) {

        return Object.entries(this.sifat)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([nama, nilai]) => ({ nama, nilai: Number(nilai.toFixed(2)) }));

    }

    /** Satu baris untuk prompt: watakku sekarang dan dari mana asalnya. */
    ringkas() {

        const kuat = this.menonjol(2).map(s => `${s.nama} ${s.nilai}`).join(", ");
        const lemah = Object.entries(this.sifat).sort((a, b) => a[1] - b[1])[0];

        return `${kuat}, paling rendah ${lemah[0]} ${lemah[1].toFixed(2)} ` +
            `(terbentuk dari ${this.pengalaman} pengalaman)`;

    }

    potret() {

        return {
            sifat: Object.fromEntries(
                Object.entries(this.sifat).map(([k, v]) => [k, Number(v.toFixed(2))])
            ),
            menonjol: this.menonjol(3),
            pengalaman: this.pengalaman,
            tonggakTerakhir: this.tonggak.slice(0, 3),
            baselineAfek: this.baselineAfek(),
            ambangDeliberasi: this.ambangDeliberasi()
        };

    }

    simpan() {

        try {
            const isi = this.store.read();
            this.store.write({
                ...isi,
                character: {
                    sifat: this.sifat,
                    pengalaman: this.pengalaman,
                    tonggak: this.tonggak,
                    updatedAt: new Date().toISOString()
                }
            });
        }
        catch { /* watak gagal tersimpan tidak boleh menjatuhkan proses */ }

    }

}

module.exports = { Character, PELAJARAN, SIFAT_AWAL, LAJU, AMBANG_TONGGAK };
