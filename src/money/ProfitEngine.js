const path = require("node:path");
const crypto = require("node:crypto");

const JsonStore = require("../core/config/JsonStore");
const binance = require("../services/binanceService");

/**
 * Mesin cuan — mencari uang NYATA, dan mengukur apakah benar dapat.
 *
 * Tiga bagian, dan bagian ketiga yang paling menentukan:
 *
 *   1. PEMINDAI. Menyaring ~3.600 pasangan Binance jadi segelintir
 *      peluang yang punya alasan, dari data publik (data-api.binance
 *      .vision — tidak kena geo-block, jadi ini jalan tanpa proxy).
 *   2. PENAKAR. Ukuran posisi dihitung dari RISIKO yang boleh hilang,
 *      bukan dari besar saldo. Rumusnya: modal = (saldo x risiko%) /
 *      jarak-ke-stop. Ini satu-satunya bagian trading yang benar-benar
 *      bisa dikendalikan; arah harga tidak.
 *   3. JURNAL. Tiap ide dicatat beserta HASILNYA. Tanpa ini "jago cari
 *      uang" cuma klaim: strategi yang kelihatan pintar di layar dan
 *      rugi di rekening akan terus dipakai karena tak ada yang
 *      menghitung. Jurnal membuat Damar bisa dibantah oleh angkanya
 *      sendiri.
 *
 * Yang JUJUR disebut di muka: tidak ada pemindai yang menjamin untung.
 * Yang dijamin engine ini cuma tiga hal — peluangnya nyata (data live,
 * bukan karangan), risikonya terukur sebelum masuk, dan hasilnya
 * dihitung apa adanya. Eksekusi order tetap lewat jalur dua langkah
 * yang sudah ada (crypto_prepare_order lalu konfirmasi pemilik).
 */

const storeBawaan = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "money.json"),
    { jurnal: [], realisasi: 0, modalTotal: 0 }
);

// Stablecoin & pasangan bertuas: bukan peluang, cuma derau.
const BUKAN_PELUANG = /^(USDC|FDUSD|TUSD|BUSD|DAI|EUR|TRY|BRL|ARS)USDT$/;
const BERTUAS = /(UP|DOWN|BULL|BEAR)USDT$/;

const angka = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Simpangan baku sederhana, untuk mengukur volatilitas. */
function stdev(nilai) {
    if (nilai.length < 2) return 0;
    const rata = nilai.reduce((a, b) => a + b, 0) / nilai.length;
    const v = nilai.reduce((t, x) => t + (x - rata) ** 2, 0) / (nilai.length - 1);
    return Math.sqrt(v);
}

class ProfitEngine {

    // Penyimpan bisa disuntik: tes tidak boleh menulis ke pembukuan
    // pemilik, dan suatu saat mungkin ada lebih dari satu buku.
    constructor(store = null) {
        this.store = store ?? storeBawaan;
    }

