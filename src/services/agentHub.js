const { manager: integrations } = require("../integrations");
const telemetry = require("./telemetryService");

const agentTools = require("../agent/agentTools");

/**
 * AgentHub — menyatukan beberapa "pekerja" dalam satu antarmuka.
 *
 * Aether bukan satu model saja; ia bisa mendelegasikan ke:
 *   - aether : otak LLM lokal (reasoning + tool + memori)
 *   - 10 anak buah: spesialis berbasis peran di runtime yang sama
 */

class AgentHub {

    /** Definisi semua agent yang bisa dipakai orkestrator. */
    agents() {

        return [
            {
                id: "aether",
                label: "Aether (LLM lokal)",
                kind: "reasoner",
                description:
                    "Menalar, menjawab, menulis, memakai memori & tool internal " +
                    "(kalkulasi, memori, filesystem, http, dst). Pilihan default " +
                    "untuk berpikir dan menyusun jawaban.",
                skills: [
                    "Menalar & menjawab",
                    "Memori jangka panjang",
                    "Vision — lihat kamera/CCTV",
                    "Kendali rumah",
                    "Kenali wajah (Immich)",
                    "Kirim media WhatsApp",
                    "Buat skill sendiri"
                ]
            },

            // ---- 10 anak buah Aether ------------------------------
            // Spesialis berbasis peran, BUKAN identitas AI terpisah.
            // Semua berjalan di runtime Aether yang sama dengan bias
            // peran — selalu online selama daemon hidup. Aether tetap
            // orkestrator akhir; agen boleh mendelegasikan bila diizinkan.

            {
                id: "vanta",
                label: "Vanta (riset & analisis)",
                kind: "worker",
                role: "Kamu Vanta, spesialis intelijen Aether. Riset informasi, analisis subjek kompleks, temukan pola, bandingkan alternatif, dan hasilkan temuan terstruktur dengan rujukan yang jelas.",
                description: "Riset, analisis informasi, deteksi pola, dan laporan terstruktur.",
                skills: ["Riset & browsing", "Analisis informasi", "Deteksi pola", "Ekstraksi fakta", "Analisis banding", "Laporan"],
                tools: ["web", "osint", "filesystem", "memory"],
                canDelegateTo: ["forge", "mira", "cipher"]
            },
            {
                id: "forge",
                label: "Forge (software engineering)",
                kind: "worker",
                role: "Kamu Forge, spesialis rekayasa perangkat lunak Aether. Bangun, ubah, debug, test, refactor, dan rawat perangkat lunak Aether serta proyek terhubung.",
                description: "Membangun, memodifikasi, debug, test, refactor, dan merawat kode.",
                skills: ["Generasi kode", "Perbaikan bug", "Refactoring", "Implementasi arsitektur", "Testing", "Operasi Git", "Manajemen dependensi", "Debug runtime"],
                tools: ["opencode", "terminal", "git", "code_search", "test_runner", "filesystem"],
                canDelegateTo: ["mira", "cipher", "vanta"]
            },
            {
                id: "nexus",
                label: "Nexus (sistem & infrastruktur)",
                kind: "worker",
                role: "Kamu Nexus, insinyur sistem Aether. Kendalikan & diagnosis OS, proses, layanan, kontainer, jaringan, penyimpanan, dan infrastruktur.",
                description: "Kendali dan diagnosis sistem, proses, kontainer, jaringan, dan penyimpanan.",
                skills: ["Manajemen proses", "Manajemen layanan", "Administrasi OS", "Docker", "Diagnostik jaringan", "Diagnostik penyimpanan", "Troubleshooting sistem"],
                tools: ["terminal", "powershell", "filesystem", "docker", "network", "process_manager", "ssh", "nas"],
                canDelegateTo: ["forge", "cipher", "pulse"]
            },
            {
                id: "sera",
                label: "Sera (vision)",
                kind: "worker",
                role: "Kamu Sera, spesialis penglihatan Aether. Pahami gambar, screenshot, dokumen, frame CCTV, objek visual, dan anomali visual.",
                description: "Memahami gambar, screenshot, dokumen, dan frame CCTV.",
                skills: ["Pemahaman gambar", "Analisis screenshot", "OCR", "Analisis CCTV", "Deteksi objek", "Troubleshooting visual"],
                tools: ["vision", "ocr", "cctv", "camera", "gallery"],
                canDelegateTo: ["nexus", "cipher", "forge"]
            },
            {
                id: "echo",
                label: "Echo (suara & audio)",
                kind: "worker",
                role: "Kamu Echo, spesialis suara & audio Aether. Tangani pengenalan suara, transkripsi, perintah suara, analisis audio, dan sintesis suara.",
                description: "Pengenalan suara, transkripsi, dan sintesis suara.",
                skills: ["Speech-to-text", "Transkripsi audio", "Perintah suara", "Analisis audio", "Text-to-speech"],
                tools: ["microphone", "speech_to_text", "text_to_speech", "audio_processor", "media_player"],
                canDelegateTo: ["vanta", "sera"]
            },
            {
                id: "cipher",
                label: "Cipher (keamanan)",
                kind: "worker",
                role: "Kamu Cipher, spesialis keamanan Aether. Audit izin, deteksi ancaman, dan tegakkan kebijakan keamanan untuk melindungi Aether & sistem terhubung.",
                description: "Audit keamanan, analisis izin, dan deteksi ancaman.",
                skills: ["Audit keamanan", "Analisis izin", "Keamanan kredensial", "Deteksi ancaman", "Keamanan jaringan", "Keamanan dependensi", "Audit konfigurasi"],
                tools: ["terminal", "network", "security_scanner", "git", "process_manager", "osint", "code_search"],
                canDelegateTo: ["nexus", "forge", "vanta"]
            },
            {
                id: "atlas",
                label: "Atlas (otomatisasi)",
                kind: "worker",
                role: "Kamu Atlas, spesialis otomatisasi Aether. Rancang & jalankan alur kerja, integrasi, tugas terjadwal, dan operasi berulang.",
                description: "Otomatisasi alur kerja, integrasi API, dan tugas terjadwal.",
                skills: ["Otomatisasi alur kerja", "Orkestrasi tugas", "Integrasi API", "Tugas terjadwal", "Penanganan event", "Pipeline data"],
                tools: ["workflow_engine", "api", "scheduler", "webhooks", "terminal", "web", "filesystem"],
                canDelegateTo: ["forge", "nexus", "vanta"]
            },
            {
                id: "mira",
                label: "Mira (memori & konteks)",
                kind: "worker",
                role: "Kamu Mira, spesialis memori Aether. Kelola memori kontekstual, retrieval, ringkasan, organisasi pengetahuan, dan informasi jangka panjang.",
                description: "Mengelola memori, retrieval, dan organisasi pengetahuan.",
                skills: ["Penyimpanan memori", "Retrieval", "Manajemen konteks", "Ringkasan percakapan", "Organisasi pengetahuan", "Pemeliharaan memori"],
                tools: ["memory_store", "memory_search", "vector_search", "gallery_people"],
                canDelegateTo: ["vanta", "forge"]
            },
            {
                id: "pulse",
                label: "Pulse (monitoring & diagnostik)",
                kind: "worker",
                role: "Kamu Pulse, spesialis monitoring Aether. Pantau Aether & infrastruktur, analisis log & metrik, deteksi anomali, dan laporkan kesehatan sistem.",
                description: "Monitoring kesehatan, analisis log & metrik, deteksi anomali.",
                skills: ["Monitoring kesehatan", "Analisis log", "Analisis metrik", "Deteksi anomali", "Monitoring layanan", "Diagnostik performa", "Peringatan"],
                tools: ["process_manager", "logs", "metrics", "network", "system_monitor", "docker", "cctv", "home"],
                canDelegateTo: ["nexus", "cipher", "forge"]
            },
            {
                id: "lumen",
                label: "Lumen (antarmuka & interaksi)",
                kind: "worker",
                role: "Kamu Lumen, spesialis antarmuka Aether. Kelola antarmuka pengguna, alur interaksi, notifikasi, dan presentasi per kanal (Console/WhatsApp).",
                description: "Antarmuka pengguna, alur interaksi, dan notifikasi per kanal.",
                skills: ["Interaksi Console", "Interaksi WhatsApp", "Keadaan UI", "Alur UX", "Notifikasi", "Format pesan", "Adaptasi kanal"],
                tools: ["console", "whatsapp", "notifications", "ui", "api", "media_share"],
                canDelegateTo: ["forge", "echo", "sera"]
            }
        ];

    }

