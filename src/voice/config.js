const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");

/**
 * Konfigurasi Voice Runtime — satu sumber kebenaran.
 *
 * Mengikuti pola config Damar yang ada (JsonStore + env fallback):
 *   - configs/voice.json menyimpan setelan STT/TTS (dipakai voiceService).
 *   - Pengaturan voice RUNTIME (wake word, timeout, enable) dibaca dari
 *     env DAMAR_VOICE_* dengan fallback default, dan bisa ditimpa lewat
 *     configs/voice.json bagian "runtime".
 *
 * Tidak ada nilai yang di-hardcode: semua bisa diganti lewat env/config.
 */
const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "voice.json"),
    { stt: {}, tts: {}, runtime: {} }
);

/** Baca nilai dengan prioritas: env > config runtime > default. */
function envOr(envName, cfgKey, dflt) {

    const fromEnv = process.env[envName];

    if (fromEnv !== undefined && fromEnv !== "") {
        return fromEnv;
    }

    const cfg = store.read()?.runtime ?? {};

    if (cfg[cfgKey] !== undefined && cfg[cfgKey] !== null && cfg[cfgKey] !== "") {
        return cfg[cfgKey];
    }

    return dflt;

}

function bool(envName, cfgKey, dflt) {

    const v = envOr(envName, cfgKey, dflt);

    if (typeof v === "boolean") return v;

    return /^(1|true|yes|on)$/i.test(String(v));

}

function num(envName, cfgKey, dflt) {

    const v = envOr(envName, cfgKey, dflt);

    const n = Number(v);

    return Number.isFinite(n) ? n : dflt;

}

function clampNum(envName, cfgKey, dflt, min, max) {

    const n = num(envName, cfgKey, dflt);

    return Math.min(max, Math.max(min, n));

}

/** "auto" → null (diputuskan runtime setelah probe STT+recorder). */
function boolOrAuto(v) {

    if (String(v).toLowerCase() === "auto") return "auto";

    if (typeof v === "boolean") return v;

    return /^(1|true|yes|on)$/i.test(String(v));

}

