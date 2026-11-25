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
 * 1b. MicroChunker — segmentasi aliran token pada granularitas KATA
 *    ("1 kata = 1 voice", mandat owner 2026-11-25 17:02): potongan mikro
 *    di batas klausa/frasa dengan batas jumlah kata, agar sintesis
 *    mengikuti aliran token nyaris kata-per-kata dan audio pertama tidak
 *    menunggu kalimat pertama selesai — bahkan bila kalimat pertama
 *    panjang. Dipakai StreamingSpeaker + endpoint /speech/stream.
 *
 * 2. StreamingTranscriber — STT streaming di atas whisper.cpp: transkripsi
 *    PARSIAL berkala selama user bicara + transkrip FINAL rapat begitu
 *    endpointing VAD (default 400 ms hening, dari config pusat) menutup
 *    ucapan. Model final bisa lebih besar dari model parsial.
 *
 * 3. StreamingSpeaker — pipeline TTS yang diperkeras untuk jawaban
 *    generatif PANJANG: sintesis mikro-chunk berjalan mendahului playback
 *    di dalam jendela jitter buffer; antrean teks dibatasi backpressure
 *    (penggabungan chunk pending, token stream tidak pernah diblokir);
 *    kegagalan/timeout satu chunk tidak membunuh giliran; BARGE-IN:
 *    interrupt() menghentikan playback secepatnya dan membuang antrean.
 *    Envelope lip-sync dihitung dari audio chunk yang BENAR-BENAR
 *    diputar (bukan dari teks).
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

// ------------------------------------------------------- micro chunker

/**
 * MicroChunker — segmentasi aliran token pada granularitas kata.
 *
 * Kebijakan potong (terdokumentasi; semua angka bisa ditimpa opsi):
 *  - Kata = run non-spasi. Kata terakhir di buffer yang belum diikuti
 *    spasi dianggap BELUM lengkap (token berikutnya bisa menyambungnya).
 *  - Batas KALIMAT: run tanda [.!?…] atau newline. Batas KLAUSA: run
 *    [,;:—–]. Sebuah batas hanya "terkonfirmasi" bila sesudahnya ada
 *    spasi DAN minimal satu karakter lagi (atau saat flush) — jadi
 *    "3,5" dan "350.000" tidak pernah terpotong di tengah angka.
 *  - Chunk PERTAMA (yang menentukan latensi audio pertama): potong di
 *    batas kalimat/klausa pertama dengan >= firstMinWords kata, atau
 *    paksa di kata lengkap ke-firstMaxWords — mana yang lebih dulu.
 *  - Chunk BERIKUTNYA: potong di batas kalimat dengan >= sentenceMinWords
 *    kata, atau batas klausa dengan >= minWords kata, atau paksa di
 *    targetWords (target lunak, potong di akhir kata), dibatasi keras
 *    oleh maxWords kata / maxChars karakter.
 *  - Karakter: buffer >= maxChars tanpa titik potong -> potong di spasi
 *    terakhir <= maxChars; satu "kata" monster yang melewati maxChars
 *    (URL/tanpa spasi) dipotong keras per maxChars agar sintesis tidak
 *    pernah menerima chunk raksasa.
 *  - flush() mengembalikan SISA sebagai array chunk (beda dari
 *    SentenceChunker yang mengembalikan string tunggal).
 *
 * Sifat 1:1: menggabungkan semua chunk dengan satu spasi menghasilkan
 * kembali teks asal (modulo normalisasi spasi) — tidak ada kata yang
 * hilang atau berubah urutan, termasuk saat backpressure menggabungkan
 * chunk di StreamingSpeaker.
 */
class MicroChunker {

    constructor({
        firstMinWords = 2, firstMaxWords = 4,
        sentenceMinWords = 3, minWords = 5,
        targetWords = 9, maxWords = 14, maxChars = 120
    } = {}) {
        this.firstMinWords = firstMinWords;
        this.firstMaxWords = firstMaxWords;
        this.sentenceMinWords = sentenceMinWords;
        this.minWords = minWords;
        this.targetWords = targetWords;
        this.maxWords = maxWords;
        this.maxChars = maxChars;
        this.buffer = "";
        this._emitted = 0;
    }

