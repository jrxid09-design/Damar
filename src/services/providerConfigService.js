const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");

/**
 * Konfigurasi provider AI — bebas platform, berbasis API key.
 *
 * Prinsip yang diminta pengguna:
 *   - API key bisa dari platform mana pun (OpenRouter, OpenAI,
 *     Google AI Studio, Groq, 9router, atau custom apa saja).
 *   - Key TERISI  → Aether jalan lewat platform itu.
 *   - Key KOSONG  → Aether otomatis pakai otak lokal (llama.cpp).
 *
 * Hampir semua platform berbicara protokol OpenAI-compatible
 * (/chat/completions), jadi cukup satu jenis klien yang dibedakan
 * oleh baseUrl + key. Google AI Studio pun punya endpoint
 * OpenAI-compatible, jadi ikut tercakup.
 *
 * Key disimpan lokal di configs/providers.json (gitignored) dan
 * SELALU dimasking saat dikembalikan ke UI.
 */

const PRESETS = {
    openrouter: {
        label: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        kind: "openai",
        modelHint: "mis. deepseek/deepseek-chat atau openai/gpt-4o-mini"
    },
    openai: {
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        kind: "openai",
        modelHint: "mis. gpt-4o-mini"
    },
    google: {
        label: "Google AI Studio (Gemini)",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        kind: "openai",
        modelHint: "mis. gemini-2.0-flash"
    },
    groq: {
        label: "Groq (gratis, cepat)",
        baseUrl: "https://api.groq.com/openai/v1",
        kind: "openai",
        free: true,
        modelHint: "mis. llama-3.3-70b-versatile"
    },
    cerebras: {
        label: "Cerebras (gratis, cepat)",
        baseUrl: "https://api.cerebras.ai/v1",
        kind: "openai",
        free: true,
        modelHint: "mis. llama-3.3-70b"
    },
    mistral: {
        label: "Mistral (ada tier gratis)",
        baseUrl: "https://api.mistral.ai/v1",
        kind: "openai",
        free: true,
        modelHint: "mis. mistral-small-latest"
    },
    together: {
        label: "Together AI (ada model gratis)",
        baseUrl: "https://api.together.xyz/v1",
        kind: "openai",
        free: true,
        modelHint: "mis. meta-llama/Llama-3.3-70B-Instruct-Turbo-Free"
    },
    deepseek: {
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        kind: "openai",
        modelHint: "mis. deepseek-chat"
    },
    anthropic: {
        label: "Anthropic (Claude)",
        baseUrl: "https://api.anthropic.com/v1",
        kind: "openai",
        modelHint: "mis. claude-sonnet-4 (berbayar; endpoint OpenAI-compat)"
    },
    custom: {
        label: "Custom (OpenAI-compatible)",
        baseUrl: "",
        kind: "openai",
        modelHint: "isi baseUrl & model sesuai platformmu (mis. 9router)"
    },
    // Jembatan Gemini web→API (ntthanh2603/gemini-web-to-api) — bisa
    // GAMBAR. OpenAI-compatible, tanpa API key (autentikasi lewat cookie
    // browser di kontainer). `keyless` supaya tak jatuh ke fallback saat
    // dipilih tanpa mengisi key.
    geminiwebapi: {
        label: "GeminiWebApi (web→API, dukung gambar)",
        baseUrl: "http://localhost:4981/openai/v1",
        kind: "openai",
        keyless: true,
        modelHint: "mis. gemini-2.5-pro / gemini-advanced (autentikasi via cookie di kontainer)"
    },
    // Otak lokal langsung: bobot GGUF dimuat di proses daemon
    // (node-llama-cpp), tanpa server terpisah.
    llamacpp: {
        label: "Model lokal langsung (llama.cpp)",
        baseUrl: "",
        kind: "llamacpp",
        modelHint: "nama berkas GGUF di models/ (mis. Qwen2.5-7B-Instruct-Q4_K_M.gguf)"
    }
};

/** Model bawaan bila belum diset — GGUF Qwen yang direkomendasikan. */
const DEFAULT_LOCAL_MODEL = "Qwen2.5-7B-Instruct-Q4_K_M.gguf";

const CONFIG_PATH = path.join(
    __dirname, "..", "..", "configs", "providers.json"
);

class ProviderConfigService {

    constructor() {

        this.store = new JsonStore(CONFIG_PATH, {
            active: null,
            providers: {},
            llamacpp: { model: null },
            updatedAt: null
        });

        this.seededFromEnv = false;

    }

    get presets() {
        return PRESETS;
    }

    read() {

        const config = this.store.read();

        // Sekali saja: pindahkan setelan lama dari .env supaya
        // instalasi yang sudah ada tidak perlu setup ulang.
        if (!this.seededFromEnv && !config.active) {
            this.seedFromEnv(config);
            this.seededFromEnv = true;
        }

        return config;

    }

