"use strict";

/**
 * RF CALIBRATION LIFECYCLE (MD-014, Phase D).
 *
 * Model semantik konservatif — bukan klaim pemahaman ruangan:
 *   UNCALIBRATED          → belum ada baseline sah
 *   COLLECTING            → baseline sedang dikumpulkan; TIDAK ada inferensi kuat
 *   CALIBRATED            → baseline sah + kualitas dapat diterima
 *   STALE                 → baseline kedaluwarsa (TTL)
 *   NOISY                 → baseline ada tapi noise berlebih
 *   INVALID               → baseline rusak/non-finite/nol sampel
 *   RECALIBRATION_REQUIRED→ binding berubah (sensor/sesi/sumber/channel)
 *                           atau validitas ditarik secara eksplisit
 *
 * HUKUM:
 *  - NO VALID BASELINE → TIDAK ADA inferensi gerak/presence produksi.
 *    Preferensi: null/unavailable, BUKAN confidence yang direkayasa.
 *  - Binding kalibrasi: sensorId + captureSession + sourceKind
 *    (+ channel/config bila diketahui) + generation. Perubahan binding
 *    mana pun → baseline TIDAK dibawa (recalibration wajib).
 *  - Replay TIDAK PERNAH mengkalibrasi live UDP; live TIDAK PERNAH
 *    membawa kalibrasi ke replay (pemisahan sourceKind di binding).
 *  - Metrik kualitas: finite, bounded, dijaga; NaN/Infinity/nol-sampel/
 *    noise berlebih DITOLAK (reject, bukan clamp).
 *  - Raw frame/buffer kalibrasi TIDAK pernah keluar dari sini —
 *    konsumen hanya melihat metadata bounded (state/generation/quality).
 */

const { CanonError } = require("../spatial/strictSchemas");

const CALIBRATION_STATE = Object.freeze({
    UNCALIBRATED: "uncalibrated",
    COLLECTING: "collecting",
    CALIBRATED: "calibrated",
    STALE: "stale",
    NOISY: "noisy",
    INVALID: "invalid",
    RECALIBRATION_REQUIRED: "recalibration_required"
});

const CALIBRATION_LIMITS = Object.freeze({
    MIN_BASELINE_SAMPLES: 5,           // mirror MIN_WINDOW_FRAMES
    MAX_BASELINE_SAMPLES: 4096,
    /**
     * Coefficient of variation maksimum baseline tenang. Baseline tenang
     * adalah sinyal STABIL: CV (stddev/mean) di atas ini berarti noise
     * berlebih → NOISY (reject). CV fisik terukur dan dapat dicapai —
     * bukan rasio dead-code yang tidak pernah terpicu.
     */
    MAX_BASELINE_CV: 1.0,
    /** Default TTL baseline sebelum STALE. */
    DEFAULT_TTL_MS: 30 * 60 * 1000
});

/**
 * Binding identitas kalibrasi. Dua binding berbeda → dua kalibrasi berbeda.
 * HANYA field data-of-origin bounded; tidak ada string bebas otoritatif.
 */
function calibrationBindingKey({ sensorId, captureSession, sourceKind, channel = null } = {}) {
    const parts = [
        String(sensorId ?? "").slice(0, 128),
        String(captureSession ?? "").slice(0, 128),
        String(sourceKind ?? "").slice(0, 32),
        channel === null || channel === undefined || !Number.isFinite(Number(channel))
            ? "ch-none" : `ch-${Number(channel)}`
    ];
    return parts.join("|");
}

/** Metrik kualitas KETAT: finite, non-negatif, bounded. Reject bukan clamp. */
function strictQualityNumber(value, field, { max = Number.MAX_SAFE_INTEGER } = {}) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CanonError(`kalibrasi.${field} wajib number finite (dapat: ${String(value)})`);
    }
    if (value < 0) {
        throw new CanonError(`kalibrasi.${field} negatif ditolak: ${value}`);
    }
    if (value > max) {
        throw new CanonError(`kalibrasi.${field} melebihi batas ${max}: ${value}`);
    }
    return value;
}

/**
 * Ringkasan kualitas kalibrasi (dibekukan; tanpa raw buffer).
 * sampleCount 0 → INVALID (tidak ada bukti → tidak ada klaim).
 * noiseMetric = coefficient of variation (stddev/mean) sampel baseline:
 * fisik terukur, dapat dicapai, dan langsung bermakna "seberapa stabil
 * sinyal tenang ini". CV > MAX_BASELINE_CV → NOISY (REJECT, bukan clamp).
 */