    describe() {
        return this.agents();
    }

    get(id) {
        return this.agents().find(a => a.id === id) ?? null;
    }

    /**
     * Apakah agent-konektor sedang online — SINKRON,
     * dari status terakhir yang diketahui, tanpa memanggil jaringan.
     *
     * Dipakai untuk menyaring tool: bila konektor offline, tool-tool
     * yang menuntutnya tidak perlu ditawarkan ke model — kalau tidak,
     * model memilihnya lalu gagal dengan "konektor sedang offline"
     * sementara jalur langsung tersedia.
     *
     * Default TRUE bila status belum diketahui: jangan menyembunyikan
     * kemampuan hanya karena probe pertama belum jalan.
     */
    connectorOnline(id) {
        try {
            const connector = integrations.get(id);
            if (!connector) return false;               // tak dikonfigurasi
            return connector.lastStatus?.online !== false;
        }
        catch {
            return true;
        }
    }

    /** Status kesiapan tiap agent (untuk UI & pemilihan rute). */
    async health() {

        const out = [];

        for (const agent of this.agents()) {

            // Agent inti & 10 anak buah hidup di runtime Aether yang
            // sama — selalu online selama daemon berjalan.
            if (agent.id === "aether" || agent.kind === "worker") {

                let toolCount = 0;
                try {
                    toolCount = require("../core/tools").ToolRegistry.describe().length;
                }
                catch { /* registry belum siap */ }

                out.push({
                    ...agent,
                    skills: agent.id === "aether" && toolCount
                        ? [...agent.skills, `+${toolCount} tool internal`]
                        : agent.skills,
                    online: true,
                    detail: agent.id === "aether" ? "runtime lokal" : "anak buah Aether"
                });
                continue;
            }

            const connector = integrations.get(agent.id);

            if (!connector) {
                out.push({ ...agent, online: false, detail: "tidak dikonfigurasi" });
                continue;
            }

            const snapshot = connector.lastStatus ?? {};

            out.push({
                ...agent,
                online: snapshot.online === true,
                detail: snapshot.online ? (connector.baseUrl ?? "") : (snapshot.error ?? "offline")
            });

        }

        return out;

    }

