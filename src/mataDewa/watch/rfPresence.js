"use strict";

/**
 * RF presence → hazard evaluator (Phase B, honest).
 *
 * HUKUM KLAIM:
 *  - RF presence estimate TIDAK pernah menjadi klaim identitas/pose/
 *    vital. Evaluator hanya menaikkan severity bila observasi RF
 *    presence/motion INFERRED yang GEO-terletak (sensor punya lokasi
 *    terdaftar) berada dalam ring kebijakan aset.
 *  - Observasi tanpa lokasi sensor TIDAK bisa dikaitkan ke aset → tidak
 *    memicu apa pun (fail closed).
 *  - Confidence rendah / stale → severity tidak dinaikkan.
 *  - Ring kebijakan per-aset tetap sumber kebenaran radius (bukan angka
 *    universal).
 *
 * MD-015/016/017 (FOURTH REPAIR) — STRICT PRODUCTION WATCH GATE:
 *  - TRUSTED LIVE != AUTHORITY, CALIBRATED STRING != VALID CALIBRATION.
 *  - Escalasi produksi (warning/critical) menuntut SEMUA bukti POSITIF:
 *      1. provenance trusted-live kanonik (verifier komposisi — BUKAN
 *         field caller, BUKAN string lineage, BUKAN bentuk objek);
 *      2. calibrationState === CALIBRATED (persyaratan positif — ABSEN
 *         berarti reject; bukan "kalau ada dan bukan calibrated");
 *      3. generation sah (safe integer > 0) dan SAMA dengan metadata
 *         internal trust;
 *      4. sensorId SAMA dengan metadata internal;
 *      5. captureSession SAMA dengan metadata internal;
 *      6. sourceKind SAMA dengan metadata internal;
 *      7. channel/config SAMA bila diketahui;
 *      8. kalibrasi segar pada saat evaluasi (now <= expiresAt dari
 *         metadata internal — bukan field caller);
 *      9. observasi segar (dalam jendela watch);
 *     10. kualitas kalibrasi acceptable (sampleCount/baseline/noise dari
 *         metadata internal).
 *  - Metadata trust HIDUP di WeakMap domain kanonik (Repair 3): watch
 *    membandingkan metadata yang DIDEKLARASI observasi dengan metadata
 *    INTERNAL verifier — mismatch/NaN/Infinity/absen → FAIL CLOSED.
 *  - Tanpa verifikator (engine test/evaluasi terisolasi) → tidak ada
 *    escalasi produksi sama sekali (fail closed).
 *  - REPLAY/SIMULASI TIDAK PERNAH alert produksi; hasil replay eksplisit
 *    { simulation: true, productionAlert: false, sourceMode: "REPLAY" }
 *    dengan severity dibatasi WATCH (Repair 5, dipertahankan).
 */

const { haversineMeters, isFiniteNumber } = require("../spatial/geo");
const { SEVERITY } = require("../events/event");
const { EPISTEMIC_STATUS } = require("../spatial/epistemic");
const { rfSourceModeOf } = require("../rf/rfTrust");
const { CALIBRATION_STATE } = require("../rf/calibration");

const HAZARD_TYPE = Object.freeze({
    RF_PRESENCE: "rf_presence"
});

/**
 * Verdict produksi untuk SATU observasi (MD-016: persyaratan positif penuh).
 * Mengembalikan metadata trust internal bila SEMUA bukti sah, atau null.
 * Setiap langkah fail-closed: absen/malformed/stale/mismatch/NaN/Infinity
 * → null (observasi tetap boleh terlihat sebagai watch coarse).
 */
