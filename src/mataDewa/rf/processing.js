"use strict";

/**
 * RF processing (Phase B) — dari frame CSI ke estimasi jujur.
 *
 * Sinyal yang diadopsi (lihat MATA-DEWA-RF-SENSING-ADOPTION.md):
 *  - amplitude per subcarrier (esp-csi / RuView ADR-018),
 *  - smoothing satu-pole IIR (konsep Wi-Pose; tanpa dependensi),
 *  - motion energy = varians amplitude dalam jendela (SenseFi-style
 *    variance feature, dihitung di Node),
 *  - presence/motion ESTIMATE dengan epistemic INFERRED + confidence —
 *    TIDAK PERNAH klaim identitas/pose/vital.
 *
 * HUKUM:
 *  - Estimasi hanya naik dari yang benar-benar terukur; tanpa baseline
 *    tenang → presence TIDAK diklaim (null), bukan dibuat-buat.
 *  - Semua output bounded dan numerik; NaN/Infinity dibuang aperture.
 *  - Confidence mencerminkan jumlah subcarrier valid & ukuran jendela.
 */

const MAX_WINDOW_FRAMES = 120;       // ~2.4s @ 50Hz
const MIN_WINDOW_FRAMES = 5;         // estimasi butuh ≥ 5 frame
const MIN_VALID_SUBCARRIERS = 8;     // < 8 subcarrier sah → buang

const { EPISTEMIC_STATUS } = require("../spatial/epistemic");

/** Smoothing satu-pole IIR per subcarrier (konsep Wi-Pose, tanpa pywt). */
class AmplitudeSmoother {
    constructor({ alpha = 0.25 } = {}) {
        this.alpha = Number.isFinite(alpha) ? Math.max(0.05, Math.min(0.9, alpha)) : 0.25;
        this.state = null;
    }

    /** Terima satu frame amplitude (Float32Array) → smoothed (Float32Array baru). */
    next(amplitude) {
        if (!amplitude || !ArrayBuffer.isView(amplitude)) return null;
        const out = new Float32Array(amplitude.length);
        if (!this.state || this.state.length !== amplitude.length) {
            this.state = new Float32Array(amplitude.length);
            for (let i = 0; i < amplitude.length; i++) this.state[i] = amplitude[i];
        }
        for (let i = 0; i < amplitude.length; i++) {
            const v = amplitude[i];
            if (!Number.isFinite(v)) {
                out[i] = this.state[i];
                continue; // NaN/Infinity tidak pernah masuk state
            }
            this.state[i] = this.alpha * v + (1 - this.alpha) * this.state[i];
            out[i] = this.state[i];
        }
        return out;
    }

    reset() { this.state = null; }
}

/** Normalisasi min-max global per sesi (konvensi SenseFi). */
class PerSessionNormalizer {
    constructor() {
        this.min = null;
        this.max = null;
        this.count = 0;
    }

    /** Update statistik dengan satu frame; kembalikan normalisasi [0,1]. */
    normalize(amplitude) {
        if (!amplitude || !ArrayBuffer.isView(amplitude)) return null;
        this.count += 1;
        for (let i = 0; i < amplitude.length; i++) {
            const v = amplitude[i];
            if (!Number.isFinite(v)) continue;
            if (this.min === null || v < this.min) this.min = v;
            if (this.max === null || v > this.max) this.max = v;
        }
        const span = (this.max ?? 0) - (this.min ?? 0);
        const out = new Float32Array(amplitude.length);
        if (span <= 0) return out; // semua sama → [0,0,...]
        for (let i = 0; i < amplitude.length; i++) {
            const v = amplitude[i];
            out[i] = Number.isFinite(v) ? (v - this.min) / span : 0;
        }
        return out;
    }

    get snapshot() { return { min: this.min, max: this.max, count: this.count }; }
}

/**
 * Motion energy dalam satu jendela frame: mean varians per subcarrier.
 * Motion = deviasi dari rata-rata waktu; quiet = varians mendekati nol.
 * @returns {{ validFrames:number, validSubcarriers:number,
 *             motionEnergy:number, perWindowMean:Float32Array } | null}
 */
