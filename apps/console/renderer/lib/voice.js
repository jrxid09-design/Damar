import { api } from "./api.js";

/**
 * Suara untuk Damar.
 *
 * Keluar (TTS): speechSynthesis milik OS — offline, tanpa server.
 * Masuk (STT): rekam mic → kirim ke daemon → teks.
 *
 * Keduanya dibuat "gagal dengan anggun": kalau tidak ada voice
 * atau STT belum dikonfigurasi, fungsinya menolak dengan pesan
 * jelas, bukan diam-diam rusak.
 */

// =====================================================================
// TTS
// =====================================================================

export const tts = {

    voices: [],

    ready: false,

    /** Voice memuat asinkron di Chromium; tunggu sampai ada. */
    load() {

        return new Promise(resolve => {

            const grab = () => {
                this.voices = window.speechSynthesis?.getVoices() ?? [];
                if (this.voices.length) {
                    this.ready = true;
                    resolve(this.voices);
                    return true;
                }
                return false;
            };

            if (grab()) {
                return;
            }

            if (!window.speechSynthesis) {
                resolve([]);
                return;
            }

            window.speechSynthesis.onvoiceschanged = () => grab();

            // Fallback bila event tidak pernah menyala.
            setTimeout(() => { grab(); resolve(this.voices); }, 1200);

        });

    },

    available() {
        return typeof window.speechSynthesis !== "undefined";
    },

    /** Voice Indonesia bila ada, kalau tidak voice default sistem. */
    pickDefault() {

        return (
            this.voices.find(v => /^id/i.test(v.lang)) ??
            this.voices.find(v => v.default) ??
            this.voices[0] ??
            null
        );

    },

    findByName(name) {
        return this.voices.find(v => v.name === name) ?? null;
    },

    /**
     * Ucapkan teks. onBoundary dipanggil tiap batas kata — dipakai
     * untuk menggerakkan mulut avatar; onEnd saat selesai.
     */
    speak(text, { voice = null, rate = 1, pitch = 1, onBoundary, onStart, onEnd } = {}) {

        return new Promise((resolve) => {

            if (!this.available() || !text?.trim()) {
                onEnd?.();
                resolve();
                return;
            }

            // Batalkan ucapan sebelumnya agar tidak menumpuk.
            window.speechSynthesis.cancel();

            const utter = new SpeechSynthesisUtterance(text);

            const chosen = voice
                ? (this.findByName(voice) ?? this.pickDefault())
                : this.pickDefault();

            if (chosen) {
                utter.voice = chosen;
                utter.lang = chosen.lang;
            }

            utter.rate = rate;
            utter.pitch = pitch;

            utter.onstart = () => onStart?.();
            utter.onboundary = (e) => onBoundary?.(e);
            utter.onend = () => { onEnd?.(); resolve(); };
            utter.onerror = () => { onEnd?.(); resolve(); };

            window.speechSynthesis.speak(utter);

        });

    },

    cancel() {
        window.speechSynthesis?.cancel();
        stopNeural();
    },

    get speaking() {
        return (window.speechSynthesis?.speaking ?? false) || neural.playing;
    },

    // ---- TTS neural (Kokoro / OpenAI-compatible) ----------------

    neuralReady: false,

    /** Cek apakah backend TTS neural dikonfigurasi di daemon. */
    async refreshStatus() {
        try {
            const status = await api.voiceStatus();
            this.neuralReady = Boolean(status.tts?.neural);
            return status;
        }
        catch {
            this.neuralReady = false;
            return null;
        }
    },

    /**
     * Ucapkan teks memakai rute terbaik yang tersedia:
     * suara neural bila dikonfigurasi (banyak voice + Indonesia +
     * bisa efek robot), kalau tidak jatuh ke suara OS.
     *
     * onLevel(0..1) dipanggil terus-menerus mengikuti amplitudo
     * suara — dipakai menggerakkan mulut avatar secara nyata.
     */
    async say(text, { voice = null, rate = 1, pitch = 1, robot = false, onLevel, onStart, onEnd } = {}) {

        // Status neural bisa BASI. Reachability daemon ke container TTS
        // di-cache 15 dtk; cek pertama saat Console baru start (Kokoro
        // belum sempat menjawab) bisa keliru "mati", lalu neuralReady
        // terkunci false walau picker sudah memuat suara Kokoro. Itu
        // sebab suara diam-diam turun ke suara OS (Microsoft) saat
        // dipakai. Cek ulang sekali sebelum memutuskan pakai OS.
        if (!this.neuralReady) {
            await this.refreshStatus();
        }

        if (this.neuralReady) {
            return this.speakNeural(text, { voice, robot, onLevel, onStart, onEnd });
        }

        // Fallback OS: suara speechSynthesis tak bisa dilewatkan Web
        // Audio, jadi efek robot ditiru lewat pitch serendah mungkin +
        // tempo sedikit melambat + ritme mulut yang lebih "patah-patah"
        // (mekanis). Ini pendekatan terbaik tanpa backend TTS neural.
        return this.speak(text, {
            voice,
            rate: robot ? Math.min(rate, 0.85) : rate,
            pitch: robot ? 0 : pitch,
            onStart,
            onBoundary: () => onLevel?.(robot
                ? (Math.random() < 0.5 ? 0.15 : 0.85)   // buka-tutup tegas
                : 0.4 + Math.random() * 0.5),
            onEnd: () => { onLevel?.(0); onEnd?.(); }
        });

    },

    async speakNeural(text, { voice = null, robot = false, onLevel, onStart, onEnd } = {}) {

        stopNeural();

        let buffer;

        try {
            const res = await fetch(`${api.root}/voice/speak`, {
                method: "POST",
                headers: api.headers({ "Content-Type": "application/json" }),
                body: JSON.stringify({ text, voice })
            });

            if (!res.ok) {
                throw new Error(`TTS ${res.status}`);
            }

            buffer = await res.arrayBuffer();
        }
        catch {
            // Neural gagal → pakai suara OS supaya tetap bersuara.
            return this.speak(text, {
                voice,
                onStart,
                onBoundary: () => onLevel?.(0.4 + Math.random() * 0.5),
                onEnd: () => { onLevel?.(0); onEnd?.(); }
            });
        }

        const ctx = new AudioContext();
        neural.ctx = ctx;
        neural.playing = true;

        const audioBuf = await ctx.decodeAudioData(buffer);

        const source = ctx.createBufferSource();
        source.buffer = audioBuf;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;

        // Rangkaian: source → [ring mod robot?] → analyser → speaker.
        let tail = source;

        if (robot) {
            tail = applyRobot(ctx, source);
        }

        tail.connect(analyser);
        analyser.connect(ctx.destination);

        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
            if (!neural.playing) return;
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (const v of data) {
                const x = (v - 128) / 128;
                sum += x * x;
            }
            onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 3));
            neural.raf = requestAnimationFrame(tick);
        };

        return new Promise(resolve => {

            source.onended = () => {
                onLevel?.(0);
                onEnd?.();
                stopNeural();
                resolve();
            };

            onStart?.();
            source.start();
            neural.raf = requestAnimationFrame(tick);

        });

    }

};

