"use strict";

/**
 * apiProvider — jalur provider API kompatibel-OpenAI untuk STT & TTS.
 *
 * STATUS: DISEDIAKAN, BELUM DIUJI — perintah owner 2026-11-25 17:08
 * ("yang provider sediain aja, gausah diuji dulu"). Kode ini ditulis
 * mengikuti kontrak yang sama persis dengan server lokal Damar
 * (POST /v1/audio/speech, POST /v1/audio/transcriptions, header
 * Authorization: Bearer) tetapi TIDAK diverifikasi terhadap mock
 * maupun provider sungguhan pada pass ini; verifikasi ditunda sampai
 * owner berlangganan / menyediakan kunci (lihat VOICE-ID.md §13.6).
 *
 * Bentuk config (configs/voice.json, per tahap — stt dan tts bebas
 * dicampur local/remote):
 *   "tts": {
 *     "provider": "local" | "remote",   // kosong = ditebak dari URL
 *     "url": "https://api.contoh.com/v1/audio/speech",  // endpoint
 *             penuh ATAU basis ("https://api.contoh.com" / ".../v1")
 *     "model": "tts-1",
 *     "voice": "alloy",
 *     "keyEnv": "DAMAR_TTS_KEY",        // RUJUKAN rahasia: NAMA env
 *             var yang memegang kunci. Nilai kunci TIDAK pernah
 *             ditulis di config yang ter-commit; field "key" lama
 *             tetap didukung untuk berkas deployment gitignored.
 *     "fallback": true,                 // remote gagal -> lokal otomatis
 *     "timeoutMs": 20000
 *   }
 *
 * Prinsip:
 *  - BUKAN pipeline paralel: fungsi synthesize/transcribe yang
 *    dihasilkan di sini berbentuk sama dengan mesin lokal
 *    (engines.synthesize / engines.transcribeWav), jadi seluruh
 *    machinery 1:1 streaming, antrean, backpressure, dan barge-in di
 *    streaming.js bekerja identik di atas jalur API — per micro-chunk
 *    satu request (itulah granularitas streaming yang portabel;
 *    provider yang menawarkan transfer chunked tetap kompatibel
 *    karena kontrak per chunk tidak berubah).
 *  - Fallback otomatis: FallbackEngine menandai remote "down" selama
 *    cooldown setelah kegagalan pertama, mencatat peristiwa lewat
 *    onFallback, dan melayani dari mesin lokal — giliran percakapan
 *    tidak gugur (mandat anti-crash). fallback:false mematikan ini.
 *  - Wake word + speaker recognition TIDAK punya jalur remote di
 *    modul ini dan tidak akan pernah: mic always-on tidak boleh
 *    streaming ke cloud dan voiceprint tidak meninggalkan mesin.
 */

const path = require("node:path");
const JsonStore = require("../../core/config/JsonStore");
const engines = require("../local/engines");

const store = new JsonStore(
    path.join(__dirname, "..", "..", "..", "configs", "voice.json"),
    { stt: {}, tts: {} }
);

function isLoopbackUrl(value) {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") &&
            (url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
                url.hostname === "::1" || url.hostname === "[::1]");
    } catch {
        return false;
    }
}

/** URL tahap: terima endpoint penuh atau basis, kembalikan endpoint. */
function stageEndpoint(section, stage) {
    const raw = String(section?.url || section?.baseUrl || "").trim();
    if (!raw) return null;
    const suffix = stage === "tts" ? "/audio/speech" : "/audio/transcriptions";
    if (/\/audio\/(speech|transcriptions)\/?$/.test(raw)) return raw.replace(/\/$/, "");
    const base = raw.replace(/\/$/, "");
    if (base.endsWith("/v1")) return `${base}${suffix}`;
    return `${base}/v1${suffix}`;
}

/**
 * Resolusi config efektif satu tahap dari section configs/voice.json.
 * Kunci API dibaca dari env var yang NAMANYA tertulis di keyEnv —
 * tidak pernah dari nilai yang ter-commit.
 */