    seedFromEnv(config) {

        const seeded = { ...config, providers: { ...config.providers } };

        if (process.env.OPENROUTER_API_KEY) {
            seeded.providers.openrouter = {
                apiKey: process.env.OPENROUTER_API_KEY,
                baseUrl: null,
                model: process.env.OPENROUTER_MODEL ?? null
            };
        }

        seeded.llamacpp = {
            model: process.env.AETHER_MODEL_PATH ?? null
        };

        // Provider aktif: ikuti AI_PROVIDER bila diset, kalau tidak
        // pilih otomatis (openrouter bila ada key, else otak lokal).
        const envProvider = (process.env.AI_PROVIDER ?? "").toLowerCase();

        seeded.active =
            PRESETS[envProvider] ? envProvider
            : (process.env.OPENROUTER_API_KEY ? "openrouter" : "llamacpp");

        this.store.write(seeded);

    }

    /**
     * Resolusi provider yang BENAR-BENAR dipakai sekarang.
     * Inilah aturan "key kosong → otak lokal (llama.cpp)".
     */
    resolveActive() {

        const config = this.read();

        const activeId = config.active ?? "llamacpp";
        const preset = PRESETS[activeId] ?? PRESETS.llamacpp;

        // Otak lokal langsung (llama.cpp): model = nama berkas GGUF.
        if (preset.kind === "llamacpp") {
            const model =
                process.env.AETHER_MODEL_PATH ||
                config.llamacpp?.model ||
                DEFAULT_LOCAL_MODEL;
            return {
                id: "llamacpp",
                kind: "llamacpp",
                label: preset.label,
                model
            };
        }

        const p = config.providers?.[activeId] ?? {};

        // Provider keyless (mis. jembatan Gemini web→API): tak butuh API
        // key — autentikasi terjadi di kontainer lewat cookie. Jangan
        // jatuh ke fallback hanya karena key kosong.
        if (preset.keyless) {
            return {
                id: activeId,
                kind: "openai",
                label: preset.label,
                apiKey: p.apiKey || "not-needed",
                baseUrl: p.baseUrl || preset.baseUrl,
                model: p.model || null
            };
        }

        // Key kosong → jatuh ke otak lokal (sesuai permintaan).
        if (!p.apiKey) {
            const model =
                process.env.AETHER_MODEL_PATH ||
                config.llamacpp?.model ||
                DEFAULT_LOCAL_MODEL;
            return {
                id: "llamacpp",
                kind: "llamacpp",
                label: PRESETS.llamacpp.label,
                model,
                fellBackFrom: activeId
            };
        }

        return {
            id: activeId,
            kind: "openai",
            label: preset.label,
            apiKey: p.apiKey,
            baseUrl: p.baseUrl || preset.baseUrl,
            model: p.model || null
        };

    }

    /** Simpan setelan satu provider. */
    setProvider(id, { apiKey, baseUrl, model } = {}) {

        // Otak lokal: yang disimpan hanya nama berkas GGUF, tanpa key/URL.
        if (id === "llamacpp") {
            const config = this.read();
            this.store.write({
                llamacpp: { model: model !== undefined ? (model || null) : (config.llamacpp?.model ?? null) }
            });
            return this.read();
        }

        if (!PRESETS[id]) {
            throw new Error(`Platform tidak dikenal: ${id}`);
        }

        const config = this.read();

        const existing = config.providers?.[id] ?? {};

        const next = {
            // apiKey undefined = jangan ubah; "" = hapus key.
            apiKey: apiKey === undefined ? existing.apiKey : (apiKey || null),
            baseUrl: baseUrl !== undefined ? (baseUrl || null) : existing.baseUrl ?? null,
            model: model !== undefined ? (model || null) : existing.model ?? null
        };

        this.store.write({
            providers: { ...config.providers, [id]: next }
        });

        return this.read();

    }

    setActive(id) {

        if (!PRESETS[id]) {
            throw new Error(`Platform tidak dikenal: ${id}`);
        }

        this.store.write({ active: id });

        return this.read();

    }

    /** Konfigurasi untuk UI: key DIMASKING, lengkap dengan preset. */
    describe() {

        const config = this.read();

        const providers = {};

        for (const [id, preset] of Object.entries(PRESETS)) {

            const p = config.providers?.[id] ?? {};

            providers[id] = {
                label: preset.label,
                baseUrl: p.baseUrl || preset.baseUrl,
                defaultBaseUrl: preset.baseUrl,
                model: p.model || null,
                modelHint: preset.modelHint,
                hasKey: Boolean(p.apiKey),
                keyHint: this.mask(p.apiKey)
            };

        }

        const resolved = this.resolveActive();

        return {
            active: config.active ?? "llamacpp",
            resolved: {
                id: resolved.id,
                kind: resolved.kind,
                label: resolved.label,
                model: resolved.model,
                fellBackFrom: resolved.fellBackFrom ?? null
            },
            providers
        };

    }

    mask(key) {

        if (!key) {
            return null;
        }

        const s = String(key);

        if (s.length <= 8) {
            return "••••";
        }

        return `${s.slice(0, 4)}…${s.slice(-4)}`;

    }

}

module.exports = new ProviderConfigService();
module.exports.PRESETS = PRESETS;
