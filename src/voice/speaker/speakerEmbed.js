"use strict";

/**
 * speakerEmbed — embedding pembicara lokal, offline, CPU-ringan.
 *
 * Pendekatan: fitur spektral gaya MFCC (pre-emphasis → jendela Hamming →
 * FFT → bank filter mel → log → DCT) + delta, diagregasi mean/std per
 * ucapan (52 dim), DITAMBAH 4 fitur prosodi (statistik log-F0 dari
 * autokorelasi + centroid spektral) = vektor 56-dim ternormalisasi-L2.
 * Kesamaan pembicara
 * = cosine similarity. Ini BUKAN model neural (ECAPA dsb. butuh runtime
 * ONNX + bobot besar); ini ekstraktor fitur deterministik tanpa dependency
 * yang cukup untuk MEMBEDAKAN suara sintesis/nyata yang berbeda jauh dan
 * untuk membuktikan mekanisme enroll→identifikasi→verifikasi. Batas
 * kejujuran: pembicara dengan warna suara mirip bisa berdekatan skornya —
 * ambang approval diset konservatif dan tier risiko tinggi tetap klik
 * (lihat voiceApproval.js). Bila nanti tersedia runtime ONNX, ekstraktor
 * ini bisa diganti model ECAPA-TDNN di balik antarmuka yang sama
 * (extractEmbedding(wav) → vektor unit).
 */

const { parseWav } = require("../providers/speechEnvelope");

const FRAME_LEN = 400;        // 25 ms @16k
const FRAME_HOP = 160;        // 10 ms @16k
const FFT_SIZE = 512;
const MEL_FILTERS = 26;
const MFCC_COUNT = 13;
const MIN_HZ = 50;
const MAX_HZ = 8000;

/** FFT radix-2 iteratif (real input → power spectrum setengah). */
function powerSpectrum(frame) {
    const n = FFT_SIZE;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < frame.length; i++) re[i] = frame[i];
    // bit-reversal
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cwr = 1, cwi = 0;
            for (let k = 0; k < len / 2; k++) {
                const ur = re[i + k], ui = im[i + k];
                const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
                const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
                re[i + k] = ur + vr; im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
                const nwr = cwr * wr - cwi * wi;
                cwi = cwr * wi + cwi * wr;
                cwr = nwr;
            }
        }
    }
    const out = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
}

const hzToMel = f => 2595 * Math.log10(1 + f / 700);
const melToHz = m => 700 * (Math.pow(10, m / 2595) - 1);

let _melBank = null;
function melBank(sampleRate) {
    if (_melBank && _melBank.sampleRate === sampleRate) return _melBank.filters;
    const maxHz = Math.min(MAX_HZ, sampleRate / 2);
    const melMin = hzToMel(MIN_HZ), melMax = hzToMel(maxHz);
    const points = [];
    for (let i = 0; i < MEL_FILTERS + 2; i++) {
        const hz = melToHz(melMin + ((melMax - melMin) * i) / (MEL_FILTERS + 1));
        points.push(Math.floor(((FFT_SIZE + 1) * hz) / sampleRate));
    }
    const filters = [];
    for (let f = 0; f < MEL_FILTERS; f++) {
        const filt = new Float64Array(FFT_SIZE / 2);
        const [a, b, c] = [points[f], points[f + 1], points[f + 2]];
        for (let k = a; k < b; k++) if (b > a) filt[k] = (k - a) / (b - a);
        for (let k = b; k < c; k++) if (c > b) filt[k] = (c - k) / (c - b);
        filters.push(filt);
    }
    _melBank = { sampleRate, filters };
    return filters;
}

/** MFCC per frame untuk seluruh ucapan (hanya frame "bersuara"). */
function mfccFrames(samples, sampleRate) {
    // Normalisasi gain (puncak) agar volume rekaman tidak jadi identitas.
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const gain = peak > 1e-4 ? 0.9 / peak : 1;

    const filters = melBank(sampleRate);
    const frames = [];
    const energies = [];
    for (let start = 0; start + FRAME_LEN <= samples.length; start += FRAME_HOP) {
        const frame = new Float64Array(FRAME_LEN);
        let e = 0;
        let prev = 0;
        for (let i = 0; i < FRAME_LEN; i++) {
            const s = samples[start + i] * gain;
            const pre = i === 0 ? s : s - 0.97 * prev;
            prev = s;
            const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1));
            frame[i] = pre * win;
            e += s * s;
        }
        energies.push(e);
        frames.push(frame);
    }
    if (frames.length === 0) return [];

    // Gerbang aktivitas suara: buang frame di bawah (maks − 40 dB).
    const maxE = Math.max(...energies);
    const gate = maxE * 1e-4;

    const out = [];
    for (let fi = 0; fi < frames.length; fi++) {
        if (energies[fi] < gate) continue;
        const spec = powerSpectrum(frames[fi]);
        const logMel = new Array(MEL_FILTERS);
        for (let f = 0; f < MEL_FILTERS; f++) {
            let sum = 0;
            const filt = filters[f];
            for (let k = 0; k < spec.length; k++) sum += spec[k] * filt[k];
            logMel[f] = Math.log(Math.max(sum, 1e-10));
        }
        const mfcc = new Array(MFCC_COUNT);
        for (let c = 0; c < MFCC_COUNT; c++) {
            let sum = 0;
            for (let f = 0; f < MEL_FILTERS; f++) {
                sum += logMel[f] * Math.cos((Math.PI * c * (f + 0.5)) / MEL_FILTERS);
            }
            mfcc[c] = sum;
        }
        out.push(mfcc);
    }
    return out;
}

