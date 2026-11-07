/**
 * Katalog risiko tool — bentuk paling sederhana: destruktif atau tidak.
 *
 * Sebelumnya Damar memakai enam tingkat (L0–L5). Enam tingkat itu
 * membawa beban: setiap tool baru harus diklasifikasi, setiap ambang
 * harus dipahami, dan hierarki tingkat membuat Damar sulit
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
    // D Round-3: filesystem WRITES berefek samping — tidak boleh
    // diklasifikasi sebagai baca murni (dua tulisan berbarengan sulit
    // ditelusuri; RuntimeExecutor menyerialkannya).
    "filesystem.writeFile",
    "filesystem.moveFile",
    "filesystem.copyFile",
    "filesystem.createDirectory",
    "run-command.runCommand",
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
    "damarSkills.home_control",
    "damarSkills.device_on",
    "damarSkills.device_off",
    "damarSkills.device_toggle",
    "damarSkills.scene_activate",
    "damarSkills.set_temperature",
    "damarSkills.arrive_home",
    "damarSkills.leave_home",
    "cursor-control.controlCursor",
    "press-button.pressButton",
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

    // E-F — OUTBOUND MESSAGING & META-MUTATING: tidak pernah
    // read-only/parallel-safe (efek eksternal tak dapat ditarik,
    // atau mengubah kapabilitas Damar sendiri).
    //
    // Nama ditulis sebagai ID KANONIK TUNGGAL (tail-agnostic): entri
    // "wa_send" mengklasifikasikan SEMUA bentuk live-nya — native
    // "wa_send", bridged "damarSkills__wa_send", registry
    // "damarSkills.wa_send". Klasifikasi lebih berat arahnya dari
    // pada kurang (fail-closed); ini klasifikasi RISIKO, bukan
    // primitif otorisasi.
    "wa_send",
    "wa_broadcast",
    "wa_notify_owner",
    "wa_send_image",
    "wa_send_document",
    "wa_send_sticker",
    "whatsapp_send_photo",
    "whatsapp_send_document",
    "whatsapp_send_sticker",
    "whatsapp_send",
    "create_tool",
    "activate_tool",
    "remove_tool",
    "skill_build",

    // E-F — SKILL EKSTERNAL-VISIBLE / META-MUTATING (live ids):
    // mengirim laporan keluar atau mengubah keadaan Damar sendiri.
    "morning_briefing",
    "daily_report",
    "security_alert",
    "watch_and_notify",

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
 * yang dibuat Damar sendiri lewat forge. Sengaja pesimistis: yang
 * tidak dikenal dan terdengar berbahaya dianggap berbahaya.
 */
const PATTERNS = [
    anyOf("delete", "remove", "destroy", "wipe", "format", "drop", "purge", "uninstall"),
    anyOf("exec", "shell", "command", "spawn", "run", "sudo", "powershell", "bash"),
    anyOf("install", "restart", "shutdown", "reboot", "service", "registry", "kill"),
    // D-F: gerakan mouse = kendali desktop langsung (berefek ke UI).
    anyOf("control", "toggle", "switch", "press", "click", "type", "cursor", "activate", "mouse")
];

/**
 * Apakah sebuah tool destruktif.
 *
 * E-F — klasifikasi terhadap ID KANONIK LIVE, bukan hanya string
 * persis: setiap id dinormalisasi ke TIGA bentuk kandidat
 *   1. apa adanya (nama model-facing, mis. "damarSkills__wa_send")
 *   2. bentuk dotted registry ("damarSkills.wa_send")
 *   3. tail kanonik ("wa_send") — ruas terakhir setelah "__"/"."/"-"
 * lalu dicek ke katalog. Dulu katalog berisi nama bare sementara
 * model menjalankan nama bridged — wa_send dsb. lolos sebagai
 * "read-only" dan dua pesan keluar dirangkai paralel.
 *
 * Urutan: deklarasi tool sendiri → katalog (3 bentuk) → pola nama →
 * tidak. Tool tak dikenal TIDAK dianggap berbahaya — gerbang yang
 * menahan segalanya hanya membuat Damar tidak bisa dipakai. Yang
 * berbahaya harus disebutkan namanya, bukan ditebak.
 *
 * CATATAN batas: ini KLASIFIKASI RISIKO (arah pesimis aman) — bukan
 * primitif otorisasi; keanggotaan capabilitySet tetap kanonik-persis
 * di Authorization (tail tidak pernah memberi izin).
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

    const raw = String(id ?? "");

    // Tiga bentuk kandidat dari SATU id live. Tail mengikuti semantik
    // CapabilityIndex.tail: pemisah "__"/"." SAJA — garis bawah tunggal
    // adalah bagian nama tool ("wa_send" bukan "wa" + "send").
    const tailOf = s => String(s ?? "").split(/__|\./).pop();

    const dotted = raw.includes("__") ? raw.replace(/__/g, ".") : raw;

    const candidates = new Set([raw, dotted, tailOf(raw), tailOf(dotted)]);

    for (const candidate of candidates) {
        if (DESTRUCTIVE.has(candidate)) return true;
    }

    for (const re of PATTERNS) {
        if (re.test(raw)) return true;
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
