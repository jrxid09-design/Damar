/**
 * Pemilih tool: PROFIL yang stabil, bukan rakitan per pesan.
 *
 * Damar mendaftarkan 142 tool. Mengirim semuanya membuat prompt
 * menembus 10.000 token, jadi harus dipilih. Versi sebelumnya
 * merakit daftar segar untuk tiap pesan berdasarkan skor kecocokan —
 * hemat token, dan ternyata itu keputusan yang salah.
 *
 * Diukur pada mesin ini (llama3.1, CPU):
 *
 *   daftar tool SAMA, diulang     → prompt eval 0,19–0,39 dtk
 *   daftar tool BERUBAH           → prompt eval 7,6–12,5 dtk
 *   pertanyaan lain, tool sama    → prompt eval 0,39 dtk
 *
 * Inferensi lokal memakai ulang prefix prompt di tingkat token. Definisi tool
 * berada di awal prompt, jadi mengganti daftarnya membatalkan cache
 * dan memaksa evaluasi ulang dari nol. Merakit daftar baru tiap
 * pesan berarti membayar 8–12 detik untuk menghemat beberapa ratus
 * token — tukar yang merugikan, dan justru pada mesin lokal yang
 * paling terasa lambat.
 *
 * Karena itu daftar kini dipilih dari beberapa PROFIL tetap. Pesan
 * yang serupa memakai profil yang sama, sehingga percakapan yang
 * berlanjut menikmati cache. Tool INTI selalu berada di urutan
 * pertama dan sama persis di semua profil: berpindah profil hanya
 * membatalkan cache mulai titik perbedaannya, bukan dari awal.
 *
 * Setel DAMAR_TOOL_BUDGET=0 untuk mematikan (kirim semua tool).
 */

/**
 * Inti — identik dan berurutan sama di SETIAP profil.
 *
 * Urutannya bagian dari kontrak: satu tool yang bertukar tempat
 * sudah cukup membatalkan cache prefix untuk semua yang mengikutinya.
 */
const CORE = [
    "memory_recall",
    "memory_remember",
    "system.time.currentTime",
    "filesystem.readFile",
    "filesystem.writeFile",
    "filesystem.listDirectory",
    // Otonomi — selalu tersedia: gap kapabilitas adalah jalur kerja
    // Damar, bukan kemampuan opsional (§2 fixed-capability thinking).
    "goal_run",
    "capability_search",
    "skill_build",
    "tool_exec",
    // Pembuatan kemampuan baru — WAJIB ikut inti.
    //
    // System prompt memerintahkan: "kalau pengguna meminta kemampuan
    // baru, kamu WAJIB memakai create_tool". Kedua tool ini terdaftar
    // di registry, tetapi dulu tidak ada di inti MAUPUN di satu pun
    // profil — jadi selektor tidak pernah bisa melampirkannya. Model
    // membaca perintah itu, tidak menemukan tool-nya, lalu menjawab
    // "create_tool belum terpasang di sesi ini" sambil mengarang sebab
    // (backend mati, toggle belum aktif). Bukan modelnya yang salah:
    // promptnya memang menjanjikan tool yang tak pernah dikirim.
    "create_tool",
    "activate_tool",
    // Layar adalah saluran KELUARAN Damar di Console, bukan
    // kemampuan sampingan.
    //
    // Dulu ketiganya hanya hidup di profil `galeri`, jadi permintaan
    // seperti "kirimkan foto Ronny" yang jatuh ke profil `pesan`
    // tidak punya satu pun cara menampilkan sesuatu — model lalu
    // menempelkan URL mentah ke dalam balasan chat. Menampilkan harus
    // selalu bisa, apa pun profilnya.
    "show_image",
    "show_video",
    "open_document",
    // Pemutar juga: system prompt menjanjikan "lagu langsung diputar",
    // dan janji itu harus ditepati di profil mana pun — bukan hanya
    // saat kalimatnya kebetulan memicu profil `musik`.
    "play_youtube",
    "play_media"
];

/**
 * Profil: tambahan tetap sesudah inti.
 *
 * Sengaja sedikit dan berbutir kasar. Makin banyak profil, makin
 * jarang dua pesan berturut-turut memakai daftar yang sama — dan
 * manfaat cache-nya hilang.
 */