/** Delta (regresi ±2 frame) untuk satu urutan fitur. */
function withDelta(frames) {
    return frames.map((f, t) => {
        const d = new Array(f.length);
        for (let c = 0; c < f.length; c++) {
            let num = 0, den = 0;
            for (let k = -2; k <= 2; k++) {
                const idx = Math.min(frames.length - 1, Math.max(0, t + k));
                num += k * frames[idx][c];
                den += k * k;
            }
            d[c] = den ? num / den : 0;
        }
        return [...f, ...d];
    });
}

/** F0 per frame via autokorelasi ternormalisasi (60–400 Hz) + centroid spektral. */
function prosodyFeatures(samples, sampleRate) {
    const minLag = Math.floor(sampleRate / 400);
    const maxLag = Math.ceil(sampleRate / 60);
    const logF0 = [];
    const centroids = [];
    for (let start = 0; start + FRAME_LEN <= samples.length; start += FRAME_HOP) {
        const frame = samples.subarray(start, start + FRAME_LEN);
        let energy = 0;
        for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
        if (energy / frame.length < 1e-4) continue; // gerbang bersuara kasar
        let bestLag = -1, bestCorr = 0.55;
        for (let lag = minLag; lag <= maxLag; lag++) {
            let num = 0, d1 = 0, d2 = 0;
            for (let i = 0; i + lag < frame.length; i++) {
                num += frame[i] * frame[i + lag];
                d1 += frame[i] * frame[i];
                d2 += frame[i + lag] * frame[i + lag];
            }
            const corr = num / (Math.sqrt(d1 * d2) || 1);
            if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
        }
        if (bestLag > 0) logF0.push(Math.log(sampleRate / bestLag));
        const spec = powerSpectrum(frame);
        let num = 0, den = 0;
        for (let k = 1; k < spec.length; k++) {
            const hz = (k * sampleRate) / FFT_SIZE;
            num += hz * spec[k]; den += spec[k];
        }
        if (den > 0) centroids.push(num / den);
    }
    const stat = arr => {
        if (!arr.length) return [0, 0];
        const m = arr.reduce((a, b) => a + b, 0) / arr.length;
        return [m, Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length)];
    };
    const [f0m, f0s] = stat(logF0);
    const [cm, cs] = stat(centroids);
    // Diskalakan agar sebanding pengaruhnya dengan blok MFCC: varian pitch
    // dari SATU suara TTS yang sama terbukti tak terpisahkan oleh MFCC saja
    // (matriks uji: pitch +35% tetap skor 0,99) — fitur prosodi inilah yang
    // memisahkannya.
    const GAIN = 1.5;
    return Float32Array.from([
        (f0m - 5.0) * 2 * GAIN, f0s * 4 * GAIN,
        (cm / 8000 - 0.25) * 4 * GAIN, (cs / 8000) * 4 * GAIN
    ]);
}

/**
 * Embedding pembicara dari WAV: vektor unit (52 MFCC + 4 prosodi = 56 dim).
 * Melempar error bila audio terlalu pendek / tanpa ucapan.
 */
function extractEmbedding(wavBuffer) {
    const { samples, sampleRate } = parseWav(wavBuffer);
    if (sampleRate !== 16000) {
        throw new Error(`embedding butuh WAV 16000 Hz (dapat ${sampleRate}) — resample dulu`);
    }
    const frames = withDelta(mfccFrames(samples, sampleRate));
    if (frames.length < 10) throw new Error("audio terlalu pendek / tanpa ucapan untuk embedding");
    const dim = frames[0].length;
    const mean = new Float64Array(dim);
    for (const f of frames) for (let i = 0; i < dim; i++) mean[i] += f[i] / frames.length;
    const std = new Float64Array(dim);
    for (const f of frames) for (let i = 0; i < dim; i++) std[i] += (f[i] - mean[i]) ** 2 / frames.length;
    for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i]);
    const mfccVec = new Float32Array(dim * 2);
    mfccVec.set(mean, 0);
    mfccVec.set(std, dim);
    let n0 = 0;
    for (let i = 0; i < mfccVec.length; i++) n0 += mfccVec[i] * mfccVec[i];
    n0 = Math.sqrt(n0) || 1;
    for (let i = 0; i < mfccVec.length; i++) mfccVec[i] /= n0;
    const extra = prosodyFeatures(samples, sampleRate);
    const vec = new Float32Array(mfccVec.length + extra.length);
    vec.set(mfccVec, 0);
    vec.set(extra, mfccVec.length);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
}

function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d ? dot / d : 0;
}

module.exports = { extractEmbedding, cosineSim, mfccFrames, EMBEDDING_DIM: MFCC_COUNT * 2 * 2 + 4 };
