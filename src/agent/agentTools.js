/**
 * Peta kapabilitas agent → tool NYATA di registry AI.
 *
 * Setiap worker di agentHub dideklarasikan dengan `tools: [...]`.
 * Sebelumnya daftar itu dekorasi: nama seperti "data_analysis" atau
 * "workflow_engine" tidak pernah ada di registry, dan `runWorker`
 * bahkan tidak melampirkan tool apa pun — worker hanya chat biasa
 * dengan bias peran.
 *
 * Modul ini menyelesaikan dua masalah sekaligus:
 *
 *   1. Tiap agent punya PROFIL TOOL — daftar nama tool yang benar-
 *      benar terdaftar (diperiksa saat runtime), dikelompokkan per
 *      topik kerjanya. Agent riset dapat tool riset, agent sistem
 *      dapat tool sistem — bukan 142 tool sekaligus.
 *   2. Nama fiktif diberi alias ke tool nyata yang setara, sehingga
 *      deklarasi lama di agentHub tetap bermakna.
 *
 * Inti (memori + berkas + waktu) dijamin ada di setiap profil:
 * worker mana pun perlu mengingat dan membaca berkas.
 */

const { CORE } = require("../ai/tools/ToolSelector");

/**
 * Profil tool per worker.
 *
 * Nama ditulis GAYA BEBAS ("readFile" cocok dengan "filesystem.readFile"
 * maupun "filesystem__readFile") — pencocokan dilakukan oleh `tail()`
 * milik ToolSelector, sama seperti mekanisme profil chat utama.
 */
const WORKER_PROFILES = {

    // Puntadewa — tata kelola, perencanaan, penilaian keputusan.
    // Sengaja BACA-DOMINAN: perencana butuh melihat keadaan, bukan
    // mengubahnya. PLAN != AUTHORITY.
    puntadewa: [
        "world_describe", "system_health", "home_state", "home_devices",
        "memory_recall", "memory_related", "memory_documents",
        "code_plan", "readFile", "listDirectory"
    ],

    // Werkudara — keamanan, pemodelan ancaman, audit.
    werkudara: [
        "osint_breach", "osint_hoax_trace", "osint_phone_assess",
        "code_diagnostics", "code_graph_query",
        "terminal_list", "terminal_run", "terminal_read",
        "system_health", "readFile", "listDirectory"
    ],

    // Janaka — riset, intelijen, verifikasi fakta.
    janaka: [
        "browse", "get", "post", "download",
        "osint_investigate", "osint_email", "osint_phone", "osint_username",
        "osint_domain", "osint_breach", "osint_hoax_check", "osint_social_network",
        "memory_documents", "memory_entities", "memory_related",
        "readFile", "listDirectory", "open_document"
    ],

    // Nakula — rekayasa perangkat lunak, sistem/infra, otomatisasi,
    // serta integrasi perangkat (vision, audio, kanal).
    nakula: [
        "opencode_run",
        "code_graph_query", "code_graph_path", "code_graph_explain",
        "code_definition", "code_references", "code_diagnostics",
        "code_plan", "code_test", "code_check_syntax",
        "code_branch", "code_commit", "code_rollback",
        "code_symbol_index", "code_ast_outline", "code_hover",
        "terminal_list", "terminal_run", "terminal_read", "terminal_restart",
        "system_health", "nas_status", "nas_pools",
        "world_describe", "open_terminal", "open_url",
        "get", "post", "download", "browse",
        "home_state", "home_devices",
        "see_camera", "list_cameras", "count_people_camera",
        "describe_image", "show_image", "show_video",
        "search_photos", "find_people", "identify_face",
        "photos_summary", "open_document",
        "voice_status", "transcribe", "tts_speak",
        "play_media", "play_youtube", "search_music", "stop_media",
        "wa_send", "wa_status", "whatsapp_send_photo", "whatsapp_send_document",
        "send_file", "send_immich_photo", "send_media_url",
        "readFile", "writeFile", "listDirectory"
    ],

    // Sadewa — memori, provenance, analisis, kontinuitas.
    sadewa: [
        "memory_recall", "memory_remember", "memory_forget",
        "memory_related", "memory_entities", "memory_documents",
        "build_recall", "build_remember",
        "search_photos", "find_people",
        "system_health", "nas_status", "terminal_list", "terminal_read",
        "list_cameras", "home_state", "home_devices",
        "world_describe", "listDirectory"
    ]

};