const PROFILES = {

    rumah: ["home_analyze", "home_control", "home_devices", "home_state"],

    pesan: [
        "whatsapp_send_photo", "whatsapp_send_document",
        "wa_send", "wa_status",
        "send_immich_photo", "send_file", "send_media_url"
    ],

    kamera: ["see_camera", "list_cameras", "count_people_camera", "describe_image"],

    galeri: [
        "find_people", "search_photos", "photos_summary",
        "show_image", "show_video", "open_document",
        "send_immich_photo", "send_file", "send_media_url"
    ],

    coding: [
        "opencode_run", "think_deeply",
        "code_graph_query", "code_plan", "code_definition", "code_references",
        "code_diagnostics", "code_test", "code_branch", "code_diff", "code_review", "code_commit"
    ],

    keamanan: [
        "sec_secret_scan", "sec_code_audit", "sec_dep_audit",
        "code_review", "code_diff", "code_graph_query"
    ],

    kali: [
        "kali_run", "kali_tools", "kali_which", "kali_status",
        "terminal_run", "sec_code_audit"
    ],

    ml: [
        "ml_env", "ml_run", "terminal_run", "code_plan",
        "code_graph_query", "kali_run"
    ],

    android: [
        "android_devices", "android_screenshot", "android_tap", "android_swipe",
        "android_type", "android_key", "android_open_app", "android_apps",
        "android_notifications", "android_info", "android_connect", "android_shell",
        "show_image"
    ],

    sistem: [
        "world_describe", "terminal_list", "terminal_read", "terminal_run",
        "terminal_restart",
        "system_health", "nas_status", "nas_pools"
    ],

    // Pertanyaan tentang kemampuan Damar sendiri. Tanpa profil ini,
    // "buatkan skill image generation" tersangkut ke profil `galeri`
    // (dipicu kata "gambar") dan model dikirimi tool foto — bukan
    // tool untuk membangun kemampuan.
    kemampuan: [
        "list_tools", "tool_info", "skill_list",
        "checkpoint_create", "checkpoint_list"
    ],

    desktop: [
        "open_app", "fill_form", "desktop_type", "desktop_press", "desktop_windows",
        "captureScreen", "scanScreen"
    ],

    memori: ["memory_related", "memory_entities", "memory_documents", "memory_forget", "build_recall"],

    // `browse` disebut eksplisit di system prompt ("membaca web
    // (browse)") tapi dulu tidak ada di sini — janji yang tak pernah
    // ditepati selektor.
    web: ["browse", "get", "post", "download"],

    musik: ["play_youtube", "play_spotify", "play_media", "search_music", "stop_media"],

    // Crypto/pasar. Tanpa profil ini "tampilkan chart live BTC"
    // tersangkut ke `galeri` (dipicu kata "tampilkan") dan model
    // dikirimi tool foto — show_chart maupun crypto_* tidak ada di
    // inti MAUPUN profil mana pun, jadi chart tak pernah bisa muncul.
    // Introspeksi. Keadaan batin sudah ikut ke tiap prompt lewat
    // Mind.stateOfMind(), tapi untuk melihat lebih dalam — potret
    // penuh, refleksi yang tersimpan, pembacaan empati — model butuh
    // toolnya benar-benar terlampir.
    kesadaran: ["self_state", "think_deeply", "self_reflect", "self_note", "empathy_read", "memory_related"],

    crypto: [
        "money_scan", "money_size", "money_report", "money_log",
        "show_chart",
        "crypto_price", "crypto_analyze", "crypto_portfolio", "crypto_positions",
        "crypto_prepare_order", "crypto_confirm_order",
        "crypto_set_alert", "crypto_bot_create", "crypto_bot_list"
    ]

};

