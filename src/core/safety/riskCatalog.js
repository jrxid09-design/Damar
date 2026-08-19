/**
 * Katalog risiko tool — bentuk paling sederhana: destruktif atau tidak.
 *
 * Sebelumnya Aether memakai enam tingkat (L0–L5). Enam tingkat itu
 * membawa beban: setiap tool baru harus diklasifikasi, setiap ambang
 * harus dipahami, dan hierarki tingkat membuat Aether sulit
 * dikontrol. Kini hanya ada satu pertanyaan:
 *
 *   "Bisakah tindakan ini menghapus data, mengeksekusi perintah
 *    sembarang, atau mengubah mesin/dunia nyata?"
 *
 * Ya → destruktif: ditahan gerbang sampai pemilik memberi izin.
 * Tidak → bebas: berjalan langsung, tetap tercatat di audit.
 *
 * Tool boleh mendeklarasikan dirinya lewat `metadata.destructive`
 * atau `metadata.risk`; katalog ini untuk tool warisan yang belum
 * melakukannya, dan sebagai jaring pengaman bagi tool baru.
 */

/**
 * Klasifikasi eksplisit tool yang BERBAHAYA. Ditulis manual karena
 * menebak dari nama saja keliru dua arah: `security_sweep` terdengar
 * menakutkan padahal hanya membaca, sedangkan `orchestrate`
 * terdengar netral padahal dapat merantai tool lain.
 */
const DESTRUCTIVE = new Set([

    // ---- Eksekusi sembarang / kehilangan data permanen -----------
    "filesystem.deleteFile",
    "run-command.runCommand",
    "aetherSkills.hermes_run",
    "aetherSkills.openclaw_do",
    "terminal_run",
    "kali_run",

    // ---- Kendali HP (setara kendali desktop) ---------------------
    "android_tap",
    "android_swipe",
    "android_type",
    "android_key",
    "android_open_app",
    "android_shell",

    // ---- Mengubah mesin atau dunia fisik -------------------------
    "aetherSkills.home_control",
    "aetherSkills.device_on",
    "aetherSkills.device_off",
    "aetherSkills.device_toggle",
    "aetherSkills.scene_activate",
    "aetherSkills.set_temperature",
    "aetherSkills.arrive_home",
    "aetherSkills.leave_home",
    "cursor-control.controlCursor",
    "press-button.pressButton",
    "aetherSkills.openclaw_open_app",
    "aetherSkills.openclaw_type",
    "aetherSkills.openclaw_web",
    "add_hanriver_camera.addHanriverCamera",
    "terminal_restart",
    "terminal_stop",
    "home_control",

    // ---- Kendali desktop langsung --------------------------------
    // Mengetik / menekan tombol ke aplikasi orang lain bisa memicu
    // kirim, hapus, atau perintah — disetarakan dengan kendali UI.
    "open_app",
    "fill_form",
    "desktop_type",
    "desktop_press",

    // ---- Mengirim media keluar ----------------------------------
    // Pesan/berkas yang sudah terkirim tidak dapat ditarik kembali,
    // dan berkas lokal bisa memuat hal pribadi — disetarakan dengan
    // kirim pesan lainnya.
    "send_immich_photo",
    "send_file",
    "send_media_url",

    // ---- OSINT (investigasi) ------------------------------------
    // Investigasi menyentuh data pihak ketiga; hanya untuk yang sah.
    "osint_investigate",
    "osint_email",
    "osint_username",
    "osint_phone",
    "osint_domain",
    "osint_breach",
    "osint_phone_assess",
    "osint_phone_blacklist",
    "osint_track_register",
    "osint_case_create",
    "osint_case_add_finding",
    "osint_case_close",
    "osint_case_delete",
    "osint_social_bot",
    "osint_social_comments",
    "osint_social_location",
    "osint_hoax_check",
    "osint_hoax_trace",
    "osint_social_network",

    // ---- Media player -------------------------------------------
    // Memutar konten eksternal bisa memuat iklan/tracker; hanya
    // untuk konten yang diminta pengguna secara eksplisit.
    "play_youtube",
    "play_media"

]);

/**
 * Kata harus berdiri sebagai kata, bukan potongan.
 *
 * Pola substring lama menurunkan risiko secara diam-diam: "get" ada
 * di dalam "for-get", sehingga `memory_forget` terbaca sebagai
 * pembacaan murni. Cocok bila kata berada di awal id, sesudah
 * pemisah (`_`, `.`, `-`), atau sebagai punuk camelCase
 * (`readFile`, `runCommand`).
 */
const word = w => new RegExp(
    `(?:^|[_.\\-])${w}(?![a-z])` +
    `|(?<=[a-z0-9])${w[0].toUpperCase()}${w.slice(1)}(?![a-z])`
);

const anyOf = (...words) => {
    const res = words.map(word);
    return { test: id => res.some(re => re.test(id)) };
};

/**
 * Pola cadangan untuk tool yang belum terdaftar — termasuk tool
 * yang dibuat Aether sendiri lewat forge. Sengaja pesimistis: yang
 * tidak dikenal dan terdengar berbahaya dianggap berbahaya.
 */
const PATTERNS = [
    anyOf("delete", "remove", "destroy", "wipe", "format", "drop", "purge", "uninstall"),
    anyOf("exec", "shell", "command", "spawn", "run", "sudo", "powershell", "bash"),
    anyOf("install", "restart", "shutdown", "reboot", "service", "registry", "kill"),
    anyOf("control", "toggle", "switch", "press", "click", "type", "cursor", "activate")
];

/**
 * Apakah sebuah tool destruktif.
 *
 * Urutan: deklarasi tool sendiri → katalog → pola nama → tidak.
 * Tool tak dikenal TIDAK dianggap berbahaya — gerbang yang menahan
 * segalanya hanya membuat Aether tidak bisa dipakai. Yang berbahaya
 * harus disebutkan namanya, bukan ditebak.
 *
 * @param {string} id
 * @param {object} [tool] objek tool (untuk membaca deklarasinya)
 * @returns {boolean}
 */
function riskOf(id, tool = null) {

    const declared = tool?.metadata?.destructive ?? tool?.destructive
        ?? tool?.metadata?.risk ?? tool?.risk;

    if (declared === true || declared === false) {
        return declared;
    }

    if (DESTRUCTIVE.has(id)) {
        return true;
    }

    // Tool jembatan memakai `__` sebagai pemisah ruas
    // (`aetherSkills__device_on`); katalog menuliskan bentuk titik.
    const dotted = id.includes("__") ? id.replace(/__/g, ".") : id;

    if (dotted !== id && DESTRUCTIVE.has(dotted)) {
        return true;
    }

    for (const re of PATTERNS) {
        if (re.test(id)) return true;
    }

    return false;

}

/**
 * Ringkasan untuk UI & audit: berapa tool berbahaya.
 */
function summarize(ids = []) {

    let destructive = 0;

    for (const id of ids) {
        if (riskOf(id)) destructive += 1;
    }

    return { destructive, safe: ids.length - destructive };

}

module.exports = { riskOf, summarize, DESTRUCTIVE };