/** Konfigurasi efektif Voice Runtime. */
function voiceConfig() {

    return {
        // Tri-state: true/false/"auto". "auto" = aktif bila STT terkonfigurasi
        // DAN perekam tersedia (ffmpeg/arecord) — wake word butuh keduanya.
        enabledRaw: String(envOr("DAMAR_VOICE_ENABLED", "enabled", "auto")).toLowerCase(),
        enabled: boolOrAuto(envOr("DAMAR_VOICE_ENABLED", "enabled", "auto")),
        wakeWord: String(envOr("DAMAR_WAKE_WORD", "wakeWord", "damar")).toLowerCase(),
        wakeProvider: String(envOr("DAMAR_VOICE_WAKE_PROVIDER", "wakeProvider", "local")),
        sttProvider: String(envOr("DAMAR_VOICE_STT_PROVIDER", "sttProvider", "local")),
        ttsProvider: String(envOr("DAMAR_VOICE_TTS_PROVIDER", "ttsProvider", "local")),
        // Batas giliran total (ms). Nol/negatif = tanpa batas.
        maxSessionMs: num("DAMAR_VOICE_MAX_SESSION_MS", "maxSessionMs", 60000),
        // Diam berapa ms dianggap selesai bicara (VAD).
        vadTimeoutMs: num("DAMAR_VOICE_VAD_TIMEOUT_MS", "vadTimeoutMs", 1200),
        // Batas maksimum rekaman (ms) — jaring pengaman VAD.
        maxListenMs: num("DAMAR_VOICE_MAX_LISTEN_MS", "maxListenMs", 10000),
        // Acknowledgement deterministik setelah wake word.
        acknowledgement: String(
            envOr("DAMAR_VOICE_ACK", "acknowledgement", "Ya?")
        ),
        // Bahasa STT (ISO, mis. "id").
        language: String(envOr("DAMAR_VOICE_LANGUAGE", "language", "id")),
        // ---- Mesin lokal (whisper.cpp + Piper) & latensi ---------------
        // Port server voice lokal (127.0.0.1) yang menyajikan STT/TTS
        // kompatibel-OpenAI untuk voiceService.
        localPort: num("DAMAR_VOICE_LOCAL_PORT", "localPort", 8127),
        // Model whisper kecil untuk wake-word spotting (resident/hangat).
        wakeModel: String(envOr("DAMAR_VOICE_WAKE_MODEL", "wakeModel", "ggml-base")),
        // Prompt bias opsional untuk spotting (kosong = tanpa bias).
        wakePrompt: String(envOr("DAMAR_VOICE_WAKE_PROMPT", "wakePrompt", "Damar")),
        // Endpointing STT streaming: hening (ms) yang menutup ucapan.
        endpointMs: num("DAMAR_VOICE_ENDPOINT_MS", "endpointMs", 400),
        // ---- Trigger "tepuk tangan 2x" (double clap) ----------------
        // Trigger alternatif wake word; nonaktif secara default.
        clapEnabled: bool("DAMAR_VOICE_CLAP_ENABLED", "clapEnabled", false),
        clapThreshold: num("DAMAR_VOICE_CLAP_THRESHOLD", "clapThreshold", 0.6),
        clapWindowMs: num("DAMAR_VOICE_CLAP_WINDOW_MS", "clapWindowMs", 800),
        clapMinClapMs: num("DAMAR_VOICE_CLAP_MIN_CLAP_MS", "clapMinClapMs", 30),
        clapMinGapMs: num("DAMAR_VOICE_CLAP_MIN_GAP_MS", "clapMinGapMs", 100),
        // ---- Voice FX: pitch + gaya Jarvis (post-processing) --------
        // Supertonic tidak punya parameter pitch native, jadi pitch
        // digeser sebagai post-processing di service Python
        // (voice_fx.py) sesudah sintesis. Diatur owner dari Control
        // Dashboard (Core settings "voice": pitchSemitones + style —
        // kunci spec voice.pitch_semitones / voice.style); di sini
        // dibaca dari configs/voice.json runtime / env DAMAR_VOICE_*.
        // pitchSemitones: -12..+12 (kelipatan 0.5 di Dashboard).
        pitchSemitones: clampNum("DAMAR_VOICE_PITCH_SEMITONES", "pitchSemitones", 0, -12, 12),
        // style: "normal" | "jarvis" (preset robot di atas output M1;
        // bahasa-agnostik karena bekerja di waveform).
        style: String(envOr("DAMAR_VOICE_STYLE", "style", "normal")).toLowerCase() === "jarvis" ? "jarvis" : "normal",
        // Parameter preset Jarvis (bisa di-tuning tanpa ubah kode):
        jarvisPitchSemitones: clampNum("DAMAR_VOICE_JARVIS_PITCH_SEMITONES", "jarvisPitchSemitones", -2, -6, 0),
        jarvisRingModHz: clampNum("DAMAR_VOICE_JARVIS_RING_HZ", "jarvisRingModHz", 32, 5, 120),
        jarvisRingModDepth: clampNum("DAMAR_VOICE_JARVIS_RING_DEPTH", "jarvisRingModDepth", 0.4, 0, 0.9),
        jarvisReverbWet: clampNum("DAMAR_VOICE_JARVIS_REVERB_WET", "jarvisReverbWet", 0.15, 0, 0.5),
        jarvisReverbDecayMs: clampNum("DAMAR_VOICE_JARVIS_REVERB_DECAY_MS", "jarvisReverbDecayMs", 110, 40, 400),
        jarvisEqLowDb: clampNum("DAMAR_VOICE_JARVIS_EQ_LOW_DB", "jarvisEqLowDb", 2, -6, 6),
        jarvisEqPresenceDb: clampNum("DAMAR_VOICE_JARVIS_EQ_PRESENCE_DB", "jarvisEqPresenceDb", 3, -6, 6),
        jarvisEqHighDb: clampNum("DAMAR_VOICE_JARVIS_EQ_HIGH_DB", "jarvisEqHighDb", 2, -6, 6)
    };

}

const { resolveStageConfig } = require("./providers/apiProvider");

/**
 * Config efektif satu tahap pipeline (stt|tts) untuk pemilihan
 * provider: { provider: "local"|"remote", endpoint, model, voice,
 * keyEnv, fallback, timeoutMs }. Section dibaca dari configs/
 * voice.json yang sama (sumber terpusat); kunci API hanya pernah
 * berupa RUJUKAN nama env var (keyEnv) — lihat apiProvider.js.
 * Jalur API disediakan, belum diuji (VOICE-ID.md §13.6).
 */
function voiceStageConfig(stage) {

    const all = store.read() ?? {};

    return resolveStageConfig(stage, all[stage] ?? {});

}

module.exports = { voiceConfig, voiceStageConfig, store, boolOrAuto };