/** Kata pemicu per profil — sisi Indonesia dari deskripsi berbahasa Inggris. */
const PEMICU = {
    kesadaran: [
        "kamu lagi gimana", "kamu ngerasain", "perasaanmu", "perasaan kamu",
        "kamu sadar", "kesadaran", "kamu merasa", "suasana hatimu", "mood kamu",
        "introspeksi", "renungkan", "refleksi", "kamu siapa", "dirimu",
        "pikirkan matang", "pikir dalam", "timbang", "wataknya", "karaktermu",
        "empati", "capek", "kesal", "sedih", "marah"
    ],
    // `crypto` dinilai SEBELUM `galeri`: "tampilkan chart BTC" berisi
    // "tampilkan" (galeri) dan "chart"+"btc" (crypto); seri dimenangkan
    // yang diperiksa lebih dulu, dan yang benar di sini adalah crypto.
    crypto: [
        "chart", "grafik", "candle", "crypto", "kripto", "bitcoin", "btc", "eth",
        "binance", "koin", "portofolio", "trading", "saham", "sinyal", "harga",
        "beli", "jual", "posisi", "futures", "cuan", "untung", "profit", "peluang",
        "uang", "modal", "rugi", "duit", "penghasilan"
    ],
    rumah: ["lampu", "saklar", "ac", "suhu", "rumah", "perangkat", "scene", "nyalakan", "matikan", "kipas", "kondisi"],
    // `galeri` sengaja dinilai SEBELUM `pesan`.
    //
    // Kata "kirim" ada di keduanya, jadi "kirimkan foto Ronny" berakhir
    // seri — dan seri dimenangkan yang diperiksa lebih dulu. Dengan
    // urutan lama, pemenangnya `pesan`: model dapat tool pengirim
    // WhatsApp tetapi tidak satu pun tool untuk MENCARI fotonya.
    // `galeri` memuat pencarian sekaligus penampil, jadi ia pilihan
    // yang benar saat ada kata benda media dalam kalimat.
    galeri: ["foto", "galeri", "immich", "gambar", "album", "wajah", "siapa saja", "tampilkan", "tunjukkan", "kirim", "ambil", "dari galeri"],
    pesan: ["wa", "whatsapp", "pesan", "kirim", "broadcast", "chat ke", "kirimkan", "telegram", "berkas", "dokumen"],
    kamera: ["kamera", "cctv", "lihat", "pantau", "wajah", "rekaman"],
    musik: ["lagu", "musik", "putar", "mainkan", "play", "youtube", "spotify", "dengar", "video klip", "nyanyi", "karaoke", "lagu anak", "potong bebek"],
    coding: ["kode", "code", "bug", "error", "test", "commit", "branch", "refactor", "fungsi", "berkas kode"],
    keamanan: ["keamanan", "security", "rentan", "kerentanan", "celah", "vulnerability", "audit keamanan", "hardening", "cve", "bocor", "kebocoran", "xss", "sql injection", "injeksi", "diretas", "peretas"],
    kali: ["kali", "nmap", "sqlmap", "metasploit", "msfconsole", "hydra", "nikto", "gobuster", "hashcat", "aircrack", "wireshark", "burp", "recon", "scan port", "pemindaian", "pentest", "penetration", "exploit", "eksploitasi", "payload", "reverse shell", "wifi", "brute force", "arsenal"],
    ml: ["ml", "machine learning", "deep learning", "model", "training", "latih", "dataset", "neural", "torch", "pytorch", "tensorflow", "transformer", "embedding", "fine-tune", "finetune", "inferensi", "gpu", "cuda", "eksperimen", "hyperparameter", "akurasi", "loss", "benchmark model", "rag", "llm", "arsitektur ai"],
    android: ["android", "hp", "ponsel", "handphone", "smartphone", "adb", "layar hp", "ketuk", "tap", "swipe", "geser layar", "buka aplikasi", "buka app", "notifikasi hp", "screenshot hp", "tangkap layar", "whatsapp di hp", "kendalikan hp", "kontrol hp", "gawai"],
    sistem: ["jalankan", "perintah", "command", "docker", "npm", "proses", "restart", "disk", "memori sistem", "layanan", "terminal", "nas", "penyimpanan"],
    desktop: ["buka", "aplikasi", "notepad", "ketik", "tulis", "isi form", "form", "klik", "tekan", "layar", "jendela", "app"],
    memori: ["ingat", "catat", "lupa", "simpan", "kenal", "siapa", "hubungan", "terkait"],
    web: ["cari", "browsing", "internet", "web", "url", "unduh", "download"],
    kemampuan: [
        "skill", "kemampuan", "tool", "plugin", "kamu bisa apa", "bisa apa",
        "buatkan skill", "bikin skill", "buat tool", "bikin tool", "checkpoint"
    ]
};

