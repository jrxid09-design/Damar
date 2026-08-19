const path = require("node:path");

/**
 * Batas untuk kode dan perintah yang dijalankan Aether (§38).
 *
 * Aether dapat mengubah dan menjalankan kodenya sendiri. Sampai
 * sekarang itu terjadi di ruang yang sama persis dengan yang
 * menjalankannya: proses anak mewarisi SELURUH environment induk —
 * termasuk `AETHER_TOKEN`, kunci OpenRouter, dan kredensial lain —
 * dan bebas bekerja di direktori mana pun.
 *
 * Yang dilakukan modul ini, dan jujur hanya ini:
 *
 *   1. **Rahasia tidak ikut.** Environment disusun ulang dari
 *      daftar-izin, bukan disaring dari daftar-larang. Variabel baru
 *      yang belum terpikirkan otomatis tidak ikut, bukan otomatis
 *      lolos.
 *   2. **Direktori kerja terkurung** ke akar proyek.
 *   3. **Batas waktu** supaya perintah yang menggantung tidak
 *      menahan Aether selamanya.
 *   4. **Batas keluaran** supaya proses cerewet tidak menghabiskan
 *      memori.
 *
 * Yang TIDAK dilakukan, dan penting untuk tidak dilupakan: ini bukan
 * jail sistem operasi. Perintah tetap berjalan dengan hak pengguna
 * yang sama, tetap dapat menyentuh jaringan, dan tetap dapat membaca
 * berkas di luar proyek bila memakai jalur mutlak. Yang menahan hal
 * terakhir adalah `pathPolicy`, bukan modul ini. Menyebutnya
 * "sandbox penuh" akan menciptakan rasa aman yang tidak ditopang
 * apa pun.
 */

const ROOT = path.join(__dirname, "..", "..", "..");

/**
 * Variabel yang boleh dilihat proses anak.
 *
 * Daftar-izin, bukan daftar-larang: kunci API berikutnya yang
 * ditambahkan ke `.env` tidak akan bocor hanya karena tak ada yang
 * ingat menambahkannya ke daftar larangan.
 */
const IZIN = [
    "PATH", "Path", "PATHEXT",
    "SystemRoot", "windir", "COMSPEC", "TEMP", "TMP",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "LANG", "LC_ALL", "TZ",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
    "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "ProgramFiles",
    "NODE_ENV", "NODE_PATH", "npm_config_cache"
];

/** Pola nama variabel yang tidak pernah boleh ikut, apa pun namanya. */
const RAHASIA = /token|key|secret|password|passwd|credential|auth|api[_-]?key|session|cookie/i;

/**
 * Susun environment untuk proses anak.
 *
 * @param {object} [tambahan] variabel yang memang perlu diteruskan
 */
function env(tambahan = {}) {

    const out = {};

    for (const nama of IZIN) {
        if (process.env[nama] !== undefined && !RAHASIA.test(nama)) {
            out[nama] = process.env[nama];
        }
    }

    // Tambahan dari pemanggil tetap disaring: kelalaian di satu
    // tempat tidak boleh membatalkan seluruh batas.
    for (const [nama, nilai] of Object.entries(tambahan)) {
        if (!RAHASIA.test(nama)) out[nama] = String(nilai);
    }

    return out;

}

/** Direktori kerja yang diizinkan; di luar itu dikembalikan ke akar. */
function cwd(diminta) {

    if (!diminta) return ROOT;

    const penuh = path.resolve(ROOT, String(diminta));

    const relatif = path.relative(ROOT, penuh);

    const diLuar = relatif.startsWith("..") || path.isAbsolute(relatif);

    return diLuar ? ROOT : penuh;

}

/** Opsi lengkap untuk `child_process`, siap dipakai apa adanya. */
function options({
    cwd: dimintaCwd = null,
    timeout = 120000,
    maxBuffer = 8 * 1024 * 1024,
    env: tambahan = {}
} = {}) {

    return {
        cwd: cwd(dimintaCwd),
        env: env(tambahan),
        timeout,
        maxBuffer,
        windowsHide: true
    };

}

/** Apa yang benar-benar dijaga — untuk ditampilkan apa adanya ke pemilik. */
function describe() {
    return {
        root: ROOT,
        allowedEnv: IZIN.length,
        secretsBlocked: true,
        note:
            "Rahasia tidak diwariskan, cwd terkurung ke akar proyek, ada batas waktu dan keluaran. " +
            "BUKAN jail sistem operasi: perintah tetap berjalan dengan hak pengguna yang sama dan " +
            "tetap dapat menyentuh jaringan."
    };
}

module.exports = { env, cwd, options, describe, ROOT, IZIN, RAHASIA };