function productionLiveVerdict(obs, verifyTrustedLive, nowMs, windowMs) {
    if (typeof verifyTrustedLive !== "function") return null;
    const trusted = verifyTrustedLive(obs);
    if (!trusted || typeof trusted !== "object") return null;

    // (1) provenance sudah diverifikasi verifier (WeakMap identitas objek).
    // (3) generation sah.
    if (!Number.isSafeInteger(trusted.calibrationGeneration) || trusted.calibrationGeneration <= 0) return null;
    // (8) freshness kalibrasi dari metadata INTERNAL.
    if (!isFiniteNumber(trusted.calibrationValidatedAtMs) || trusted.calibrationValidatedAtMs < 0) return null;
    if (!isFiniteNumber(trusted.calibrationTtlMs) || trusted.calibrationTtlMs <= 0) return null;
    const expiresAt = trusted.calibrationValidatedAtMs + trusted.calibrationTtlMs;
    if (!isFiniteNumber(expiresAt) || nowMs > expiresAt) return null;
    // (10) kualitas kalibrasi dari metadata INTERNAL.
    const q = trusted.calibrationQuality;
    if (!q || typeof q !== "object") return null;
    if (!Number.isSafeInteger(q.sampleCount) || q.sampleCount <= 0) return null;
    if (!isFiniteNumber(q.baselineMetric) || q.baselineMetric < 0) return null;
    if (!isFiniteNumber(q.noiseMetric) || q.noiseMetric < 0) return null;

    // Perbandingan metadata DIDEKLARASI vs INTERNAL (Repair 3).
    // (2) calibrationState positif: bukan "kalau ada", TAPI wajib === CALIBRATED.
    if (obs.attributes?.calibrationState !== CALIBRATION_STATE.CALIBRATED) return null;
    // (3) generation cocok.
    if (obs.attributes?.calibrationGeneration !== trusted.calibrationGeneration) return null;
    // (4)(5)(6) binding sensor/sesi/sumber cocok.
    if (obs.attributes?.sensorId !== trusted.sensorId) return null;
    if (obs.attributes?.captureSession !== trusted.captureSession) return null;
    if (obs.attributes?.sourceKind !== trusted.sourceKind) return null;
    // (7) channel/config cocok bila diketahui.
    const declaredChannel = obs.attributes?.channel ?? null;
    if ((trusted.channel ?? null) !== (declaredChannel ?? null)) return null;
    // (9) observasi segar.
    if (!isFiniteNumber(obs.observedAt) || obs.observedAt < nowMs - windowMs) return null;

    return trusted;
}

/**
 * @param {object} asset aset dengan watchPolicy.rings
 * @param {Array<object>} rfObservations observasi rf.presence_estimate /
 *        rf.motion_estimate yang BERLOKASI (sensor location)
 * @param {{ nowMs?: number, windowMs?: number, verifyTrustedLive?: Function }} opts
 * @returns {object|null} evaluation { riskState, ring, severity, evidence, ... }
 */