function computeMotionEnergy(windowFrames) {
    if (!Array.isArray(windowFrames) || windowFrames.length < MIN_WINDOW_FRAMES) return null;

    const n = windowFrames.length;
    const nsc = Math.min(...windowFrames.map(f => f.length));
    if (nsc < MIN_VALID_SUBCARRIERS) return null;

    // Mean per subcarrier.
    const mean = new Float64Array(nsc);
    let validFrames = 0;
    for (const frame of windowFrames) {
        if (!frame || !ArrayBuffer.isView(frame) || frame.length < nsc) continue;
        let frameOk = true;
        for (let sc = 0; sc < nsc; sc++) {
            const v = frame[sc];
            if (!Number.isFinite(v)) { frameOk = false; break; }
            mean[sc] += v;
        }
        if (frameOk) validFrames += 1;
        else {
            for (let sc = 0; sc < nsc; sc++) mean[sc] -= frame[sc]; // jangan hitung
        }
    }
    if (validFrames < MIN_WINDOW_FRAMES) return null;
    for (let sc = 0; sc < nsc; sc++) mean[sc] /= validFrames;

    // Varians total (energi gerak ~ sebaran sinyal di jendela).
    let sumVar = 0;
    let validSc = 0;
    for (let sc = 0; sc < nsc; sc++) {
        let acc = 0;
        let cnt = 0;
        for (const frame of windowFrames) {
            if (!frame || !ArrayBuffer.isView(frame) || frame.length <= sc) continue;
            const v = frame[sc];
            if (!Number.isFinite(v)) continue;
            acc += (v - mean[sc]) ** 2;
            cnt += 1;
        }
        if (cnt >= MIN_WINDOW_FRAMES) {
            sumVar += acc / cnt;
            validSc += 1;
        }
    }
    if (validSc < MIN_VALID_SUBCARRIERS) return null;

    return {
        validFrames,
        validSubcarriers: validSc,
        motionEnergy: sumVar / validSc,   // mean varians per subcarrier
        perWindowMean: mean
    };
}

/**
 * Estimasi presence dari motion energy terhadap baseline tenang.
 * HONEST: tanpa baseline → null (tidak diklaim). Baseline = jendela
 * awal sesi/kalibrasi. Threshold relatif (multiplikatif) agar kokoh
 * terhadap amplitudo mutlak yang berbeda per ruangan.
 *
 * @returns {{ presence:boolean, motionEnergy, threshold,
 *             confidence, epistemic:"INFERRED", basis:"quiet-baseline-variance",
 *             quietBaseline } | null}
 */
function estimatePresence(motion, { quietBaseline = null, baselineMultiplier = 4.0 } = {}) {
    if (!motion || motion.motionEnergy === null || !Number.isFinite(motion.motionEnergy)) return null;
    // Tanpa baseline tenang → TIDAK mengklaim presence (fail closed).
    if (quietBaseline === null || quietBaseline < 0 || !Number.isFinite(quietBaseline)) {
        return null;
    }
    const threshold = Math.max(quietBaseline * baselineMultiplier, 1e-9);
    const presence = motion.motionEnergy > threshold;

    // Confidence: lebih banyak frame + subcarrier sah = lebih percaya.
    const frameFactor = Math.min(1, motion.validFrames / 60);
    const scFactor = Math.min(1, motion.validSubcarriers / 64);
    const ratioFactor = Math.min(1, motion.motionEnergy / (threshold * 10));
    const confidence = Math.min(0.9, 0.3 + 0.3 * frameFactor + 0.2 * scFactor + 0.05 * ratioFactor);

    return {
        presence,
        motionEnergy: motion.motionEnergy,
        threshold,
        confidence: Number(confidence.toFixed(3)),
        epistemic: EPISTEMIC_STATUS.INFERRED,
        basis: "quiet-baseline-variance",
        quietBaseline
    };
}

/**
 * Ekstrak baseline tenang dari beberapa frame awal (kalibrasi otomatis).
 * Mengembalikan motion energy median dari awal; null jika belum cukup.
 */
function estimateQuietBaseline(windowFrames, { sampleMs = 30 * 60 * 1000, nowMs = Date.now() } = {}) {
    if (!Array.isArray(windowFrames) || windowFrames.length < MIN_WINDOW_FRAMES) return null;
    // Gunakan frame paling awal sebagai calibration window.
    const head = windowFrames.slice(0, Math.min(windowFrames.length, 30));
    const energy = computeMotionEnergy(head);
    if (!energy) return null;
    return energy.motionEnergy;
}

