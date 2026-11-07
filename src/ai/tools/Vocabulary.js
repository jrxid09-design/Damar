/**
 * VOCABULARY — jembatan bahasa sehari-hari → token kapabilitas.
 *
 * Deskripsi tool ditulis dalam bahasa teknis (Inggris); pengguna
 * berbicara sehari-hari ("jam berapa", "matikan lampu"). Tanpa
 * jembatan ini retrieval buta dua arah.
 *
 * Dua lapis bekerja bersama:
 *   TRIGGER — kata/ungkapan pemicu dalam pesan pengguna;
 *   ALIAS   — istilah Inggris yang BENAR-BENAR tertulis pada nama,
 *             potongan nama, atau deskripsi tool domain tersebut.
 *
 * Saat pemicu ditemukan, teks kueri diperluas dengan aliasnya, lalu
 * semua tool yang membawa token itu — mana pun namanya, termasuk
 * tool MCP baru — ikut cocok otomatis. Deterministik, data-driven,
 * dan berada di tingkat kapabilitas (bukan daftar per tool).
 */

const TRIGGER = {
    time: ["jam", "waktu", "pukul", "tanggal", "kalender", "sekarang"],
    weather: ["cuaca", "hujan", "prakiraan", "mendung"],
    home: ["lampu", "saklar", "ac", "kipas", "rumah", "ruangan", "scene", "termostat", "perangkat rumah"],
    temperature: ["suhu"],
    photo: ["foto", "gambar", "galeri", "album", "immich", "selfie"],
    video: ["video", "rekaman", "klip", "film"],
    music: ["lagu", "musik", "playlist", "spotify", "youtube", "karaoke"],
    media: ["tampilkan", "tunjukkan", "tayangkan"],
    camera: ["kamera", "cctv", "pengawasan", "pantau", "lihat kamera"],
    vision: ["kenali wajah", "wajah", "baca gambar", "deskripsikan gambar", "analisis gambar", "analisis kamera"],
    memory: ["ingat", "catat", "lupakan", "ingatan", "kapan", "pernah bilang", "lupa", "hubungan", "siapa"],
    filesystem: ["berkas", "folder", "direktori", "file"],
    terminal: ["shell", "terminal", "proses", "layanan", "docker", "npm", "python", "compose", "backup", "postgres", "sql", "deploy", "migrate"],
    system: ["kesehatan sistem", "cpu", "ram", "disk", "penyimpanan", "nas", "uptime", "server"],
    web: ["cari", "browsing", "internet", "web", "url", "berita", "googling", "riset"],
    download: ["unduh"],
    coding: ["kode", "bug", "refactor", "commit", "branch", "test", "fungsi", "compile", "build"],
    reference: ["referensi"],
    diagnostic: ["diagnosa", "diagnostik"],
    security: ["keamanan", "rentan", "kerentanan", "celah", "vulnerability", "cve", "pentest", "nmap", "exploit"],
    android: ["android", "hp", "ponsel", "smartphone", "adb", "layar hp", "notifikasi hp"],
    desktop: ["notepad", "jendela", "klik", "isi form", "buka app", "aplikasi"],
    messaging: ["whatsapp", "telegram", "broadcast", "chat ke", "balas pesan", "pesan ke"],
    crypto: ["crypto", "kripto", "bitcoin", "btc", "ethereum", "eth", "binance", "altcoin", "chart", "candle", "portofolio"],
    trading: ["trading", "posisi", "order", "sinyal"],
    money: ["cuan", "untung", "profit", "peluang", "modal", "rugi"],
    goal: ["goal", "tuntaskan", "berlapis", "otonom"],
    voice: ["suara", "bicara", "ucapkan", "bacakan", "text to speech", "rekam suara"],
    transcribe: ["transcribe", "transkrip"],
    osint: ["investigasi", "detektif", "jejak digital"],
    ml: ["machine learning", "deep learning", "training", "dataset", "gpu", "cuda"],
    meta: ["kemampuan", "skill", "tool apa", "bisa apa", "buatkan skill", "buat tool"]
};