function resolveStageConfig(stage, section = {}, env = process.env) {
    const endpoint = stageEndpoint(section, stage);
    let provider = String(section?.provider || "").trim().toLowerCase();
    if (provider !== "local" && provider !== "remote") {
        provider = endpoint && !isLoopbackUrl(endpoint) ? "remote" : "local";
    }
    const keyEnv = section?.keyEnv ? String(section.keyEnv) : null;
    let apiKey = null;
    if (keyEnv && env[keyEnv]) apiKey = env[keyEnv];
    else if (section?.key) apiKey = String(section.key);
    else {
        const legacyEnv = stage === "tts" ? "DAMAR_TTS_KEY" : "DAMAR_STT_KEY";
        if (env[legacyEnv]) apiKey = env[legacyEnv];
    }
    const timeoutMs = Number(section?.timeoutMs) > 0
        ? Number(section.timeoutMs)
        : (stage === "tts" ? 20000 : 60000);
    return {
        stage, provider, endpoint,
        model: section?.model || null,
        voice: section?.voice || null,
        apiKey, keyEnv,
        fallback: section?.fallback !== false,
        timeoutMs
    };
}

/** Baca section tahap dari configs/voice.json (sumber terpusat). */
function readStageSection(stage) {
    const all = store.read() ?? {};
    return all[stage] ?? {};
}

// ---------------------------------------------------------- remote TTS

/**
 * Synthesizer remote kompatibel-OpenAI. Bentuk hasil sama dengan
 * engines.synthesize: { audio: Buffer, ms, voice, engine: "remote" }.
 */
function createRemoteSynthesizer(stageCfg, { fetchImpl = fetch } = {}) {
    return async function remoteSynthesize(text) {
        if (!stageCfg.endpoint) throw new Error("endpoint TTS remote tidak dikonfigurasi");
        const headers = { "Content-Type": "application/json" };
        if (stageCfg.apiKey) headers.Authorization = `Bearer ${stageCfg.apiKey}`;
        const t0 = Date.now();
        const res = await fetchImpl(stageCfg.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: stageCfg.model || "tts-1",
                input: String(text),
                voice: stageCfg.voice || "alloy",
                response_format: "wav"
            }),
            signal: AbortSignal.timeout(stageCfg.timeoutMs)
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`TTS remote menolak (${res.status}): ${detail.slice(0, 200)}`);
        }
        const audio = Buffer.from(await res.arrayBuffer());
        return { audio, ms: Date.now() - t0, engine: "remote", voice: stageCfg.voice };
    };
}

// ---------------------------------------------------------- remote STT

/**
 * Transcriber remote kompatibel-OpenAI (multipart, pola yang sama
 * dengan voiceService.transcribe). Hasil: { text, ms, engine }.
 */
function createRemoteTranscriber(stageCfg, { fetchImpl = fetch } = {}) {
    return async function remoteTranscribe(wavBuffer, { language = "id" } = {}) {
        if (!stageCfg.endpoint) throw new Error("endpoint STT remote tidak dikonfigurasi");
        const form = new FormData();
        form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
        form.append("model", stageCfg.model || "whisper-1");
        if (language) form.append("language", language);
        form.append("response_format", "json");
        const headers = {};
        if (stageCfg.apiKey) headers.Authorization = `Bearer ${stageCfg.apiKey}`;
        const t0 = Date.now();
        const res = await fetchImpl(stageCfg.endpoint, {
            method: "POST", headers, body: form,
            signal: AbortSignal.timeout(stageCfg.timeoutMs)
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`STT remote menolak (${res.status}): ${detail.slice(0, 200)}`);
        }
        const data = await res.json().catch(() => null);
        return { text: String(data?.text ?? "").trim(), ms: Date.now() - t0, engine: "remote" };
    };
}

// ---------------------------------------------------------- fallback

/**
 * FallbackEngine — bungkus primer (remote) + cadangan (lokal).
 * Kegagalan primer: catat (onFallback + stats), tandai remote down
 * selama cooldownMs (panggilan berikutnya langsung ke lokal agar
 * tidak membayar timeout berulang di tengah percakapan), dan layani
 * panggilan ini dari lokal. Primer pulih dicoba lagi setelah
 * cooldown lewat. enabled=false -> primer apa adanya (error naik).
 */
class FallbackEngine {

