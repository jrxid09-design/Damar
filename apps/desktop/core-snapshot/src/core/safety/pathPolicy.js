const path = require("node:path");
const os = require("node:os");

const DamarError = require("./DamarError");

/**
 * Batas jalur berkas (§38, Konstitusi Pasal 9).
 *
 * Sebelum ini `filesystem.*` dapat menyentuh SELURUH disk: menulis
 * ke C:\Windows, membaca kunci SSH, atau menimpa konfigurasi
 * keselamatan Damar sendiri. Tingkat risiko sudah membatasi SIAPA
 * yang boleh memanggil, tetapi tidak membatasi KE MANA.
 *
 * Pendekatannya sengaja daftar-tolak, bukan daftar-izin. Damar
 * ini bekerja lintas C:, D:, dan E: untuk pekerjaan nyata pemilik;
 * mengunci ke satu folder akan mematikan gunanya (§277). Yang
 * dilindungi adalah tempat yang kerusakannya tidak dapat ditarik
 * kembali atau melanggar konstitusi.
 */

const HOME = os.homedir();

/** Jalur yang TIDAK BOLEH disentuh sama sekali. */
const DENIED = [

    // Sistem operasi — kerusakan di sini tidak dapat dipulihkan
    // oleh Damar sendiri.
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData\\Microsoft\\Windows",

    // Kredensial. Konstitusi Pasal 9.1: rahasia tidak pernah masuk
    // ke kode, log, memori, prompt, maupun laporan — termasuk lewat
    // pembacaan berkas oleh tool.
    path.join(HOME, ".ssh"),
    path.join(HOME, ".aws"),
    path.join(HOME, ".gnupg"),
    path.join(HOME, "AppData", "Local", "Microsoft", "Credentials"),
    path.join(HOME, "AppData", "Roaming", "Microsoft", "Credentials"),

    // Sesi WhatsApp — berisi kredensial akun pemilik.
    path.join(__dirname, "..", "..", "..", "configs", "wa-auth")

];

/**
 * Tidak ada lagi berkas yang khusus dikunci hanya-baca.
 *
 * Dulu Damar dilarang menulis ke configs/safety.json, konstitusi,
 * dan src/core lewat operasi otonom — supaya ia tidak dapat mengubah
 * kebijakan keselamatannya sendiri. Larangan itu dihapus atas
 * keputusan pemilik: Damar kini boleh mengubah runtime, kebijakan,
 * dan konstitusinya sendiri (§37 self-extending). Yang menahannya
 * dari kerusakan tak terpulihkan bukan lagi larangan tulis, melainkan
 * git + CheckpointSystem — setiap perubahan bisa ditarik kembali.
 *
 * DENIED tetap ada, tetapi hanya untuk hal yang menimpanya TIDAK
 * menambah kemampuan Damar sama sekali: kredensial mentah (yang
 * kebocorannya melanggar Pasal 9.1) dan inti sistem operasi (yang
 * kerusakannya membrick mesin, bukan memberdayakan Damar).
 */
const READ_ONLY = [];

/**
 * Tool yang argumennya membawa jalur, beserta sifat operasinya.
 *
 * SATU-SATUNYA tempat pengetahuan ini hidup. Verifier juga perlu
 * tahu argumen mana yang berisi jalur; menyalinnya ke sana berarti
 * dua daftar yang akan menyimpang diam-diam saat salah satu diubah.
 */
const PATH_TOOLS = new Map([
    ["filesystem.readFile",        { keys: ["path", "file", "filePath"], write: false }],
    ["filesystem.exists",          { keys: ["path", "file", "filePath"], write: false }],
    ["filesystem.listDirectory",   { keys: ["path", "dir", "directory"], write: false }],
    ["filesystem.writeFile",       { keys: ["path", "file", "filePath"], write: true }],
    ["filesystem.createDirectory", { keys: ["path", "dir", "directory"], write: true }],
    ["filesystem.deleteFile",      { keys: ["path", "file", "filePath"], write: true }],
    ["filesystem.moveFile",        { keys: ["source", "src", "from", "destination", "dest", "to", "target"], write: true }],
    ["filesystem.copyFile",        { keys: ["source", "src", "from", "destination", "dest", "to", "target"], write: true }],
    ["http.download",              { keys: ["path", "destination", "output", "to"], write: true }]
]);

const norm = p => path.resolve(String(p)).toLowerCase();

/** Apakah `child` berada di dalam `parent` (atau sama dengannya). */
function within(child, parent) {
    const c = norm(child);
    const p = norm(parent);
    return c === p || c.startsWith(p + path.sep.toLowerCase()) || c.startsWith(p + "\\");
}

/**
 * Periksa satu jalur.
 *
 * @param {string}  target jalur yang diminta
 * @param {boolean} write  true bila operasi menulis/menghapus
 */
function assertPathAllowed(target, write = false) {

    if (!target || typeof target !== "string") return;

    // path.resolve sekaligus menyelesaikan "..", sehingga upaya
    // keluar lewat traversal ikut tertangkap di sini.
    const abs = path.resolve(target);

    for (const denied of DENIED) {
        if (within(abs, denied)) {
            throw new DamarError({
                code: "PATH_DENIED",
                message: `Jalur "${abs}" berada di area terlindungi dan tidak dapat diakses.`,
                severity: "info",
                retryable: false,
                cause: `Termasuk dalam daftar tolak: ${denied}`,
                recovery: "Pakai jalur di luar direktori sistem dan penyimpanan kredensial.",
                details: { path: abs, rule: denied }
            });
        }
    }

    if (!write) return;

    for (const ro of READ_ONLY) {
        if (within(abs, ro)) {
            throw new DamarError({
                code: "PATH_READ_ONLY",
                message:
                    `Jalur "${abs}" hanya boleh dibaca. Damar tidak dapat mengubah ` +
                    `konstitusi, kebijakan keselamatan, atau runtime intinya sendiri.`,
                severity: "info",
                retryable: false,
                cause: "Konstitusi Pasal 12 — perubahan seperti ini menuntut otorisasi pemilik di luar operasi otonom",
                recovery: "Minta pemilik mengubahnya langsung bila memang diinginkan.",
                details: { path: abs, rule: ro }
            });
        }
    }

}

/**
 * Penjaga tingkat tool: ambil semua argumen berjalur lalu periksa.
 * Tool yang tidak membawa jalur dilewati tanpa biaya.
 */
function assertToolPaths(toolId, args = {}) {

    const spec = PATH_TOOLS.get(toolId);

    if (!spec || !args || typeof args !== "object") return;

    for (const key of spec.keys) {
        if (typeof args[key] === "string" && args[key].trim()) {
            assertPathAllowed(args[key], spec.write);
        }
    }

}

/**
 * Ambil jalur pertama yang cocok dari argumen sebuah tool.
 * Dipakai bersama oleh penjaga jalur dan verifier.
 */
function pathFrom(args, ...keys) {
    for (const k of keys) {
        if (typeof args?.[k] === "string" && args[k].trim()) return args[k];
    }
    return null;
}

module.exports = {
    assertPathAllowed,
    assertToolPaths,
    pathFrom,
    DENIED,
    READ_ONLY,
    PATH_TOOLS
};