function buildCalibrationQuality({ sampleCount, baselineMetric, noiseMetric, createdAtMs, lastValidatedAtMs, ttlMs }) {
    const count = strictQualityNumber(sampleCount, "sampleCount", { max: CALIBRATION_LIMITS.MAX_BASELINE_SAMPLES });
    if (count < CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES) {
        throw new CanonError(
            `kalibrasi.sampleCount ${count} < minimum ${CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES} — tidak ada baseline sah`);
    }
    const baseline = strictQualityNumber(baselineMetric, "baselineMetric");
    const noise = strictQualityNumber(noiseMetric, "noiseMetric", { max: 1e9 });
    const created = strictQualityNumber(createdAtMs, "createdAtMs");
    const validated = strictQualityNumber(lastValidatedAtMs, "lastValidatedAtMs");
    if (validated < created) {
        throw new CanonError("kalibrasi.lastValidatedAtMs < createdAtMs — ditolak");
    }
    const ttl = strictQualityNumber(ttlMs, "ttlMs", { max: 24 * 60 * 60 * 1000 });
    if (noise > CALIBRATION_LIMITS.MAX_BASELINE_CV) {
        throw new CanonError(
            `kalibrasi coefficient-of-variation ${noise} > ${CALIBRATION_LIMITS.MAX_BASELINE_CV} — baseline tenang tidak stabil — REJECT (NOISY)`);
    }
    return Object.freeze({
        sampleCount: count,
        baselineMetric: baseline,
        noiseMetric: noise,
        createdAtMs: created,
        lastValidatedAtMs: validated,
        ttlMs: ttl
    });
}

/**
 * Sesi kalibrasi per (sensor, captureSession, sourceKind, channel).
 * Berpindah binding → instance baru; baseline TIDAK PERNAH menyeberang.
 */
class RfCalibration {
    /**
     * @param {{
     *   sensorId: string, captureSession: string, sourceKind: string,
     *   channel?: number|null, clock?: { nowMs(): number },
     *   ttlMs?: number, baselineHeadSamples?: number
     * }} opts
     */
    constructor({ sensorId, captureSession, sourceKind, channel = null, clock = { nowMs: () => Date.now() }, ttlMs = CALIBRATION_LIMITS.DEFAULT_TTL_MS, baselineHeadSamples = 30 } = {}) {
        if (!sensorId || typeof sensorId !== "string") throw new TypeError("kalibrasi butuh sensorId");
        if (!captureSession || typeof captureSession !== "string") throw new TypeError("kalibrasi butuh captureSession");
        if (!sourceKind || typeof sourceKind !== "string") throw new TypeError("kalibrasi butuh sourceKind");
        this.binding = calibrationBindingKey({ sensorId, captureSession, sourceKind, channel });
        this.generation = 1;
        this.clock = clock && typeof clock.nowMs === "function" ? clock : { nowMs: () => Date.now() };
        this.ttlMs = ttlMs;
        this.baselineHeadSamples = Math.max(CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES, Math.min(baselineHeadSamples, 240));

        /** @type {Array<number>} energi frame awal (bounded head window) */
        this._frameEnergies = [];
        /** @type {object|null} quality beku bila CALIBRATED */
        this._quality = null;
        this._state = CALIBRATION_STATE.UNCALIBRATED;
    }

    get state() { return this._state; }

    /**
     * Catat satu pengukuran energi frame untuk calibrasi (masuk COLLECTING).
     * @param {number} motionEnergy hasil computeMotionEnergy (finite) atau null
     * @returns {object} metadata state terkini (bounded)
     */
    recordFrameEnergy(motionEnergy) {
        if (this._state === CALIBRATION_STATE.INVALID ||
            this._state === CALIBRATION_STATE.RECALIBRATION_REQUIRED) {
            // baseline ditolak/ditarik → jangan dianggap sah kembali diam-diam
            return this.describe();
        }
        if (motionEnergy !== null && motionEnergy !== undefined) {
            if (typeof motionEnergy !== "number" || !Number.isFinite(motionEnergy) || motionEnergy < 0) {
                // sampel rusak → kalibrasi jadi INVALID (reject, bukan abaikan)
                this._state = CALIBRATION_STATE.INVALID;
                this._frameEnergies = [];
                return this.describe();
            }
            this._frameEnergies.push(motionEnergy);
            if (this._frameEnergies.length > this.baselineHeadSamples) {
                this._frameEnergies.shift();
            }
        }
        this._state = this._frameEnergies.length >= CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES
            ? this._state === CALIBRATION_STATE.CALIBRATED
                ? CALIBRATION_STATE.CALIBRATED
                : CALIBRATION_STATE.COLLECTING
            : CALIBRATION_STATE.COLLECTING;
        return this.describe();
    }

