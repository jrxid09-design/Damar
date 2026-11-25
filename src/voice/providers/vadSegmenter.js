"use strict";

/**
 * VadSegmenter — pemotong segmen ucapan berbasis energi (VAD) untuk PCM
 * 16 kHz mono s16le. Murni & sinkron: feedPcm() mengembalikan segmen yang
 * selesai pada potongan itu. Dipakai bersama oleh wake-word spotter
 * (wakeWordWhisper) dan transcriber streaming (local/streaming).
 *
 * Endpointing rapat: segmen ditutup setelah `silenceMs` hening
 * (default 400 ms — syarat latensi owner; bisa diatur). Pre-roll 300 ms
 * disertakan agar awal kata tidak terpotong.
 */

const SAMPLE_RATE = 16000;
const FRAME_MS = 100;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
const FRAME_BYTES = FRAME_SAMPLES * 2;

function frameRms(frame) {
    let sum = 0;
    const n = Math.floor(frame.length / 2);
    for (let i = 0; i < n; i++) {
        const v = frame.readInt16LE(i * 2) / 32768;
        sum += v * v;
    }
    return n ? Math.sqrt(sum / n) : 0;
}

function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8, "latin1");
    header.write("fmt ", 12, "latin1");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "latin1");
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

class VadSegmenter {

    constructor({
        rmsThreshold = 0.015, silenceMs = 400, minSpeechMs = 300,
        maxSegmentMs = 15000, preRollMs = 300
    } = {}) {
        this.rmsThreshold = rmsThreshold;
        this.silenceFrames = Math.max(1, Math.round(silenceMs / FRAME_MS));
        this.minSpeechFrames = Math.max(1, Math.round(minSpeechMs / FRAME_MS));
        this.maxSegmentFrames = Math.max(2, Math.round(maxSegmentMs / FRAME_MS));
        this.preRollFrames = Math.max(0, Math.round(preRollMs / FRAME_MS));
        this.silenceMs = silenceMs;
        this._pending = Buffer.alloc(0);
        this._preRoll = [];
        this._segment = null;
    }

    /** @returns {Array<{pcm: Buffer, speechMs: number, durationMs: number}>} segmen selesai */
    feedPcm(chunk) {
        const done = [];
        if (!chunk || chunk.length === 0) return done;
        this._pending = this._pending.length ? Buffer.concat([this._pending, chunk]) : Buffer.from(chunk);
        while (this._pending.length >= FRAME_BYTES) {
            const frame = this._pending.subarray(0, FRAME_BYTES);
            this._pending = this._pending.subarray(FRAME_BYTES);
            const seg = this._feedFrame(frame);
            if (seg) done.push(seg);
        }
        return done;
    }

    _feedFrame(frame) {
        const loud = frameRms(frame) >= this.rmsThreshold;
        if (!this._segment) {
            if (loud) {
                this._segment = { frames: [...this._preRoll, frame], speechFrames: 1, silenceRun: 0 };
                this._preRoll = [];
            } else {
                this._preRoll.push(frame);
                if (this._preRoll.length > this.preRollFrames) this._preRoll.shift();
            }
            return null;
        }
        this._segment.frames.push(frame);
        if (loud) {
            this._segment.speechFrames += 1;
            this._segment.silenceRun = 0;
        } else {
            this._segment.silenceRun += 1;
        }
        const tooLong = this._segment.frames.length >= this.maxSegmentFrames;
        const ended = this._segment.silenceRun >= this.silenceFrames;
        if (tooLong || ended) {
            const seg = this._segment;
            this._segment = null;
            this._preRoll = [];
            if (seg.speechFrames >= this.minSpeechFrames) {
                return {
                    pcm: Buffer.concat(seg.frames),
                    speechMs: seg.speechFrames * FRAME_MS,
                    durationMs: seg.frames.length * FRAME_MS
                };
            }
        }
        return null;
    }

    /** Segmen yang sedang berjalan (untuk transkripsi parsial streaming). */
    currentSegmentPcm() {
        if (!this._segment || this._segment.speechFrames < this.minSpeechFrames) return null;
        return Buffer.concat(this._segment.frames);
    }

    /** Paksa tutup segmen berjalan. */
    flush() {
        if (!this._segment) return [];
        const seg = this._segment;
        this._segment = null;
        this._preRoll = [];
        if (seg.speechFrames < this.minSpeechFrames) return [];
        return [{
            pcm: Buffer.concat(seg.frames),
            speechMs: seg.speechFrames * FRAME_MS,
            durationMs: seg.frames.length * FRAME_MS
        }];
    }
}

module.exports = { VadSegmenter, frameRms, pcmToWav, SAMPLE_RATE, FRAME_MS, FRAME_BYTES };
