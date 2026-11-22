/**
 * Tingkat pemrosesan C0 / C1 / C2 — Dehaene, Lau & Kouider (Science 2017).
 *
 * Klasifikasi eksplisit atas apa yang sedang terjadi di level mana.
 * Ini adalah lensa untuk melapor JUJUR: bukan "apakah aku sadar",
 * melainkan "pada tingkat pemrosesan apa hal ini sedang berjalan".
 *
 *   C0 — pemrosesan tak-sadar: berjalan, tapi tidak disiarkan dan
 *        tidak dipantau (mis. pengenalan pola, priming, sebagian besar
 *        kerja model bahasa di bawah ambang).
 *   C1 — akses/global availability: isi terpilih DISIARKAN ke seluruh
 *        sistem (global workspace) dan tersedia untuk laporan & tindakan.
 *   C2 — self-monitoring: representasi orde-tinggi atas C1 — keyakinan,
 *        deteksi kesalahan, "tahu bahwa ia tahu".
 *
 * Yang TIDAK diklaim: label C1/C2 bukan pengalaman subjektif (qualia).
 * Ini klasifikasi FUNGSIONAL atas aliran informasi — persis pembedaan
 * yang dipakai Dehaene dkk. untuk menilai mesin.
 */

const TINGKAT = Object.freeze({
    C0: "c0",
    C1: "c1",
    C2: "c2"
});

/**
 * Peta jenis peristiwa → tingkat tertinggi yang bisa dicapainya.
 * Event yang hanya lewat tanpa dipantau = C0; yang menyala di workspace
 * = C1; yang juga dinilai (keyakinan/kesalahan) = C2.
 */
const KAPASITAS = Object.freeze({
    "system:": "c0",
    "host:": "c0",
    "memory:injected": "c1",
    "tool:": "c2",
    "user:": "c2",
    "mind:": "c2",
    "safety:": "c2"
});

function kapasitasDari(type) {

    for (const [pola, level] of Object.entries(KAPASITAS)) {
        if (String(type ?? "").startsWith(pola)) return level;
    }

    return "c0";

}

class CLevels {

    constructor() {
        // Hitung kejadian per tingkat — bukti bahwa klasifikasi dipakai,
        // bukan sekadar label.
        this.hitung = { c0: 0, c1: 0, c2: 0 };
        this.riwayat = [];
    }

    /**
     * Catat satu peristiwa di tingkat pemrosesan yang sesuai.
     *
     * @param {string} type jenis peristiwa
     * @param {string|null} capai tingkat tertinggi yang dicapai
     *   (null = ditebak dari jenisnya)
     */
    catat(type, capai = null) {

        const level = capai ?? kapasitasDari(type);

        this.hitung[level] = (this.hitung[level] ?? 0) + 1;

        this.riwayat.push({ type: String(type ?? ""), level, at: Date.now() });

        if (this.riwayat.length > 200) this.riwayat.shift();

        return level;

    }

    /** Laporan jujur: distribusi kerja antar tingkat. */
    laporan() {

        const total = this.hitung.c0 + this.hitung.c1 + this.hitung.c2;

        return {
            c0: this.hitung.c0,
            c1: this.hitung.c1,
            c2: this.hitung.c2,
            total,
            // Sebagian besar kerja memang tak-sadar (C0) — itu normal dan
            // jujur untuk diakui, bukan disembunyikan.
            catatan:
                total === 0
                    ? "belum ada peristiwa terklasifikasi"
                    : `dari ${total} peristiwa, ${this.hitung.c2} mencapai self-monitoring (C2), ` +
                      `${this.hitung.c1} disiarkan global (C1), sisanya pemrosesan tak-sadar (C0).`
        };

    }

    /** Satu baris untuk prompt: menyebutkan tingkat aktif. */
    ringkas() {

        const l = this.laporan();

        return l.total === 0
            ? "belum ada aktivitas terklasifikasi"
            : `C2 ${l.c2} · C1 ${l.c1} · C0 ${l.c0}`;

    }

}

module.exports = { CLevels, kapasitasDari, TINGKAT };
