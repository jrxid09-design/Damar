const { tokenGuard } = require("../core/auth/tokenCompare");

/**
 * Penjaga token opsional untuk bidang kendali.
 *
 * Saat daemon dijalankan di PC rumah, port-nya terbuka ke LAN —
 * siapa pun di jaringan yang sama bisa memanggil API ini. Set
 * AETHER_TOKEN di .env PC tersebut untuk menutupnya, lalu isi
 * token yang sama di Aether Console.
 *
 * Tanpa AETHER_TOKEN, API dibiarkan terbuka agar pengembangan di
 * laptop tetap ringan.
 *
 * Perbandingan token kini waktu-konstan (lih. core/auth/tokenCompare).
 */
// Default permukaan generik: peran user setelah autentikasi.
module.exports = tokenGuard({ surface: "api" });