    /** Tambah teks; kembalikan array micro-chunk yang siap disintesis. */
    push(text) {
        this.buffer += String(text ?? "");
        const out = [];
        let chunk;
        while ((chunk = this._take(false)) !== null) out.push(chunk);
        return out;
    }

    /** Akhir aliran: paksa keluarkan semua sisa sebagai array chunk. */
    flush() {
        const out = [];
        let chunk;
        while ((chunk = this._take(true)) !== null) out.push(chunk);
        const rest = this.buffer.trim();
        this.buffer = "";
        if (rest) out.push(rest);
        return out;
    }

    /**
     * Pindai buffer menjadi rentang kata: {start, end, boundary}
     * boundary: "sentence" | "clause" | null — tanda baca yang MENUTUP
     * kata itu dan sudah terkonfirmasi (atau final=true saat flush).
     * Kata terakhir tanpa spasi sesudahnya hanya dihitung saat final.
     */
    _spans(final) {
        const buf = this.buffer;
        const spans = [];
        const re = /\S+/g;
        let m;
        while ((m = re.exec(buf)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            const complete = final || end < buf.length;
            if (!complete) break;
            // Tanda baca penutup kata (run di ujung kata).
            let boundary = null;
            const tail = /[.!?…]+$/.exec(m[0]);
            const clause = /[,;:—–]+$/.exec(m[0]);
            const punctEnd = tail ? end - tail[0].length : (clause ? end - clause[0].length : -1);
            if (punctEnd >= 0) {
                // Terkonfirmasi: ada spasi + karakter sesudah run tanda baca,
                // atau newline tepat sesudah kata, atau flush.
                const after = buf[end];
                const confirmed = final || after === "\n" ||
                    (after !== undefined && /\s/.test(after) && /\S/.test(buf.slice(end + 1)));
                if (confirmed) boundary = tail ? "sentence" : "clause";
            }
            if (buf[end] === "\n") boundary = "sentence";
            spans.push({ start, end, boundary });
        }
        return spans;
    }

    _emit(uptoIndex) {
        const raw = this.buffer.slice(0, uptoIndex);
        this.buffer = this.buffer.slice(uptoIndex).replace(/^\s+/, "");
        const chunk = raw.trim();
        if (!chunk) return null;
        this._emitted++;
        return chunk;
    }

    _take(final) {
        const buf = this.buffer;
        if (!buf.trim()) { if (final) this.buffer = ""; return null; }
        const first = this._emitted === 0;
        const spans = this._spans(final);
        // Aturan batas: pindai kata lengkap berurutan; titik potong
        // PERTAMA yang memenuhi syarat menang (itulah yang membuat
        // chunk pertama keluar sedini mungkin).
        for (let i = 0; i < spans.length; i++) {
            const words = i + 1;
            const b = spans[i].boundary;
            if (b === "sentence" && words >= (first ? this.firstMinWords : this.sentenceMinWords)) {
                return this._emit(spans[i].end);
            }
            if (b === "clause" && words >= (first ? this.firstMinWords : this.minWords)) {
                return this._emit(spans[i].end);
            }
            if (words >= (first ? this.firstMaxWords : this.targetWords)) {
                return this._emit(spans[i].end);
            }
            if (words >= this.maxWords) {
                return this._emit(spans[i].end);
            }
        }
        // Batas karakter: tanpa titik potong kata yang memenuhi syarat.
        if (buf.length >= this.maxChars) {
            let cut = buf.lastIndexOf(" ", this.maxChars);
            if (cut < 1) {
                // Satu kata monster melewati maxChars: potong keras.
                if (spans.length && spans[0].end > this.maxChars && spans[0].start === 0) {
                    return this._emit(this.maxChars);
                }
                cut = this.maxChars;
                return this._emit(cut);
            }
            return this._emit(cut);
        }
        if (final && spans.length) {
            // Flush: keluarkan sampai kata lengkap terakhir; sisa mentah
            // (kata parsial di ujung) ditangani flush() sebagai sisa.
            return this._emit(spans[spans.length - 1].end);
        }
        return null;
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

/** Estimasi durasi bicara dari teks (cadangan bila envelope tak terhitung). */
function estimateDurationMs(text) {
    const words = String(text).trim().split(/\s+/).filter(Boolean).length;
    return Math.max(250, words * 360);
}

class StreamingSpeaker {

    /**
     * Pipeline TTS percakapan yang diperkeras untuk jawaban PANJANG.
     *
     * Tiga loop berjalan bersamaan di dalam satu speak():
     *  - producer: token -> MicroChunker -> antrean teks pending. TIDAK
     *    pernah diblokir backpressure; bila pending melewati
     *    maxPendingChunks, chunk pending tertua DIGABUNG (coalesce)
     *    sampai di bawah batas — teks tidak ada yang dibuang.
     *  - synthesizer: mengambil pending FIFO, mensintesis serial dengan
     *    timeout per chunk + retry terbatas. Berhenti mendahului bila
     *    audio siap-putar yang belum dimainkan melewati jendela jitter
     *    buffer maxBufferedAudioMs. Kegagalan satu chunk dicatat sebagai
     *    chunk error dan DILEWATI — giliran tidak pernah mati karenanya.
     *  - player: memutar ready FIFO; envelope lip-sync berasal dari audio
     *    aktual per chunk; mengukur celah antar-chunk (gap).
     *
     * @param {object} opts
     * @param {Function} opts.synthesize async (text) => {audio: Buffer, ms}
     * @param {Function} opts.play async (audio, {signal}) => void (selesai saat audio habis diputar)
     * @param {Function} [opts.stop] () => void — hentikan playback berjalan (barge-in)
     * @param {Function} [opts.onChunk] (chunkInfo) => void
     * @param {Function} [opts.onEvent] ({type, ...}) => void — peristiwa
     *        coalesce / synth-retry / synth-error untuk log & telemetri
     * @param {object} [opts.chunker] instance/factory chunker (default MicroChunker)
     * @param {object} [opts.chunkerOptions] opsi untuk MicroChunker bawaan
     * @param {number} [opts.maxPendingChunks=8] batas antrean teks pending
     * @param {number} [opts.coalesceMaxChars=260] target lunak gabungan coalesce
     * @param {number} [opts.synthMaxChars=600] ukuran maks satu request sintesis
     * @param {number} [opts.maxBufferedAudioMs=20000] jendela jitter buffer
     * @param {number} [opts.synthTimeoutMs=30000] timeout sintesis per chunk
     * @param {number} [opts.synthRetries=1] retry per chunk (bukan untuk timeout)
     */
    constructor({
        synthesize, play, stop = null, onChunk = null, onEvent = null,
        chunker = null, chunkerOptions = {},
        maxPendingChunks = 8, coalesceMaxChars = 260, synthMaxChars = 600,
        maxBufferedAudioMs = 20000, synthTimeoutMs = 30000, synthRetries = 1
    } = {}) {
        if (!synthesize || !play) throw new Error("StreamingSpeaker butuh synthesize + play");
        this._synthesize = synthesize;
        this._play = play;
        this._stop = stop;
        this.onChunk = onChunk;
        this.onEvent = onEvent;
        this._chunkerSpec = chunker;
        this._chunkerOptions = chunkerOptions;
        this.maxPendingChunks = maxPendingChunks;
        this.coalesceMaxChars = coalesceMaxChars;
        this.synthMaxChars = synthMaxChars;
        this._expandAboveChars = Math.max(40, Number(chunkerOptions.maxChars) || 120);
        this.maxBufferedAudioMs = maxBufferedAudioMs;
        this.synthTimeoutMs = synthTimeoutMs;
        this.synthRetries = synthRetries;
        this._interrupt = null;
    }

    _newChunker() {
        if (typeof this._chunkerSpec === "function") return this._chunkerSpec();
        if (this._chunkerSpec) return this._chunkerSpec;
        return new MicroChunker(this._chunkerOptions);
    }

    _emitEvent(ev) {
        if (this.onEvent) { try { this.onEvent(ev); } catch { /* abaikan */ } }
    }

    /** Potong pembicaraan sekarang (barge-in). */
    interrupt() {
        if (this._interrupt) this._interrupt();
        if (this._stop) { try { this._stop(); } catch { /* abaikan */ } }
    }

    _withTimeout(promise, ms) {
        if (!ms || !Number.isFinite(ms) || ms <= 0) return promise;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const err = new Error(`sintesis melewati timeout ${ms} ms`);
                err.code = "SYNTH_TIMEOUT";
                reject(err);
            }, ms);
            Promise.resolve(promise).then(
                v => { clearTimeout(timer); resolve(v); },
                e => { clearTimeout(timer); reject(e); }
            );
        });
    }

    /**
     * Ekspansi wadah coalesce kembali menjadi micro-chunk dengan
     * kebijakan MicroChunker yang sama (granularitas sintesis pulih
     * penuh setelah burst); potongan yang masih melewati
     * synthMaxChars (tidak terjadi pada MicroChunker bawaan,
     * maxChars 120) dipotong lagi oleh _splitForSynth sebagai
     * pengaman ukuran request.
     */
    _expandForSynth(text) {
        const chunker = new MicroChunker(this._chunkerOptions);
        const pieces = [...chunker.push(String(text)), ...chunker.flush()];
        const out = [];
        for (const piece of pieces.length ? pieces : [String(text)]) {
            if (piece.length > this.synthMaxChars) out.push(...this._splitForSynth(piece));
            else out.push(piece);
        }
        return out;
    }

    /**
     * Pecah teks panjang menjadi potongan <= synthMaxChars di batas
     * kata (kata tunggal yang lebih panjang dipotong keras). Pengaman
     * ukuran request untuk _expandForSynth.
     */
    _splitForSynth(text) {
        const cap = this.synthMaxChars;
        const pieces = [];
        let cur = "";
        for (const word of String(text).split(/\s+/)) {
            if (!word) continue;
            if (word.length > cap) {
                if (cur) { pieces.push(cur); cur = ""; }
                for (let i = 0; i < word.length; i += cap) pieces.push(word.slice(i, i + cap));
                continue;
            }
            if (cur && cur.length + 1 + word.length > cap) { pieces.push(cur); cur = word; }
            else cur = cur ? `${cur} ${word}` : word;
        }
        if (cur) pieces.push(cur);
        return pieces.length ? pieces : [String(text)];
    }

    /** Sintesis satu chunk dengan timeout + retry; TIDAK pernah melempar. */
    async _synthChunk(text, isInterrupted) {
        let lastError = null;
        let retries = 0;
        for (let attempt = 0; attempt <= this.synthRetries; attempt++) {
            if (isInterrupted()) return { text, error: "interrupted", retries };
            const s0 = Date.now();
            try {
                const out = await this._withTimeout(
                    Promise.resolve().then(() => this._synthesize(text)),
                    this.synthTimeoutMs
                );
                const audio = out.audio ?? out;
                let envelope = null;
                try { envelope = computeEnvelope(audio, { frameMs: 50 }); } catch { /* abaikan */ }
                return {
                    text, audio, synthMs: Date.now() - s0, retries,
                    envelope, durationMs: envelope ? envelope.durationMs : null
                };
            } catch (error) {
                lastError = error;
                const timedOut = error && error.code === "SYNTH_TIMEOUT";
                // Timeout berarti service kemungkinan wedged — retry hanya
                // menggandakan stall; error koneksi sesaat boleh dicoba
                // lagi sekali (menunggangi restart service oleh supervisor).
                if (timedOut || attempt >= this.synthRetries || isInterrupted()) break;
                retries++;
                this._emitEvent({ type: "synth-retry", text, error: error.message });
                await new Promise(r => setTimeout(r, 150));
            }
        }
        this._emitEvent({ type: "synth-error", text, error: lastError ? lastError.message : "sintesis gagal" });
        return { text, error: lastError ? lastError.message : "sintesis gagal", retries };
    }

    /**
     * Bicara dari aliran token teks (async iterable / iterable string).
     * @returns {Promise<{interrupted: boolean, firstAudioMs: number|null,
     *          textCompleteMs: number|null, totalMs: number, chunks: Array,
     *          stats: object}>}
     */
    async speak(tokenSource, { signal = null } = {}) {
        const t0 = Date.now();
        const now = () => Date.now() - t0;
        const chunker = this._newChunker();
        const chunks = [];
        const stats = {
            maxPendingDepth: 0, maxReadyDepth: 0, maxBufferedAudioMs: 0,
            maxGapMs: 0, coalescedChunks: 0, splitItems: 0, retries: 0, synthErrors: 0,
            playedChunks: 0, queueSamples: []
        };
        let textCompleteMs = null;
        let interrupted = false;
        let wakeInterrupt;
        const interruptPromise = new Promise(r => { wakeInterrupt = r; });

        // --- primitif tunggu bersama (banyak penunggu, satu notify) ---
        const waiters = new Set();
        const notify = () => { for (const r of [...waiters]) { waiters.delete(r); r(); } };
        const waitChange = () => new Promise(r => waiters.add(r));
        const waitOrInterrupt = () => Promise.race([waitChange(), interruptPromise]);

        this._interrupt = () => { interrupted = true; wakeInterrupt(); notify(); };
        if (signal) signal.addEventListener("abort", () => this.interrupt(), { once: true });

        const pending = [];   // teks belum disintesis (FIFO)
        const ready = [];     // audio siap putar / penanda error (FIFO)
        let bufferedAudioMs = 0;
        let producerDone = false;
        let synthDone = false;

        const sample = () => {
            stats.maxPendingDepth = Math.max(stats.maxPendingDepth, pending.length);
            stats.maxReadyDepth = Math.max(stats.maxReadyDepth, ready.length);
            stats.maxBufferedAudioMs = Math.max(stats.maxBufferedAudioMs, bufferedAudioMs);
            if (stats.queueSamples.length < 4000) {
                stats.queueSamples.push({ atMs: now(), pending: pending.length, ready: ready.length, bufferedAudioMs });
            }
        };

        // Backpressure: gabung chunk pending yang berurutan sampai
        // kedalaman <= maxPendingChunks — batas ini KETAT: penggabungan
        // selalu mungkin karena chunk gabungan hanyalah wadah teks.
        // Hanya teks yang BELUM disintesis yang boleh digabung; audio
        // yang sudah jadi tidak pernah dibuang/diubah; producer tidak
        // pernah diblokir. Pasangan yang digabung diutamakan yang
        // gabungannya <= coalesceMaxChars (target lunak prosodi);
        // bila tidak ada, pasangan tertua digabung apa adanya. Wadah
        // yang tumbuh besar TIDAK dikirim utuh ke service: synthesizer
        // memecahnya lagi menjadi MICRO-chunk dengan kebijakan
        // MicroChunker yang sama saat giliran sintesisnya tiba (lihat
        // _expandForSynth) — granularitas 1:1 pulih setelah burst,
        // ukuran request ke service tetap terbatas, tidak ada teks
        // hilang. (Pelajaran terukur §13: memecah wadah menjadi
        // potongan besar 600 kar membuat satu panggilan sintesis
        // berjalan 10-20 dtk dan player kelaparan — gap 4,4 dtk.
        // Potongan mikro mensintesis dalam 1-2 dtk sehingga buffer
        // selalu terisi di depan player.)
        const coalesce = () => {
            while (pending.length > this.maxPendingChunks && pending.length >= 2) {
                let idx = 0;
                for (let i = 0; i + 1 < pending.length; i++) {
                    if (pending[i].length + 1 + pending[i + 1].length <= this.coalesceMaxChars) { idx = i; break; }
                }
                const merged = `${pending[idx]} ${pending[idx + 1]}`;
                pending.splice(idx, 2, merged);
                stats.coalescedChunks++;
                this._emitEvent({ type: "coalesce", mergedChars: merged.length, pendingDepth: pending.length });
            }
        };

        const producer = (async () => {
            try {
                for await (const token of tokenSource) {
                    if (interrupted) break;
                    for (const c of chunker.push(token)) {
                        pending.push(c);
                        coalesce();
                        sample();
                        notify();
                    }
                }
            } catch { /* sumber token gagal → flush sisa */ }
            textCompleteMs = now();
            if (!interrupted) {
                const rest = chunker.flush();
                const restArr = Array.isArray(rest) ? rest : (rest ? [rest] : []);
                for (const c of restArr) {
                    pending.push(c);
                    coalesce();
                }
                sample();
                notify();
            }
            producerDone = true;
            notify();
        })();

        const synthesizer = (async () => {
            for (;;) {
                if (interrupted) break;
                if (!pending.length) {
                    if (producerDone) break;
                    await waitOrInterrupt();
                    continue;
                }
                if (bufferedAudioMs > this.maxBufferedAudioMs) {
                    // Jendela jitter penuh: berhenti mendahului sampai
                    // player mengonsumsi sebagian audio siap.
                    await waitOrInterrupt();
                    continue;
                }
                const text = pending.shift();
                sample();
                notify();
                // Wadah hasil coalesce boleh besar: pecah lagi
                // menjadi micro-chunk sebelum dikirim ke service.
                // Ambang ekspansi = langit-langit micro-chunk alami
                // (maxChars MicroChunker); chunk normal tidak pernah
                // melewatinya sehingga jalur non-burst tidak berubah.
                const pieces = text.length > this._expandAboveChars
                    ? this._expandForSynth(text) : [text];
                if (pieces.length > 1) stats.splitItems++;
                for (const piece of pieces) {
                    if (interrupted) break;
                    if (bufferedAudioMs > this.maxBufferedAudioMs) {
                        await waitOrInterrupt();
                        if (interrupted) break;
                    }
                    const item = await this._synthChunk(piece, () => interrupted);
                    if (interrupted) break;
                    item.readyMs = now();
                    stats.retries += item.retries || 0;
                    if (item.error) {
                        stats.synthErrors++;
                    } else {
                        item.bufferMs = item.durationMs ?? estimateDurationMs(item.text);
                        bufferedAudioMs += item.bufferMs;
                    }
                    ready.push(item);
                    sample();
                    notify();
                }
            }
            synthDone = true;
            notify();
        })();

        let firstAudioMs = null;
        let prevPlayEndMs = null;
        const player = (async () => {
            for (;;) {
                if (interrupted) break;
                if (!ready.length) {
                    if (synthDone && !pending.length) break;
                    await waitOrInterrupt();
                    continue;
                }
                const item = ready.shift();
                notify();
                if (item.error) {
                    chunks.push({ text: item.text, error: item.error });
                    continue;
                }
                const playStartMs = now();
                if (firstAudioMs === null) firstAudioMs = playStartMs;
                if (prevPlayEndMs !== null) {
                    const gap = playStartMs - prevPlayEndMs;
                    if (gap > stats.maxGapMs) stats.maxGapMs = gap;
                }
                const info = { ...item, playStartMs };
                chunks.push(info);
                stats.playedChunks++;
                if (this.onChunk) { try { this.onChunk(info); } catch { /* abaikan */ } }
                await Promise.race([
                    Promise.resolve().then(() => this._play(item.audio, { signal })).catch(() => {}),
                    interruptPromise
                ]);
                info.playEndMs = now();
                prevPlayEndMs = info.playEndMs;
                bufferedAudioMs = Math.max(0, bufferedAudioMs - (item.bufferMs ?? 0));
                sample();
                notify();
                if (interrupted) break;
            }
        })();

        // Keepalive: ketiga loop menunggu lewat promise polos; pada
        // host Node polos (tanpa handle lain) event loop bisa kosong
        // di tengah giliran dan proses keluar diam-diam (teramati
        // pada jalur Piper di harness §13). Interval ter-ref ini
        // menahan proses selama giliran berjalan; dibersihkan di
        // semua jalan keluar speak().
        const keepAlive = setInterval(() => {}, 1000);
        try {
            // Selesai normal: ketiga loop tuntas. Terinterupsi: beri
            // loop waktu wajar untuk berhenti, tetapi speak() TIDAK
            // boleh menggantung selamanya pada sumber token macet.
            await Promise.race([
                Promise.all([producer, synthesizer, player]),
                interruptPromise.then(() => Promise.race([
                    Promise.allSettled([producer, synthesizer, player]),
                    new Promise(r => setTimeout(r, 1000))
                ]))
            ]);
        } finally {
            clearInterval(keepAlive);
        }
        this._interrupt = null;
        return { interrupted, firstAudioMs, textCompleteMs, totalMs: now(), chunks, stats };
    }
}

