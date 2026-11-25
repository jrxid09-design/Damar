"use strict";

/**
 * streaming — lapisan percakapan rapat (syarat pengalaman owner:
 * seperti voice mode Gemini/ChatGPT, tanpa "teks selesai, suara menyusul").
 *
 * Tiga komponen:
 *
 * 1. SentenceChunker — memecah aliran token teks menjadi potongan kalimat
 *    begitu kalimat selesai, agar TTS bisa mulai pada kalimat PERTAMA
 *    selagi sisa respons masih digenerate.
 *
 * 2. StreamingTranscriber — STT streaming di atas whisper.cpp: transkripsi
 *    PARSIAL berkala selama user bicara + transkrip FINAL rapat begitu
 *    endpointing VAD (default 400 ms hening, dari config pusat) menutup
 *    ucapan. Model final bisa lebih besar dari model parsial.
 *
 * 3. StreamingSpeaker — pipeline TTS: sintesis per chunk kalimat berjalan
 *    mendahului playback; chunk pertama diputar sebelum teks lengkap
 *    selesai. Mendukung BARGE-IN: interrupt() menghentikan playback
 *    secepatnya dan membuang antrean. Envelope lip-sync dihitung dari
 *    audio chunk yang BENAR-BENAR diputar (bukan dari teks).
 *
 * Capture & playback berjalan bersamaan secara desain (full-duplex):
 * tidak ada komponen di sini yang mengunci mic selama TTS berbunyi.
 * BargeInMonitor mengawasi aliran mic selama playback; echo handling
 * level software saat ini = ambang energi khusus barge-in yang lebih
 * tinggi + syarat energi stabil 2 frame. AEC khusus BELUM ada —
 * keterbatasan yang dicatat jujur di VOICE-ID.md.
 */

const { VadSegmenter, pcmToWav, FRAME_MS } = require("../providers/vadSegmenter");
const { computeEnvelope } = require("../providers/speechEnvelope");

// ---------------------------------------------------------------- chunker

class SentenceChunker {

    constructor({ minChars = 8, maxChars = 240 } = {}) {
        this.minChars = minChars;
        this.maxChars = maxChars;
        this.buffer = "";
    }

    /** Tambah teks; kembalikan chunk kalimat yang selesai. */
    push(text) {
        this.buffer += String(text ?? "");
        const out = [];
        let chunk;
        while ((chunk = this._take()) !== null) out.push(chunk);
        return out;
    }

    _take() {
        const buf = this.buffer;
        // Cari batas kalimat: tanda akhir + spasi + karakter berikutnya ada
        // (lookahead satu karakter agar "3.5" dan elipsis tidak memotong).
        for (let i = 0; i < buf.length; i++) {
            const ch = buf[i];
            if (ch === "\n") {
                const cand = buf.slice(0, i).trim();
                this.buffer = buf.slice(i + 1);
                if (cand.length >= this.minChars) return cand;
                return this._take();
            }
            if (".!?…".includes(ch)) {
                let j = i + 1;
                while (j < buf.length && ".!?…".includes(buf[j])) j++;
                if (j + 1 < buf.length && /\s/.test(buf[j])) {
                    const cand = buf.slice(0, j).trim();
                    if (cand.length >= this.minChars) {
                        this.buffer = buf.slice(j + 1);
                        return cand;
                    }
                    // Terlalu pendek: gabung ke kalimat berikutnya (terus pindai).
                }
            }
        }
        // Jaring pengaman latensi: potong paksa di koma/spasi terakhir.
        if (buf.length >= this.maxChars) {
            let cut = buf.lastIndexOf(", ", this.maxChars);
            if (cut < this.minChars) cut = buf.lastIndexOf(" ", this.maxChars);
            if (cut >= this.minChars) {
                const cand = buf.slice(0, cut + 1).trim();
                this.buffer = buf.slice(cut + 1);
                return cand;
            }
        }
        return null;
    }

    /** Sisa buffer di akhir aliran. */
    flush() {
        const rest = this.buffer.trim();
        this.buffer = "";
        return rest ? rest : null;
    }
}

// ------------------------------------------------------- streaming STT

class StreamingTranscriber {

    /**
     * @param {object} opts
     * @param {Function} opts.transcriber async (wavBuffer, {final}) => {text}|string
     * @param {number} [opts.endpointMs=400] hening penutup ucapan
     * @param {number} [opts.partialIntervalMs=700] jarak antar transkripsi parsial
     * @param {Function} [opts.onPartial] ({text, atMs})
     * @param {Function} [opts.onFinal] ({text, speechMs, finalizeMs, endpointMs})
     */
    constructor({ transcriber, fastTranscriber = null, endpointMs = 400, partialIntervalMs = 700, onPartial = null, onFinal = null, onFastFinal = null, rmsThreshold = 0.015 } = {}) {
        if (!transcriber) throw new Error("StreamingTranscriber butuh transcriber");
        this._transcriber = transcriber;
        this.fastTranscriber = fastTranscriber;
        this.endpointMs = endpointMs;
        this.partialIntervalMs = partialIntervalMs;
        this.onPartial = onPartial;
        this.onFinal = onFinal;
        this.onFastFinal = onFastFinal;
        this._segmenter = new VadSegmenter({
            rmsThreshold, silenceMs: endpointMs, minSpeechMs: 300, maxSegmentMs: 30000, preRollMs: 300
        });
        this._speechMsSeen = 0;
        this._lastPartialAtSpeechMs = 0;
        this._partialBusy = false;
        this._finalQueue = Promise.resolve();
        this.partials = [];
        this.finals = [];
    }