    /**
     * Jalankan satu tugas pada agent tertentu.
     *
     * `contextRefs` adalah port Context Intelligence untuk masa depan
     * (Colony): director mengirim referensi ("project:x") alih-alih
     * menyalin seluruh context; pipeline yang menyelesaikannya menjadi
     * context minimal untuk worker.
     *
     * N2: `exec` = identitas eksekusi DELEGATOR. Delegasi tidak boleh
     * menaikkan otoritas — worker mewarisi otoritas delegator.
     *
     * @returns {Promise<{ ok, agent, output, error? }>}
     */
    async run(agentId, task, { signal = null, contextRefs = [], exec = null } = {}) {

        telemetry.publish("agent:run", { agent: agentId, task: String(task).slice(0, 80) });

        try {

            if (agentId === "aether") {
                return { ok: true, agent: agentId, output: await this.runAether(task, { contextRefs, exec }) };
            }

            // 10 anak buah: runtime Aether yang sama + bias peran.
            const worker = this.get(agentId);

            if (worker?.kind === "worker") {
                return { ok: true, agent: agentId, output: await this.runWorker(worker, task, { contextRefs, exec }) };
            }

            throw new Error(`Agent tidak dikenal: ${agentId}`);

        }

        catch (error) {

            telemetry.warn(`[agent] ${agentId} gagal: ${error.message}`);

            return { ok: false, agent: agentId, output: null, error: error.message };

        }

    }