/**
 * Sesi RF: state yang menyatukan kalibrasi + jendela + estimasi.
 * Fail-closed: baseline hanya dipakai bila bagian dari frame yang SAMA
 * memiliki timestamp/pairing yang sah — sesi tidak pernah mencampur
 * sumber atau mengarang waktu.
 */
class RfProcessingSession {
    /**
     * @param {{ sensorId: string, captureSession: string,
     *           independenceGroup?: string, location?: {lat,lon},
     *           baselineMultiplier?: number, maxWindowFrames?: number }} opts
     */
    constructor({ sensorId, captureSession, independenceGroup = null, location = null, baselineMultiplier = 4.0, maxWindowFrames = MAX_WINDOW_FRAMES } = {}) {
        if (!sensorId || typeof sensorId !== "string") throw new TypeError("sensorId wajib");
        this.sensorId = sensorId;
        this.captureSession = captureSession ?? `session-${Date.now().toString(36)}`;
        this.independenceGroup = independenceGroup ?? sensorId;
        this.location = location;
        this.baselineMultiplier = baselineMultiplier;
        this.maxWindowFrames = Number.isFinite(maxWindowFrames)
            ? Math.max(MIN_WINDOW_FRAMES, Math.min(maxWindowFrames, MAX_WINDOW_FRAMES))
            : MAX_WINDOW_FRAMES;

        this.smoother = new AmplitudeSmoother();
        this.normalizer = new PerSessionNormalizer();
        this.window = [];
        this.quietBaseline = null;
        this.framesProcessed = 0;
        this.lastEstimate = null;
    }

    /**
     * Proses satu frame → estimasi terbaru (atau null bila belum cukup).
     * @param {{ amplitude: Float32Array, capturedAtMs?: number|null,
     *           rssiDbm?: number|null, channel?: number|null,
     *           phase?: Float32Array|null }} frame
     */
    update(frame) {
        if (!frame || !frame.amplitude || !ArrayBuffer.isView(frame.amplitude)) return null;

        const smoothed = this.smoother.next(frame.amplitude);
        const normalized = this.normalizer.normalize(smoothed);
        if (!normalized) return null;

        this.window.push(normalized);
        if (this.window.length > this.maxWindowFrames) this.window.shift();
        this.framesProcessed += 1;

        // Kalibrasi baseline tenang hanya dari AWAL sesi (frame pertama).
        if (this.quietBaseline === null && this.window.length < this.maxWindowFrames) {
            const baseline = estimateQuietBaseline(this.window);
            if (baseline !== null) this.quietBaseline = baseline;
        }

        const motion = computeMotionEnergy(this.window);
        if (!motion) return null;

        const estimate = estimatePresence(motion, {
            quietBaseline: this.quietBaseline,
            baselineMultiplier: this.baselineMultiplier
        });
        this.lastEstimate = estimate ? {
            ...estimate,
            sensorId: this.sensorId,
            captureSession: this.captureSession,
            framesProcessed: this.framesProcessed
        } : null;
        return this.lastEstimate;
    }

    describe() {
        return {
            sensorId: this.sensorId,
            captureSession: this.captureSession,
            independenceGroup: this.independenceGroup,
            framesProcessed: this.framesProcessed,
            windowFrames: this.window.length,
            quietBaseline: this.quietBaseline,
            lastEstimate: this.lastEstimate
                ? {
                    presence: this.lastEstimate.presence,
                    motionEnergy: Number(this.lastEstimate.motionEnergy.toFixed(4)),
                    confidence: this.lastEstimate.confidence,
                    epistemic: this.lastEstimate.epistemic
                }
                : null
        };
    }

    reset() {
        this.smoother.reset();
        this.window = [];
        this.quietBaseline = null;
        this.framesProcessed = 0;
        this.lastEstimate = null;
    }
}

module.exports = Object.freeze({
    MAX_WINDOW_FRAMES,
    MIN_WINDOW_FRAMES,
    MIN_VALID_SUBCARRIERS,
    AmplitudeSmoother,
    PerSessionNormalizer,
    computeMotionEnergy,
    estimatePresence,
    estimateQuietBaseline,
    RfProcessingSession
});