    constructor({ kind = "tts", primary, fallback, enabled = true, cooldownMs = 60000, onFallback = null } = {}) {
        if (!primary || !fallback) throw new Error("FallbackEngine butuh primary + fallback");
        this.kind = kind;
        this.primary = primary;
        this.fallback = fallback;
        this.enabled = enabled;
        this.cooldownMs = cooldownMs;
        this.onFallback = onFallback;
        this._downUntil = 0;
        this.stats = { failures: 0, fallbackCalls: 0, primaryCalls: 0 };
        this.lastError = null;
    }

    async call(...args) {
        if (!this.enabled) return this.primary(...args);
        if (Date.now() < this._downUntil) {
            this.stats.fallbackCalls++;
            const out = await this.fallback(...args);
            return { ...out, viaFallback: true };
        }
        try {
            this.stats.primaryCalls++;
            const out = await this.primary(...args);
            return { ...out, viaFallback: false };
        } catch (error) {
            this.stats.failures++;
            this.lastError = error.message;
            this._downUntil = Date.now() + this.cooldownMs;
            if (this.onFallback) {
                try { this.onFallback({ kind: this.kind, error, at: new Date().toISOString() }); } catch { /* abaikan */ }
            }
            this.stats.fallbackCalls++;
            const out = await this.fallback(...args);
            return { ...out, viaFallback: true };
        }
    }
}

function defaultFallbackLogger({ kind, error }) {
    try {
        const telemetry = require("../../services/telemetryService");
        telemetry.warn(`[voice] provider ${kind} remote gagal, jatuh ke lokal: ${error.message}`);
    } catch {
        console.warn(`[voice] provider ${kind} remote gagal, jatuh ke lokal: ${error.message}`);
    }
}

// ---------------------------------------------------------- factory

/**
 * Synthesizer ucapan sesuai config terpusat tahap TTS:
 *  - provider local  -> engines.synthesize (Supertonic/Piper lokal)
 *  - provider remote -> remote; fallback aktif -> dibungkus
 *    FallbackEngine dengan lokal sebagai cadangan.
 * Mengembalikan { synthesize, stage, fallbackEngine }.
 */
function createSpeechSynthesizer({ section = null, env = process.env, onFallback = defaultFallbackLogger } = {}) {
    const cfg = resolveStageConfig("tts", section ?? readStageSection("tts"), env);
    const local = async text => engines.synthesize(text, { voice: cfg.voice || undefined });
    if (cfg.provider !== "remote") {
        return { synthesize: local, stage: cfg, fallbackEngine: null };
    }
    const remote = createRemoteSynthesizer(cfg);
    if (!cfg.fallback) {
        return { synthesize: remote, stage: cfg, fallbackEngine: null };
    }
    const engine = new FallbackEngine({ kind: "tts", primary: remote, fallback: local, onFallback });
    return { synthesize: (...args) => engine.call(...args), stage: cfg, fallbackEngine: engine };
}

/**
 * Transcriber sesuai config terpusat tahap STT (pola yang sama).
 * Mengembalikan { transcriber, stage, fallbackEngine }.
 * CATATAN: ini untuk transkripsi PERCAKAPAN. Wake word dan speaker
 * recognition TIDAK melewati jalur ini — keduanya selalu lokal.
 */
function createTranscriber({ section = null, env = process.env, onFallback = defaultFallbackLogger } = {}) {
    const cfg = resolveStageConfig("stt", section ?? readStageSection("stt"), env);
    const local = async (wavBuffer, opts = {}) =>
        engines.transcribeWav(wavBuffer, { model: cfg.model || "ggml-small", language: opts.language || "id" });
    if (cfg.provider !== "remote") {
        return { transcriber: local, stage: cfg, fallbackEngine: null };
    }
    const remote = createRemoteTranscriber(cfg);
    if (!cfg.fallback) {
        return { transcriber: remote, stage: cfg, fallbackEngine: null };
    }
    const engine = new FallbackEngine({ kind: "stt", primary: remote, fallback: local, onFallback });
    return { transcriber: (...args) => engine.call(...args), stage: cfg, fallbackEngine: engine };
}

module.exports = {
    resolveStageConfig, stageEndpoint, isLoopbackUrl, readStageSection,
    createRemoteSynthesizer, createRemoteTranscriber,
    FallbackEngine, createSpeechSynthesizer, createTranscriber
};
