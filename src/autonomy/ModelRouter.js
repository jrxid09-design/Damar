/**
 * MODEL ROUTER (§14) — model sesuai kelas tugas, bukan satu untuk semua.
 *
 * Klasifikasi tugas DETERMINISTIK di runtime (kata kunci + konteks
 * pemanggil), lalu memilih model dari konfigurasi provider yang ADA
 * (configs/providers.json + aiRuntimeService). Tidak ada nama model
 * yang di-hardcode wajib — hanya kelas & preferensi.
 *
 * Failover (§40) memakai rantai fallback aiRuntimeService yang sudah
 * ada (provider cloud → provider lain → otak lokal llama.cpp).
 */

/** Kelas tugas → kata kunci pemicu (bahasa user sehari-hari). */
const TASK_CLASSES = [
    {
        id: "coding",
        match: /kode|code|bug|refactor|implement|fungsi|function|api|script|deploy|build|compile|error stack|traceback|npm|git/i,
        preferTags: ["coding", "kimi", "glm", "claude", "deepseek", "qwen-coder"],
        desc: "implementasi/debug perangkat lunak"
    },
    {
        id: "vision",
        match: /gambar|image|foto|screenshot|kamera|camera|cctv|ocr|wajah|visual/i,
        preferTags: ["vision", "gemini", "llama-vision", "moondream"],
        desc: "pemahaman visual"
    },
    {
        id: "fast",
        match: /jam|waktu|siapa|apa itu singkat|ringkas|cepat|terjemah|translate/i,
        preferTags: ["flash", "mini", "nano", "8b", "3b", "fast"],
        desc: "keputusan/jawaban ringan"
    },
    {
        id: "reasoning",
        match: /rencana|plan|arsitektur|architecture|analisis|bandingkan|mengapa|strategi|riset|research/i,
        preferTags: ["ultra", "max", "pro", "70b", "reasoning", "thinking"],
        desc: "penalaran kompleks"
    }
];

class ModelRouter {

    constructor() {
        this.lastRoute = null;
    }

    /** Klasifikasi kelas tugas dari teks (deterministik). */
    classify(text) {

        const t = String(text ?? "");

        for (const cls of TASK_CLASSES) {
            if (cls.match.test(t)) return { id: cls.id, desc: cls.desc, preferTags: cls.preferTags };
        }

        return { id: "general", desc: "umum", preferTags: [] };

    }

    /**
     * Pilih model untuk sebuah tugas.
     *
     * @returns {model, provider, taskClass, why} — model null berarti
     * pakai default aktif (router tidak memaksakan).
     */
    route(task, { availableModels = null } = {}) {

        const taskClass = this.classify(task);

        // Daftar model tersedia: dari pemanggil (listModels) atau aktif.
        const models = availableModels ?? this.availableModels();

        let chosen = null;
        let why = `kelas '${taskClass.id}' → default aktif`;

        if (models.length && taskClass.preferTags.length) {

            const scored = models
                .map(m => {
                    const name = String(m.id ?? m ?? "").toLowerCase();
                    let score = 0;
                    for (const tag of taskClass.preferTags) {
                        if (name.includes(tag)) score += 10;
                    }
                    // gratis = bonus kecil untuk tugas rutin
                    if (m?.free && taskClass.id === "fast") score += 2;
                    return { model: m, score };
                })
                .sort((a, b) => b.score - a.score);

            if (scored[0]?.score > 0) {
                chosen = scored[0].model.id ?? scored[0].model;
                why = `kelas '${taskClass.id}' cocok tag → ${chosen}`;
            }

        }

        this.lastRoute = { taskClass: taskClass.id, model: chosen, why };

        return { model: chosen, provider: null, taskClass: taskClass.id, why };

    }

    /** Model yang diketahui runtime saat ini. */
    availableModels() {

        try {
            const aiRuntime = require("../services/aiRuntimeService");
            const info = aiRuntime.activeInfo?.();
            return info?.model ? [info.model] : [];
        }
        catch {
            return [];
        }

    }

    classes() {
        return TASK_CLASSES.map(({ id, desc }) => ({ id, desc }));
    }

}

module.exports = new ModelRouter();