// State pemutaran neural, agar bisa dibatalkan.
const neural = { ctx: null, raf: null, playing: false };

function stopNeural() {
    neural.playing = false;
    if (neural.raf) {
        cancelAnimationFrame(neural.raf);
        neural.raf = null;
    }
    neural.ctx?.close().catch(() => {});
    neural.ctx = null;
}

/**
 * Efek "robot" untuk suara neural: ring modulation + sedikit
 * distorsi + highpass, supaya timbre-nya jelas metalik/mekanis.
 *
 * Ring modulation = kalikan sinyal suara dengan osilator. GainNode
 * di Web Audio bisa dimodulasi audio-rate lewat parameter gain-nya,
 * jadi itu dipakai sebagai pengali. Osilator kotak (square) memberi
 * harmonik lebih kaya → terdengar lebih "robot" ketimbang sine.
 */
function applyRobot(ctx, source) {

    // --- Ring modulation ---
    const ring = ctx.createGain();
    ring.gain.value = 0;

    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 50;

    // Kedalaman modulasi penuh.
    const depth = ctx.createGain();
    depth.gain.value = 1;

    osc.connect(depth);
    depth.connect(ring.gain);
    osc.start();

    source.connect(ring);

    // --- Distorsi ringan (kesan "mesin") ---
    const shaper = ctx.createWaveShaper();
    shaper.curve = distortionCurve(12);
    shaper.oversample = "2x";
    ring.connect(shaper);

    // --- Highpass menajamkan sisi logam ---
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 350;
    shaper.connect(hp);

    // Kompensasi volume karena ring-mod menurunkan energi.
    const makeup = ctx.createGain();
    makeup.gain.value = 1.6;
    hp.connect(makeup);

    return makeup;

}