/** Alias kapabilitas lama di agentHub → nama profil di atas. */
const CAPABILITY_ALIAS = {
    web: ["browse", "get", "post"],
    document_reader: ["open_document", "readFile"],
    data_analysis: ["readFile", "listDirectory"],
    filesystem: ["readFile", "writeFile", "listDirectory"],
    terminal: ["terminal_list", "terminal_run", "terminal_read"],
    powershell: ["terminal_run"],
    git: ["code_branch", "code_commit", "code_rollback"],
    opencode: ["opencode_run"],
    code_search: ["code_graph_query", "code_definition", "code_references"],
    test_runner: ["code_test"],
    ocr: ["describe_image"],
    image_processor: ["describe_image", "show_image"],
    cctv: ["see_camera", "list_cameras"],
    camera: ["see_camera", "list_cameras"],
    vision: ["see_camera", "describe_image"],
    microphone: ["voice_status"],
    speech_to_text: ["transcribe"],
    text_to_speech: ["tts_speak"],
    audio_processor: ["transcribe", "tts_speak"],
    security_scanner: ["osint_breach", "code_diagnostics"],
    network: ["terminal_run", "get"],
    process_manager: ["terminal_list", "terminal_run", "system_health"],
    workflow_engine: ["terminal_run", "get", "post"],
    api: ["get", "post"],
    scheduler: ["terminal_run"],
    webhooks: ["get", "post"],
    memory_store: ["memory_remember"],
    memory_search: ["memory_recall", "memory_related"],
    vector_search: ["memory_related", "memory_documents"],
    database: ["readFile", "listDirectory"],
    logs: ["terminal_read", "terminal_list"],
    metrics: ["system_health", "nas_status"],
    system_monitor: ["system_health", "nas_status", "terminal_list"],
    docker: ["terminal_run", "terminal_list"],
    ssh: ["terminal_run"],
    console: ["show_image", "open_url"],
    whatsapp: ["wa_send", "wa_status", "whatsapp_send_photo"],
    notifications: ["wa_send"],
    ui: ["show_image", "show_video"],
    osint: ["osint_investigate", "osint_email", "osint_phone", "osint_username", "osint_domain"],
    nas: ["nas_status", "nas_pools"],
    gallery: ["search_photos", "find_people", "photos_summary"],
    "gallery_people": ["find_people", "list_known_people"],
    media_player: ["play_media", "play_youtube", "search_music", "stop_media"],
    home: ["home_state", "home_devices"],
    media_share: ["send_file", "send_immich_photo", "send_media_url"],
    memory: ["memory_recall", "memory_remember", "memory_related"]
};

/** Ruas terakhir nama tool — "filesystem__readFile" → "readFile". */
function tail(name) {
    return String(name ?? "").split(/__|\./).pop();
}

/** Cari tool terdaftar yang cocok dengan sebuah nama gaya bebas. */
function cari(tools, nama) {
    return tools.find(t =>
        t.name === nama || tail(t.name) === nama || tail(t.name) === tail(nama)
    ) ?? null;
}

/** Susun daftar tool final: inti + profil, tanpa duplikat. */
function susun(tools, namaDaftar) {

    const out = [];
    const sudah = new Set();

    for (const nama of [...CORE, ...namaDaftar]) {

        const tool = cari(tools, nama);

        if (tool && !sudah.has(tool.name)) {
            out.push(tool);
            sudah.add(tool.name);
        }

    }

    return out;

}

/**
 * Tool untuk satu agent worker.
 *
 * @param {Array}  tools            seluruh tool di registry AI
 * @param {string} agentId          id worker Pandawa (mis. "nakula")
 * @param {string[]} deklarasiLama  `tools:` dari agentHub (opsional)
 * @returns {Array} tool inti + tool profil worker
 */
function toolsForWorker(tools = [], agentId, deklarasiLama = []) {

    const profil = WORKER_PROFILES[agentId] ?? [];

    // Deklarasi lama diterjemahkan lewat alias — kapabilitas yang
    // dulu fiktif kini menunjuk tool nyata.
    const dariDeklarasi = deklarasiLama.flatMap(k => CAPABILITY_ALIAS[k] ?? []);

    return susun(tools, [...profil, ...dariDeklarasi]);

}

/**
 * Nama-nama tool yang MENANDAI spesialisasi seorang worker.
 *
 * Kini berupa HINT untuk pipeline seleksi (boost), bukan lagi
 * penggantinya: tugas tetap dinilai lewat retrieval + ranking,
 * profil hanya menguntungkan tool yang khas peran worker itu.
 */
function profileFor(agentId) {

    const profil = WORKER_PROFILES[agentId] ?? [];

    return [...profil];

}

/** Daftar profil worker yang dikenal. */
function knownWorkers() {
    return Object.keys(WORKER_PROFILES);
}

module.exports = {
    toolsForWorker, profileFor, knownWorkers,
    WORKER_PROFILES, CAPABILITY_ALIAS
};

