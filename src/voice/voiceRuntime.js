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
 * Default DAMAR_VOICE_ENABLED=false: voice runtime pasif, daemon normal.
 */
const { EventEmitter } = require("node:events");

const telemetry = require("../services/telemetryService");
const { voiceConfig } = require("./config");
const { StateMachine, STATES } = require("./stateMachine");
const { VoiceSession } = require("./voiceSession");
const { createWakeWordProvider } = require("./providers/wakeWord");
const { ClapDetector } = require("./providers/clapDetector");
const { AudioInput } = require("./providers/audioInput");
const { AudioOutput } = require("./providers/audioOutput");
const { VadDetector } = require("./providers/vad");

class VoiceRuntime extends EventEmitter {

    constructor({ config = voiceConfig, session = null, interactionIngress = null } = {}) {

        super();
        this.setMaxListeners(20);

        this.cfg = typeof config === "function" ? config() : config;

        this.enabled = false;
        this.running = false;

        this.session = session ?? new VoiceSession({ interactionIngress });
        this._interactionHost = null;
        // DSC-R5-001: PRIVATE voice-continuity activation closure, captured
        // from the trusted RuntimeHost composition at start().  It is a
        // module/instance-private field — never exposed on the returned
        // RuntimeHost, never derived from event/model/user payload, and not
        // reconstructible by shape or naming.  Ordinary RuntimeHost holders
        // never receive it.
        this._continuityActivation = null;
        this._turnController = null;
        this._turnGeneration = 0;
        this._activeCapture = null;

        this.machine = new StateMachine((from, to) => {
            this.emit("state", { from, to });
            telemetry.publish("voice:state", { from, to });
        });

        this.wake = createWakeWordProvider({
            provider: this.cfg.wakeProvider,
            wakeWord: this.cfg.wakeWord
        });

        this.clap = new ClapDetector({
            threshold: this.cfg.clapThreshold,
            windowMs: this.cfg.clapWindowMs,
            minClapMs: this.cfg.clapMinClapMs,
            minGapMs: this.cfg.clapMinGapMs
        });

        this.input = new AudioInput({ backend: this._inputBackend() });
        this.output = new AudioOutput({ backend: this._outputBackend() });
        this.vad = new VadDetector({ vadTimeoutMs: this.cfg.vadTimeoutMs });

        // Timers & cancellation.
        this._timers = new Set();
        this._cancelled = false;
        this._speaking = false;
        this._levelStream = null;      // handle stream level audio standby
        this._lastVoiceAt = 0;         // RMS terakhir di atas ambang
        this._burstSeen = false;
        this._capturing = false;
        this._lastWakeTry = 0;
        this._autoReason = null;
        this.lastError = null;

    }

    _inputBackend() {
        // Backend audio dari env; default "cli" hanya bila diaktifkan
        // secara eksplisit, selain itu "none" (graceful).
        return process.env.DAMAR_VOICE_AUDIO_BACKEND === "cli" ? "cli" : "none";
    }

    _outputBackend() {
        return process.env.DAMAR_VOICE_AUDIO_BACKEND === "cli" ? "cli" : "none";
    }

    // ---- Lifecycle -------------------------------------------------