/** Kurva distorsi lembut untuk WaveShaperNode. */
function distortionCurve(amount = 12) {

    const samples = 1024;
    const curve = new Float32Array(samples);
    const deg = Math.PI / 180;

    for (let i = 0; i < samples; i++) {
        const x = (i * 2) / samples - 1;
        curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }

    return curve;

}

// =====================================================================
// STT — rekam mikrofon lalu kirim ke daemon
// =====================================================================

export class MicRecorder {

    constructor({ deviceId = null, language = "id" } = {}) {
        this.deviceId = deviceId;
        this.language = language;
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
        this.recording = false;
        this.onLevel = null;
        this.audioContext = null;
        this.raf = null;
    }

    async start() {

        if (this.recording) {
            return;
        }

        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: this.deviceId ? { deviceId: { exact: this.deviceId } } : true
        });

        this.chunks = [];

        // Pilih tipe yang didukung; webm/opus paling umum di Chromium.
        const mimeType = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/ogg;codecs=opus"
        ].find(t => MediaRecorder.isTypeSupported(t)) ?? "";

        this.recorder = new MediaRecorder(
            this.stream,
            mimeType ? { mimeType } : undefined
        );

        this.mimeType = this.recorder.mimeType || mimeType || "audio/webm";

        this.recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                this.chunks.push(e.data);
            }
        };

        this.recorder.start();
        this.recording = true;

        this.startLevelMeter();

    }

    /** Hentikan rekaman, kembalikan Blob audio. */
    stop() {

        return new Promise((resolve) => {

            if (!this.recorder || !this.recording) {
                resolve(null);
                return;
            }

            this.recorder.onstop = () => {
                const blob = new Blob(this.chunks, { type: this.mimeType });
                this.cleanup();
                resolve(blob);
            };

            this.recorder.stop();
            this.recording = false;

        });

    }

    /** Rekam sampai stop() lalu transkripsi lewat daemon. */
    async stopAndTranscribe() {

        const blob = await this.stop();

        if (!blob || blob.size === 0) {
            return { text: "" };
        }

        const base64 = await blobToBase64(blob);

        return api.transcribe({
            audio: base64,
            mimeType: this.mimeType,
            language: this.language
        });

    }

    /** Meter level untuk umpan balik visual saat mendengarkan. */
    startLevelMeter() {

        if (!this.onLevel) {
            return;
        }

        this.audioContext = new AudioContext();
        const source = this.audioContext.createMediaStreamSource(this.stream);
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);

        const buf = new Float32Array(analyser.fftSize);

        const tick = () => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (const v of buf) sum += v * v;
            const rms = Math.sqrt(sum / buf.length);
            this.onLevel(Math.min(1, Math.sqrt(rms) * 2.2));
            this.raf = requestAnimationFrame(tick);
        };

        this.raf = requestAnimationFrame(tick);

    }

    cleanup() {

        if (this.raf) {
            cancelAnimationFrame(this.raf);
            this.raf = null;
        }

        this.audioContext?.close().catch(() => {});
        this.audioContext = null;

        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;

    }

    abort() {
        this.recording = false;
        try { this.recorder?.stop(); } catch { /* sudah berhenti */ }
        this.cleanup();
    }

}

function blobToBase64(blob) {

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // dataURL: "data:audio/webm;base64,XXXX" → ambil bagian base64.
            const result = String(reader.result);
            resolve(result.slice(result.indexOf(",") + 1));
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });

}