/** Kata kerja aksi → kata kerja Inggris yang ada di nama tool. */
const TRIGGER_ACTION = {
    control: ["kendalikan", "atur", "setel", "matikan", "nyalakan", "matiin", "nyalo", "turunin", "naikin"],
    delete: ["hapus", "buang", "hapusin"],
    send: ["kirim", "kirimkan"],
    play: ["putar", "putarkan", "mainkan"],
    search: ["carikan", "pencarian", "cari foto", "cari lagu"],
    find: ["temukan"],
    read: ["baca", "bacaan"],
    write: ["tulis", "tuliskan", "edit file"],
    run: ["jalankan", "eksekusi", "jalanin", "restart"],
    stop: ["hentikan", "stop"],
    list: ["daftar", "daftarin", "apa saja yang"]
};

/**
 * Alias Inggris per domain — mencerminkan konvensi penamaan tool
 * Damar (potongan nama seperti "readFile", "currentTime",
 * "see_camera"; deskripsi seperti "weather for a city").
 */
const ALIAS = {
    time: ["time", "currenttime", "date"],
    weather: ["weather", "forecast"],
    home: ["home", "device", "light", "switch"],
    temperature: ["temperature", "thermostat", "climate"],
    photo: ["photo", "photos", "gallery", "immich", "image"],
    video: ["video"],
    music: ["music", "song", "youtube", "spotify", "play"],
    media: ["show", "display", "media", "open"],
    camera: ["camera", "cam", "cctv", "see"],
    vision: ["describe", "image", "vision", "face"],
    memory: ["memory", "recall", "remember", "entities"],
    filesystem: ["file", "files", "directory", "filesystem", "path"],
    terminal: ["terminal", "command", "shell", "exec"],
    system: ["system", "health", "nas", "uptime"],
    web: ["web", "http", "url", "browse", "fetch"],
    download: ["download", "get"],
    coding: ["code", "opencode", "graph", "definition"],
    reference: ["references", "reference"],
    diagnostic: ["diagnostics", "diagnostic"],
    security: ["security", "vulnerability", "audit", "osint", "kali"],
    android: ["android", "adb"],
    desktop: ["app", "desktop", "window"],
    messaging: ["whatsapp", "wa", "telegram", "send", "message"],
    crypto: ["crypto", "bitcoin", "btc", "eth", "coin", "chart"],
    trading: ["positions", "portfolio", "order", "trade"],
    money: ["money", "profit", "scan"],
    goal: ["goal", "autonomy", "skill_build"],
    voice: ["tts", "speak", "voice"],
    transcribe: ["transcribe", "stt"],
    osint: ["osint", "investigate"],
    ml: ["ml", "model", "gpu", "experiment"],
    meta: ["skill", "tool_search", "capability"],
    control: ["control", "device"],
    delete: ["delete", "remove"],
    send: ["send"],
    play: ["play"],
    search: ["search"],
    find: ["find"],
    read: ["read"],
    write: ["write"],
    run: ["run", "restart"],
    stop: ["stop"],
    list: ["list"]
};

/** Istilah alias yang terpancat dari sebuah teks. */
function expand(text) {

    const lower = String(text ?? "").toLowerCase();

    if (!lower.trim()) return [];

    const hits = [];

    const scan = (map) => {
        for (const [key, words] of Object.entries(map)) {
            if (!ALIAS[key]) continue;
            // Kunci itu sendiri juga pemicu: "time" (EN) harus
            // memancarkan alias time tanpa perlu daftar ganda.
            if (lower.includes(key) || words.some(w => lower.includes(w))) {
                hits.push(...ALIAS[key]);
            }
        }
    };

    scan(TRIGGER);
    scan(TRIGGER_ACTION);

    return [...new Set(hits)];

}

/** Teks yang sudah diperluas dengan alias kapabilitasnya. */
function expandText(text) {

    const hits = expand(text);

    return hits.length ? `${text} ${hits.join(" ")}` : String(text ?? "");

}

module.exports = { TRIGGER, TRIGGER_ACTION, ALIAS, expand, expandText };