/**
 * Tool yang selalu disertakan — tulang punggung Damar.
 *
 * Dicocokkan pada RUAS TERAKHIR nama, karena tool hidup dengan dua
 * gaya penamaan: tool asli memakai namanya sendiri (`memory_recall`),
 * sedangkan tool plugin dijembatani dengan awalan (`filesystem.readFile`
 * menjadi `filesystem__readFile`). Daftar lama menuliskan `readFile`
 * begitu saja dan mencocokkannya persis — sehingga TIDAK PERNAH cocok,
 * dan justru ketiga tool berkas inilah yang diam-diam kehilangan
 * jaminannya sementara komentar di sini menjanjikan sebaliknya.
 *
 * `terminal_run` sengaja TIDAK di sini. Ia destruktif dan ditahan
 * gerbang; menjamin satu slot untuk tool yang akan ditolak memboroskan
 * anggaran dan — terbukti pada percobaan langsung — menuntun model
 * memilihnya bahkan untuk hal sesederhana menanyakan jam. Ia tetap
 * dapat terpilih ketika pengguna memang meminta menjalankan perintah.
 */
const ALWAYS = new Set([
    "memory_remember",
    "memory_recall",
    "readFile",
    "writeFile",
    "listDirectory",
    "currentTime"
]);

/**
 * Apa yang dikirim saat tak satu pun tool relevan.
 *
 *   "none"     — tidak ada (bawaan): tercepat, dan pesan yang tidak
 *                menyinggung kemampuan apa pun memang tidak
 *                membutuhkannya
 *   "backbone" — tulang punggung tetap dikirim: model masih bisa
 *                mengingat atau membaca berkas atas inisiatif
 *                sendiri, dengan bayaran ± 16 detik per pesan
 */
function idleMode() {
    return String(process.env.DAMAR_TOOLS_WHEN_IDLE || "none").toLowerCase();
}

/**
 * Adakah tool yang benar-benar disinggung permintaan ini?
 *
 * Dinilai atas kecocokan sesungguhnya, TERMASUK tool tulang
 * punggung. Mengecualikan mereka akan membuat "jam berapa sekarang"
 * terbaca sebagai obrolan biasa — padahal tool waktu yang
 * dibutuhkannya justru ada di tulang punggung.
 */
function relevantAny(tools, haystack) {
    return tools.some(tool => score(tool, haystack) > 0);
}

/** Ruas terakhir nama tool: `filesystem__readFile` -> `readFile`,
 *  `system.time.currentTime` -> `currentTime`. */
function tail(name) {
    return String(name ?? "").split(/__|\./).pop();
}

/** Apakah tool termasuk tulang punggung, apa pun gaya penamaannya. */
function isAlways(tool) {
    return ALWAYS.has(tool?.name) || ALWAYS.has(tail(tool?.name));
}

/**
 * Apakah tool berasal dari server MCP eksternal.
 *
 * Nama bridge MCP: `mcp__{serverId}__{toolName}` (lihat McpClient).
 * Mereka tidak masuk profil tetap (daftarnya dinamis), jadi dipilih
 * terpisah di susun() berdasarkan skor kecocokan dengan pesan.
 */
function isExternal(tool) {
    // H10: delegasi ke provenance kanonik.
    try {
        return require("./CapabilityIndex").provenanceOf(tool).external;
    }
    catch {
        return String(tool?.name ?? "").startsWith("mcp__");
    }
}

/**
 * Kata kunci per tool di luar nama/deskripsi, untuk menjembatani
 * bahasa sehari-hari ke nama tool teknis.
 */