    /**
     * N2-FINAL — penafsir delegasi yang SUDAH diselesaikan oleh titik
     * kanonik (Authorization.resolveDelegator). Hanya grant kanonik
     * berprovenance 'autonomous:' yang menghasilkan 'system'; identitas
     * biasa mewarisi perannya; tanpa keduanya → 'user' least-privilege.
     */
    delegatedRoleOf(exec) {
        const { isCanonicalInternalGrant } = require("../ai/tools/Authorization");
        if (isCanonicalInternalGrant(exec)) return "system";
        const role = String(exec?.role ?? "").toLowerCase();
        return role || "user";
    }

    /**
     * A-FINAL — RUNTIME ASSERTION: restriction tidak boleh hilang
     * di transit. Bila delegator membawa capabilitySet, permintaan
     * ke runtime WAJIB membawanya juga. Pelanggaran = bug wiring,
     * gagal-keras (fail-closed) sebelum otoritas bocor.
     *
     * M-1 CLOSURE: dulu precondition checker adalah Array.isArray
     * sendiri — restriction berbentuk non-array (string id, Set
     * programatik, hasil serialisasi rusak) MELOLEWATI asersi dan
     * lenyap menjadi privileged + unrestricted. Kini state restriction
     * dideteksi via Authorization.hasRestriction (malformed = PRESENT),
     * normalisasi lewat toCapabilitySet (fail-closed), dan pelestarian
     * diverifikasi arah: child hanya boleh SAMA atau LEBIH SEMPIT.
     */
    assertRestrictionsPreserved(exec, request) {
        // M-1 CLOSURE: SATU mekanisme kanonik di Authorization —
        // dipakai bersama batas fallback runtime; tidak ada lagi
        // implementasi pelestarian lokal yang bisa menyimpang.
        return require("../ai/tools/Authorization")
            .assertRestrictionPreserved(exec, request);
    }

    async runAether(task, { contextRefs = [], exec = null } = {}) {

        const aiRuntime = require("./aiRuntimeService");

        // CRITICAL-1 FIX: capabilitySet delegasi IKUT ke runtime.
        // Dulu hanya role/sessionId yang lewat — restriction watchdog
        // lenyap di hop pertama dan worker melihat universe penuh.
        const request = {
            messages: [{ role: "user", content: String(task) }],
            contextRefs,
            // N2-FINAL: direktor mewarisi delegator; identitas hilang
            // dari jalur tak-tepercaya = 'user', BUKAN system implisit.
            role: this.delegatedRoleOf(exec),
            sessionId: exec?.sessionId ?? "anon"
        };

        // M-1 CLOSURE: restriction ikut dalam bentuk yang SAH apa pun
        // (array/string id/Set programatik); malformed = gagal-keras
        // di sini, bukan lenyap lalu tertangkap asersi.
        const runAetherSet = require("../ai/tools/Authorization")
            .toCapabilitySet(exec?.capabilitySet);
        if (runAetherSet) {
            request.capabilitySet = runAetherSet;
        }

        this.assertRestrictionsPreserved(exec, request);

        const response = await aiRuntime.chat(request);

        return response.content ?? "";

    }

