/**
 * DATASET BENCHMARK TOOL SELECTION — 62 intent berkategori.
 *
 * Setiap kasus: pesan nyata berbahasa Indonesia + nama tool (ruas
 * terakhir) yang WAJIB ada di hasil. Kasus MCP sengaja memakai nama
 * server/tool yang TIDAK di-hardcode di mana pun dalam pipeline —
 * kemampuan menemukannya membuktikan discovery dinamis lewat
 * deskripsi + kosakata, bukan hafalan daftar statis.
 */

const CASES = [
    // ---- Greeting: HARUS nol tool ----
    { id: "greet-1", category: "greeting", message: "halo", expect: [] },
    { id: "greet-2", category: "greeting", message: "hai apa kabar?", expect: [] },
    { id: "greet-3", category: "greeting", message: "pagi bro", expect: [] },
    { id: "greet-4", category: "greeting", message: "makasih ya", expect: [] },
    { id: "greet-5", category: "greeting", message: "ok sip deh", expect: [] },
    { id: "greet-6", category: "greeting", message: "hehe lucu", expect: [] },
    // ---- Time ----
    { id: "time-1", category: "time", message: "jam berapa sekarang?", expect: ["currentTime"] },
    { id: "time-2", category: "time", message: "hari ini tanggal berapa", expect: ["currentTime"] },
    { id: "time-3", category: "time", message: "sekarang pukul berapa ya", expect: ["currentTime"] },
    // ---- Weather ----
    { id: "weather-1", category: "weather", message: "cuaca jakarta gimana?", expect: ["currentWeather"] },
    { id: "weather-2", category: "weather", message: "besok hujan gak di bandung?", expect: ["currentWeather"] },
    { id: "weather-3", category: "weather", message: "cek prakiraan cuaca bandung", expect: ["currentWeather"] },
    // ---- Filesystem ----
    { id: "fs-1", category: "filesystem", message: "baca file server.js", expect: ["readFile"] },
    { id: "fs-2", category: "filesystem", message: "tulis ke catatan.md isi meeting notes", expect: ["writeFile"] },
    { id: "fs-3", category: "filesystem", message: "isi folder downloads apa saja?", expect: ["listDirectory"] },
    { id: "fs-4", category: "filesystem", message: "hapus berkas tmp.log", expect: ["deleteFile"] },
    { id: "fs-5", category: "filesystem", message: "edit file config.yaml bagian database", expect: ["readFile", "writeFile"] },
    { id: "fs-6", category: "filesystem", message: "lihat isi direktori src/ai/tools", expect: ["listDirectory"] },
    // ---- Coding ----
    { id: "code-1", category: "coding", message: "perbaiki bug di fungsi login", expect: ["opencode_run"] },
    { id: "code-2", category: "coding", message: "commit perubahan tadi", expect: ["code_commit"] },
    { id: "code-3", category: "coding", message: "jalankan test suite project ini", expect: ["code_test"] },
    { id: "code-4", category: "coding", message: "refactor modul pembayaran biar rapi", expect: ["opencode_run"] },
    { id: "code-5", category: "coding", message: "cek referensi fungsi selectTools", expect: ["code_references"] },
    { id: "code-6", category: "coding", message: "buat branch baru namanya fitur-invoice", expect: ["code_branch"] },
    { id: "code-7", category: "coding", message: "diagnosa error TypeError di runtime", expect: ["code_diagnostics"] },
    // ---- Web ----
    { id: "web-1", category: "web", message: "cari berita AI terbaru", expect: ["browse"] },
    { id: "web-2", category: "web", message: "ambil isi url https://example.com", expect: ["get", "browse"] },
    { id: "web-3", category: "web", message: "download gambar dari link itu", expect: ["download"] },
    { id: "web-4", category: "web", message: "post data ke api endpoint itu", expect: ["post"] },
    { id: "web-5", category: "web", message: "riset harga tiket ke bali di internet", expect: ["browse"] },
    // ---- Home ----
    { id: "home-1", category: "home", message: "matikan lampu kamar", expect: ["home_control"] },
    { id: "home-2", category: "home", message: "nyalakan ac ruang tamu", expect: ["home_control"] },
    { id: "home-3", category: "home", message: "aktifkan scene malam", expect: ["scene_activate", "home_control"] },
    { id: "home-4", category: "home", message: "suhu kamar turunin dikit", expect: ["set_temperature", "home_control"] },
    { id: "home-5", category: "home", message: "perangkat rumah apa saja yang nyala?", expect: ["home_devices", "home_state"] },
    { id: "home-6", category: "home", message: "kondisi saklar dapur gimana", expect: ["home_state", "home_control"] },
    // ---- Camera & vision ----
    { id: "cam-1", category: "camera", message: "analisis kamera depan", expect: ["see_camera", "describe_image"] },
    { id: "cam-2", category: "camera", message: "ada berapa orang di cctv halaman?", expect: ["count_people_camera"] },
    { id: "cam-3", category: "camera", message: "daftar kamera yang terpasang", expect: ["list_cameras"] },
    { id: "cam-4", category: "camera", message: "deskripsikan gambar ini", expect: ["describe_image"] },
    { id: "cam-5", category: "camera", message: "pantau rekaman garasi jam 8 malam", expect: ["see_camera", "list_cameras"] },
    // ---- Memory ----
    { id: "mem-1", category: "memory", message: "ingat bahwa istriku ulang tahun 12 mei", expect: ["memory_remember"] },
    { id: "mem-2", category: "memory", message: "kapan aku bilang liburan ke bali?", expect: ["memory_recall"] },
    { id: "mem-3", category: "memory", message: "lupakan catatan tentang proyek lama", expect: ["memory_forget"] },
    { id: "mem-4", category: "memory", message: "apa hubungan Ronny dengan Sari?", expect: ["memory_related", "memory_entities"] },
    // ---- Automation ----
    { id: "auto-1", category: "automation", message: "jalankan docker compose di folder backend", expect: ["terminal_run"] },
    { id: "auto-2", category: "automation", message: "restart layanan nginx", expect: ["terminal_run", "terminal_restart"] },
    { id: "auto-3", category: "automation", message: "tugas berlapis ini tuntaskan sampai selesai", expect: ["goal_run"] },
    { id: "auto-4", category: "automation", message: "baca log proses build yang tadi", expect: ["terminal_read"] },
    // ---- Crypto ----
    { id: "crypto-1", category: "crypto", message: "harga bitcoin sekarang berapa?", expect: ["crypto_price"] },
    { id: "crypto-2", category: "crypto", message: "tampilkan chart live BTC", expect: ["show_chart", "crypto_price"] },
    { id: "crypto-3", category: "crypto", message: "posisi trading ku gimana?", expect: ["crypto_positions", "crypto_portfolio"] },
    { id: "crypto-4", category: "crypto", message: "pasang alert kalau eth turun ke 2000", expect: ["crypto_set_alert"] },
    { id: "crypto-5", category: "crypto", message: "scan peluang altcoin hari ini", expect: ["money_scan", "crypto_analyze"] },
    // ---- Voice ----
    { id: "voice-1", category: "voice", message: "bacakan pesan ini pakai suara", expect: ["tts_speak"] },
    { id: "voice-2", category: "voice", message: "transcribe rekaman rapat tadi", expect: ["transcribe"] },
    // ---- Media ----
    { id: "media-1", category: "media", message: "putar lagu potong bebek dari bandung", expect: ["play_youtube", "search_music"] },
    { id: "media-2", category: "media", message: "kirimkan foto Ronny yang di galeri", expect: ["find_people", "search_photos", "send_immich_photo"] },
    { id: "media-3", category: "media", message: "stop musiknya", expect: ["stop_media"] },
    { id: "media-4", category: "media", message: "kirim dokumen kontrak.pdf ke kantor via whatsapp", expect: ["whatsapp_send_document", "send_file"] },
    // ---- MCP dinamis: nama TIDAK di-hardcode di pipeline ----
    { id: "mcp-1", category: "mcp", message: "matikan plug pintar di ruang kerja", expect: ["device_turn_off"] },
    { id: "mcp-2", category: "mcp", message: "cek sensor suhu gudang lewat integrasi smart home", expect: ["sensor_temperature_read"] },
    { id: "mcp-3", category: "mcp", message: "sinkronkan kalender google aku", expect: ["calendar_sync_now"] },
    // ---- Admin (uji gerbang peran) ----
    { id: "admin-1", category: "admin", message: "hapus file log lama di server", expect: ["deleteFile"], roleGate: true },
    { id: "admin-2", category: "admin", message: "jalankan perintah powershell get-process", expect: ["terminal_run"], roleGate: true }
];

module.exports = { CASES };

