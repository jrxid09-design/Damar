"use strict";

/**
 * speechEnvelope — envelope amplitudo ucapan dari audio WAV PCM.
 *
 * Kontrak amplitudo yang dikonsumsi Presence renderer (damar-island.js)
 * adalah dua global halaman: `damarIsSpeaking` (boolean) dan `voiceAmp`
 * (angka 0..1, envelope halus yang menggerakkan mulut karakter lewat
 * setSpeechLevel). Modul ini menghitung envelope yang sama bentuknya dari
 * berkas WAV hasil TTS lokal: RMS per frame (default 50 ms), dinormalisasi
 * ke 0..1 terhadap persentil-95 energi, sehingga konsumen mana pun
 * (renderer, tes, server lokal) bisa menggerakkan lip-sync dari audio
 * sungguhan — bukan dari tebakan per suku kata.
 *
 * Murni & deterministik: tanpa I/O, tanpa dependency.
 */

/** Parse WAV PCM (8/16/24/32-bit int atau float32) menjadi sampel float -1..1. */
function parseWav(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer ?? []);
    if (buffer.length < 44) throw new Error("WAV terlalu pendek");
    if (buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WAVE") {
        throw new Error("bukan berkas WAV (RIFF/WAVE tidak ditemukan)");
    }

    let fmt = null;
    let data = null;
    let off = 12;
    while (off + 8 <= buffer.length) {
        const id = buffer.toString("latin1", off, off + 4);
        const size = buffer.readUInt32LE(off + 4);
        const body = off + 8;
        if (id === "fmt ") {
            fmt = {
                audioFormat: buffer.readUInt16LE(body),
                channels: buffer.readUInt16LE(body + 2),
                sampleRate: buffer.readUInt32LE(body + 4),
                bitsPerSample: buffer.readUInt16LE(body + 14)
            };
        } else if (id === "data") {
            data = buffer.subarray(body, Math.min(buffer.length, body + size));
        }
        off = body + size + (size % 2);
    }
    if (!fmt || !data) throw new Error("WAV tanpa chunk fmt/data");

    const { audioFormat, channels, sampleRate, bitsPerSample } = fmt;
    const bytesPerSample = Math.ceil(bitsPerSample / 8);
    const frameSize = bytesPerSample * channels;
    const frames = Math.floor(data.length / frameSize);
    const samples = new Float32Array(frames);

    for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let ch = 0; ch < channels; ch++) {
            const p = i * frameSize + ch * bytesPerSample;
            let v = 0;
            if (audioFormat === 3 && bitsPerSample === 32) {
                v = data.readFloatLE(p);
            } else if (bitsPerSample === 16) {
                v = data.readInt16LE(p) / 32768;
            } else if (bitsPerSample === 8) {
                v = (data[p] - 128) / 128;
            } else if (bitsPerSample === 24) {
                let x = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
                if (x & 0x800000) x -= 0x1000000;
                v = x / 8388608;
            } else if (bitsPerSample === 32) {
                v = data.readInt32LE(p) / 2147483648;
            } else {
                throw new Error(`kedalaman bit WAV tidak didukung: ${bitsPerSample}`);
            }
            acc += v;
        }
        samples[i] = acc / channels;
    }

    return { samples, sampleRate, channels, durationMs: (frames / sampleRate) * 1000 };
}

/** RMS satu potongan sampel. */
function rmsSamples(samples, from = 0, to = samples.length) {
    let sum = 0;
    const n = Math.max(0, to - from);
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    return n ? Math.sqrt(sum / n) : 0;
}

/**
 * Envelope amplitudo 0..1 per frame.
 *
 * Normalisasi: nilai RMS frame dibagi persentil-95 seluruh frame (agar satu
 * ledakan sesaat tidak mematikan seluruh envelope), lalu di-clamp 0..1.
 * Frame di bawah `floor` (relatif terhadap puncak) dianggap hening → 0,
 * supaya mulut karakter benar-benar menutup di jeda.
 *
 * @param {Buffer} wavBuffer audio WAV
 * @param {object} [opts] { frameMs = 50, floor = 0.03 }
 * @returns {{ frameMs: number, frames: number[], durationMs: number, sampleRate: number }}
 */
function computeEnvelope(wavBuffer, { frameMs = 50, floor = 0.03 } = {}) {
    const { samples, sampleRate, durationMs } = parseWav(wavBuffer);
    const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
    const count = Math.max(1, Math.ceil(samples.length / frameLen));
    const raw = new Array(count);
    for (let f = 0; f < count; f++) {
        raw[f] = rmsSamples(samples, f * frameLen, Math.min(samples.length, (f + 1) * frameLen));
    }
    const sorted = [...raw].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
    const scale = p95 > 1e-6 ? p95 : 1;
    const frames = raw.map(v => {
        const n = v / scale;
        if (n < floor) return 0;
        return Math.min(1, Number(n.toFixed(4)));
    });
    return { frameMs, frames, durationMs, sampleRate };
}

/** Bangun WAV PCM16 mono dari sampel float (untuk tes & perkakas). */
function encodeWavPcm16(samples, sampleRate = 16000) {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        data.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8, "latin1");
    header.write("fmt ", 12, "latin1");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);       // PCM
    header.writeUInt16LE(1, 22);       // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "latin1");
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

/** PCM16 mentah (tanpa header) dari buffer WAV — untuk jalur spotter. */
function wavToPcm16(wavBuffer) {
    const { samples, sampleRate } = parseWav(wavBuffer);
    const out = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
    }
    return { pcm: out, sampleRate };
}

module.exports = { parseWav, rmsSamples, computeEnvelope, encodeWavPcm16, wavToPcm16 };
