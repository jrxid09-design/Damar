const { manager: integrations } = require("../integrations");
const telemetry = require("./telemetryService");

const agentTools = require("../agent/agentTools");

/**
 * AgentHub — menyatukan beberapa "pekerja" di bawah satu antarmuka.
 *
 * Aether bukan satu model saja; ia bisa mendelegasikan ke:
 *   - aether   : otak LLM lokal (reasoning + tool + memori)
 *   - openclaw : "tangan digital" — mengoperasikan aplikasi desktop
 *                yang tak punya API (klik, isi form, dsb)
 *   - hermes   : runtime agent untuk tugas berlapis
 *
 * OpenClaw & Hermes dipanggil lewat konektor integrasi yang sudah
 * ada. Karena instance sungguhannya belum bisa diverifikasi di sini,
 * pemanggilannya dibuat "gagal dengan anggun": agent offline
 * melaporkan status, bukan menjatuhkan orkestrasi.
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
            {
                id: "openclaw",
                label: "OpenClaw (otomasi desktop)",
                kind: "actuator",
                description:
                    "Mengoperasikan aplikasi desktop/website tanpa API: klik tombol, " +
                    "isi formulir, buka browser, tugas berulang di komputer. Pilih ini " +
                    "untuk AKSI pada antarmuka yang tak bisa dilakukan lewat kode biasa.",
                skills: [
                    "Klik & isi formulir",
                    "Operasikan aplikasi desktop",
                    "Buka & kendalikan browser",
                    "Tugas berulang di layar"
                ]
            },
            {
                id: "hermes",
                label: "Hermes (agent runtime)",
                kind: "agent",
                description:
                    "Menjalankan tugas agentik berlapis di runtime terpisah. Pilih ini " +
                    "untuk pekerjaan panjang yang lebih cocok didelegasikan ke agent khusus.",
                skills: [
                    "Tugas agentik berlapis",
                    "Orkestrasi tugas panjang",
                    "Runtime agent terpisah"
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
     * Apakah agent-konektor (openclaw/hermes) sedang online — SINKRON,
     * dari status terakhir yang diketahui, tanpa memanggil jaringan.
     *
     * Dipakai untuk menyaring tool: bila openclaw offline, tool-tool
     * yang menuntutnya tidak perlu ditawarkan ke model — kalau tidak,
     * model memilihnya lalu gagal dengan "openclaw sedang offline"
     * sementara jalur langsung (open_app/desktop_type) tersedia.
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
     * @returns {Promise<{ ok, agent, output, error? }>}
     */
    async run(agentId, task, { signal = null } = {}) {

        telemetry.publish("agent:run", { agent: agentId, task: String(task).slice(0, 80) });

        try {

            if (agentId === "aether") {
                return { ok: true, agent: agentId, output: await this.runAether(task) };
            }

            // 10 anak buah: runtime Aether yang sama + bias peran.
            const worker = this.get(agentId);

            if (worker?.kind === "worker") {
                return { ok: true, agent: agentId, output: await this.runWorker(worker, task) };
            }

            if (agentId === "openclaw" || agentId === "hermes") {
                return { ok: true, agent: agentId, output: await this.runConnector(agentId, task, signal) };
            }

            throw new Error(`Agent tidak dikenal: ${agentId}`);

        }

        catch (error) {

            telemetry.warn(`[agent] ${agentId} gagal: ${error.message}`);

            return { ok: false, agent: agentId, output: null, error: error.message };

        }

    }

    async runAether(task) {

        const aiRuntime = require("./aiRuntimeService");

        const response = await aiRuntime.chat({
            messages: [{ role: "user", content: String(task) }]
        });

        return response.content ?? "";

    }

    /** Anak buah menjalankan tugas dengan bias peran DAN tool sesuai topiknya.
     *
     * Sebelumnya worker hanya chat dengan bias peran — deklarasi
     * `tools:` di agent-nya dekorasi. Sekarang tiap worker menerima
     * PROFIL TOOL nyata (lihat src/agent/agentTools.js): agent riset
     * dapat tool riset, agent sistem dapat tool sistem. Model tetap
     * satu runtime Aether, jadi loop tool-calling, rem kebuntuan,
     * dan jatuh-balik provider semua tetap berlaku.
     *
     * Forge adalah kasus khusus: tugas menulis/mengubah kode
     * didelegasikan ke opencode lewat tool `opencode_run` — agent
     * coding sungguhan dengan editor penuh, bukan patch manual.
     */
    async runWorker(agent, task) {

        const aiRuntime = require("./aiRuntimeService");

        let tools = [];

        try {
            tools = agentTools.toolsForWorker(aiRuntime.tools(), agent.id, agent.tools);
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

        const response = await aiRuntime.chat({
            messages: [{ role: "user", content: instruksi }],
            tools
        });

        return response.content ?? "";

    }

    async runConnector(agentId, task, signal) {

        const connector = integrations.get(agentId);

        if (!connector) {
            throw new Error(`${agentId} belum dikonfigurasi di configs/integrations.json`);
        }

        if (connector.lastStatus?.online === false) {
            throw new Error(`${agentId} sedang offline (${connector.baseUrl})`);
        }

        if (typeof connector.chat !== "function") {
            throw new Error(`${agentId} tidak mendukung eksekusi tugas`);
        }

        // Konektor berbicara gaya OpenAI chat-completions; ambil teks
        // jawabannya. Bentuk lain ditangani apa adanya.
        const data = await connector.chat({
            messages: [{ role: "user", content: String(task) }],
            signal
        });

        return this.extractText(data);

    }

    extractText(data) {

        if (typeof data === "string") {
            return data;
        }

        return (
            data?.choices?.[0]?.message?.content ??
            data?.message?.content ??
            data?.content ??
            data?.output ??
            data?.result ??
            JSON.stringify(data)
        );

    }

}

module.exports = new AgentHub();
