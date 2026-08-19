const path = require("node:path");
const fs = require("node:fs");

/**
 * LlamaEngine — otak lokal Aether yang berjalan DI DALAM proses daemon.
 *
 * Tidak ada Ollama, tidak ada HTTP: node-llama-cpp menautkan llama.cpp
 * langsung ke Node, memuat bobot GGUF dari disk, dan menghasilkan token
 * di proses yang sama. Satu model dimuat sekali lalu dipakai ulang —
 * memuat ulang tiap permintaan akan menghabiskan detik dan RAM.
 *
 * node-llama-cpp adalah modul ESM; dari CommonJS ia dimuat lewat
 * import() dinamis (di-cache).
 */
class LlamaEngine {

    constructor() {
        this._mod = null;          // modul node-llama-cpp (ESM, di-cache)
        this._llama = null;        // instance getLlama()
        this._loaded = null;       // { modelPath, model, context, sequence, chat }
        this._queue = Promise.resolve();   // serialisasi: satu sequence, satu generasi
    }

    async _lib() {
        if (!this._mod) this._mod = await import("node-llama-cpp");
        if (!this._llama) this._llama = await this._mod.getLlama();
        return this._mod;
    }

    /**
     * Pastikan model termuat. Aman dipanggil berkali-kali; hanya memuat
     * ulang bila path model berubah. contextSize dibatasi agar RAM di
     * mesin CPU tidak meledak (num_ctx besar = KV-cache besar).
     */
    async ensureLoaded(modelPath, { contextSize, gpuLayers } = {}) {

        const abs = path.resolve(modelPath);

        if (this._loaded && this._loaded.modelPath === abs) return this._loaded;

        if (!fs.existsSync(abs)) {
            throw new Error(`Berkas model tidak ditemukan: ${abs}. Unduh GGUF-nya dulu (lihat scripts/pull-model.js).`);
        }

        const mod = await this._lib();

        if (this._loaded) { await this._dispose(); }

        const model = await this._llama.loadModel({
            modelPath: abs,
            ...(Number.isFinite(gpuLayers) ? { gpuLayers } : {})   // default: auto (pakai Vulkan/GPU bila ada)
        });

        const context = await model.createContext({
            contextSize: Number.isFinite(contextSize) && contextSize > 0 ? contextSize : 8192
        });

        const sequence = context.getSequence();
        const chat = new mod.LlamaChat({ contextSequence: sequence, chatWrapper: "auto" });

        this._loaded = { modelPath: abs, model, context, sequence, chat };
        return this._loaded;
    }

    /**
     * Satu putaran generasi. history = ChatHistoryItem[] node-llama-cpp,
     * functions = ChatModelFunctions. Dikembalikan { response, functionCalls,
     * stopReason }. DISERIALKAN: satu contextSequence tak bisa dua generasi
     * sekaligus.
     *
     * ponytail: global lock per-engine. Bila butuh throughput paralel,
     * naikkan ke kolam beberapa contextSequence.
     */
    async generate(history, { functions, onTextChunk, maxTokens, temperature, topP, signal } = {}) {

        const run = async () => {
            const { chat } = this._loaded;

            const opts = {};
            if (functions && Object.keys(functions).length) opts.functions = functions;
            if (typeof onTextChunk === "function") opts.onTextChunk = onTextChunk;
            if (Number.isFinite(maxTokens)) opts.maxTokens = maxTokens;
            if (signal) opts.signal = signal;

            if (Number.isFinite(temperature)) opts.temperature = temperature;
            if (Number.isFinite(topP)) opts.topP = topP;

            const res = await chat.generateResponse(history, opts);
            return {
                response: res.response ?? "",
                functionCalls: res.functionCalls ?? [],
                stopReason: res.metadata?.stopReason ?? null
            };
        };

        // Antre di belakang generasi yang sedang berjalan.
        const p = this._queue.then(run, run);
        this._queue = p.then(() => {}, () => {});
        return p;
    }

    /** Model GGUF yang tersedia di direktori model (untuk UI/Console). */
    listModels(dir) {
        const root = path.resolve(dir || process.env.AETHER_MODEL_DIR || "models");
        let files = [];
        try { files = fs.readdirSync(root).filter(f => f.toLowerCase().endsWith(".gguf")); } catch { /* dir belum ada */ }
        return files.map(f => {
            const full = path.join(root, f);
            let size = null;
            try { size = fs.statSync(full).size; } catch { /* abaikan */ }
            return { id: f, name: f, provider: "llamacpp", path: full, size };
        });
    }

    async status() {
        return {
            available: !!this._loaded,
            model: this._loaded ? path.basename(this._loaded.modelPath) : null,
            gpu: this._llama?.gpu ?? "belum dimuat"
        };
    }

    async _dispose() {
        try { await this._loaded?.chat?.dispose?.(); } catch { /* */ }
        try { await this._loaded?.context?.dispose?.(); } catch { /* */ }
        try { await this._loaded?.model?.dispose?.(); } catch { /* */ }
        this._loaded = null;
    }
}

module.exports = new LlamaEngine();
