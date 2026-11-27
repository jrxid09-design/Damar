"use strict";

/**
 * WhisperWakeWordProvider — engine wake-word sungguhan untuk "Damar".
 *
 * Mengimplementasikan antarmuka WakeWordProvider yang sama (detect(text) +
 * status()), ditambah jalur audio: PCM 16 kHz mono dialirkan lewat
 * feedPcm(); VadSegmenter memotong segmen ucapan; tiap segmen ditranskripsi
 * LOKAL oleh whisper.cpp model kecil (default ggml-tiny) dan hasilnya dicek
 * dengan pencocok kata-utuh yang sama seperti provider "local". Standby
 * TIDAK menyentuh LLM dan TIDAK mengirim audio ke mana pun.
 *
 * Sifat hemat CPU: whisper hanya berjalan pada segmen yang lolos VAD
 * (ada energi suara), bukan pada keheningan.
 *
 * Transcriber bisa disuntikkan (untuk tes hermetik); default-nya
 * src/voice/local/engines.transcribeWav.
 */

const { WakeWordProvider } = require("./wakeWord");
const { VadSegmenter, pcmToWav } = require("./vadSegmenter");

class WhisperWakeWordProvider extends WakeWordProvider {

    /**
     * @param {object} opts
     * @param {string} opts.wakeWord
     * @param {string} [opts.model] model whisper spotting (default ggml-tiny)
     * @param {Function} [opts.transcriber] async (wavBuffer) => {text} | string
     * @param {Function} [opts.onWake] callback ({text, at, segmentMs})
     * @param {number} [opts.rmsThreshold] ambang energi VAD (0..1)
     * @param {number} [opts.silenceMs] diam penutup segmen (default 600)
     * @param {number} [opts.minSpeechMs] durasi bicara minimum segmen
     * @param {number} [opts.maxSegmentMs] potong paksa segmen panjang
     * @param {number} [opts.cooldownMs] jeda abaikan setelah wake terdeteksi
     * @param {string} [opts.prompt] prompt bias whisper (opsional)
     */
    constructor({
        wakeWord = "damar", model = "ggml-tiny", transcriber = null, onWake = null,
        rmsThreshold = 0.015, silenceMs = 600, minSpeechMs = 300,
        maxSegmentMs = 5000, cooldownMs = 1500, prompt = null
    } = {}) {
        super({ wakeWord });
        this.name = "whisper";
        this.model = model;
        this.prompt = prompt;
        this._transcriber = transcriber;
        this._listeners = new Set();
        if (onWake) this._listeners.add(onWake);

        this._segmenter = new VadSegmenter({
            rmsThreshold, silenceMs, minSpeechMs, maxSegmentMs, preRollMs: 300
        });
        this.cooldownMs = cooldownMs;
        this._queue = Promise.resolve();
        this._lastWakeAt = 0;

        this.listening = false;
        this.segmentsHeard = 0;
        this.segmentsChecked = 0;
        this.lastText = "";
        this.lastError = null;
        this.events = [];
    }

    async _transcribe(wavBuffer) {
        if (this._transcriber) {
            const out = await this._transcriber(wavBuffer);
            return typeof out === "string" ? out : (out?.text ?? "");
        }
        const engines = require("../local/engines");
        const out = await engines.transcribeWav(wavBuffer, {
            model: this.model, language: "id", prompt: this.prompt ?? undefined
        });
        return out.text;
    }

    onWake(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    start() { this.listening = true; return this; }
    stop() { this.listening = false; return this; }

    feedPcm(chunk) {
        for (const seg of this._segmenter.feedPcm(chunk)) {
            this.segmentsHeard += 1;
            this._enqueueSegment(seg);
        }
    }

    _enqueueSegment(seg) {
        this._queue = this._queue.then(async () => {
            try {
                const text = await this._transcribe(pcmToWav(seg.pcm));
                this.segmentsChecked += 1;
                this.lastText = text;
                const r = this.detect(text);
                if (r.detected) {
                    const now = Date.now();
                    if (now - this._lastWakeAt >= this.cooldownMs) {
                        this._lastWakeAt = now;
                        const ev = { detected: true, wakeWord: this.wakeWord, text: r.text, at: new Date(now).toISOString(), segmentMs: seg.durationMs };
                        this.events.push(ev);
                        for (const fn of this._listeners) {
                            try { fn(ev); } catch { /* pendengar tak boleh merusak spotter */ }
                        }
                    }
                }
            } catch (error) {
                this.lastError = error.message;
            }
        });
        return this._queue;
    }

    async flush() {
        for (const seg of this._segmenter.flush()) {
            this.segmentsHeard += 1;
            this._enqueueSegment(seg);
        }
        await this._queue;
        return this;
    }

    /**
     * Kemudahan untuk berkas: proses satu WAV utuh lewat jalur yang sama.
     * @returns {Promise<Array>} events wake yang terpicu dari panggilan ini
     */
    async processWav(wavBuffer) {
        const { wavToPcm16 } = require("./speechEnvelope");
        const { FRAME_BYTES } = require("./vadSegmenter");
        const { pcm, sampleRate } = wavToPcm16(wavBuffer);
        if (sampleRate !== 16000) {
            throw new Error(`processWav butuh WAV 16000 Hz (dapat ${sampleRate} Hz) — resample dulu`);
        }
        const before = this.events.length;
        const silence = Buffer.alloc(FRAME_BYTES * 8);
        this.feedPcm(silence);
        this.feedPcm(pcm);
        this.feedPcm(silence);
        await this.flush();
        return this.events.slice(before);
    }

    status() {
        return {
            provider: this.name,
            wakeWord: this.wakeWord,
            model: this.model,
            listening: this.listening,
            segmentsHeard: this.segmentsHeard,
            segmentsChecked: this.segmentsChecked,
            wakesDetected: this.events.length,
            lastText: this.lastText,
            lastError: this.lastError
        };
    }
}

module.exports = { WhisperWakeWordProvider };