const HINTS = {
    home: ["lampu", "saklar", "ac", "suhu", "rumah", "perangkat", "scene", "nyalakan", "matikan"],
    camera: ["kamera", "cctv", "lihat", "pantau", "orang", "wajah"],
    whatsapp: ["wa", "whatsapp", "pesan", "kirim", "broadcast"],
    terminal: ["jalankan", "perintah", "command", "docker", "npm", "python", "proses", "restart"],
    memory: ["ingat", "catat", "lupa", "simpan", "kenal", "siapa"],
    photo: ["foto", "galeri", "immich", "gambar", "album", "ambil", "kirim", "tampilkan"],
    music: ["lagu", "musik", "putar", "mainkan", "play", "youtube", "dengar", "video"],
    desktop: ["buka", "aplikasi", "notepad", "ketik", "klik", "layar", "jendela", "isi"],
    app: ["buka", "aplikasi", "jalankan", "program"],
    form: ["isi", "form", "kolom", "ketik"],
    file: ["file", "berkas", "folder", "direktori", "baca", "tulis"],
    web: ["cari", "browsing", "internet", "web", "url", "unduh", "download"],
    chart: ["chart", "grafik", "candle", "live"],
    crypto: ["crypto", "kripto", "bitcoin", "btc", "eth", "koin", "binance", "portofolio", "trading", "harga", "beli", "jual"],
    opencode: ["opencode", "kode", "coding", "program", "bug", "refactor", "commit", "test kode", "perbaiki kode", "tulis kode", "ubah kode"],

    // Deskripsi tool ditulis dalam bahasa Inggris, pertanyaan
    // pengguna dalam bahasa Indonesia — tanpa jembatan ini
    // "jam berapa sekarang" tidak cocok dengan apa pun, dan model
    // memakai tool lain yang kebetulan terkirim.
    time: ["jam", "waktu", "tanggal", "hari", "sekarang", "pukul"]
};

function normalise(text) {
    return String(text ?? "").toLowerCase();
}

/** Bobot kecocokan satu tool terhadap teks permintaan. */
function score(tool, text) {

    const name = normalise(tool.name);
    const description = normalise(tool.description);

    let value = 0;

    // Nama tool disebut langsung — sinyal terkuat.
    if (text.includes(name.replace(/_/g, " ")) || text.includes(name)) {
        value += 10;
    }

    // Potongan nama (mis. "home_control" -> "home", "control").
    for (const part of name.split(/[_\-.]/)) {

        if (part.length >= 4 && text.includes(part)) {
            value += 3;
        }

    }

    // Kata penting dari deskripsi.
    for (const word of new Set(description.split(/[^a-z0-9]+/))) {

        if (word.length >= 5 && text.includes(word)) {
            value += 1;
        }

    }

    // Petunjuk bahasa sehari-hari.
    for (const [key, words] of Object.entries(HINTS)) {

        if (!name.includes(key) && !description.includes(key)) {
            continue;
        }

        for (const word of words) {

            if (text.includes(word)) {
                value += 2;
                break;
            }

        }

    }

    return value;

}

/**
 * Profil yang paling disinggung pesan ini, atau null bila tak satu pun.
 *
 * Satu profil, bukan gabungan: menggabungkan dua profil menciptakan
 * daftar baru yang belum pernah dipakai, dan itu persis yang
 * membatalkan cache.
 */
/**
 * Kata yang MENENTUKAN, bukan sekadar menyinggung.
 *
 * "kirim" muncul di profil pesan maupun galeri, jadi "kirim foto ini
 * ke whatsapp istri" berakhir seri 2-2 dan dimenangkan urutan daftar
 * belaka — model dapat tool galeri tanpa satu pun cara mengirim.
 * Menyebut nama platform atau tujuan adalah bukti yang jauh lebih
 * kuat daripada kata kerja umum, jadi bobotnya tiga kali.
 */
const PEMICU_KUAT = new Set(["whatsapp", "telegram", "broadcast", "chat ke"]);

function chooseProfile(haystack) {

    let terpilih = null;
    let tertinggi = 0;

    for (const [nama, kata] of Object.entries(PEMICU)) {

        let nilai = 0;
        for (const k of kata) {
            if (haystack.includes(k)) nilai += PEMICU_KUAT.has(k) ? 3 : 1;
        }

        if (nilai > tertinggi) {
            tertinggi = nilai;
            terpilih = nama;
        }

    }

    return terpilih;

}

/** Cari tool terdaftar yang cocok dengan sebuah nama — nama persis,
 *  ruas terakhir, atau ruas terakhir dari bentuk titik/plugin. */
function cari(tools, nama) {

    const direct = tools.find(t => t.name === nama || tail(t.name) === nama);

    if (direct) return direct;

    // Nama profil polos ("readFile") harus cocok dengan bentuk
    // terdaftar ("filesystem.readFile" / "filesystem__readFile").
    return tools.find(t => tail(t.name) === tail(nama)) ?? null;

}