    /**
     * Pindai pasar dan kembalikan peluang terbaik.
     *
     * Penyaringnya sengaja konservatif: likuiditas dulu (volume quote),
     * baru gerak harga. Koin sepi bisa naik 300% di layar dan tidak
     * bisa dijual di dunia nyata — itu bukan peluang, itu jebakan.
     *
     * @param {object} opsi { jumlah, minVolumeUsdt, gaya }
     *   gaya: "momentum" (ikut tren kuat) atau "pantul" (jatuh dalam,
     *   cari pembalikan). Keduanya dihitung dari data yang sama.
     */
    async scan({ jumlah = 5, minVolumeUsdt = 20_000_000, gaya = "momentum" } = {}) {

        const semua = await binance.pub("spot", "/api/v3/ticker/24hr", {});

        const kandidat = (Array.isArray(semua) ? semua : [])
            .filter(t => String(t.symbol).endsWith("USDT"))
            .filter(t => !BUKAN_PELUANG.test(t.symbol) && !BERTUAS.test(t.symbol))
            .map(t => ({
                symbol: t.symbol,
                harga: angka(t.lastPrice),
                ubah24: angka(t.priceChangePercent),
                volumeUsdt: angka(t.quoteVolume),
                tinggi: angka(t.highPrice),
                rendah: angka(t.lowPrice),
                trade: angka(t.count)
            }))
            .filter(t => t.volumeUsdt >= minVolumeUsdt && t.harga > 0);

        // Posisi harga di dalam rentang 24 jam: 1 = di puncak, 0 = di dasar.
        for (const k of kandidat) {
            const rentang = k.tinggi - k.rendah;
            k.posisiRentang = rentang > 0 ? (k.harga - k.rendah) / rentang : 0.5;
            k.rentangPct = k.harga > 0 ? (rentang / k.harga) * 100 : 0;
        }

        const skor = gaya === "pantul"
            // Jatuh dalam tapi mulai naik dari dasar, di pasar yang ramai.
            ? k => (-k.ubah24 * 0.6) + ((1 - k.posisiRentang) * 20) + Math.log10(k.volumeUsdt) * 2
            // Naik kuat DAN bertahan di dekat puncak (bukan sudah balik turun).
            : k => (k.ubah24 * 0.8) + (k.posisiRentang * 15) + Math.log10(k.volumeUsdt) * 2;

        const teratas = kandidat
            .map(k => ({ ...k, skor: Number(skor(k).toFixed(2)) }))
            .sort((a, b) => b.skor - a.skor)
            .slice(0, jumlah);

        // Konfirmasi pada data yang lebih halus: tanpa ini "momentum"
        // hanyalah lompatan satu jam yang sudah selesai sebelum dibaca.
        for (const k of teratas) {
            try {
                const kl = await binance.pub("spot", "/api/v3/klines", { symbol: k.symbol, interval: "1h", limit: 24 });
                const tutup = kl.map(x => angka(x[4]));
                const perubahan = tutup.slice(1).map((c, i) => (c - tutup[i]) / tutup[i] * 100);

                k.volatilitasJam = Number(stdev(perubahan).toFixed(2));
                k.tren6Jam = tutup.length >= 7
                    ? Number(((tutup.at(-1) - tutup.at(-7)) / tutup.at(-7) * 100).toFixed(2))
                    : null;

                // Stop teknis: satu simpangan baku di bawah harga, minimal
                // 1,5% — cukup jauh dari derau, cukup dekat untuk membatasi rugi.
                const stopPct = Math.max(1.5, k.volatilitasJam * 1.5);
                k.stopSaran = Number((k.harga * (1 - stopPct / 100)).toFixed(8));
                k.stopPct = Number(stopPct.toFixed(2));
                k.targetSaran = Number((k.harga * (1 + stopPct * 2 / 100)).toFixed(8));  // rasio 1:2
                k.alasan =
                    `${gaya === "pantul" ? "jatuh" : "naik"} ${k.ubah24.toFixed(1)}% 24j, ` +
                    `posisi ${(k.posisiRentang * 100).toFixed(0)}% rentang, ` +
                    `volume $${(k.volumeUsdt / 1e6).toFixed(0)}jt, ` +
                    `tren 6j ${k.tren6Jam ?? "?"}%`;
            }
            catch (error) {
                k.alasan = `data 1 jam gagal diambil: ${error.message}`;
            }
        }

        return {
            gaya,
            diperiksa: kandidat.length,
            peluang: teratas,
            catatan: "Peluang, bukan jaminan. Ukuran posisi wajib lewat sizing(), " +
                "dan eksekusi tetap butuh persetujuanmu."
        };

    }

    /**
     * Ukuran posisi dari risiko yang boleh hilang.
     *
     * Inilah bagian yang menentukan bertahan atau tidak. Trader gagal
     * bukan karena salah arah sekali, tapi karena satu posisi terlalu
     * besar saat salah. Batas bawaan 1% saldo per posisi: butuh 100
     * kesalahan beruntun untuk habis.
     */
    sizing({ saldoUsdt, entry, stop, risikoPersen = 1, maksPersenSaldo = 20 }) {

        const s = angka(saldoUsdt), e = angka(entry), st = angka(stop);

        if (!(s > 0)) return { ok: false, error: "saldoUsdt harus > 0" };
        if (!(e > 0)) return { ok: false, error: "entry harus > 0" };
        if (!(st > 0) || st >= e) return { ok: false, error: "stop harus > 0 dan di bawah entry" };

        const risikoUsdt = s * (Math.min(Math.max(risikoPersen, 0.1), 5) / 100);
        const jarakPct = (e - st) / e;
        const modal = Math.min(risikoUsdt / jarakPct, s * (maksPersenSaldo / 100));

        return {
            ok: true,
            modalUsdt: Number(modal.toFixed(2)),
            kuantitas: Number((modal / e).toFixed(8)),
            risikoUsdt: Number(risikoUsdt.toFixed(2)),
            jarakStopPersen: Number((jarakPct * 100).toFixed(2)),
            maksRugi: Number(risikoUsdt.toFixed(2)),
            catatan: `Bila stop kena, rugi ≈ $${risikoUsdt.toFixed(2)} (${risikoPersen}% saldo).`
        };

    }