// ------------------------------------------------------- barge-in monitor

class BargeInMonitor {

    /**
     * Awasi aliran mic SELAMA playback. Ucapan user yang stabil
     * (requiredFrames frame keras berturut-turut di atas ambang
     * barge-in) memicu onSpeechStart. Latensi deteksi <=
     * requiredFrames * frameMs sejak energi mulai: default historis
     * 2 x 100 ms = ~200 ms; wiring percakapan kini memakai frameMs 50
     * -> ~100 ms (lihat VOICE-ID.md §13).
     * @param {object} opts { rmsThreshold=0.05, onSpeechStart,
     *        frameMs=100, requiredFrames=2 }
     */
    constructor({ rmsThreshold = 0.05, onSpeechStart = null, frameMs = 100, requiredFrames = 2 } = {}) {
        this.rmsThreshold = rmsThreshold;
        this.onSpeechStart = onSpeechStart;
        this.frameMs = frameMs;
        this.requiredFrames = requiredFrames;
        this.armed = false;
        this._loudRun = 0;
        this.triggeredAt = null;
        this._carry = Buffer.alloc(0);
    }

    arm() { this.armed = true; this._loudRun = 0; this.triggeredAt = null; this._carry = Buffer.alloc(0); return this; }
    disarm() { this.armed = false; return this; }

