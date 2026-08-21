/**
 * VoiceRuntime — orchestrator always-on voice assistant.
 *
 * Loop standby → wake → listen → transcribe → think → speak → idle.
 * Ia TIDAK menggantikan AI Runtime; ia hanya memanggilnya lewat VoiceSession
 * (jalur yang sama dengan Telegram/WhatsApp/Console).
 *
 * Prinsip:
 *   - Standby TIDAK mengirim audio ke LLM/cloud (hanya wake-word detection).
 *   - Acknowledgement setelah wake word = deterministik/local (tanpa LLM).
 *   - Semua kegagalan (mic rusak, STT mati, TTS mati, wake engine mati)
 *     TIDAK BOLEH menjatuhkan daemon — graceful degradation.
 *
 * Default AETHER_VOICE_ENABLED=false: voice runtime pasif, daemon normal.
 */
const { EventEmitter } = require("node:events");

const telemetry = require("../services/telemetryService");
const { voiceConfig } = require("./config");
const { StateMachine, STATES } = require("./stateMachine");
const { VoiceSession } = require("./voiceSession");
const { createWakeWordProvider } = require("./providers/wakeWord");
const { AudioInput } = require("./providers/audioInput");
const { AudioOutput } = require("./providers/audioOutput");
const { VadDetector } = require("./providers/vad");

class VoiceRuntime extends EventEmitter {

    constructor({ config = voiceConfig, session = null } = {}) {

        super();
        this.setMaxListeners(20);

        this.cfg = typeof config === "function" ? config() : config;

        this.enabled = false;
        this.running = false;

        this.session = session ?? new VoiceSession();

        this.machine = new StateMachine((from, to) => {
            this.emit("state", { from, to });
            telemetry.publish("voice:state", { from, to });
        });

        this.wake = createWakeWordProvider({
            provider: this.cfg.wakeProvider,
            wakeWord: this.cfg.wakeWord
        });

        this.input = new AudioInput({ backend: this._inputBackend() });
        this.output = new AudioOutput({ backend: this._outputBackend() });
        this.vad = new VadDetector({ vadTimeoutMs: this.cfg.vadTimeoutMs });

        // Timers & cancellation.
        this._timers = new Set();
        this._cancelled = false;
        this._speaking = false;
        this.lastError = null;

    }

    _inputBackend() {
        // Backend audio dari env; default "cli" hanya bila diaktifkan
        // secara eksplisit, selain itu "none" (graceful).
        return process.env.AETHER_VOICE_AUDIO_BACKEND === "cli" ? "cli" : "none";
    }

    _outputBackend() {
        return process.env.AETHER_VOICE_AUDIO_BACKEND === "cli" ? "cli" : "none";
    }

    // ---- Lifecycle -------------------------------------------------

    async start() {

        if (!this.cfg.enabled) {
            telemetry.info("[voice] nonaktif (AETHER_VOICE_ENABLED tidak diset).");
            return this;
        }

        if (this.running) return this;

        this.running = true;
        this.enabled = true;

        // Probe perangkat (graceful: gagal pun tetap lanjut).
        await Promise.allSettled([this.input.probe(), this.output.probe()]);

        this.session.register();

        telemetry.publish("voice:started", {
            wakeWord: this.cfg.wakeWord,
            mic: this.input.available,
            speaker: this.output.available
        });

        this.emit("started");

        // Mulai loop standby.
        this._loop().catch(error => {
            this.lastError = error.message;
            telemetry.warn(`[voice] loop berhenti: ${error.message}`);
        });

        return this;

    }

    async stop() {

        this.running = false;

        for (const t of this._timers) clearTimeout(t);
        this._timers.clear();

        await this.output.stop();
        this.machine.reset();

        telemetry.publish("voice:stopped", {});

        return this;

    }

    // ---- Loop utama ------------------------------------------------

    async _loop() {

        while (this.running) {

            // IDLE: standby (deteksi wake word saja). Selain IDLE:
            // poll cepat antar-tahapan. Tidak pernah memanggil LLM/STT di sini.
            const delay = this.machine.current === STATES.IDLE ? 250 : 50;

            await this._sleep(delay);

        }

    }

    _sleep(ms) {
        return new Promise(resolve => {
            const t = setTimeout(() => {
                this._timers.delete(t);
                resolve();
            }, ms);
            this._timers.add(t);
            t.unref?.();
        });
    }