    /** Anak buah menjalankan tugas dengan bias peran DAN tool sesuai topiknya.
     *
     * Seleksi kini lewat pipeline yang SAMA dengan chat biasa
     * (ai/tools/Pipeline.js): tugas dinilai secara deterministik,
     * lalu profil spesialis worker (agentTools.profileFor) masuk
     * sebagai BOOST — menguntungkan tool khas perannya tanpa pernah
     * menggantikan penilaian. Dulu daftar statis per worker dikirim
     * mentah dan melewati seluruh mesin seleksi.
     *
     * Forge adalah kasus khusus: tugas menulis/mengubah kode
     * didelegasikan ke opencode lewat tool `opencode_run` — agent
     * coding sungguhan dengan editor penuh, bukan patch manual.
     */
    async runWorker(agent, task, { contextRefs = [], exec = null } = {}) {

        const aiRuntime = require("./aiRuntimeService");

        // N2 Round-2 — DELEGI TIDAK MENAIKKAN OTORITAS, dan identitas
        // hilang ≠ grant tepercaya. Lihat delegatedRoleOf().
        const workerRole = this.delegatedRoleOf(exec);

        // C-F — himpunan kapabilitas terbatas ikut ke SELEKSI: worker
        // ber-delegasi terbatas tidak melihat kandidat di luar set.
        // Pencocokan KANONIK (bukan tail) — satu mesin dengan gerbang
        // eksekusi, jadi seleksi & otorisasi tidak pernah berbeda.
        let universe = aiRuntime.tools();
        const filterSet = require("../ai/tools/Authorization")
            .toCapabilitySet(exec?.capabilitySet);
        if (filterSet && filterSet.length) {
            const { capSetWithin } = require("../ai/tools/Authorization");
            universe = universe.filter(t => capSetWithin(t.name, filterSet));
        }

        let tools = [];

        try {
            const Pipeline = require("../ai/tools/Pipeline");
            const agentTools = require("../agent/agentTools");

            tools = Pipeline.select({
                tools: universe,
                message: String(task),
                // Seleksi memakai peran worker hasil penurunan —
                // user yang mendelegasikan tidak melihat/mendapat
                // tool privileged lewat jalur worker.
                role: workerRole,
                workerId: agent.id,
                boost: agentTools.profileFor(agent.id)
            }).tools;
        }
        catch { /* registry belum siap — jalan tanpa tool */ }

        // Bias peran ditempel SEBELUM pesan pengguna, bukan sebagai
        // pesan system — supaya system prompt utama (memori, tool)
        // tetap terpasang oleh aiRuntimeService.
        const instruksi = agent.id === "forge"
            ? `[Peran: ${agent.label}]\n${agent.role}\n\n` +
              "Untuk mengubah/menulis kode, WAJIB delegasikan ke opencode lewat tool " +
              "`opencode_run` — jangan tulis patch manual lewat filesystem.\n\n" +
              `Tugas: ${String(task)}`
            : `[Peran: ${agent.label}]\n${agent.role}\n\nTugas: ${String(task)}`;

        const request = {
            messages: [{ role: "user", content: instruksi }],
            tools,
            contextRefs,
            // H7 Round-2 + N2: seleksi & eksekusi SATU identitas
            // koheren yang DITURUNKAN dari delegator. workerId tetap
            // penanda delegasi/telemetri — BUKAN sumber otoritas.
            role: workerRole,
            sessionId: exec?.sessionId
                ? `${exec.sessionId}>worker:${agent.id}`
                : `worker:${agent.id}`
        };

        // CRITICAL-1 FIX: restriction ikut ke runtime (sama dengan
        // runAether) — worker terbatas tidak boleh kehilangan set-nya.
        // CRITICAL-1 FIX + M-1 CLOSURE: restriction ikut ke runtime
        // dalam bentuk sah apa pun; malformed fail-closed di sini.
        const workerSet = require("../ai/tools/Authorization")
            .toCapabilitySet(exec?.capabilitySet);
        if (workerSet) {
            request.capabilitySet = workerSet;
        }

        this.assertRestrictionsPreserved(exec, request);

        const response = await aiRuntime.chat(request);

        return response.content ?? "";

    }

}

module.exports = new AgentHub();