    feedPcm(chunk) {
        if (!this.armed || this.triggeredAt) return;
        const { frameRms } = require("../providers/vadSegmenter");
        // Pecah ke frame frameMs (16 kHz mono 16-bit = 32 byte/ms);
        // sisa byte di bawah satu frame dibawa ke panggilan berikutnya
        // agar deteksi tidak kehilangan energi di jahitan potongan.
        const frameBytes = 32 * this.frameMs;
        const buf = this._carry.length ? Buffer.concat([this._carry, chunk]) : chunk;
        let off = 0;
        while (off + frameBytes <= buf.length) {
            const rms = frameRms(buf.subarray(off, off + frameBytes));
            off += frameBytes;
            if (rms >= this.rmsThreshold) {
                this._loudRun += 1;
                if (this._loudRun >= this.requiredFrames) {
                    this.triggeredAt = Date.now();
                    if (this.onSpeechStart) { try { this.onSpeechStart({ at: this.triggeredAt }); } catch { /* abaikan */ } }
                    this._carry = Buffer.alloc(0);
                    return;
                }
            } else {
                this._loudRun = 0;
            }
        }
        this._carry = Buffer.from(buf.subarray(off));
    }
}

module.exports = { SentenceChunker, MicroChunker, StreamingTranscriber, StreamingSpeaker, BargeInMonitor, estimateDurationMs };