    /**
     * Titik masuk dari luar: sebuah teks (mis. hasil STT ringan dari
     * wake-word provider, atau input programatik untuk tes).
     * Digunakan untuk DETEKSI wake word saat IDLE.
     *
     * @returns {object} { wake }
     */
    wakeDetect(text) {

        const r = this.wake.detect(text);

        if (r.detected && this.machine.current === STATES.IDLE) {
            this.machine.transit(STATES.WAKE_DETECTED);
            this.emit("wake", r);
            telemetry.publish("voice:wake", { text: r.text });
            // Acknowledgement deterministik (tanpa LLM) — cepat.
            this._acknowledge();
        }

        return r;

    }

    _acknowledge() {
        // "Ya?" / "Siap." — deterministic, local, langsung.
        this.emit("ack", this.cfg.acknowledgement);
        telemetry.publish("voice:ack", { ack: this.cfg.acknowledgement });
        this.speak(this.cfg.acknowledgement).catch(() => {});
    }

    // ---- Tahapan interaksi ----------------------------------------

    /**
     * Mulai mendengar (setelah wake). Biasanya dipicu otomatis oleh
     * acknowledgement; disediakan juga sebagai API untuk tes/integrasi.
     */
    async listen() {
        this.machine.transit(STATES.LISTENING);
        this.vad.start();
        this.emit("listening");
        return this;
    }

    /**
     * Terima transkrip (dari STT) dan jalankan putaran penuh:
     * THINKING → (tools) → SPEAKING.
     *
     * @param {string} transcript teks perintah
     * @returns {Promise<{ answer: string }>}
     */
    async handleTranscript(transcript) {

        const text = String(transcript ?? "").trim();

        if (!text) return { answer: null, skipped: true };

        this.machine.transit(STATES.THINKING);

        try {

            const { answer } = await this.session.think(text);

            this.machine.transit(STATES.SPEAKING);

            this.emit("answer", answer);
            telemetry.publish("voice:answer", { chars: answer.length });

            await this.speak(answer);

            return { answer };

        }
        catch (error) {

            this.lastError = error.message;
            telemetry.warn(`[voice] putaran gagal: ${error.message}`);
            this.machine.reset();
            return { answer: null, error: error.message };

        }
        finally {
            // Kembali standby setelah selesai / gagal.
            this.machine.reset();
        }

    }

    /**
     * Ucapkan teks lewat TTS (voiceService) lalu putar lewat AudioOutput.
     * Graceful: kegagalan TTS/speaker TIDAK melempar ke pemanggil loop.
     */
    async speak(text) {

        this._speaking = true;
        this._cancelled = false;

        try {

            const voice = require("../services/voiceService");

            // TTS streaming/chunked: voiceService.speak menghasilkan audio
            // utuh; di masa depan bisa di-chunk. Untuk sekarang, kita
            // putar hasilnya — dan barge-in bisa membatalkan pemutaran.
            const { audio } = await voice.speak(text, {
                voice: voice.ttsVoice
            });

            if (this._cancelled) return;

            await this.output.play(audio);

        }
        catch (error) {
            // TTS/speaker gagal ≠ daemon mati. Catat, diam, lanjut.
            this.lastError = error.message;
            telemetry.warn(`[voice] TTS/putar gagal: ${error.message}`);
        }
        finally {
            this._speaking = false;
        }

    }

    /**
     * Barge-in: hentikan TTS, kembali ke LISTENING (atau IDLE).
     */
    async interrupt() {

        this._cancelled = true;

        await this.output.stop();

        if (this.machine.current === STATES.SPEAKING) {
            this.machine.transit(STATES.LISTENING);
        }

        this.emit("interrupt");
        telemetry.publish("voice:interrupt", {});

    }

    // ---- Status ----------------------------------------------------

    status() {

        const c = this.cfg;

        return {
            enabled: this.enabled,
            running: this.running,
            state: this.machine.current,
            wakeWord: c.wakeWord,
            microphone: this.input.status(),
            speaker: this.output.status(),
            sttProvider: c.sttProvider,
            ttsProvider: c.ttsProvider,
            wakeWordProvider: this.wake.status(),
            activeSession: this.machine.current !== STATES.IDLE
                ? this.machine.potret()
                : null,
            lastError: this.lastError
        };

    }

}

module.exports = { VoiceRuntime };