    async start() {

        // "auto": aktif bila STT terkonfigurasi + perekam tersedia —
        // wake word mustahil tanpa keduanya; jujur daripada diam mati.
        let enabled = this.cfg.enabled;
        if (enabled === "auto") {
            const sttOk = require("../services/voiceService").sttConfigured;
            enabled = sttOk; // recorder diverifikasi setelah probe di bawah
            this._autoReason = sttOk ? null : "STT belum dikonfigurasi";
        }

        if (!enabled) {
            telemetry.info("[voice] nonaktif (DAMAR_VOICE_ENABLED=" +
                this.cfg.enabledRaw + ").");
            return this;
        }

        if (this.running) return this;

        this.running = true;
        this.enabled = true;

        // Probe perangkat (graceful: gagal pun tetap lanjut).
        await Promise.allSettled([this.input.probe(), this.output.probe()]);

        // auto tapi tak ada perekam → mati dengan alasan jelas.
        if (this.cfg.enabled === "auto" && !this.input.available) {
            this.enabled = false;
            this.running = false;
            this._autoReason = "perekam audio tidak tersedia";
            telemetry.info("[voice] auto-nonaktif: " + this._autoReason);
            return this;
        }

        if (!this.session.interactionIngress && typeof this.session.bindInteractionIngress === "function") {
            // DSC-R5-001: the trusted Voice composition creates the RuntimeHost
            // WITH a composition-private capture hook.  The canonical
            // voice-continuity ACTIVATION closure is delivered ONLY into this
            // VoiceRuntime's private field — it is NEVER read back off the
            // returned host facade (there is no such property).  Ordinary
            // RuntimeHost holders receive no activation capability.
            this._interactionHost = await require("../runtime/host/runtimeHost").createRuntimeHost({
                voiceActivation: (activate) => { this._continuityActivation = activate; }
            });
            this.session.bindInteractionIngress(this._interactionHost.channels);
            // DSC-R4-001/006 + DSC-R5-001: activate the canonical voice
            // continuity identity through the PRIVATE captured closure.  The
            // voice runtime mints no scope, no handle, and supplies NO
            // identity string — the RuntimeHost composition mints the
            // canonical runtime-owner peer internally.  Voice continuity is
            // DEVICE/RUNTIME-SCOPED (one local Damar owner per voice
            // runtime) — explicitly NOT physical-speaker identity.
            const activate = this._continuityActivation;
            const bind = typeof activate === "function"
                ? activate()
                : { ok: false, code: "TRANSPORT_PEER_SEAM_UNAVAILABLE" };
            if (!bind.ok) {
                // Fail closed: voice continuity simply stays unbound; the
                // ordinary ses_* interaction path continues.
                telemetry.info("[voice] continuity binding gagal: " + (bind.code ?? "unknown"));
            }
        }
        this.session.register();

        // Standby stream: RMS dari mic untuk (a) deteksi tepuk tangan,
        // (b) deteksi burst suara pemicu wake-word.
        this._startStandbyStream();

        telemetry.publish("voice:started", {
            wakeWord: this.cfg.wakeWord,
            clapEnabled: this.cfg.clapEnabled,
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

    /**
     * Stream level standby: satu sumber RMS untuk clap + burst-wake.
     * Hanya bekerja saat IDLE agar tidak mengganggu giliran aktif.
     */
    async _startStandbyStream() {

        if (!this.input.available) return;

        const stream = await this.input.startLevelStream((rms) => {

            var now = Date.now();
            if (rms > 0.055) this._lastVoiceAt = now;

            if (this.machine.current !== STATES.IDLE) return;

            if (this.cfg.clapEnabled) this.clapDetect(rms);

            // Detektor burst: suara di atas ambang = calon ucapan.
            if (rms > 0.055) {
                this._burstSeen = true;
            }
            // Setelah burst selesai (senyap 350ms) dan belum sedang merekam,
            // picu perekaman utterance untuk diperiksa wake word-nya.
            if (this._burstSeen && !this._capturing &&
                now - this._lastVoiceAt > 350 && now - (this._lastWakeTry || 0) > 2000) {
                this._burstSeen = false;
                this._lastWakeTry = now;
                this._wakeCycle().catch(err => {
                    this.lastError = err.message;
                });
            }

        });

        if (stream) {
            this._levelStream = stream;
            telemetry.info("[voice] standby stream aktif (wake word + tepuk).");
        }

    }

    async stop() {

        this.running = false;
        this._cancelActiveTurn();
        await this._finalizeCapture(this._activeCapture);

        for (const t of this._timers) clearTimeout(t);
        this._timers.clear();

        // Hentikan stream level audio standby.
        if (this._levelStream) {
            try { this._levelStream.stop(); } catch { /* abaikan */ }
            this._levelStream = null;
        }

        await this.output.stop();
        if (this._interactionHost) {
            const hostToStop = this._interactionHost;
            this._interactionHost = null;
            // DSC-R1-005: await the durable continuity flush (and contain
            // any failure) before releasing the voice-owned host.
            try { await hostToStop.shutdown("voice-runtime-stop"); }
            catch { /* idempoten / contained */ }
        }
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

        if (r.detected) {
            this._onWake({ source: "wakeword", text: r.text });
        }

        return r;

    }

    /**
     * Siklus WAKE: utterance hasil burst → STT → cek wake word.
     * Bila terdeteksi: ack (dibicarakan dulu, agar capture berikutnya tak
     * menelan suara Damar sendiri) → lanjut siklus LISTEN perintah.
     */
    async _wakeCycle() {

        const turn = this._beginTurn();
        this._capturing = true;

        try {

            const buf = await this._captureUtterance(4000, { signal: turn.controller.signal });

            if (!buf || buf.length < 20000) return;   // < ~0.6s audio: buang

            const { text } = await this._transcribe(buf, { signal: turn.controller.signal });
            if (!text) return;

            const r = this.wake.detect(text);

            telemetry.publish("voice:wake-check", {
                text: text.slice(0, 60),
                detected: r.detected
            });

            if (!r.detected) return;   // percakapan orang lain — biarkan

            if (!this._ownsTurn(turn)) return;

            // ---- WAKE! ----
            this.machine.transit(STATES.WAKE_DETECTED);
            this.emit("wake", { source: "wakeword", text });
            telemetry.publish("voice:wake", { source: "wakeword", text });

            // Ack dibicarakan DULU (blocking) supaya mic berikutnya tidak
            // merekam suara Damar sendiri.
            await this.speak(this.cfg.acknowledgement, { signal: turn.controller.signal, generation: turn.generation });

            // Lalu buka sesi dengar untuk perintah.
            await this._listenCycle({ signal: turn.controller.signal, generation: turn.generation });

        }
        catch (error) {
            this.lastError = error.message;
            telemetry.warn(`[voice] wake cycle gagal: ${error.message}`);
        }
        finally {
            if (this._ownsTurn(turn)) {
                this._capturing = false;
                this.machine.reset();
            }
        }

    }

    /**
     * Siklus LISTEN: rekam perintah (maks maxListenMs, VAD senyap 1.2s)
     * → STT → THINKING→SPEAKING via handleTranscript.
     */
    async _listenCycle({ signal, generation = this._turnGeneration } = {}) {

        if (generation !== this._turnGeneration) return;
        this.machine.transit(STATES.LISTENING);
        setImmediate(() => {});   // biarkan transisi terserap

        const buf = await this._captureUtterance(this.cfg.maxListenMs || 8000, { signal, generation });

        if (generation !== this._turnGeneration) return;

        if (!buf || buf.length < 20000) {
            this.speak("Sepertinya tak ada perintah.").catch(() => {});
            if (generation === this._turnGeneration) this.machine.reset();
            return;
        }

        if (generation !== this._turnGeneration) return;
        this.machine.transit(STATES.TRANSCRIBING);

        const { text } = await this._transcribe(buf, { signal });

        if (generation !== this._turnGeneration) return;

        if (!text) {
            this.speak("Aku kurang menangkapnya.").catch(() => {});
            if (generation === this._turnGeneration) this.machine.reset();
            return;
        }

        await this.handleTranscript(text);   // THINKING→SPEAKING→IDLE di dalam

    }

    /**
     * Rekam satu utterance: mulai sekarang, berhenti lebih awal bila
     * senyap ≥1.2 dtk SETELAH ada suara, atau saat maxMs habis.
     */
    async _captureUtterance(maxMs = 4000, { signal, generation = this._turnGeneration } = {}) {

        const cap = await this.input.startCapture({ durationMs: maxMs + 1500 });

        if (!cap) return null;
        const capture = { cap, generation, finalized: false };
        this._activeCapture = capture;

        this._capturing = true;

        try {

            return await new Promise(resolve => {

                const startedAt = Date.now();
                var spoke = false;

                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearInterval(iv);
                    clearTimeout(safety);
                    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
                    this._finalizeCapture(capture).then(resolve).catch(() => resolve(null));
                };
                const iv = setInterval(() => {

                    var now = Date.now();
                    if (now - this._lastVoiceAt < 300) spoke = true;

                    var silence = now - this._lastVoiceAt;
                    var elapsed = now - startedAt;

                    if ((spoke && silence > 1200) || elapsed > maxMs) {
                        finish();
                    }

                }, 120);

                // Jaring pengaman
                const safety = setTimeout(finish, maxMs + 2500);
                safety.unref?.();
                const onAbort = signal ? finish : null;
                if (onAbort) {
                    signal.addEventListener("abort", onAbort, { once: true });
                    if (signal.aborted) onAbort();
                }

            });

        }
        finally {
            if (this._activeCapture === capture) {
                this._activeCapture = null;
                this._capturing = false;
            }
        }

    }

    /** STT via voiceService (faster-whisper dsb). Gagal → teks kosong. */
    async _transcribe(buf, { signal } = {}) {

        try {
            const voice = require("../services/voiceService");
            const r = await voice.transcribe(buf, {
                mimeType: "audio/wav",
                language: this.cfg.language || "id",
                localOnly: true,
                signal
            });
            return { text: (r.text || "").trim() };
        }
        catch (error) {
            this.lastError = error.message;
            telemetry.warn(`[voice] STT gagal: ${error.message}`);
            return { text: "" };
        }

    }
    /**
     * Trigger tepuk tangan 2x: beri sampel RMS lalu periksa double clap.
     */
    clapDetect(rms, t = Date.now()) {

        this.clap.feedLevel(rms, t);

        const r = this.clap.detect(t);

        if (r.detected) {
            this._onWake({ source: "clap", gapMs: r.gapMs });
        }

        return r;

    }

    /** Jalur bersama saat sebuah trigger wake terpicu (IDLE → WAKE). */
    _onWake({ source, text = null, gapMs = null }) {

        if (this.machine.current !== STATES.IDLE) return;

        this.machine.transit(STATES.WAKE_DETECTED);
        this.emit("wake", { source, text, gapMs });
        telemetry.publish("voice:wake", { source, text, gapMs });

        // Acknowledgement deterministik (tanpa LLM) — cepat.
        const turn = this._beginTurn();
        this._acknowledge(turn);

    }

    _acknowledge(turn) {
        // "Ya?" / "Siap." — deterministic, local, langsung.
        this.emit("ack", this.cfg.acknowledgement);
        telemetry.publish("voice:ack", { ack: this.cfg.acknowledgement });
        this.speak(this.cfg.acknowledgement, {
            signal: turn?.controller.signal,
            generation: turn?.generation
        }).catch(() => {});
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

        const text = typeof transcript === "string" ? transcript.trim() : "";

        if (!text) return { answer: null, skipped: true };

        const { controller, generation } = this._beginTurn();
        if (this.machine.current !== STATES.THINKING) this.machine.transit(STATES.THINKING);

        try {

            const { answer } = await this.session.think(text, { signal: controller.signal });
            if (controller.signal.aborted || generation !== this._turnGeneration) return { answer: null, cancelled: true };

            this.machine.transit(STATES.SPEAKING);

            this.emit("answer", answer);
            telemetry.publish("voice:answer", { chars: answer.length });

            await this.speak(answer, { signal: controller.signal, generation });

            return { answer };

        }
        catch (error) {

            if (controller.signal.aborted || generation !== this._turnGeneration) return { answer: null, cancelled: true };
            this.lastError = error.message;
            telemetry.warn(`[voice] putaran gagal: ${error.message}`);
            if (this._ownsTurn({ controller, generation })) {
                this._turnController = null;
                this.machine.reset();
            }
            return { answer: null, error: error.message };

        }
        finally {
            // Kembali standby setelah selesai / gagal.
            if (this._ownsTurn({ controller, generation })) {
                this._turnController = null;
                this.machine.reset();
            }
        }

    }

    /**
     * Ucapkan teks lewat TTS (voiceService) lalu putar lewat AudioOutput.
     * Graceful: kegagalan TTS/speaker TIDAK melempar ke pemanggil loop.
     */
    async speak(text, { signal = null, generation = this._turnGeneration } = {}) {

        this._speaking = true;
        this._cancelled = false;

        try {

            const voice = require("../services/voiceService");

            // TTS streaming/chunked: voiceService.speak menghasilkan audio
            // utuh; di masa depan bisa di-chunk. Untuk sekarang, kita
            // putar hasilnya — dan barge-in bisa membatalkan pemutaran.
            const { audio } = await voice.speak(text, {
                voice: voice.ttsVoice,
                localOnly: true,
                signal
            });

            if (this._cancelled || signal?.aborted || generation !== this._turnGeneration) return;

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
        this._cancelActiveTurn();
        await this._finalizeCapture(this._activeCapture);

        await this.output.stop();

        if (this.machine.current === STATES.SPEAKING) {
            this.machine.transit(STATES.LISTENING);
        }

        this.emit("interrupt");
        telemetry.publish("voice:interrupt", {});

    }

    _cancelActiveTurn() {
        this._turnGeneration += 1;
        if (this._turnController) this._turnController.abort();
        this._turnController = null;
    }

    _ownsTurn(turn) {
        return Boolean(turn) && turn.generation === this._turnGeneration &&
            this._turnController === turn.controller;
    }

    async _finalizeCapture(capture) {
        if (capture && typeof capture.stop === "function" && !capture.cap) {
            capture = { cap: capture, finalized: false };
            this._activeCapture = capture;
        }
        if (!capture || capture.finalized) return null;
        capture.finalized = true;
        try {
            return await capture.cap.stop();
        }
        finally {
            if (this._activeCapture === capture) {
                this._activeCapture = null;
                this._capturing = false;
            }
        }
    }

    _beginTurn() {
        this._cancelActiveTurn();
        const controller = new AbortController();
        const generation = ++this._turnGeneration;
        this._turnController = controller;
        return { controller, generation };
    }

    // ---- Status ----------------------------------------------------

    status() {

        const c = this.cfg;

        return {
            enabled: this.enabled,
            enabledRaw: c.enabledRaw,
            autoReason: this._autoReason,
            capturing: this._capturing,
            running: this.running,
            state: this.machine.current,
            wakeWord: c.wakeWord,
            clapEnabled: c.clapEnabled,
            clapDetector: this.clap.status(),
            clapStreamActive: Boolean(this._levelStream),
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