/**
 * @param {Array} tools     seluruh tool terdaftar
 * @param {string} text     pesan terakhir pengguna
 * @param {number} budget   jumlah maksimum tool yang dikirim
 * @returns {Array}         inti dulu, lalu tambahan profil — urutan tetap
 */
function selectTools(tools = [], text = "", budget = 32) {

    if (!Array.isArray(tools) || budget <= 0 || tools.length <= budget) {
        return tools;
    }

    const haystack = normalise(text);

    const profil = chooseProfile(haystack);

    // Melampirkan tool sama sekali punya harga tetap: template
    // tool-calling llama3.1 memakan ± 600 token sebelum tool pertama
    // ikut dihitung (diukur: tanpa tool 12 token/1,8 dtk, dengan 6
    // tool 789 token/15,5 dtk). Untuk sapaan dan ucapan terima kasih
    // itu membeli nol manfaat.
    //
    // Yang penting: "tanpa tool" juga sebuah keadaan STABIL, jadi
    // obrolan beruntun tetap menikmati cache prefix.
    //
    // Setel DAMAR_TOOLS_WHEN_IDLE=backbone untuk selalu mengirim inti.
    if (!profil && !relevantAny(tools, haystack)) {
        return idleMode() === "backbone" ? susun(tools, [], budget, haystack) : [];
    }

    return susun(tools, profil ? PROFILES[profil] : [], budget, haystack);

}

/**
 * Rakit daftar: inti dulu (sama di semua profil), lalu tambahannya.
 *
 * Inti didahulukan supaya perpindahan profil hanya membatalkan cache
 * mulai titik perbedaan — bukan dari token pertama.
 */
function susun(tools, tambahan, budget, haystack = "") {

    // Inti tidak boleh menghabiskan seluruh anggaran.
    //
    // Inti kini 17 tool. Pada anggaran kecil ia melahap semuanya dan
    // profilnya tak kebagian slot sama sekali — "kirim foto ini ke
    // whatsapp istri" berakhir tanpa satu pun tool WhatsApp.
    //
    // Enam yang pertama (memori, waktu, berkas) adalah tulang punggung
    // dan tidak pernah dikorbankan; sisa inti — otonomi, pembuat skill,
    // penampil media — mengalah bila ruangnya menipis. Batasnya
    // dihitung dari ANGGARAN saja, bukan dari panjang profil: kalau
    // tidak, potongan intinya berbeda-beda per profil dan prefix
    // prompt tak lagi sama — persis yang membatalkan cache yang jadi
    // alasan seluruh berkas ini ada.
    const MIN_INTI = 6;
    const CADANGAN_PROFIL = 4;

    const jatahInti = tambahan.length
        ? Math.max(MIN_INTI, budget - CADANGAN_PROFIL)
        : budget;

    const out = [];
    const sudah = new Set();

    const ambil = (nama) => {
        const t = cari(tools, nama);
        if (t && !sudah.has(t.name)) {
            out.push(t);
            sudah.add(t.name);
        }
    };

    for (const nama of CORE) {
        if (out.length >= jatahInti) break;
        ambil(nama);
    }

    for (const nama of tambahan) {
        if (out.length >= budget) break;
        ambil(nama);
    }

    // Tool eksternal (MCP) — tak masuk profil tetap karena daftarnya
    // dinamis (server luar hidup/mati). Mereka dilampirkan hanya bila
    // skornya terhadap pesan > 0, urut skor menurun lalu nama agar
    // stabil antar pesan yang sama (cache prefix prompt).
    if (haystack) {
        const eksternal = tools
            .filter(t => isExternal(t) && !sudah.has(t.name))
            .map(t => ({ t, nilai: score(t, haystack) }))
            .filter(x => x.nilai > 0)
            .sort((a, b) => b.nilai - a.nilai || String(a.t.name).localeCompare(String(b.t.name)));

        for (const { t } of eksternal) {
            if (out.length >= budget) break;
            out.push(t);
            sudah.add(t.name);
        }
    }

    return out;

}

module.exports = {
    selectTools, susun, chooseProfile,
    ALWAYS, isAlways, isExternal, tail,
    CORE, PROFILES, PEMICU
};