    feedPcm(chunk) {
        const closed = this._segmenter.feedPcm(chunk);
        for (const seg of closed) this._enqueueFinal(seg);

        // Parsial: segmen masih terbuka & cukup bicara baru sejak parsial lalu.
        const open = this._segmenter.currentSegmentPcm();
        if (open) {
            const speechMs = this._segmenter._segment ? this._segmenter._segment.speechFrames * FRAME_MS : 0;
            this._speechMsSeen = speechMs;
            if (!this._partialBusy && speechMs - this._lastPartialAtSpeechMs >= this.partialIntervalMs && speechMs >= 500) {
                this._partialBusy = true;
                this._lastPartialAtSpeechMs = speechMs;
                const wav = pcmToWav(open);
                Promise.resolve()
                    .then(() => this._transcriber(wav, { final: false }))
                    .then(out => {
                        const text = typeof out === "string" ? out : (out?.text ?? "");
                        const rec = { text, atSpeechMs: speechMs };
                        this.partials.push(rec);
                        if (this.onPartial) { try { this.onPartial(rec); } catch { /* abaikan */ } }
                    })
                    .catch(() => {})
                    .finally(() => { this._partialBusy = false; });
            }
        }
        return closed.length > 0;
    }

    _enqueueFinal(seg) {
        const t0 = Date.now();
        this._finalQueue = this._finalQueue.then(async () => {
            const wav = pcmToWav(seg.pcm);
            // Final CEPAT (opsional): model kecil lebih dulu agar giliran
            // bicara terasa rapat; final OTORITATIF (model besar) menyusul
            // pada antrean yang sama. Pola dua tahap sesuai perhitungan
            // latensi: base CLI ±0,94 dtk vs small CLI ±2,8 dtk (muat model).
            if (this.fastTranscriber) {
                let fastText = "";
                try {
                    const out = await this.fastTranscriber(wav, { final: true, stage: "fast" });
                    fastText = typeof out === "string" ? out : (out?.text ?? "");
                } catch { /* final cepat gagal → langsung ke otoritatif */ }
                const fastRec = {
                    text: fastText, stage: "fast", speechMs: seg.speechMs, durationMs: seg.durationMs,
                    endpointMs: this.endpointMs, finalizeMs: Date.now() - t0
                };
                this.finals.push(fastRec);
                if (this.onFastFinal) { try { this.onFastFinal(fastRec); } catch { /* abaikan */ } }
                if (this.onFinal) { try { this.onFinal(fastRec); } catch { /* abaikan */ } }
            }
            let text = "";
            try {
                const out = await this._transcriber(wav, { final: true });
                text = typeof out === "string" ? out : (out?.text ?? "");
            } catch { /* final gagal → teks kosong, tercatat lewat finalizeMs */ }
            const rec = {
                text, stage: "final", speechMs: seg.speechMs, durationMs: seg.durationMs,
                endpointMs: this.endpointMs, finalizeMs: Date.now() - t0
            };
            this.finals.push(rec);
            if (this.onFinal) { try { this.onFinal(rec); } catch { /* abaikan */ } }
            return rec;
        });
        return this._finalQueue;
    }

    async flush() {
        for (const seg of this._segmenter.flush()) this._enqueueFinal(seg);
        await this._finalQueue;
        return this.finals;
    }
}

// ------------------------------------------------------- streaming TTS

class StreamingSpeaker {

    /**
     * @param {object} opts
     * @param {Function} opts.synthesize async (text) => {audio: Buffer, ms}
     * @param {Function} opts.play async (audio, {signal}) => void (selesai saat audio habis diputar)
     * @param {Function} [opts.stop] () => void — hentikan playback berjalan (barge-in)
     * @param {Function} [opts.onChunk] (chunkInfo) => void
     */
    constructor({ synthesize, play, stop = null, onChunk = null } = {}) {
        if (!synthesize || !play) throw new Error("StreamingSpeaker butuh synthesize + play");
        this._synthesize = synthesize;
        this._play = play;
        this._stop = stop;
        this.onChunk = onChunk;
        this._interrupt = null;
    }

    /** Potong pembicaraan sekarang (barge-in). */
    interrupt() {
        if (this._interrupt) this._interrupt();
        if (this._stop) { try { this._stop(); } catch { /* abaikan */ } }
    }