    /**
     * Finalisasi baseline dari sampel terkumpul (median → robust).
     * noiseMetric = coefficient of variation (stddev/mean) sampel head —
     * stabil rendah, berisik tinggi; REJECT bila CV melebihi batas.
     * Gagal kualitas → NOISY/INVALID (baseline tidak dipakai).
     * @returns {object} metadata state terkini
     */
    finalizeBaseline() {
        if (this._frameEnergies.length < CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES) {
            this._state = CALIBRATION_STATE.UNCALIBRATED;
            return this.describe();
        }
        const sorted = [...this._frameEnergies].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const baselineMetric = sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
        // Coefficient of variation dari sampel MENTAH (internal only —
        // raw samples tidak pernah keluar dari modul ini).
        const mean = this._frameEnergies.reduce((s, v) => s + v, 0) / this._frameEnergies.length;
        const variance = this._frameEnergies.reduce((s, v) => s + (v - mean) ** 2, 0) / this._frameEnergies.length;
        const noiseMetric = mean > 0 ? Math.sqrt(variance) / mean : Infinity;
        const nowMs = this.clock.nowMs();
        try {
            this._quality = buildCalibrationQuality({
                sampleCount: this._frameEnergies.length,
                baselineMetric,
                noiseMetric,
                createdAtMs: nowMs,
                lastValidatedAtMs: nowMs,
                ttlMs: this.ttlMs
            });
            this._state = CALIBRATION_STATE.CALIBRATED;
        }
        catch (error) {
            this._quality = null;
            this._state = /coefficient-of-variation/i.test(error.message)
                ? CALIBRATION_STATE.NOISY
                : CALIBRATION_STATE.INVALID;
        }
        return this.describe();
    }

    /**
     * Metadata kalibrasi untuk observasi (TANPA raw buffer). Ketika state
     * bukan CALIBRATED valid → quality null (tidak ada angka direkayasa).
     */
    observationMetadata() {
        const meta = {
            calibrationState: this.effectiveState(),
            calibrationGeneration: this.generation,
            calibrationQuality: null
        };
        if (this.effectiveState() === CALIBRATION_STATE.CALIBRATED && this._quality) {
            meta.calibrationQuality = this._quality;
        }
        return Object.freeze(meta);
    }

    /** Apakah baseline ini layak dipakai untuk inferensi produksi? */
    isUsableForProductionInference({ nowMs = null } = {}) {
        if (this.effectiveState(nowMs) !== CALIBRATION_STATE.CALIBRATED) return false;
        return this._quality !== null;
    }

    /** State efektif: TTL diperhitungkan terhadap lastValidatedAtMs. */
    effectiveState(nowMs = null) {
        if (this._state !== CALIBRATION_STATE.CALIBRATED) return this._state;
        const t = nowMs ?? this.clock.nowMs();
        if (this._quality && t - this._quality.lastValidatedAtMs > this._quality.ttlMs) {
            return CALIBRATION_STATE.STALE;
        }
        return this._state;
    }

    /**
     * Binding berubah (sensor/sesi/koneksi/channel/sumber) → generation baru,
     * sampel dibuang, RECALIBRATION_REQUIRED. Replay↔live TIDAK PERNAH carry.
     */
    invalidate({ reason = "binding_changed" } = {}) {
        this._frameEnergies = [];
        this._quality = null;
        this._state = reason === "ttl"
            ? CALIBRATION_STATE.STALE
            : CALIBRATION_STATE.RECALIBRATION_REQUIRED;
        this.generation += 1;
        return this.describe();
    }

    /** Metadata bounded untuk status/observasi. */
    describe() {
        return Object.freeze({
            binding: this.binding,
            state: this.effectiveState(),
            generation: this.generation,
            sampleCount: this._frameEnergies.length,
            quality: this._quality
        });
    }

    /**
     * Deklarasi kalibrasi untuk binding live-trust (MD-015/016/017).
     * Hanya CALIBRATED sah yang mengembalikan deklarasi (null selain itu)
     * — COLLECTING/STALE/NOISY/INVALID/RECALIBRATION_REQUIRED TIDAK pernah
     * membentuk bukti live. Semua field sudah strict (finite, bounded)
     * dari buildCalibrationQuality; pemanggil (RfManager kanonik) memakai
     * ini sebagai calibration-portion dari binding trusted.
     */
    trustedDeclaration() {
        if (this._state !== CALIBRATION_STATE.CALIBRATED || !this._quality) {
            return null;
        }
        return Object.freeze({
            state: CALIBRATION_STATE.CALIBRATED,
            generation: this.generation,
            validatedAtMs: this._quality.lastValidatedAtMs,
            ttlMs: this._quality.ttlMs,
            quality: Object.freeze({
                sampleCount: this._quality.sampleCount,
                baselineMetric: this._quality.baselineMetric,
                noiseMetric: this._quality.noiseMetric
            })
        });
    }
}

module.exports = Object.freeze({
    CALIBRATION_STATE,
    CALIBRATION_LIMITS,
    calibrationBindingKey,
    buildCalibrationQuality,
    RfCalibration
});
