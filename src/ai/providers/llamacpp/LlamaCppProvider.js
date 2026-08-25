const path = require("node:path");
const BaseAIProvider = require("../BaseAIProvider");
const LlamaCppMapper = require("./LlamaCppMapper");
const engine = require("./LlamaEngine");

/**
 * Provider otak lokal in-process (node-llama-cpp / llama.cpp).
 *
 * Jalur inferensi lokal: tanpa HTTP, model GGUF
 * dimuat langsung ke proses daemon. chat() menjalankan SATU putaran
 * model — bila model memanggil tool, panggilannya dikembalikan sebagai
 * toolCalls agar loop tool Aether (yang sudah ada) mengeksekusinya,
 * lalu memanggil chat() lagi dengan hasilnya. Provider ini tidak
 * menjalankan tool sendiri.
 */
class LlamaCppProvider extends BaseAIProvider {

    constructor({ context, modelPath, contextSize, gpuLayers, mapper = new LlamaCppMapper() } = {}) {
        super(context);
        this.mapper = mapper;
        this.modelDir = process.env.AETHER_MODEL_DIR || "models";
        this.modelPath = modelPath || process.env.AETHER_MODEL_PATH || null;
        this.contextSize = contextSize;
        this.gpuLayers = gpuLayers;
    }

    get id() { return "llamacpp"; }

    /** Path model efektif: request.model (nama/berkas) menimpa bawaan. */
    _resolveModel(requestModel) {
        const pick = requestModel || this.modelPath;
        if (!pick) throw new Error("Model lokal belum dipilih. Set AETHER_MODEL_PATH atau config providers.llamacpp.model.");
        // Nama berkas polos → cari di direktori model; path → apa adanya.
        if (!pick.includes("/") && !pick.includes("\\")) return path.join(this.modelDir, pick);
        return pick;
    }

    async _prepare(request) {
        const modelPath = this._resolveModel(request.model);
        await engine.ensureLoaded(modelPath, { contextSize: this.contextSize, gpuLayers: this.gpuLayers });
        return {
            history: this.mapper.toHistory(request.messages),
            functions: this.mapper.toFunctions(request.tools),
            modelName: path.basename(modelPath)
        };
    }

    async chat(request) {
        const { history, functions, modelName } = await this._prepare(request);
        const result = await engine.generate(history, {
            functions,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            topP: request.topP
        });
        return this.mapper.toResponse(result, { model: modelName });
    }

    /**
     * Streaming: node-llama-cpp memberi token lewat callback (push),
     * sedangkan Aether menariknya (pull). Jembatani lewat antrean kecil —
     * teks mengalir saat diproduksi, lalu satu chunk penutup membawa
     * toolCalls + done.
     */
    async *stream(request) {
        const { history, functions, modelName } = await this._prepare(request);

        const antrean = [];
        let tunggu = null;
        const dorong = (t) => { antrean.push(t); if (tunggu) { tunggu(); tunggu = null; } };

        const selesai = engine.generate(history, {
            functions,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            topP: request.topP,
            onTextChunk: (t) => { if (t) dorong(t); }
        });

        let beres = false;
        let hasil = null;
        selesai.then(r => { hasil = r; beres = true; if (tunggu) { tunggu(); tunggu = null; } },
                     () => { beres = true; if (tunggu) { tunggu(); tunggu = null; } });

        // Kuras teks selama generasi berjalan.
        while (!beres || antrean.length) {
            if (antrean.length) {
                yield this.mapper.toStreamChunk(antrean.shift(), { model: modelName });
            } else if (!beres) {
                await new Promise(res => { tunggu = res; });
            }
        }

        const r = await selesai;   // lempar ulang bila gagal
        yield this.mapper.toStreamChunk("", {
            model: modelName,
            done: true,
            finishReason: this.mapper._finishReason(r.stopReason, r.functionCalls),
            toolCalls: this.mapper._toolCalls(r.functionCalls)
        });
    }

    // ---- Kemampuan operasional ---------------------------------

    async health() {
        return engine.status();
    }

    async listModels() {
        return engine.listModels(this.modelDir);
    }
}

module.exports = LlamaCppProvider;
