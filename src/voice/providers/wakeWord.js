/**
 * WakeWordProvider — deteksi kata panggil ("Damar").
 *
 * Abstraction: engine bisa diganti tanpa menyentuh VoiceRuntime.
 * Default "local" = keyword-match deterministik (tanpa model, tanpa
 * cloud, tanpa dependency). Standby TIDAK mengirim audio ke STT/LLM.
 *
 * Implementasi keyword-match sengaja sederhana & jujur: ia mencocokkan
 * transkrip singkat (hasil STT ringan) atau teks input terhadap wake
 * word. Untuk engine wake-word sungguhan (Porcupine/Vosk/openWakeWord),
 * tinggal implementasi antarmuka yang sama dan set
 * DAMAR_VOICE_WAKE_PROVIDER=<nama>.
 */

class WakeWordProvider {

    /** @param {string} wakeWord kata panggil (lowercase) */
    constructor({ wakeWord = "damar" } = {}) {
        this.wakeWord = String(wakeWord ?? "damar").toLowerCase();
        this.name = "local";
    }

    /**
     * Deteksi wake word pada teks (hasil STT ringan / input).
     *
     * @param {string} text
     * @returns {object} { detected, wakeWord, text }
     */
    detect(text) {

        const t = String(text ?? "").toLowerCase().trim();

        if (!t) return { detected: false, wakeWord: this.wakeWord, text: t };

        // Cocokkan kata panggil sebagai kata utuh (bukan substring "ethereum").
        const re = new RegExp(`(^|[^a-z0-9])${this.escape(this.wakeWord)}($|[^a-z0-9])`, "i");

        return { detected: re.test(t), wakeWord: this.wakeWord, text: t };

    }

    escape(word) {
        return String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    status() {
        return { provider: this.name, wakeWord: this.wakeWord };
    }

}

/** Factory: pilih provider dari konfigurasi. */
function createWakeWordProvider({ provider = "local", wakeWord = "damar" } = {}) {

    if (provider === "whisper") {
        // Engine wake-word sungguhan: VAD + whisper.cpp lokal (lazy require
        // agar jalur "local" tetap ringan). Model/prompt dari konfigurasi
        // terpusat (configs/voice.json "runtime" / env DAMAR_VOICE_*).
        const { WhisperWakeWordProvider } = require("./wakeWordWhisper");
        let cfg = {};
        try { cfg = require("../config").voiceConfig(); } catch { /* pakai default */ }
        return new WhisperWakeWordProvider({
            wakeWord,
            model: cfg.wakeModel || "ggml-tiny",
            prompt: cfg.wakePrompt ? cfg.wakePrompt : null
        });
    }

    // Engine lain belum tersedia -> jatuh ke local + catat (jujur).
    if (provider !== "local") {
        const p = new WakeWordProvider({ wakeWord });
        p.name = provider;
        p.fallback = true;
        return p;
    }

    return new WakeWordProvider({ wakeWord });

}
module.exports = { WakeWordProvider, createWakeWordProvider };
