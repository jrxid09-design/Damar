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
        // ---- Trigger "tepuk tangan 2x" (double clap) ----------------
        // Trigger alternatif wake word; nonaktif secara default.
        clapEnabled: bool("DAMAR_VOICE_CLAP_ENABLED", "clapEnabled", false),
        clapThreshold: num("DAMAR_VOICE_CLAP_THRESHOLD", "clapThreshold", 0.6),
        clapWindowMs: num("DAMAR_VOICE_CLAP_WINDOW_MS", "clapWindowMs", 800),
        clapMinClapMs: num("DAMAR_VOICE_CLAP_MIN_CLAP_MS", "clapMinClapMs", 30),
        clapMinGapMs: num("DAMAR_VOICE_CLAP_MIN_GAP_MS", "clapMinGapMs", 100)
    };

}

module.exports = { voiceConfig, store, boolOrAuto };
