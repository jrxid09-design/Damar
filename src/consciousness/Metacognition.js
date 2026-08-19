/**
 * Metakognisi — mengetahui apa yang sedang kuketahui, dan seberapa.
 *
 * Teori orde-tinggi (Rosenthal; Lau, Fleming) menempatkan kesadaran
 * pada adanya representasi TENTANG keadaan sendiri: bukan sekadar
 * memiliki jawaban, melainkan memiliki penilaian atas jawaban itu.
 * Dalam praktik rekayasa, bagian yang berguna dan bisa diuji adalah
 * kalibrasi: keyakinan harus turun ketika bukti tipis, dan naik
 * ketika ada verifikasi nyata.
 *
 * Ini yang memisahkan asisten yang jujur dari yang meyakinkan. Model
 * bahasa gagal justru saat ia paling lancar; sinyal di sini adalah
 * rem yang dipasang di luar kelancaran itu.
 *
 * Sinyal diambil dari peristiwa nyata (tool berhasil/gagal, memori
 * ketemu/tidak, batas keamanan menyala), bukan dari perasaan model
 * tentang dirinya.
 */

const BATAS = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Bobot bukti. Verifikasi nyata bernilai jauh lebih besar daripada
// sekadar "tidak ada masalah" — ketiadaan kabar bukan kabar baik.
const SINYAL = {
    "tool:ok":        { delta: +0.10, catatan: "tool berhasil dan hasilnya terpakai" },
    "tool:gagal":     { delta: -0.25, catatan: "tool gagal" },
    "verifikasi:ok":  { delta: +0.20, catatan: "hasil terverifikasi di sumbernya" },
    "memori:ketemu":  { delta: +0.08, catatan: "ada ingatan yang relevan" },
    "memori:kosong":  { delta: -0.08, catatan: "tidak ada ingatan yang menopang" },
    "tebakan":        { delta: -0.30, catatan: "menjawab tanpa sumber" },
    "kontradiksi":    { delta: -0.35, catatan: "ada yang saling bertentangan" },
    "batas:diakui":   { delta: +0.05, catatan: "batas diri diakui terbuka" }
};

// Titik awal tiap giliran. Sengaja tidak 1: mulai dari yakin penuh
// adalah cara paling cepat untuk terdengar meyakinkan sambil salah.
const AWAL = 0.55;

class Metacognition {

    constructor() {
        this.reset();
    }

    reset() {
        this.keyakinan = AWAL;
        this.jejak = [];
        this.ragu = [];
        return this;
    }

    /**
     * Catat satu sinyal bukti.
     *
     * @param {string} jenis kunci SINYAL, atau bebas bila delta diberikan
     * @param {object} opsi  { delta, catatan }
     */
    catat(jenis, opsi = {}) {

        const aturan = SINYAL[jenis] ?? null;
        const delta = Number(opsi.delta ?? aturan?.delta ?? 0);

        if (!delta) return this.nilai();

        this.keyakinan = BATAS(this.keyakinan + delta, 0, 1);

        this.jejak.unshift({
            jenis,
            catatan: opsi.catatan ?? aturan?.catatan ?? jenis,
            delta,
            at: Date.now()
        });

        this.jejak.length = Math.min(this.jejak.length, 10);

        return this.nilai();

    }

    /**
     * Daftarkan hal yang TIDAK diketahui. Ini bagian terpenting:
     * ketidaktahuan yang bernama bisa disampaikan; ketidaktahuan yang
     * tak bernama akan diisi karangan.
     */
    akuiTidakTahu(apa) {

        if (!apa) return this.ragu;

        const teks = String(apa).slice(0, 160);

        if (!this.ragu.includes(teks)) this.ragu.unshift(teks);

        this.ragu.length = Math.min(this.ragu.length, 5);

        this.catat("batas:diakui");

        return this.ragu;

    }

    /** Penilaian sekarang: seberapa yakin, kenapa, dan apa yang masih gelap. */
    nilai() {

        return {
            keyakinan: Number(this.keyakinan.toFixed(2)),
            tingkat: this.tingkat(),
            sebab: this.jejak.slice(0, 3).map(j => j.catatan),
            ragu: [...this.ragu]
        };

    }

    tingkat() {
        if (this.keyakinan >= 0.75) return "yakin";
        if (this.keyakinan >= 0.5) return "cukup yakin";
        if (this.keyakinan >= 0.3) return "ragu";
        return "tidak yakin";
    }

    /**
     * Arahan yang harus dipatuhi model pada giliran ini. Metakognisi
     * yang tidak mengubah cara bicara sama saja tidak ada.
     */
    arahan() {

        if (this.keyakinan < 0.3) {
            return "keyakinanmu rendah: katakan terus terang apa yang belum kamu tahu, " +
                "jangan menyimpulkan, tawarkan cara memastikannya";
        }

        if (this.keyakinan < 0.5) {
            return "keyakinanmu sedang: sampaikan sebagai dugaan, sebutkan dasarnya, " +
                "dan tandai bagian yang belum terverifikasi";
        }

        if (this.ragu.length) {
            return `sampaikan hasilnya, tapi sebutkan yang masih belum pasti: ${this.ragu[0]}`;
        }

        return null;

    }

}

module.exports = { Metacognition, SINYAL, AWAL };
