/**
 * InstrumentCatalog — abstraksi INSTRUMEN untuk user (§13).
 *
 * User melihat konsep instrumen (Terminal, Git, Web, …); agent
 * menerima tool konkret yang di-resolve terhadap registry AI NYATA
 * lewat agentTools (resolver `tail()` — cocok filesystem.readFile /
 * filesystem__readFile / readFile). Kapabilitas tak dikenal gagal
 * anggun (§10): dicatat tapi tidak membuat instrumen palsu.
 */

const { PROFILES } = require("../agent/agentTools");
const { WORKER_PROFILES } = require("../agent/agentTools");

/** Definisi instrumen: kapabilitas abstrak → deskripsi + tool inti. */
const INSTRUMENTS = [
    {
        id: "terminal", label: "Terminal", icon: "terminal",
        description: "Shell persisten: jalankan perintah, baca output.",
        capabilities: ["terminal"],
        tools: ["terminal_list", "terminal_run", "terminal_read", "terminal_restart"]
    },
    {
        id: "filesystem", label: "Filesystem", icon: "folder",
        description: "Baca/tulis berkas & folder di dalam batas path policy.",
        capabilities: ["filesystem"],
        tools: ["readFile", "writeFile", "listDirectory"]
    },
    {
        id: "git", label: "Git", icon: "link",
        description: "Branch, commit, rollback repositori.",
        capabilities: ["git"],
        tools: ["code_branch", "code_commit", "code_rollback"]
    },
    {
        id: "web", label: "Web", icon: "cloud",
        description: "HTTP & browsing untuk riset.",
        capabilities: ["web"],
        tools: ["browse", "get", "post", "download"]
    },
    {
        id: "memory", label: "Memory", icon: "memory",
        description: "Ingatan jangka panjang: simpan, ingat kembali, relasi.",
        capabilities: ["memory"],
        tools: ["memory_remember", "memory_recall", "memory_related"]
    },
    {
        id: "knowledge", label: "Knowledge", icon: "brain",
        description: "Dokumen & pengetahuan yang sudah dipelajari Damar.",
        capabilities: ["document_reader", "data_analysis"],
        tools: ["memory_documents", "open_document"]
    },
    {
        id: "vision", label: "Vision & Camera", icon: "camera",
        description: "Lihat kamera/CCTV, analisis gambar & wajah.",
        capabilities: ["vision", "cctv"],
        tools: ["see_camera", "list_cameras", "describe_image", "identify_face"]
    },
    {
        id: "opencode", label: "OpenCode", icon: "tool",
        description: "Agent coding berat: implementasi, refactor, test.",
        capabilities: ["opencode"],
        tools: ["opencode_run"]
    },
    {
        id: "code", label: "Code Analysis", icon: "search",
        description: "Graf kode, definisi, referensi, diagnostik, AST.",
        capabilities: ["code_search"],
        tools: ["code_graph_query", "code_definition", "code_references", "code_diagnostics"]
    },
    {
        id: "testing", label: "Testing", icon: "check",
        description: "Menjalankan test proyek.",
        capabilities: ["test_runner"],
        tools: ["code_test", "code_check_syntax"]
    },
    {
        id: "monitoring", label: "Monitoring", icon: "activity",
        description: "Kesehatan sistem, NAS, layanan.",
        capabilities: ["system_monitor", "metrics"],
        tools: ["system_health", "nas_status"]
    },
    {
        id: "osint", label: "OSINT", icon: "search",
        description: "Investigasi terbuka: email, telepon, domain, breach.",
        capabilities: ["osint"],
        tools: ["osint_investigate", "osint_email", "osint_phone", "osint_domain"]
    },
    {
        id: "media", label: "Media & Messaging", icon: "send",
        description: "Tampilkan/kirim media & notifikasi antar kanal.",
        capabilities: ["whatsapp", "notifications", "media_share"],
        tools: ["show_image", "wa_send", "send_file"]
    },
    {
        id: "home", label: "Smart Home", icon: "home",
        description: "Kendali rumah & perangkat.",
        capabilities: ["home"],
        tools: ["home_state", "home_devices", "home_control"]
    }
];

const tail = (name) => String(name ?? "").split(/__|\./).pop();

class InstrumentCatalog {

    /** Katalog instrumen + resolusi tool NYATA terhadap registry. */
    async catalog() {

        let registry = [];

        try {
            const aiRuntime = require("../services/aiRuntimeService");
            registry = aiRuntime.tools().map(t => t.name);
        }
        catch { /* registry belum siap — instrumen tetap tampil tanpa status */ }

        return INSTRUMENTS.map(inst => {

            const tools = inst.tools.map(name => {
                const found = registry.find(r => r === name || tail(r) === name);
                return { name, available: Boolean(found), registeredAs: found ?? null };
            });

            return {
                ...inst,
                tools,
                availableCount: tools.filter(t => t.available).length,
                online: registry.length > 0 && tools.some(t => t.available)
            };

        });

    }

    /** Profil tool konkret untuk sebuah instrumen — dipakai agent. */
    toolsForInstrument(instrumentId, registryTools = []) {

        const inst = INSTRUMENTS.find(i => i.id === instrumentId);

        if (!inst) {
            throw new Error(`Instrumen tidak dikenal: ${instrumentId}`);
        }

        const out = [];
        const seen = new Set();

        for (const name of inst.tools) {
            const found = registryTools.find(t => t.name === name || tail(t.name) === name);
            if (found && !seen.has(found.name)) {
                out.push(found);
                seen.add(found.name);
            }
        }

        return out;

    }

    /** Instrumen apa saja yang dimiliki seorang agent (dari profilnya). */
    instrumentsForAgent(agentId) {

        const profileTools = WORKER_PROFILES[agentId] ?? [];

        return INSTRUMENTS.filter(inst =>
            inst.tools.some(t =>
                profileTools.some(p =>
                    tail(p) === tail(t) ||
                    (PROFILES.coding ?? []).includes(p) && false
                )
            )
        ).map(i => i.id);

    }

    list() {
        return INSTRUMENTS.map(({ id, label, icon, description, capabilities }) =>
            ({ id, label, icon, description, capabilities }));
    }

}

module.exports = new InstrumentCatalog();
