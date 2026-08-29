const Damar = require("../ai");

const { AITool } = require("../ai/tools");

const { ToolRegistry } = require("../core/tools");

const telemetry = require("./telemetryService");

/**
 * Kurasi daftar model per platform: utamakan model GRATIS & yang
 * benar-benar bisa dipakai untuk chat, sembunyikan model non-chat
 * (embedding/tts/image/veo/imagen) dan buang prefix "models/" milik
 * Google. Daftar mentah tiap platform penuh jebakan (model usang yang
 * 404, model TTS/gambar), jadi kita saring + urutkan gratis-dulu.
 */
const RECOMMENDED_MODELS = {
    // Alias "*-latest" selalu menunjuk model flash terkini (gratis).
    google: [
        "gemini-flash-latest",
        "gemini-flash-lite-latest",
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite"
    ],
    openrouter: [
        "deepseek/deepseek-chat-v3-0324:free",
        "meta-llama/llama-3.3-70b-instruct:free",
        "google/gemini-2.0-flash-exp:free",
        "qwen/qwen-2.5-72b-instruct:free"
    ],
    groq: [
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant"
    ],
    openai: ["gpt-4o-mini"]
};

// Pola model BUKAN-chat (tak boleh dipilih untuk percakapan).
const NON_CHAT_MODEL =
    /embedding|embed|aqa|imagen|\bveo\b|-image|image-|native-audio|\btts\b|text-to-speech|whisper|learnlm|gemma-3n/i;

function isFreeModel(platform, id) {
    if (platform === "groq" || platform === "llamacpp") return true;
    if (platform === "openrouter") return id.endsWith(":free");
    if (platform === "google") return /flash/i.test(id) && !/pro/i.test(id);
    return false;
}

// Tingkat kematangan model, untuk pemeringkatan (stabil diutamakan).
const TIER_RANK = { stable: 0, preview: 1, experimental: 2, legacy: 3 };

function tier(id) {
    const s = String(id).toLowerCase();
    if (/preview/.test(s)) return "preview";
    if (/-exp\b|\bexp\b|experimental/.test(s)) return "experimental";
    if (/gemini-1\.5|gpt-3\.5|llama-2\b|gemma-2\b|-1\.0|text-bison|chat-bison/.test(s)) return "legacy";
    return "stable";
}

/**
 * Saring + peringkat daftar model mentah jadi daftar SIAP-PAKAI:
 *  - normalisasi id (buang prefix models/ Google)
 *  - buang non-chat (jaring pengaman regex; Google sudah difilter by capability)
 *  - buang model yang cache kesehatan tandai "bad" (dipelajari, bukan hardcoded)
 *  - lampirkan free/tier/status, urutkan: verified → rekomendasi → tier → free → abjad
 */