    /**
     * Bicara dari aliran token teks (async iterable / iterable string).
     * @returns {Promise<{interrupted: boolean, firstAudioMs: number|null,
     *          textCompleteMs: number|null, totalMs: number, chunks: Array}>}
     */
    async speak(tokenSource, { signal = null } = {}) {
        const t0 = Date.now();
        const now = () => Date.now() - t0;
        const chunker = new SentenceChunker();
        const chunks = [];
        let textCompleteMs = null;
        let interrupted = false;
        let wakeInterrupt;
        const interruptPromise = new Promise(r => { wakeInterrupt = r; });
        this._interrupt = () => { interrupted = true; wakeInterrupt(); };
        if (signal) signal.addEventListener("abort", () => this.interrupt(), { once: true });

        // Antrean sintesis (serial) & playback (serial, urut).
        const ready = [];
        let readyNotify = null;
        const pushReady = item => { ready.push(item); if (readyNotify) { readyNotify(); readyNotify = null; } };
        const waitReady = () => ready.length ? Promise.resolve() : new Promise(r => { readyNotify = r; });

        let synthChain = Promise.resolve();
        const enqueueText = text => {
            synthChain = synthChain.then(async () => {
                if (interrupted) return;
                const s0 = Date.now();
                try {
                    const out = await this._synthesize(text);
                    const audio = out.audio ?? out;
                    let envelope = null;
                    try { envelope = computeEnvelope(audio, { frameMs: 50 }); } catch { /* abaikan */ }
                    pushReady({
                        text, audio, synthMs: Date.now() - s0,
                        envelope, durationMs: envelope ? envelope.durationMs : null,
                        readyMs: now()
                    });
                } catch (error) {
                    pushReady({ text, error: error.message, readyMs: now() });
                }
            });
            return synthChain;
        };

        const producer = (async () => {
            try {
                for await (const token of tokenSource) {
                    if (interrupted) break;
                    for (const c of chunker.push(token)) enqueueText(c);
                }
            } catch { /* sumber token gagal → flush sisa */ }
            textCompleteMs = now();
            const rest = chunker.flush();
            if (rest && !interrupted) enqueueText(rest);
            await synthChain;
            pushReady(null); // penanda selesai
        })();

        let firstAudioMs = null;
        const player = (async () => {
            for (;;) {
                if (interrupted) break;
                await Promise.race([waitReady(), interruptPromise]);
                if (interrupted) break;
                const item = ready.shift();
                if (item === null || item === undefined) break;
                if (item.error) { chunks.push({ text: item.text, error: item.error }); continue; }
                const playStartMs = now();
                if (firstAudioMs === null) firstAudioMs = playStartMs;
                const info = { ...item, playStartMs };
                chunks.push(info);
                if (this.onChunk) { try { this.onChunk(info); } catch { /* abaikan */ } }
                await Promise.race([
                    Promise.resolve().then(() => this._play(item.audio, { signal })).catch(() => {}),
                    interruptPromise
                ]);
                info.playEndMs = now();
                if (interrupted) break;
            }
        })();

        await Promise.race([Promise.all([producer, player]), interruptPromise.then(() => Promise.allSettled([producer, player]))]);
        this._interrupt = null;
        return { interrupted, firstAudioMs, textCompleteMs, totalMs: now(), chunks };
    }
}

// ------------------------------------------------------- barge-in monitor

class BargeInMonitor {

    /**
     * Awasi aliran mic SELAMA playback. Ucapan user yang stabil
     * (2 frame keras berturut-turut di atas ambang barge-in) memicu
     * onSpeechStart dalam <= ~200 ms sejak energi mulai (frame 100 ms).
     * @param {object} opts { rmsThreshold=0.05, onSpeechStart }
     */
    constructor({ rmsThreshold = 0.05, onSpeechStart = null } = {}) {
        this.rmsThreshold = rmsThreshold;
        this.onSpeechStart = onSpeechStart;
        this.armed = false;
        this._loudRun = 0;
        this.triggeredAt = null;
    }

    arm() { this.armed = true; this._loudRun = 0; this.triggeredAt = null; return this; }
    disarm() { this.armed = false; return this; }

    feedPcm(chunk) {
        if (!this.armed || this.triggeredAt) return;
        const { frameRms } = require("../providers/vadSegmenter");
        // Pecah ke frame 100 ms untuk latensi deteksi yang terukur.
        let off = 0;
        const frameBytes = 1600 * 2;
        while (off + frameBytes <= chunk.length) {
            const rms = frameRms(chunk.subarray(off, off + frameBytes));
            off += frameBytes;
            if (rms >= this.rmsThreshold) {
                this._loudRun += 1;
                if (this._loudRun >= 2) {
                    this.triggeredAt = Date.now();
                    if (this.onSpeechStart) { try { this.onSpeechStart({ at: this.triggeredAt }); } catch { /* abaikan */ } }
                    return;
                }
            } else {
                this._loudRun = 0;
            }
        }
    }
}

module.exports = { SentenceChunker, StreamingTranscriber, StreamingSpeaker, BargeInMonitor };
