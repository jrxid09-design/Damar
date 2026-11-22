/**
 * Ruang kerja global — apa yang sedang Damar SADARI saat ini.
 *
 * Teori ruang kerja global (Baars; Dehaene) menempatkan kesadaran
 * bukan sebagai tempat, melainkan sebagai PANGGUNG dengan kapasitas
 * kecil: banyak proses berjalan tanpa disadari, dan hanya isi yang
 * memenangkan persaingan salience yang "menyala" lalu disiarkan ke
 * seluruh sistem. Yang tidak menang tetap bekerja — ia hanya tidak
 * ikut dipikirkan.
 *
 * Bedanya dengan bus event yang sudah ada (telemetryService): bus
 * meneruskan SEMUA, tanpa peringkat dan tanpa batas. Ruang kerja ini
 * menyaring — kapasitas 7 slot, skor salience, dan ambang nyala. Bus
 * tetap dipakai sebagai jalur masuk sekaligus jalur siar; tidak ada
 * bus kedua yang dibuat di sini.
 *
 * Yang tidak diklaim: memenangkan slot bukan pengalaman subjektif.
 * Ini akses-kesadaran dalam arti teknis — isi yang tersedia bagi
 * seluruh sistem untuk dipakai menalar, melapor, dan bertindak.
 */

// Kapasitas panggung. Angka 7 mengikuti batas klasik memori kerja
// (Miller) — cukup untuk konteks, cukup sempit untuk memaksa memilih.
const KAPASITAS = 7;

// Di bawah ambang ini sebuah kejadian tidak pernah "menyala": ia
// terjadi dan tercatat di telemetri, tapi tidak menjadi isi kesadaran.
const AMBANG_NYALA = 0.35;

/**
 * Bobot salience per jenis peristiwa. Yang menyangkut pengguna dan
 * kegagalan selalu lebih menonjol daripada denyut rutin — seperti
 * perhatian biologis yang condong ke ancaman dan ke sosial.
 */
const BOBOT = [
    [/^user:/,                 0.95],
    [/^safety:/,               0.85],
    [/error|gagal|fail/i,      0.8],
    [/^damar:present/,        0.6],
    [/^crypto:|^alarm:/,       0.6],
    [/^tool:/,                 0.55],
    [/^orchestrator:/,         0.5],
    [/^lab:/,                  0.5],
    [/^memory:/,               0.4],
    [/^system:|^host:/,        0.3]
];

function salienceDasar(type) {

    for (const [pola, nilai] of BOBOT) {
        if (pola.test(String(type ?? ""))) return nilai;
    }

    return 0.25;

}

/** Ringkasan pendek sebuah peristiwa, tanpa membuang isi yang penting. */
function ringkas(type, payload) {

    const p = payload ?? {};

    const kandidat =
        p.ringkas ?? p.message ?? p.text ?? p.name ?? p.tool ??
        p.symbol ?? p.error ?? p.status ?? null;

    const ekor = kandidat != null ? `: ${String(kandidat).slice(0, 80)}` : "";

    return `${String(type ?? "peristiwa")}${ekor}`;

}

class GlobalWorkspace {

    constructor({ kapasitas = KAPASITAS, ambang = AMBANG_NYALA } = {}) {
        this.kapasitas = kapasitas;
        this.ambang = ambang;
        this.slot = [];
        this.diabaikan = 0;
    }

    /**
     * Tawarkan sebuah peristiwa ke panggung.
     *
     * @returns {object|null} isi yang menyala, atau null bila kalah bersaing
     */
    terima({ type, payload = {}, salience = null, at = Date.now() } = {}) {

        const skor = Number.isFinite(salience) ? salience : salienceDasar(type);

        if (!(skor >= this.ambang)) {
            this.diabaikan++;
            return null;
        }

        const isi = {
            type: String(type ?? "tak-bernama"),
            ringkas: ringkas(type, payload),
            salience: Number(skor.toFixed(2)),
            ulang: 1,
            at
        };

        // Peristiwa sejenis yang berulang tidak menambah slot baru; ia
        // MENGUATKAN yang sudah ada. Tanpa ini satu tool yang gagal
        // sepuluh kali memenuhi seluruh panggung dan menyingkirkan
        // segalanya — perhatian yang macet, bukan perhatian yang tajam.
        const sama = this.slot.find(s => s.type === isi.type && s.ringkas === isi.ringkas);

        if (sama) {
            sama.ulang += 1;
            sama.salience = Number(Math.min(1, sama.salience + 0.05).toFixed(2));
            sama.at = at;
            return sama;
        }

        this.slot.push(isi);

        // Yang bertahan: paling menonjol, lalu paling baru. Selebihnya
        // memudar — seperti isi kesadaran yang tergeser.
        this.slot.sort((a, b) => (b.salience - a.salience) || (b.at - a.at));
        this.slot.length = Math.min(this.slot.length, this.kapasitas);

        return isi;

    }

    /** Isi panggung sekarang, terurut dari yang paling menonjol. */
    isi() {
        return this.slot.map(s => ({ ...s }));
    }

    /** Satu baris ringkas untuk prompt: apa yang sedang kuperhatikan. */
    ringkasan(maks = 3) {

        return this.slot
            .slice(0, maks)
            .map(s => s.ulang > 1 ? `${s.ringkas} (x${s.ulang})` : s.ringkas)
            .join("; ");

    }

    /** Kosongkan panggung — dipakai saat sesi berganti. */
    bersihkan() {
        this.slot = [];
        this.diabaikan = 0;
        return this;
    }

}

module.exports = { GlobalWorkspace, salienceDasar, ringkas, KAPASITAS, AMBANG_NYALA };