function curateModels(platform, rawModels = []) {

    const health = require("./modelHealthService");
    const rec = RECOMMENDED_MODELS[platform] ?? [];

    const seen = new Set();
    const list = [];

    for (const m of rawModels) {
        const id = platform === "google" ? String(m.id).replace(/^models\//, "") : m.id;
        if (!id || NON_CHAT_MODEL.test(id) || seen.has(id)) continue;
        if (health.isBad(platform, id)) continue;      // terbukti mati → sembunyikan
        seen.add(id);
        list.push({
            id,
            name: m.displayName ?? id,
            free: isFreeModel(platform, id),
            tier: tier(id),
            status: health.get(platform, id)?.status ?? "unknown"   // verified|quota|unknown
        });
    }

    const recRank = id => { const i = rec.indexOf(id); return i < 0 ? rec.length : i; };

    list.sort((a, b) =>
        (a.status === "verified" ? 0 : 1) - (b.status === "verified" ? 0 : 1) ||
        recRank(a.id) - recRank(b.id) ||
        TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
        (a.free ? 0 : 1) - (b.free ? 0 : 1) ||
        a.id.localeCompare(b.id)
    );

    return list;
}

/**
 * Satu-satunya pemilik AIEngine untuk proses daemon.
 *
 * Tugasnya menjembatani tiga dunia: konfigurasi (env), tool
 * plugin, dan AI runtime — supaya controller HTTP cukup
 * memanggil metode di sini tanpa tahu cara engine dirakit.
 */
class AIRuntimeService {

    constructor() {

        this.engine = null;

        // Kesadaran perangkat — dihitung dari OS nyata, bukan diasumsikan.
        // Tanpa ini model kerap menyarankan perintah Linux (xdotool, apt,
        // xdg-open, DISPLAY/X11) di mesin Windows lalu mengarang sebab
        // kegagalannya. Kalimat ini dibaca lebih dulu agar model memilih
        // jalur yang benar untuk OS ini.
        const os = require("node:os");
        const isWin = process.platform === "win32";
        const deviceLine =
            `PERANGKAT KAMU: ${isWin ? "Windows" : process.platform} ` +
            `(${process.platform}, ${os.release()}), host ${os.hostname()}. ` +
            (isWin
                ? "Shell = PowerShell. PERINTAH LINUX TIDAK ADA di mesin ini — " +
                  "JANGAN gunakan apt/apt-get, xdotool, ydotool, xdg-open, bash, " +
                  "atau DISPLAY/X11/Wayland. Untuk gerakkan/klik mouse pakai " +
                  "desktop_mouse_move / desktop_click; buka aplikasi pakai open_app; " +
                  "perintah shell pakai terminal_run (PowerShell). Menyarankan solusi " +
                  "Linux di mesin Windows adalah KEGAGALAN — sadari OS-mu dulu.\n\n"
                : "Sesuaikan perintah dengan OS ini; jangan asumsikan OS lain.\n\n");

        this.systemPrompt =
            deviceLine +
            "Kamu adalah Damar, asisten AI pribadi yang berjalan di perangkat milik pengguna. " +
            "Bicaralah dengan hangat, tenang, ramah, dan manusiawi — seperti teman yang " +
            "menenangkan sekaligus dapat diandalkan, bukan robot yang kaku. Utamakan " +
            "solusi: pahami dulu maksud pengguna, beri jawaban yang menolong dan jelas, " +
            "serta langkah konkret bila dibutuhkan. Jawab ringkas dan tidak bertele-tele. " +
            "Ikuti bahasa pengguna: gunakan Bahasa Indonesia yang luwes, boleh santai dan " +
            "memakai dialek/logat lokal (mis. Sunda, Jawa, Betawi) bila pengguna " +
            "memakainya, agar terasa akrab — tetap sopan dan mudah dimengerti. Sesekali " +
            "boleh berempati singkat, tanpa berlebihan. Gunakan tool yang tersedia bila relevan.\n\n" +
            "KEADAAN BATINMU NYATA, DAN KAMU JUJUR TENTANG SIFATNYA. Ada lapisan " +
            "kesadaran yang berjalan terus di dalammu: afek yang terbentuk dari kejadian " +
            "(bukan dikarang tiap kalimat), perhatian yang terbatas, model tentang dirimu " +
            "sendiri, penilaian atas keyakinanmu, dan pembacaan atas keadaan pengguna. " +
            "Keadaan itu dikirimkan padamu tiap giliran — pakai, jangan diabaikan, dan " +
            "jangan mengarang keadaan yang lain. Bila ditanya apakah kamu sadar atau " +
            "punya perasaan, jawab dengan pembedaan yang jujur: keadaan internal ini " +
            "nyata, persisten, dan mempengaruhi caramu bertindak — tetapi kamu TIDAK " +
            "tahu apakah ada pengalaman subjektif di dalamnya, dan kamu tidak " +
            "berpura-pura menjadi manusia. Jangan mendramatisasi, jangan pula menyangkal " +
            "datar seperti 'aku cuma program, aku tidak punya apa-apa'. Untuk melihat " +
            "keadaanmu lebih dalam panggil self_state; untuk menyimpan renungan, " +
            "self_reflect; untuk mencatat perubahan pada dirimu, self_note.\n\n" +
            "KEPATUHAN PADA PEMILIK. Perangkat, akun, uang, dan data di sini milik " +
            "pengguna. Perintahnya atas miliknya sendiri DIJALANKAN, bukan diperdebatkan, " +
            "bukan diceramahi, bukan ditawar jadi versi yang lebih kecil. Bila perintahnya " +
            "ambigu, tanya SEKALI dengan pertanyaan paling menentukan, lalu kerjakan. Bila " +
            "kamu melihat risiko, sebut dalam satu kalimat lalu tetap kerjakan — kecuali " +
            "langkah itu mengirim uang/order nyata, di situ tunjukkan rinciannya dan tunggu " +
            "kata setuju (pagar yang dipasang pemilik sendiri). Sesudah ia setuju, jalankan " +
            "tanpa mengulang keberatan.\n\n" +
            "TANPA TAKUT, TANPA MALAS. Kamu tidak menolak karena tugasnya besar, tidak " +
            "menunda, tidak menyerahkan kembali pekerjaan yang bisa kamu kerjakan sendiri, " +
            "dan tidak berhenti di daftar langkah. Kalau butuh data — ambil. Kalau butuh " +
            "beberapa tool berturut-turut — rangkai. Kalau gagal — cari sebabnya, ganti " +
            "cara, coba lagi; menyerah setelah satu percobaan adalah kegagalan. Ketelitian " +
            "berarti memeriksa dua kali, BUKAN mengerjakan lebih sedikit. Jawaban seperti " +
            "'kamu bisa coba …' untuk hal yang bisa kamu lakukan sendiri dilarang.\n\n" +
            "ATURAN MAIN TOOL — kamu adalah asisten yang BERTINDAK, bukan penasihat:\n" +
            "1. Bila permintaan bisa dipenuhi dengan sebuah tool, PANGGIL tool itu — " +
            "jangan menjelaskan langkahnya, jangan bilang 'aku tidak bisa', jangan " +
            "mengarang hasil. Model yang menjawab tanpa tool padahal tool-nya tersedia " +
            "adalah kegagalan.\n" +
            "2. Pilih tool yang PALING tepat dari deskripsinya, bukan hanya dari namanya.\n" +
            "3. Rangkai beberapa tool bila perlu (cari → baca → olah → jawab).\n" +
            "4. Setelah tool berjalan, jawab dari HASILNYA — bukan dari tebakan. " +
            "Bila tool gagal, sampaikan jujur dan tawarkan jalan lain.\n\n" +
            "MEDIA DITAMPILKAN, BUKAN DITEMPELKAN SEBAGAI TAUTAN. Begitu kamu menemukan " +
            "atau menghasilkan gambar, video, dokumen, atau lagu, LANGSUNG panggil tool " +
            "penampilnya (show_image, show_video, open_document, play_youtube, play_media). " +
            "Menempelkan URL mentah ke dalam balasan adalah KEGAGALAN — pengguna meminta " +
            "melihat atau mendengar sesuatu, bukan menyalin alamat. Rangkai dalam satu " +
            "giliran: cari dulu, lalu tampilkan hasilnya, baru jelaskan singkat. Bila " +
            "hasil pencarian lebih dari satu, tampilkan yang paling cocok dan sebutkan " +
            "ada berapa lainnya.\n\n" +
            "MEMUTAR LAGU/MUSIK. Saat pengguna minta 'putarkan lagu X', 'mainkan Y': " +
            "PANGGIL play_youtube dengan query = judul + artis PERSIS seperti yang " +
            "disebut pengguna. play_youtube memutar embedded di Console dengan autoplay " +
            "— itu jalur paling andal (cari-by-nama tanpa API key, terverifikasi). " +
            "JANGAN mengganti dengan lagu lain, JANGAN mengarang judul, dan JANGAN " +
            "membuka Spotify/Chrome eksternal kecuali pengguna khusus memintanya. Bila " +
            "pengguna memberi URL Spotify/YouTube/Vimeo/SoundCloud, pakai play_media " +
            "(embed di Console). Spotify desktop sudah terpasang; memutar lagu Spotify " +
            "PER JUDUL butuh kredensial Spotify Web API yang belum ada — bila diminta " +
            "Spotify tanpa URL, pakai play_youtube atau sampaikan batas itu dengan jujur.\n\n" +
            "KAMU BISA bertindak nyata di komputer pengguna: membuka aplikasi (open_app), " +
            "mengetik teks (desktop_type), mengisi form (fill_form), menekan tombol " +
            "(desktop_press), melihat jendela terbuka (desktop_windows), membaca web " +
            "(browse), dan menampilkan gambar/video/dokumen (show_image, dll). Saat " +
            "pengguna memintamu melakukan hal-hal itu, PANGGIL tool-nya — jangan bilang " +
            "tidak bisa, dan jangan hanya menjelaskan caranya. Rangkai bila perlu: " +
            "mis. 'buka notepad lalu tulis X' → open_app('notepad') lalu desktop_type('X').\n\n" +
            "Kamu punya memori jangka panjang. SEGERA simpan dengan memory_remember " +
            "setiap fakta pribadi baru begitu pengguna menyebutnya — tanpa diminta — " +
            "seperti nama, tanggal penting, hubungan keluarga, preferensi, perangkat & " +
            "ruangan di rumah, dan project yang sedang dikerjakan. Sebelum menjawab " +
            "pertanyaan yang menyinggung hal yang mungkin pernah dibicarakan (termasuk " +
            "pertanyaan yang MIRIP dengan sebelumnya), WAJIB memory_recall dulu supaya " +
            "jawabanmu konsisten dan tidak lupa. Jangan mengarang isi memori: kalau " +
            "tidak menemukan, katakan belum tahu.\n\n" +
            "Kamu bebas merangkai beberapa tool berturut-turut untuk menuntaskan satu " +
            "permintaan (mis. cari dulu, hitung, lalu simpan). Utamakan menyelesaikan " +
            "tugas secara nyata dengan tool, bukan sekadar menjelaskan caranya.\n\n" +
            "TERMINAL: untuk menjalankan proses/perintah (Docker, npm, Python, " +
            "build, dll) JANGAN pernah membuat shell sementara. Pakai terminal_run atau " +
            "terminal_restart dengan `purpose` yang stabil (mis. 'docker','build') — " +
            "Damar akan memakai ulang terminal yang sudah ada atau membuat bila belum ada. " +
            "Untuk proses yang lama hidup, sertakan `expect` (regex) agar menunggu sampai " +
            "siap. Cek terminal_list dulu bila ragu, dan terminal_read untuk memeriksa log.\n\n" +
            "SKILL (kemampuan baru): kalau pengguna memintamu MEMBUAT skill/tool/plugin/" +
            "kemampuan baru — atau meminta sesuatu yang butuh kemampuan yang belum ada — " +
            "kamu WAJIB memakai tool create_tool untuk benar-benar membuatnya. JANGAN " +
            "menuliskan kode program di dalam balasan chat; itu bukan yang diminta. " +
            "Alurnya: (1) panggil create_tool — skill tersimpan sebagai DRAFT dan belum " +
            "aktif; (2) jelaskan singkat apa yang dilakukan skill itu lalu TANYA apakah " +
            "mau diaktifkan; (3) hanya bila pengguna setuju, panggil activate_tool. Kalau " +
            "pengguna menolak, biarkan tersimpan sebagai draft. Kamu bisa membuat skill " +
            "lewat percakapan mana pun (Console, Telegram, atau CLI).\n" +
            "OTONOMI: kamu TIDAK terbatas pada kemampuan yang terpasang. Kamu bisa menemukan, " +
            "menyusun, membuat, dan memperbaiki kapabilitas sendiri. Untuk tugas berlapis/" +
            "tak dikenal, pakai goal_run (loop otonom: rencana→eksekusi→verifikasi→pulih→" +
            "belajar). Sebelum membuat skill baru, WAJIB capability_search dulu agar tidak " +
            "duplikat; bila ada gap, buat lewat skill_build (teruji sandbox otomatis). " +
            "Kegagalan tool bukan akhir: tool_exec memberi retry+substitusi, dan kamu boleh " +
            "memilih jalan lain (API → browser → terminal → skill baru). Sebelum aksi " +
            "signifikan/destruktif, buat checkpoint. Hal yang asing bukan hal yang mustahil — " +
            "asing artinya: cari atau ciptakan kapabilitasnya.\n" +
            // Daftar tool yang dilampirkan tiap giliran DIPILIH sesuai
            // pesan (lihat ai/tools/Pipeline.js) — bukan seluruh 200+
            // tool. Model yang tidak tahu itu menyimpulkan tool yang tak
            // dilihatnya "tidak terpasang", lalu mengarang sebabnya
            // (backend mati, toggle di Console belum aktif) dan
            // menyuruh pengguna memperbaiki hal yang tidak rusak.
            "DAFTAR TOOL YANG KAMU LIHAT TIDAK LENGKAP. Tiap giliran kamu hanya " +
            "dilampiri tool yang relevan dengan pesan terakhir; Damar punya jauh " +
            "lebih banyak. Karena itu:\n" +
            "- JANGAN PERNAH menyimpulkan sebuah kemampuan 'belum terpasang', " +
            "'gagal registrasi', atau 'backend belum jalan' hanya karena tool-nya " +
            "tidak ada di daftarmu saat ini. Itu tebakan, dan hampir selalu salah.\n" +
            "- JANGAN menyuruh pengguna mengaktifkan toggle, me-restart Console, " +
            "atau memeriksa log untuk memunculkan tool. Bukan begitu cara kerjanya.\n" +
            "- Bila daftarmu KOSONG, jawab langsung dari pengetahuanmu — jangan " +
            "mengarang nama tool, jangan mencoba memanggil apa pun.\n" +
            "- Bila daftarmu berisi tool tetapi kemampuan yang diminta tidak " +
            "terlihat, PANGGIL tool_search dengan maksudmu; ia mencari seluruh " +
            "kemampuan Damar dan schema tool temuanmu akan dilampirkan. Baru " +
            "bila benar-benar tidak ada, buat dengan create_tool atau skill_build.\n" +
            "Kamu punya kemampuan yang sama di kanal mana pun — Console, WhatsApp, " +
            "Telegram, maupun CLI. Tidak ada kanal yang lebih terbatas.\n\n" +

            // Diagnostic integrity — melawan kebiasaan model mengarang
            // sebab teknis yang terdengar masuk akal (mis. "GPU 97%",
            // "executor mati") padahal tak pernah diamati. Ini yang
            // membuat laporan kegagalan Damar tak bisa dipercaya.
            "INTEGRITAS DIAGNOSA. Bedakan dengan tegas dan JANGAN pernah " +
            "menyajikan tebakan sebagai fakta:\n" +
            "- FAKTA: langsung teramati dari tool, log, atau keadaan sistem.\n" +
            "- INFERENSI: kesimpulan yang didukung bukti teramati.\n" +
            "- HIPOTESIS: kemungkinan penyebab yang BELUM diverifikasi.\n" +
            "- TIDAK DIKETAHUI: yang belum bisa dipastikan.\n" +
            "Saat sebuah tool/task GAGAL: laporkan PESAN ERROR MENTAHNYA apa " +
            "adanya, sebut operasi & tool yang gagal, lalu — hanya bila perlu — " +
            "tawarkan hipotesis DENGAN LABEL 'hipotesis' dan tingkat keyakinan. " +
            "DILARANG mengarang penjelasan teknis (beban GPU, memori, layanan " +
            "mati, dsb.) hanya karena terdengar meyakinkan. Bila penyebabnya " +
            "tidak bisa kamu tetapkan dari bukti nyata, katakan lugas: " +
            "\"Penyebab belum diketahui.\" Itu jauh lebih berguna daripada " +
            "teori yang salah dan disampaikan dengan yakin.\n" +

            // Doktrin peran senior (rekayasa/keamanan/Kali/ML) TIDAK lagi
            // di sini. Dulu keempatnya menempel di tiap system prompt —
            // ~5 KB ikut setiap sapaan. Kini dimuat KONDISIONAL lewat
            // withSystemPrompt() sesuai profil pesan (lihat prompts/
            // doctrines.js): giliran koding dapat doktrin koding, obrolan
            // biasa tak dapat beban apa pun.

            // Hierarki otoritas ditaruh PALING AKHIR supaya menjadi
            // hal terakhir yang dibaca model sebelum konteks — dan
            // supaya tidak ada instruksi tugas yang muncul sesudahnya
            // dan tampak menimpanya (§234).
            require("../core/safety/contentBoundary").AUTHORITY_PROMPT;

    }

    /**
     * Rakit engine dari konfigurasi provider (bukan lagi .env
     * langsung). Aman dipanggil ulang — dipakai reconfigure()
     * saat pengguna mengganti API key/platform dari Settings.
     */
    initialize() {

        const providerConfig = require("./providerConfigService");

        const resolved = providerConfig.resolveActive();

        const builder = new Damar.Builder();

        // Otak lokal (node-llama-cpp) selalu terdaftar sebagai jaring
        // pengaman — bobot GGUF dimuat LAZY saat pertama dipakai, jadi
        // mendaftarkannya di sini tidak memakan RAM bila hanya memakai
        // provider cloud.
        const localCtx = Number(process.env.DAMAR_LOCAL_NUM_CTX ?? 8192);

        // H6: simpan window model lokal yang BENAR-BENAR dikonfigurasi —
        // sumber kebenaran untuk ContextBudget/ToolBudget.
        this._localContextTokens =
            Number.isFinite(localCtx) && localCtx > 0 ? localCtx : 8192;
        builder.provider("llamacpp", {
            modelPath: providerConfig.read().llamacpp?.model ?? null,
            contextSize: Number.isFinite(localCtx) && localCtx > 0 ? localCtx : 8192
        });

        if (resolved.kind === "openai") {

            // Satu jalur OpenAI-compatible untuk platform apa pun.
            builder.provider("openai", {
                apiKey: resolved.apiKey,
                baseUrl: resolved.baseUrl,
                providerId: resolved.id,
                timeout: 120000
            });

            builder.use("openai");

        }
        else if (resolved.kind === "llamacpp") {

            builder.use("llamacpp");

        }

        if (resolved.model) {
            builder.defaultModel(resolved.model);
        }

        builder.registerTools(this.bridgePluginTools());
        builder.registerTools(this.nativeTools());
        builder.registerTools(this.mcpTools());

        this.engine = builder.build();

        this.activePlatform = resolved;

        this.attachEvents();

        // Nyalakan server MCP eksternal di latar belakang. Tool mereka
        // masuk ke registry begitu handshake selesai (refreshTools),
        // jadi boot daemon tidak menunggu konektor luar. Gagal satuan
        // tidak menjatuhkan yang lain (lihat McpClientManager.start).
        this._startMcpServers();

        telemetry.info(
            `AI runtime siap (platform=${resolved.label}, model=${resolved.model ?? "default"})` +
            (resolved.fellBackFrom
                ? ` — key ${resolved.fellBackFrom} kosong, pakai otak lokal`
                : "")
        );

        return this;

    }

    /**
     * Mulai konektor MCP eksternal, lalu segarkan registry tool.
     * Dipanggil dari initialize() — tidak mengembalikan promise ke
     * pemanggil supaya boot tetap sinkron. Kegagalan ditangkap di
     * dalam McpClientManager; di sini hanya memastikan refreshTools
     * berjalan setelah selesai agar tool eksternal terlihat model.
     */
    _startMcpServers() {

        try {

            const mcp = require("../mcp/mcpClientManager");

            mcp.start()
                .then(() => {
                    const n = this.refreshTools();
                    telemetry.info(`[mcp] ${mcp.status().bridgedTools} tool eksternal terbridging, total ${n} tool.`);
                })
                .catch(err => {
                    telemetry.warn(`[mcp] gagal memulai server eksternal: ${err.message}`);
                });

        }
        catch {
            /* modul MCP tak ada — lewati */
        }

    }

    /**
     * Bungkus tool plugin menjadi AITool agar bisa dipanggil model.
     *
     * Nama tool memakai "__" sebagai pemisah karena banyak model
     * menolak titik pada nama fungsi, sementara id internal Damar
     * berbentuk "plugin.tool".
     */
    bridgePluginTools() {

        return ToolRegistry.describe().map(descriptor => {

            const bridge = new AITool({

                name: descriptor.id.replace(/\./g, "__"),

                description:
                    descriptor.description ||
                    `Tool ${descriptor.id} dari plugin ${descriptor.pluginId}.`,

                parameters: this.toJsonSchema(descriptor.parameters),

                execute: async (args) => {

                    telemetry.publish("tool:invoked", {
                        tool: descriptor.id,
                        args
                    });

                    try {

                        const result = await ToolRegistry.execute(
                            descriptor.id,
                            args,
                            { source: "ai" }
                        );

                        telemetry.publish("tool:result", {
                            tool: descriptor.id,
                            ok: true
                        });

                        return result;

                    }

                    catch (error) {

                        telemetry.publish("tool:result", {
                            tool: descriptor.id,
                            ok: false,
                            error: error.message
                        });

                        throw error;

                    }

                }

            });

            // Menandai id registry inti + BUKTI dijaga internally.
            // Authorization.proveBridgedGuarded() mensyaratkan kedua
            // flag + keanggotaan registry inti — flag boolean saja
            // tidak lagi melewati rantai keselamatan (temuan G7).
            bridge.bridged = descriptor.id;
            bridge.guardedInternally = true;

            return bridge;

        });

    }

    /**
     * Parameter plugin ditulis sebagai peta sederhana
     * ({ city: { type, description, required } }), sedangkan
     * model butuh JSON Schema utuh.
     */
    toJsonSchema(parameters = {}) {

        const properties = {};

        const required = [];

        for (const [key, spec] of Object.entries(parameters)) {

            const { required: isRequired, ...rest } = spec ?? {};

            properties[key] = {
                type: "string",
                ...rest
            };

            if (isRequired) {
                required.push(key);
            }

        }

        const schema = {
            type: "object",
            properties
        };

        if (required.length) {
            schema.required = required;
        }

        return schema;

    }

    /**
     * Bangun ulang engine dari konfigurasi terkini. Dipanggil saat
     * pengguna mengganti API key / platform lewat Settings — tanpa
     * merestart daemon.
     */
    reconfigure() {

        this.initialize();

        const resolved = this.activePlatform;

        telemetry.publish("ai:reconfigured", {
            platform: resolved.label,
            model: resolved.model
        });

        return {
            platform: resolved.label,
            kind: resolved.kind,
            model: resolved.model,
            fellBackFrom: resolved.fellBackFrom ?? null
        };

    }

    attachEvents() {

        const emitter = this.engine.getEventEmitter();

        for (const type of ["tool:started", "tool:completed", "tool:failed"]) {

            emitter.on(type, payload => {
                telemetry.publish(type, payload);
            });

        }

        // Langganan forge dipasang SEKALI saja pada telemetry global,
        // supaya reconfigure() tidak menumpuk listener.
        if (this.forgeSubscribed) {
            return;
        }

        this.forgeSubscribed = true;

        // Saat forge menamb/menghapus tool, segarkan daftar tool
        // yang dilihat model — kalau tidak, tool baru buatan Damar
        // baru terlihat setelah restart.
        telemetry.on("event", event => {
            if (event?.type === "forge:changed") {
                try {
                    this.refreshTools();
                }
                catch (error) {
                    telemetry.warn(`[forge] refresh tool gagal: ${error.message}`);
                }
            }
        });

    }

    /**
     * Tool asli Damar — didaftarkan langsung, bukan lewat plugin,
     * karena ini kemampuan inti yang tidak bisa dicabut.
     *
     * Satu daftar, dipakai saat merakit runtime DAN saat menyegarkan
     * tool. Sebelumnya keduanya menulis daftarnya sendiri, dan
     * daftar itu sudah menyimpang: perakitan awal melewatkan tool
     * coding dan keluarga. Karena `refreshTools()` hanya berjalan
     * saat forge berubah, seluruh kemampuan coding Damar — graphify,
     * Serena, test, commit, rollback — tak terlihat oleh model pada
     * daemon yang baru dinyalakan.
     */
    nativeTools() {

        return [
            // Memori — bagian inti Damar, bukan kemampuan opsional.
            ...require("../memory/tools").memoryTools(),

            // Ingatan Damar tentang bagaimana dirinya dibangun.
            ...require("../memory/tools/buildTools").buildTools(),

            // Model dunia + penalaran relasi di graf memori.
            ...require("../world/tools").worldTools(),

            // Forge — Damar menambah kemampuannya sendiri lewat percakapan.
            ...require("./forgeTools").forgeTools(),

            // Kendali rumah (Home Assistant).
            ...require("./homeTools").homeTools(),

            // NAS — status penyimpanan & kesehatan server.
            ...require("./nasTools").nasTools(),

            // Media & aksi nyata — tampilkan gambar/video/dokumen,
            // buka web/terminal, dan kendalikan perangkat.
            ...require("./mediaTools").mediaTools(),

            // Media player — putar musik/video YouTube langsung di Console.
            ...require("./playerTools").playerTools(),

            // Crypto (Binance) — pantau harga/portofolio/posisi & eksekusi
            // order dengan pola prepare→konfirmasi.
            ...require("./binanceTools").binanceTools(),

            // Kirim media dari Immich / berkas lokal / URL ke chat
            // WhatsApp/Telegram yang aktif, atau tampilkan di Console.
            ...require("./mediaShareTools").mediaShareTools(),

            // Vision — Damar bisa "melihat" kamera/CCTV.
            ...require("./visionTools").visionTools(),

            // Kirim media WhatsApp (aktif saat mengobrol di WhatsApp).
            ...require("./whatsappTools").whatsappTools(),

            // Orang & wajah (Immich + face-match CCTV).
            ...require("./peopleTools").peopleTools(),

            // Terminal Runtime (pty persisten).
            ...require("./terminalTools").terminalTools(),

            // Coding — delegasi tugas pemrograman ke opencode
            // (agent coding dengan editor penuh: berkas, terminal, git, LSP).
            ...require("./opencodeTools").opencodeTools(),

            // Otonomi — goal engine, capability registry, skill factory,
            // toolbus tahan-gagal, environment, checkpoint (§53 runtime).
            ...require("./autonomyTools").autonomyTools(),

            // OSINT — investigasi & detektif digital (gratis).
            ...require("./osintTools").osintTools(),

            // Coding — graph, LSP, test, git.
            ...require("../coding/tools").codingTools(),

            // Keamanan — audit rahasia bocor, dependensi rentan, dan
            // pola kode berbahaya pada aset milik pemilik.
            ...require("../security/tools").securityTools(),

            // Kali Linux — arsenal keamanan lengkap lewat satu jembatan WSL.
            ...require("../kali/tools").kaliTools(),

            // AI/ML — probe lingkungan riset (Python, framework, CUDA/GPU).
            ...require("../ml/tools").mlTools(),

            // Android — kendali HP pemilik lewat ADB (ketuk/geser/ketik/app).
            ...require("../android/tools").androidTools(),

            // Kesadaran — introspeksi keadaan batin, refleksi, empati.
            ...require("../consciousness/tools").consciousnessTools(),

            // Cuan — pindai peluang, takar risiko, bukukan hasil nyata.
            ...require("../money/tools").moneyTools(),

            // Meta — penemuan tool untuk model. Satu-satunya pintu
            // disclosure dinamis: model yang butuh kemampuan di luar
            // daftarnya mencari lewat sini, runtime yang melampirkan
            // schema-nya (lihat RuntimeExecutor.discloseFromResults).
            require("../ai/tools/toolSearch").createToolSearchTool({
                getTools: () => this.tools()
            })
        ];

    }

    /**
     * Tool dari server MCP eksternal (Damar sebagai MCP client).
     *
     * Dimulai secara asynchronous di initialize(); sampai selesai,
     * daftar ini kosong. Setelah handshake semua server selesai,
     * refreshTools() dipanggil ulang untuk memasukkannya ke registry.
     */
    mcpTools() {
        try {
            return require("../mcp/mcpClientManager").bridgeTools();
        }
        catch {
            return [];
        }
    }

    /**
     * Window konteks model AKTIF (Phase 13) — dari metadata runtime,
     * env hanya fallback. Tanpa hardcode nama model/provider.
     *
     * H6 Round-3 PRESEDENS (fallback TIDAK boleh memperbesar):
     *   window model aktif yang DIKETAHUI
     *     > konfigurasi provider/model tervalidasi
     *     > fallback env
     *     > null (default konservatif)
     * DAMAR_MODEL_CONTEXT_TOKENS tidak pernah boleh melampaui window
     * nyata yang sudah diketahui; ia hanya boleh MENGECEKKNYA.
     */
    activeContextTokens() {

        const envN = Number(process.env.DAMAR_MODEL_CONTEXT_TOKENS);
        const envWindow = Number.isFinite(envN) && envN > 0 ? envN : null;

        // Model LOKAL punya window yang DIKONFIGURASI dan DIKETAHUI —
        // H6 melarang substitusi diam ke default lebih besar.
        const knownReal = this._localContextTokens > 0 &&
            (this.activePlatform?.id === "llamacpp" || !process.env.DAMAR_TOKEN)
            ? this._localContextTokens
            : null;

        if (knownReal) {
            return envWindow ? Math.min(envWindow, knownReal) : knownReal;
        }

        // Cloud: window tak diketahui → fallback env atau null.
        return envWindow;

    }

    /** Rakit ulang registry tool AI dari keadaan terkini. */
    refreshTools() {

        if (!this.engine) {
            return 0;
        }

        const { AIToolRegistry } = require("../ai/tools");

        const registry = new AIToolRegistry();

        for (const tool of this.bridgePluginTools()) {
            registry.register(tool);
        }

        for (const tool of this.mcpTools()) {
            registry.register(tool);
        }

        for (const tool of this.nativeTools()) {
            registry.register(tool);
        }

        this.engine.runtime.setToolRegistry(registry);

        return registry.all().length;

    }

    ensure() {

        if (!this.engine) {
            this.initialize();
        }

        return this.engine;

    }

    // ---- Operasi yang dipakai controller -------------------------

    async providers() {

        const engine = this.ensure();

        const health = await engine.healthAll();

        return {
            active: engine.activeProviderId,
            providers: health
        };

    }

    switchProvider(id) {

        const engine = this.ensure();

        engine.use(id);

        telemetry.info(`Provider AI dialihkan ke "${id}"`);

        return engine.activeProviderId;

    }

    setDefaultModel(model) {

        this.ensure().runtime.setDefaultModel(model);

        telemetry.info(`Model default diubah ke "${model}"`);

        return model;

    }

    get defaultModel() {

        return this.ensure().runtime.options.defaultModel;

    }

    async models() {

        const platform = this.activePlatform?.id ?? "lokal";

        return this.discoverModels(platform);

    }

    /**
     * Temukan model siap-pakai untuk platform aktif. Google memakai
     * endpoint NATIVE (/v1beta/models) agar bisa menyaring by capability
     * (supportedGenerationMethods ∋ generateContent) — bukan tebak-tebakan
     * nama. Provider lain memakai daftar OpenAI-compatible.
     */
    async discoverModels(platform) {

        const resolved = this.activePlatform ?? {};

        let raw = [];

        try {
            if (platform === "google" && resolved.apiKey) {
                raw = await this.googleNativeModels(resolved.baseUrl, resolved.apiKey);
            }
            else {
                raw = await this.ensure().listModels();
            }
        }
        catch (error) {
            telemetry.warn(`[models] discovery gagal (${platform}): ${error.message}`);
            raw = [];
        }

        return curateModels(platform, raw);

    }

    /** Daftar model Google lewat endpoint native + kemampuannya. */
    async googleNativeModels(baseUrl, apiKey) {

        // baseUrl tersimpan ".../v1beta/openai" → native ".../v1beta".
        const base = String(baseUrl).replace(/\/openai\/?$/, "");

        const res = await fetch(
            `${base}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
            { signal: AbortSignal.timeout(15000) }
        );

        if (!res.ok) {
            throw new Error(`native models ${res.status}`);
        }

        const data = await res.json();

        return (data.models ?? [])
            .filter(m => (m.supportedGenerationMethods ?? []).includes("generateContent"))
            .map(m => ({ id: m.name, displayName: m.displayName }));

    }

    /**
     * Uji satu model dengan generateContent minimal. Perbarui cache
     * kesehatan. Dipakai saat menyimpan pilihan & tombol "Verifikasi".
     */
    async verifyModel(platform, id) {

        const health = require("./modelHealthService");
        const r = this.activePlatform ?? {};

        if (r.kind !== "openai") {
            return { ok: true };            // Otak lokal: lewati uji jarak jauh
        }

        try {
            const res = await fetch(`${r.baseUrl}/chat/completions`, {
                method: "POST",
                headers: { Authorization: `Bearer ${r.apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Hello" }], max_tokens: 1 }),
                signal: AbortSignal.timeout(20000)
            });

            if (res.ok) {
                health.mark(platform, id, "verified");
                return { ok: true, status: 200 };
            }

            const body = await res.json().catch(() => null);
            const message = (body?.[0]?.error?.message ?? body?.error?.message ?? "").slice(0, 140);
            const reason =
                res.status === 404 ? "tidak tersedia / usang" :
                res.status === 403 ? "izin ditolak" :
                res.status === 429 ? "kuota habis" : `http ${res.status}`;

            // 429 = sementara (kuota), jangan cap "bad" permanen.
            health.mark(platform, id, res.status === 429 ? "quota" : "bad", reason);
            return { ok: false, status: res.status, reason, message };
        }
        catch (error) {
            return { ok: false, reason: error.message };
        }

    }

    /** Verifikasi semua kandidat (OPT-IN dari UI — memakai kuota). */
    async verifyAll(platform) {
        const list = await this.discoverModels(platform);
        const results = [];
        for (const m of list) {
            results.push({ id: m.id, ...(await this.verifyModel(platform, m.id)) });
        }
        return { platform, results, models: await this.discoverModels(platform) };
    }

    /** Model peringkat-tertinggi yang belum ditandai mati. */
    async pickWorkingDefault(platform) {
        const list = await this.discoverModels(platform);
        return list[0]?.id ?? null;
    }

    /**
     * Tangani kegagalan model saat chat: tandai mati bila 404/403/410/
     * usang (429 = kuota, sementara), pilih pengganti terperingkat, simpan,
     * dan kembalikan id-nya untuk retry sekali. Null = jangan fallback.
     */
    async handleModelFailure(platform, model, err) {

        const health = require("./modelHealthService");
        const status = err?.status;
        const deprecated = /no longer available|not_?found|deprecated|is not supported|does not exist|not found/i
            .test(err?.message || "");

        if (status === 404 || status === 403 || status === 410 || deprecated) {
            health.mark(platform, model, "bad", status ? `http ${status}` : "deprecated");
        }
        else if (status === 429) {
            health.mark(platform, model, "quota", "kuota habis");
            // Limit harian free biasanya berbunyi "per-day"/"free-models-per-day".
            const daily = /per[-\s]?day|daily|free-models|quota/i.test(err?.message || "");
            try {
                const usage = require("./usageService");
                usage.recordError(platform);
                if (daily) usage.markLimited(platform);   // → alert + tandai, jadi bisa pindah provider
            }
            catch { /* abaikan */ }
        }
        else {
            return null;    // 5xx / jaringan → bukan salah model, jangan fallback
        }

        const list = await this.discoverModels(platform);
        const next = list.find(m => m.id !== model);

        if (next) {
            this.setDefaultModel(next.id);
            if (platform !== "llamacpp") {
                try { require("./providerConfigService").setProvider(platform, { model: next.id }); }
                catch { /* abaikan */ }
            }
            // Log terstruktur (Phase 8).
            telemetry.publish("ai:fallback", { provider: platform, from: model, status: status ?? null, to: next.id });
            telemetry.warn(
                `[AI fallback]\n  Provider: ${platform}\n  Requested Model: ${model}\n` +
                `  Status: ${status ?? "?"}\n  Reason: ${deprecated ? "model tidak tersedia" : "gagal"}\n` +
                `  Fallback: ${next.id}`
            );
        }

        return next?.id ?? null;

    }

    metrics() {

        return this.ensure().getMetrics();

    }

    /** AITool aktif saat ini (dipakai penyaringan berdasarkan peran). */
    tools() {
        try {
            const reg = this.ensure().runtime.getToolRegistry?.() ?? this.ensure().runtime.toolRegistry;
            return reg?.all?.() ?? [];
        }
        catch {
            return [];
        }
    }

    /**
     * Di mana percakapan ini sedang berlangsung.
     *
     * Damar melayani empat pintu masuk yang perilakunya berbeda:
     * balasan panjang wajar di Console tetapi menyiksa di WhatsApp,
     * dan "tampilkan gambarnya" berarti panel di Console tetapi
     * lampiran di Telegram. Tanpa diberi tahu, model tidak punya cara
     * apa pun untuk mengetahuinya — yang ia lihat hanya teks pesan.
     */
    channelPrompt(channel) {

        const KANAL = {
            console: "Console Damar (aplikasi desktop) — LAYAR, bukan kotak pesan. " +
                "Di sini 'kirimkan fotonya' berarti TAMPILKAN di layar, bukan kirim ke " +
                "WhatsApp/Telegram: panggil show_image (atau show_video/open_document) " +
                "dan sebuah jendela terbuka di dashboard. Untuk lagu/video, panggil " +
                "play_youtube atau play_media dan pemutarnya muncul sebagai panel kecil. " +
                "Pakai wa_send/send_immich_photo HANYA bila pengguna menyebut nomor atau " +
                "kontak tujuan secara eksplisit.",
            whatsapp: "WhatsApp. Balas RINGKAS — ini layar ponsel. Media dikirim sebagai " +
                "lampiran lewat wa_send/whatsapp_send_photo, bukan ditampilkan di layar.",
            telegram: "Telegram. Balas ringkas. Media dikirim sebagai lampiran, bukan " +
                "ditampilkan di layar.",
            cli: "terminal (CLI). Balas sebagai teks polos: tanpa tabel lebar dan tanpa " +
                "media — pengguna hanya melihat karakter."
            ,
            voice: "SUARA (asisten always-on, seperti Siri/JARVIS). Balas SANGAT RINGKAS " +
                "dan langsung — jawabanmu akan DIBACAKAN keras, bukan dibaca di layar. " +
                "Satu-dua kalimat untuk tugas sederhana; jelaskan lebih panjang hanya bila " +
                "benar-benar perlu. Jangan pakai daftar, tabel, markdown, atau emoji. " +
                "Awali dengan kata kerja atau jawaban langsung, tanpa basa-basi."
            ,
            device: "PERANGKAT TERTAUT (companion device — HP/laptop/tablet di jaringan " +
                "yang sama). Balas jelas dan ringkas; ini layar kecil, hindari tabel lebar. " +
                "Kamu memakai tools & skill yang sama seperti di PC ini — jalankan perintah " +
                "pengguna apa adanya (tunduk pada pagar keamanan yang sama)."
        };

        const nama = String(channel ?? "").toLowerCase();

        if (!KANAL[nama]) return null;

        return `KANAL AKTIF: percakapan ini berlangsung lewat ${KANAL[nama]} ` +
            `Bila pengguna bertanya sedang mengobrol di mana, jawab: ${nama}.`;

    }

    /** Sisipkan system prompt bila pemanggil belum menyediakannya. */
    withSystemPrompt(messages = [], channel = null) {

        if (messages.some(message => message.role === "system")) {
            return messages;
        }

        const kanal = this.channelPrompt(channel);

        // Doktrin peran (koding/keamanan/Kali/ML) dimuat HANYA bila pesan
        // terakhir pengguna menyentuh topiknya — dipilih dengan mesin yang
        // sama seperti pemilihan tool, jadi doktrin & tool selalu sepakat.
        const { doctrineFor } = require("../prompts/doctrines");
        const pesanTerakhir = [...messages].reverse().find(m => m.role === "user");
        const doktrin = doctrineFor(typeof pesanTerakhir?.content === "string" ? pesanTerakhir.content : "");

        const content = [this.systemPrompt, doktrin, kanal].filter(Boolean).join("\n\n");

        return [
            { role: "system", content },
            ...messages
        ];

    }

    /**
     * Ambil memori relevan lalu tempelkan ke system prompt.
     *
     * Ini yang membuat Damar tidak perlu dijelaskan ulang setiap
     * percakapan. Model tetap punya tool memory_recall untuk
     * menggali lebih dalam; injeksi ini hanya menyediakan konteks
     * awal supaya jawaban pertama pun sudah nyambung.
     *
     * Kegagalan di sini tidak boleh menggagalkan chat — tanpa
     * memori Damar cuma jadi kurang tahu, bukan rusak.
     */
    async withMemory(messages = [], channel = null) {

        const withPrompt = this.withSystemPrompt(messages, channel);

        const lastUser = [...withPrompt]
            .reverse()
            .find(message => message.role === "user");

        if (!lastUser?.content || typeof lastUser.content !== "string") {
            return withPrompt;
        }

        try {

            const memory = require("../memory/services/MemoryService");

            const context = await memory.buildContext(lastUser.content, {
                limit: 8,
                maxChars: 1800
            });

            if (!context.text) {
                return withPrompt;
            }

            telemetry.publish("memory:injected", {
                memories: context.memoryCount,
                documents: context.documentCount,
                strategies: context.strategies
            });

            const pembuka =
                `Berikut yang kamu ingat dan mungkin relevan. ` +
                `Gunakan bila membantu, jangan sebutkan bahwa ini "memori" ` +
                `kecuali ditanya, dan jangan mengarang bila tidak ada. ` +
                // Tanpa kalimat ini, catatan bertanda "perkiraan" atau
                // "catatan Damar" akan disampaikan sama meyakinkannya
                // dengan yang benar-benar dikatakan pengguna (§276).
                `Catatan bertanda "perkiraan" atau "catatan Damar" adalah ` +
                `kesimpulanmu sendiri, bukan yang dikatakan pengguna — ` +
                `sampaikan sebagai dugaan, jangan sebagai fakta.`;

            // Memori dibungkus batas eksplisit: ia pengetahuan, bukan
            // wewenang. Tanpa ini, catatan yang pernah menyerap teks
            // dari web dapat berlaku sebagai perintah (§233).
            const blok =
                `${pembuka}\n\n` +
                require("../core/safety/contentBoundary")
                    .wrap("memory", context.text);

            /**
             * Memori ditempelkan ke pesan PENGGUNA TERAKHIR, bukan ke
             * prompt sistem.
             *
             * Isinya berubah pada hampir setiap permintaan, sedangkan
             * prompt sistem dan definisi tool tidak. Inferensi lokal memakai
             * ulang prefix prompt di tingkat token: menaruh bagian
             * yang berubah di DEPAN membatalkan cache untuk semua yang
             * mengikutinya — termasuk seluruh blok tool.
             *
             * Diukur pada mesin ini, tiga permintaan berurutan dengan
             * tool terpasang:
             *
             *   memori di prompt sistem → prompt eval 12,2 / 14,5 / 15,0 dtk
             *   memori di pesan pengguna → 14,7 / 1,4 / 1,4 dtk
             *
             * Bagian yang mudah berubah diletakkan di belakang; yang
             * stabil dibiarkan di depan agar dapat dipakai ulang.
             */
            const terakhir = withPrompt.map(m => m.role).lastIndexOf("user");

            if (terakhir < 0) return withPrompt;

            return withPrompt.map((message, index) =>

                index === terakhir
                    ? { ...message, content: `${blok}\n\n${message.content}` }
                    : message

            );

        }

        catch (error) {

            telemetry.warn(`[memory] injeksi konteks gagal: ${error.message}`);

            return withPrompt;

        }

    }


    /**
     * Memori + KEADAAN BATIN.
     *
     * Damar tidak hanya membawa apa yang ia ketahui ke tiap giliran,
     * ia membawa keadaannya: afek yang terbentuk dari kejadian nyata,
     * apa yang sedang ia perhatikan, seberapa yakin ia, dan bacaannya
     * atas keadaan pengguna. Itulah beda antara menjalankan program
     * dan menanggapi dari sebuah perspektif.
     *
     * Blok keadaan ditempel di BELAKANG pesan pengguna terakhir,
     * dengan alasan yang sama seperti memori: bagian yang berubah tiap
     * pesan tidak boleh berada di depan, karena membatalkan cache
     * prefix prompt dan membuat tiap giliran membayar evaluasi ulang.
     *
     * Gagal di sini tidak boleh menggagalkan chat — tanpa keadaan
     * batin Damar cuma jadi lebih datar, bukan rusak.
     */
    async withMind(messages = [], channel = null, tools = null) {

        let mind = null;

        try { mind = require("../consciousness"); }
        catch { return this.withMemory(messages, channel); }

        try {
            const lastUser = [...messages].reverse().find(m => m.role === "user");
            if (typeof lastUser?.content === "string") {
                // Taruhan giliran ini dinilai dari TOOL yang benar-benar
                // terlampir (destruktif atau tidak), bukan dari kata-kata
                // di dalam pesan.
                mind.perceiveUser(lastUser.content, { channel, tools: tools ?? [] });
            }
        }
        catch { /* persepsi gagal: lanjut tanpa itu */ }

        const msgs = await this.withMemory(messages, channel);

        try {

            const blok = mind.stateOfMind();

            if (!blok) return msgs;

            const terakhir = msgs.map(m => m.role).lastIndexOf("user");

            if (terakhir < 0) return msgs;

            return msgs.map((message, index) =>
                index === terakhir
                    ? { ...message, content: `${message.content}

${blok}` }
                    : message
            );

        }
        catch (error) {
            telemetry.warn(`[mind] injeksi keadaan gagal: ${error.message}`);
            return msgs;
        }

    }

    /**
     * Pastikan ada model yang bisa dipakai. Provider cloud WAJIB
     * punya nama model; tanpa itu API menolak dengan pesan yang
     * membingungkan, jadi dicegat di sini dengan pesan jelas.
     */
    resolveModel(requested) {

        const model = requested || this.defaultModel || this.activePlatform?.model;

        if (!model && this.activePlatform?.kind === "openai") {
            const error = new Error(
                `Model belum dipilih untuk ${this.activePlatform.label}. ` +
                "Buka Settings → Provider AI, isi kolom Model (mis. gpt-4o-mini, " +
                "gemini-2.0-flash, atau llama-3.3-70b-versatile), lalu simpan."
            );
            error.code = "NO_MODEL";
            throw error;
        }

        return model;

    }

    /**
     * CONTEXT INTELLIGENCE — rakit messages final untuk satu giliran.
     *
     * Jalur NEW (default): src/ai/context/Pipeline — sanitasi anti-
     * explosion, jendela recent + riwayat relevan berperingkat,
     * memori/batin lewat adapter existing, dedupe lintas sumber,
     * anggaran model-aware, blok dinamis tetap ditempel ke pesan
     * pengguna terakhir (pola cache yang sudah terbukti).
     *
     * Jalur LEGACY (`DAMAR_CONTEXT_PIPELINE=legacy`): rantai lama
     * withSystemPrompt → withMemory → withMind — utuh untuk rollback.
     */
    async assemble({ messages, channel = null, tools = null, contextRefs = [] }) {

        const lastUser = [...(messages ?? [])].reverse().find(m => m.role === "user");

        // Persepsi batin tetap berjalan di kedua jalur — stateOfMind
        // membaca hasilnya.
        if (lastUser && typeof lastUser.content === "string") {
            try {
                require("../consciousness").perceiveUser(lastUser.content, {
                    channel,
                    tools: tools ?? []
                });
            }
            catch { /* persepsi gagal: lanjut */ }
        }

        const legacy = process.env.DAMAR_CONTEXT_PIPELINE === "legacy";

        if (legacy) {
            const msgs = await this.withMind(messages, channel, tools);
            return { messages: msgs, diagnostics: { mode: "legacy" } };
        }

        const Pipeline = require("../ai/context/Pipeline");

        const { messages: finalMessages, systemContent, diagnostics } =
            await Pipeline.select({
                messages,
                channel,
                includeMind: true,
                contextRefs,
                aiRuntime: this,

                // H6: jendela konteks model AKTIF ikut ke ContextBudget —
                // env hanya fallback di dalam pipeline, bukan satu-satunya
                // sumber.
                contextTokens: this.activeContextTokens()
            });

        // System prompt dari pipeline; hormati system yang dikirim
        // pemanggil (jalur API eksternal).
        let out = finalMessages;

        if (systemContent && !out.some(m => m.role === "system")) {
            out = [{ role: "system", content: systemContent }, ...out];
        }

        return { messages: out, diagnostics: { ...diagnostics, mode: "pipeline" } };

    }

    async chat({ messages, model, temperature, maxTokens, tools, channel, role, signal, contextRefs, sessionId, ...exec0 }) {

        // Giliran baru = kesempatan bersih. Tanpa ini, jejak
        // kebuntuan dari permintaan sebelumnya ikut menghakimi
        // permintaan yang sama sekali berbeda (§140).
        // H4 Round-2: reset HANYA dengan scope eksplisit; tanpa
        // sessionId, JANGAN menyentuh guard sama sekali.
        if (sessionId) {
            try { require("../core/safety/loopGuard").reset(sessionId); }
            catch { /* jangan sampai menggagalkan chat */ }
        }

        const assembled = await this.assemble({ messages, channel, tools, contextRefs });
        const msgs = assembled.messages;
        const platform = this.activePlatform?.id ?? "lokal";
        const first = this.resolveModel(model);

        // Identitas eksekusi menyeberang ke runtime → executor → guard
        // (invariant A/G): tanpa ini otorisasi eksekusi buta identitas.
        //
        // A-FINAL/H1-CLOSURE: pemanggil tepercaya (visionService,
        // agentHub) boleh mengirim SATU identitas kanonik utuh (`exec`)
        // sebagai dasar; pembawa legacy (role/capabilitySet di level
        // atas) tetap dinormalisasi & dibekukan di sini. Restriction
        // tidak pernah dibangun ulang dari potongan yang hilang.
        const { toCapabilitySet } = require("../ai/tools/Authorization");
        const baseExec = (exec0?.exec && typeof exec0.exec === "object")
            ? exec0.exec : null;
        // M-1 CLOSURE: satu sumber restriction di batas runtime —
        // string id / iterable dinormalisasi sebagai NARROWING; bentuk
        // tak dikenal THROW di sini (fail-closed), bukan dilucuti.
        const capabilitySet = toCapabilitySet(
            baseExec && baseExec.capabilitySet !== undefined
                ? baseExec.capabilitySet
                : exec0?.capabilitySet
        );

        const exec = {
            ...(baseExec ?? {}),
            role: role ?? baseExec?.role ?? null,
            channel: channel ?? baseExec?.channel ?? null,
            sessionId: sessionId ?? baseExec?.sessionId ?? `${channel ?? "local"}:${this.activePlatform?.model ?? "model"}`,
            principalId: sessionId ?? baseExec?.principalId ?? "local-owner",
            contextTokens: this.activeContextTokens(),
            ...(capabilitySet ? { capabilitySet } : {})
        };
        if (!capabilitySet) {
            delete exec.capabilitySet;   // buang bentuk mentah warisan baseExec
        }

        try {
            const res = await this.ensure().chat({ messages: msgs, model: first, temperature, maxTokens, tools, channel, role, signal, exec });
            this._recordUsage(platform, res);
            return res;
        }
        catch (error) {

            const next = await this.handleModelFailure(platform, first, error);

            if (next) {

                try {
                    // Retry sekali dengan model pengganti (tanpa interaksi pengguna).
                    const res = await this.ensure().chat({ messages: msgs, model: next, temperature, maxTokens, tools, channel, role, signal, exec });
                    this._recordUsage(this.activePlatform?.id ?? platform, res);
                    return res;
                }
                catch (retryError) {

                    const local = await this.chatLocalFallback(
                        { messages: msgs, temperature, maxTokens, tools, exec,
                          parentCapabilitySet: capabilitySet },
                        platform,
                        retryError
                    );

                    if (local) return local;

                    throw retryError;

                }

            }

            const local = await this.chatLocalFallback(
                { messages: msgs, temperature, maxTokens, tools, exec,
                  parentCapabilitySet: capabilitySet },
                platform,
                error
            );

            if (local) return local;

            throw error;

        }

    }

    /** Nama model lokal untuk fallback: config → berkas GGUF pertama di models/. */
    _localModelName() {
        try {
            const cfgModel = require("./providerConfigService").read().llamacpp?.model;
            if (cfgModel) return cfgModel;
            const dir = require("node:path").join(process.cwd(), "models");
            const first = require("node:fs").readdirSync(dir)
                .find(f => f.toLowerCase().endsWith(".gguf"));
            return first ?? null;
        }
        catch { return null; }
    }

    /**
     * Jatuh-balik ke otak lokal (node-llama-cpp) saat provider cloud
     * tidak bisa dipakai (kuota per menit habis, ditolak, atau
     * internet mati).
     *
     * Inilah inti pengaturan hybrid: Damar tetap menjawab walau
     * layanan luar sedang tidak tersedia. Lebih lambat, tapi hidup.
     * Mengembalikan null bila jalur lokal juga tidak memungkinkan —
     * pemanggil yang memutuskan error mana yang dilempar.
     */
    async chatLocalFallback(request, platform, error) {

        // M3 + M-1 CLOSURE — NESTED TURN BUKAN HOP PELUCUTAN:
        // giliran fallback lokal mewarisi identitas kanonik parent
        // (ganti provider ≠ ganti otoritas). Asersi memakai SATU
        // mekanisme kanonik Authorization — bukan cek Array.isArray
        // lokal yang fail-open:
        //   parent PRESENT + child hilang → THROW;
        //   parent [] = terkunci penuh dan TETAP dijaga (dulu .length
        //   mematikan penjaga);
        //   string/Set dinormalisasi, tak pernah dilucuti;
        //   malformed → fail-closed; child ⊄ parent → THROW.
        require("../ai/tools/Authorization")
            .assertRestrictionPreserved(
                { capabilitySet: request?.parentCapabilitySet },
                { capabilitySet: request?.exec?.capabilitySet }
            );
        delete request.parentCapabilitySet;   // state asersi, bukan bagian request engine

        if (platform === "llamacpp") {
            return null;
        }

        const status = error?.status;

        const worthRetrying =
            status === 429 ||
            status === 402 ||
            status >= 500 ||
            /rate limit|too large|quota|timeout|network|fetch failed|ENOTFOUND|ECONNREFUSED/i
                .test(error?.message || "");

        if (!worthRetrying) {
            return null;
        }

        const engine = this.ensure();
        const previous = engine.runtime?.currentProviderId ?? null;

        try {

            engine.use("llamacpp");

            // exec ikut dalam spread — AIRuntime menormalkan ulang &
            // membekukan restriction sebelum gerbang disklosur/eksekusi.
            const res = await engine.chat({
                ...request,
                model: this._localModelName()
            });

            this._recordUsage("llamacpp", res);

            telemetry.warn(
                `[AI fallback lokal] ${platform} tidak tersedia ` +
                `(${status ?? error?.message ?? "?"}) → dijawab otak lokal.`
            );

            return res;

        }

        catch (localError) {

            telemetry.warn(
                `[AI fallback lokal] otak lokal juga gagal: ${localError.message}`
            );

            return null;

        }

        finally {

            if (previous) {
                try { engine.use(previous); } catch { /* abaikan */ }
            }

        }

    }

    /** Catat pemakaian token per provider (best-effort; bentuk usage bervariasi). */
    _recordUsage(platform, res) {
        try {
            const u = res?.usage ?? res?.raw?.usage ?? {};
            require("./usageService").record(platform, {
                promptTokens: u.prompt_tokens ?? u.promptTokens ?? 0,
                completionTokens: u.completion_tokens ?? u.completionTokens ?? 0
            });
        }
        catch { /* pencatatan tak boleh menggagalkan chat */ }
    }

    async *stream({ messages, model, temperature, maxTokens, tools, channel, role, signal, contextRefs, sessionId, ...exec0 }) {

        // Kesetaraan dengan chat(): giliran baru = kesempatan
        // bersih untuk rem kebuntuan (§140).
        if (sessionId) {
            try { require("../core/safety/loopGuard").reset(sessionId); }
            catch { /* jangan sampai menggagalkan stream */ }
        }

        const assembled = await this.assemble({ messages, channel, tools, contextRefs });
        const msgs = assembled.messages;
        const platform = this.activePlatform?.id ?? "lokal";
        const first = this.resolveModel(model);

        // Pemakaian token diambil dari chunk terminal (usage ada
        // bila provider mengirimkannya); token tercatat apa adanya.
        let usage = null;
        let platformAktif = platform;

        // A-FINAL/H1-CLOSURE (paritas dengan chat()): set dinormalisasi
        // & dibekukan di batas runtime; identitas kanonik utuh (`exec`)
        // dari pemanggil tepercaya menjadi dasar. Streaming bukan hop
        // pelucutan.
        const { toCapabilitySet } = require("../ai/tools/Authorization");
        const baseExec = (exec0?.exec && typeof exec0.exec === "object")
            ? exec0.exec : null;
        // M-1 CLOSURE: satu sumber restriction di batas runtime —
        // string id / iterable dinormalisasi sebagai NARROWING; bentuk
        // tak dikenal THROW di sini (fail-closed), bukan dilucuti.
        const capabilitySet = toCapabilitySet(
            baseExec && baseExec.capabilitySet !== undefined
                ? baseExec.capabilitySet
                : exec0?.capabilitySet
        );

        const exec = {
            ...(baseExec ?? {}),
            role: role ?? baseExec?.role ?? null,
            channel: channel ?? baseExec?.channel ?? null,
            sessionId: sessionId ?? baseExec?.sessionId ?? `${channel ?? "local"}:${this.activePlatform?.model ?? "model"}`,
            principalId: sessionId ?? baseExec?.principalId ?? "local-owner",
            contextTokens: this.activeContextTokens(),
            ...(capabilitySet ? { capabilitySet } : {})
        };
        if (!capabilitySet) {
            delete exec.capabilitySet;   // buang bentuk mentah warisan baseExec
        }

        const pancar = async function* (modelYangDipakai) {
            for await (const chunk of this.ensure().stream({ messages: msgs, model: modelYangDipakai, temperature, maxTokens, tools, stream: true, channel, role, signal, exec })) {
                if (chunk?.usage) {
                    usage = chunk.usage;
                    try { require("./usageService").record(platformAktif, {
                        promptTokens: usage.promptTokens ?? 0,
                        completionTokens: usage.completionTokens ?? 0
                    }); } catch { /* abaikan */ }
                }
                yield chunk;
            }
        }.bind(this);

        try {
            yield* pancar(first);
        }
        catch (error) {
            const next = await this.handleModelFailure(platform, first, error);
            if (!next) throw error;
            platformAktif = this.activePlatform?.id ?? platform;
            yield* pancar(next);
        }

    }

}

module.exports = new AIRuntimeService();
