const { AITool } = require("../ai/tools");

const engine = require("./ProfitEngine");

/**
 * Tool cuan — mencari uang nyata, menakar risikonya, membukukan
 * hasilnya.
 *
 * Pembagian tugas dengan tool crypto yang sudah ada sengaja tegas:
 * di sini SEMUA soal mencari peluang, menghitung ukuran posisi, dan
 * mengukur hasil. Mengirim order tetap milik crypto_prepare_order →
 * crypto_confirm_order. Tidak ada jalur eksekusi kedua, jadi tidak ada
 * cara untuk tak sengaja melewati persetujuan pemilik.
 */
function moneyTools() {

    return [

        new AITool({
            name: "money_scan",
            description:
                "Pindai pasar Binance untuk mencari PELUANG UANG nyata sekarang: " +
                "saring ribuan pasangan jadi beberapa yang punya likuiditas cukup dan " +
                "gerak yang berarti, lengkap dengan alasan, saran stop, dan target. " +
                "Pakai saat pengguna bertanya 'ada peluang apa', 'apa yang layak dibeli " +
                "hari ini', 'cari cuan', atau saat kamu menyusun rencana trading. Data " +
                "publik — jalan tanpa API key. Ini peluang, BUKAN jaminan untung; " +
                "sampaikan begitu.",
            parameters: {
                type: "object",
                properties: {
                    gaya: { type: "string", description: "'momentum' (ikut yang sedang kuat) atau 'pantul' (cari pembalikan setelah jatuh). Default momentum." },
                    jumlah: { type: "number", description: "Berapa peluang teratas dikembalikan (default 5)." },
                    minVolumeUsdt: { type: "number", description: "Ambang likuiditas 24 jam dalam USDT (default 20 juta)." }
                }
            },
            execute: async ({ gaya, jumlah, minVolumeUsdt } = {}) => {
                try {
                    return { ok: true, ...await engine.scan({ gaya, jumlah, minVolumeUsdt }) };
                }
                catch (error) { return { ok: false, error: error.message }; }
            }
        }),

        new AITool({
            name: "money_size",
            description:
                "Hitung UKURAN POSISI dari risiko yang boleh hilang, bukan dari besar " +
                "saldo: modal = (saldo x risiko%) / jarak ke stop. WAJIB dipanggil " +
                "sebelum menyiapkan order beli, supaya jumlahnya punya dasar dan " +
                "kerugian terburuknya diketahui di depan. Kembalikan juga kuantitas " +
                "koin yang siap dipakai crypto_prepare_order.",
            parameters: {
                type: "object",
                properties: {
                    saldoUsdt: { type: "number", description: "Saldo yang dipakai untuk trading (USDT)." },
                    entry: { type: "number", description: "Harga masuk." },
                    stop: { type: "number", description: "Harga stop (harus di bawah entry)." },
                    risikoPersen: { type: "number", description: "Persen saldo yang boleh hilang per posisi (default 1, maksimum 5)." },
                    maksPersenSaldo: { type: "number", description: "Batas modal per posisi dalam persen saldo (default 20)." }
                },
                required: ["saldoUsdt", "entry", "stop"]
            },
            execute: async (args) => engine.sizing(args)
        }),

        new AITool({
            name: "money_log",
            description:
                "Catat sebuah posisi/ide penghasilan ke jurnal cuan, atau TUTUP entri " +
                "yang sudah ada dengan hasil nyatanya (untung/rugi USDT). Berlaku juga " +
                "untuk pemasukan di luar crypto (jasa, jualan) — sumbernya bebas. " +
                "Catat saat posisi dibuka; tutup saat sudah tahu hasilnya. Tanpa ini " +
                "tidak ada yang bisa membuktikan strategi mana yang benar-benar " +
                "menghasilkan.",
            parameters: {
                type: "object",
                properties: {
                    aksi: { type: "string", description: "'catat' (buka entri baru) atau 'tutup' (isi hasilnya)." },
                    sumber: { type: "string", description: "Asal peluangnya, mis. 'spot-momentum', 'jasa-desain'. Untuk aksi catat." },
                    simbol: { type: "string", description: "Pasangan/aset bila ada, mis. SOLUSDT." },
                    modal: { type: "number", description: "Modal yang dipakai (USDT). Untuk aksi catat." },
                    id: { type: "string", description: "id entri yang ditutup. Untuk aksi tutup." },
                    hasilUsdt: { type: "number", description: "Hasil nyata: positif untung, negatif rugi. Untuk aksi tutup." },
                    catatan: { type: "string", description: "Catatan singkat." }
                },
                required: ["aksi"]
            },
            execute: async ({ aksi, sumber, simbol, modal, id, hasilUsdt, catatan } = {}) => {

                if (String(aksi).toLowerCase() === "tutup") {
                    if (!id) return { ok: false, error: "aksi tutup butuh id entri." };
                    if (!Number.isFinite(Number(hasilUsdt))) return { ok: false, error: "aksi tutup butuh hasilUsdt (boleh negatif)." };
                    return engine.tutup({ id, hasilUsdt, catatan });
                }

                if (!sumber) return { ok: false, error: "aksi catat butuh sumber." };

                return { ok: true, entri: engine.catat({ sumber, simbol, modal, catatan }) };

            }
        }),

        new AITool({
            name: "money_report",
            description:
                "Rapor uang APA ADANYA: total realisasi untung/rugi, jumlah posisi " +
                "selesai & terbuka, persentase menang, dan peringkat sumber penghasilan " +
                "dari yang paling menghasilkan sampai yang cuma sibuk. Pakai saat " +
                "pengguna bertanya 'sudah dapat berapa', 'strategi mana yang jalan', " +
                "atau saat kamu hendak memilih strategi — pilih berdasarkan angka ini, " +
                "bukan berdasarkan kesan.",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ ok: true, ...engine.rapor() })
        })

    ];

}

module.exports = { moneyTools };