function evaluateRfPresenceRisk(asset, rfObservations, { nowMs = Date.now(), windowMs = 30 * 1000, verifyTrustedLive = null } = {}) {
    if (!asset?.geometry || asset.geometry.type !== "point") return null;
    if (!Array.isArray(rfObservations) || rfObservations.length === 0) return null;

    const policyRings = asset.watchPolicy?.rings ?? [];
    const criticalRing = policyRings.find(r => r.name === "critical");
    const warningRing = policyRings.find(r => r.name === "warning");
    const watchRing = policyRings.find(r => r.name === "watch");
    const maxRadiusM = policyRings.length ? policyRings[0].radiusM : 40000;

    const windowStart = nowMs - windowMs;
    const inWindow = [];
    for (const obs of rfObservations) {
        // Hanya estimasi RF yang jujur (epistemic INFERRED + geo-located).
        if (obs.epistemic !== EPISTEMIC_STATUS.INFERRED) continue;
        // F: lat/lon 0 VALID — tidak boleh ditolak karena truthiness.
        if (!isFiniteNumber(obs.attributes?.sensorLat) || !isFiniteNumber(obs.attributes?.sensorLon)) continue;
        if (obs.attributes.sensorLat < -90 || obs.attributes.sensorLat > 90) continue;
        if (obs.attributes.sensorLon < -180 || obs.attributes.sensorLon > 180) continue;
        const sensorPoint = { lat: obs.attributes.sensorLat, lon: obs.attributes.sensorLon };
        const d = haversineMeters(asset.geometry, sensorPoint);
        if (!isFiniteNumber(d) || d > maxRadiusM) continue;
        // (9) observasi freshness.
        if (!isFiniteNumber(obs.observedAt) || obs.observedAt < windowStart) continue;
        // Presence true = sinyal; motion-only tanpa presence tidak dinaikkan.
        if (obs.type === "rf.presence_estimate" && obs.attributes?.presence !== true) continue;
        inWindow.push({ obs, distanceM: d });
    }
    if (inWindow.length === 0) return null;

    // MD-010/C3: REPLAY tidak pernah alert produksi normal (Repair 5).
    const replayInWindow = inWindow.filter(x => rfSourceModeOf(x.obs) === "REPLAY");
    if (replayInWindow.length > 0) {
        return {
            simulation: true,
            sourceMode: "REPLAY",
            productionAlert: false,
            riskState: "watch",
            ring: watchRing?.name ?? "watch",
            nearestSensorM: Math.round(replayInWindow[0].distanceM),
            presenceCount: replayInWindow.length,
            stale: false,
            epistemic: EPISTEMIC_STATUS.INFERRED,
            basis: "rf_presence_replay_simulation",
            severity: SEVERITY.WATCH,
            evidence: []
        };
    }

    const freshest = Math.max(...inWindow.map(x => x.obs.observedAt));
    const stale = nowMs - freshest > windowMs / 2;
    // Confidence rata-rata observasi dalam jendela.
    const meanConfidence = inWindow.reduce((s, x) => s + (x.obs.confidence ?? 0), 0) / inWindow.length;
    const nearest = inWindow.sort((a, b) => a.distanceM - b.distanceM)[0];

    let riskState = "watch";
    let ringName = watchRing?.name ?? "watch";
    const atOrBelow = (ring) => isFiniteNumber(ring?.radiusM) && nearest.distanceM <= ring.radiusM;
    if (atOrBelow(criticalRing)) { riskState = "critical"; ringName = criticalRing.name; }
    else if (atOrBelow(warningRing)) { riskState = "warning"; ringName = warningRing.name; }
    else if (atOrBelow(watchRing)) { riskState = "watch"; ringName = watchRing.name; }

    // Confidence < 0.5 atau stale → TIDAK pernah critical (jujur).
    if (meanConfidence < 0.5 || stale) {
        if (riskState === "critical") riskState = "warning";
        if (riskState === "warning") riskState = "watch";
    }
    if (stale) ringName = watchRing?.name ?? ringName;

    // MD-016 STRICT GATE: escalasi produksi (warning/critical) HANYA dari
    // observasi yang lulus SEMUA persyaratan positif (verdict penuh di
    // atas). Tanpa verifikator / tanpa trust / kalibrasi absen-atau-tak-
    // sah → dibatasi watch (coarse, eksperimental), TIDAK pernah produksi-
    // alert. Persyaratan POSITIF: absence IS rejection.
    const productionCapable = inWindow.some(x =>
        productionLiveVerdict(x.obs, verifyTrustedLive, nowMs, windowMs) !== null);
    if (!productionCapable && (riskState === "warning" || riskState === "critical")) {
        riskState = "watch";
        ringName = watchRing?.name ?? ringName;
    }

    const severityByRisk = { critical: SEVERITY.CRITICAL, warning: SEVERITY.WARNING, watch: SEVERITY.WATCH };

    return {
        riskState,
        ring: ringName,
        nearestSensorM: Math.round(nearest.distanceM),
        presenceCount: inWindow.length,
        stale,
        productionAlert: riskState === "warning" || riskState === "critical",
        epistemic: EPISTEMIC_STATUS.INFERRED,
        basis: "rf_presence_geo_ring",
        evidence: inWindow.slice(0, 10).map(x => ({
            observationId: x.obs.id,
            distanceM: Math.round(x.distanceM),
            observedAt: x.obs.observedAt,
            source: x.obs.source,
            confidence: x.obs.confidence
        })),
        severity: severityByRisk[riskState] ?? SEVERITY.WATCH
    };
}

module.exports = { evaluateRfPresenceRisk, HAZARD_TYPE, productionLiveVerdict };