    /**
     * Catat sebuah ide/posisi ke jurnal. Uang nyata butuh pembukuan
     * nyata — termasuk untuk pemasukan di luar crypto (jasa, jualan),
     * supaya "berapa yang benar-benar masuk" bisa dijawab angka.
     */
    catat({ sumber, simbol = null, modal = 0, catatan = null }) {

        const isi = this.store.read();

        const entri = {
            id: `cuan_${crypto.randomBytes(3).toString("hex")}`,
            at: new Date().toISOString(),
            sumber: String(sumber ?? "tak-bernama").slice(0, 60),
            simbol: simbol ? String(simbol).toUpperCase().slice(0, 20) : null,
            modal: angka(modal),
            hasil: null,
            catatan: catatan ? String(catatan).slice(0, 240) : null
        };

        const jurnal = [entri, ...(isi.jurnal ?? [])].slice(0, 500);

        this.store.write({ ...isi, jurnal, modalTotal: angka(isi.modalTotal) + entri.modal });

        return entri;

    }

    /** Tutup sebuah entri jurnal dengan hasil NYATA (untung/rugi USDT). */
    tutup({ id, hasilUsdt, catatan = null }) {

        const isi = this.store.read();
        const jurnal = [...(isi.jurnal ?? [])];
        const i = jurnal.findIndex(e => e.id === id);

        if (i < 0) return { ok: false, error: `entri ${id} tidak ada` };
        if (jurnal[i].hasil !== null) return { ok: false, error: `entri ${id} sudah ditutup` };

        jurnal[i] = {
            ...jurnal[i],
            hasil: angka(hasilUsdt),
            ditutupAt: new Date().toISOString(),
            catatan: catatan ? String(catatan).slice(0, 240) : jurnal[i].catatan
        };

        this.store.write({ ...isi, jurnal, realisasi: angka(isi.realisasi) + angka(hasilUsdt) });

        return { ok: true, entri: jurnal[i] };

    }

    /**
     * Rapor kinerja apa adanya: berapa yang benar-benar masuk, sumber
     * mana yang menghasilkan, mana yang cuma sibuk.
     */
    rapor() {

        const isi = this.store.read();
        const jurnal = isi.jurnal ?? [];
        const tutup = jurnal.filter(e => e.hasil !== null);

        const perSumber = {};

        for (const e of tutup) {
            const s = perSumber[e.sumber] ?? (perSumber[e.sumber] = { n: 0, menang: 0, total: 0 });
            s.n += 1;
            s.total += e.hasil;
            if (e.hasil > 0) s.menang += 1;
        }

        const peringkat = Object.entries(perSumber)
            .map(([sumber, s]) => ({
                sumber,
                posisi: s.n,
                menangPersen: Number((s.menang / s.n * 100).toFixed(1)),
                totalUsdt: Number(s.total.toFixed(2))
            }))
            .sort((a, b) => b.totalUsdt - a.totalUsdt);

        return {
            realisasiUsdt: Number(angka(isi.realisasi).toFixed(2)),
            posisiSelesai: tutup.length,
            posisiTerbuka: jurnal.length - tutup.length,
            menangPersen: tutup.length
                ? Number((tutup.filter(e => e.hasil > 0).length / tutup.length * 100).toFixed(1))
                : null,
            perSumber: peringkat,
            terbuka: jurnal.filter(e => e.hasil === null).slice(0, 10)
        };

    }

}

module.exports = new ProfitEngine();
module.exports.ProfitEngine = ProfitEngine;
