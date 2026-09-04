"use strict";

/**
 * RF presence → hazard evaluator (Phase B, honest).
 *
 * HUKUM KLaim:
 *  - RF presence estimate TIDAK pernah menjadi klaim identitas/pose/
 *    vital. Evaluator hanya menaikkan severity bila observasi RF
 *    presence/motion INFERRED yang GEO-terletak (sensor punya lokasi
 *    terdaftar) berada dalam ring kebijakan aset.
 *  - Observasi tanpa lokasi sensor TIDAK bisa dikaitkan ke aset → tidak
 *    memicu apa pun (fail closed).
 *  - Confidence rendah / stale → severity tidak dinaikkan.
 *  - Ring kebijakan per-aset tetap sumber kebenaran radius (bukan angka
 *    universal).
 */

const { haversineMeters, isFiniteNumber } = require("../spatial/geo");
const { SEVERITY } = require("../events/event");
const { EPISTEMIC_STATUS } = require("../spatial/epistemic");
const { isTrustedLiveRfObservation, rfSourceModeOf } = require("../rf/rfTrust");
const { CALIBRATION_STATE } = require("../rf/calibration");

const HAZARD_TYPE = Object.freeze({
    RF_PRESENCE: "rf_presence"
});

/** State kalibrasi yang dianggap cukup matang untuk escalasi produksi. */
const PRODUCTION_READY_STATES = Object.freeze(new Set([CALIBRATION_STATE.CALIBRATED]));

/**
 * @param {object} asset aset dengan watchPolicy.rings
 * @param {Array<object>} rfObservations observasi rf.presence_estimate /
 *        rf.motion_estimate yang BERLOKASI (sensor location)
 * @returns {object|null} evaluation { riskState, ring, severity, evidence, ... }
 *
 * MD-010/C3: observasi REPLAY/SIMULASI TIDAK PERNAH menghasilkan alert
 * produksi normal. Evaluasi replay mengembalikan struktur eksplisit
 * { simulation: true, sourceMode: "REPLAY", productionAlert: false }
 * dengan severity dibatasi WATCH — tidak pernah memicu escalation produksi.
 *
 * MD-014/D5: hanya trusted LIVE provenance + kalibrasi CALIBRATED sah
 * yang boleh mengeskalasi ke warning/critical produksi. Tanpa itu,
 * estimasi tetap boleh terlihat sebagai watch (coarse, eksperimental)
 * tapi tidak pernah produksi-critical.
 */
function evaluateRfPresenceRisk(asset, rfObservations, { nowMs = Date.now(), windowMs = 30 * 1000 } = {}) {
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
        // MD-014: kalibrasi belum matang → tidak ada escalasi (data tetap
        // terlihat sebagai watch coarse, tidak pernah produksi-alert).
        const calState = obs.attributes?.calibrationState;
        if (calState !== undefined && !PRODUCTION_READY_STATES.has(calState)) continue;
        const sensorPoint = { lat: obs.attributes.sensorLat, lon: obs.attributes.sensorLon };
        const d = haversineMeters(asset.geometry, sensorPoint);
        if (!isFiniteNumber(d) || d > maxRadiusM) continue;
        if (!isFiniteNumber(obs.observedAt) || obs.observedAt < windowStart) continue;
        // Presence true = sinyal; motion-only tanpa presence tidak dinaikkan.
        if (obs.type === "rf.presence_estimate" && obs.attributes?.presence !== true) continue;
        inWindow.push({ obs, distanceM: d });
    }
    if (inWindow.length === 0) return null;

    // MD-010/C3: REPLAY tidak pernah alert produksi normal.
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

    // MD-010/C1+C4: escalasi produksi (warning/critical) hanya dari
    // trusted LIVE provenance (seal opaque mint kanonik). Estimasi tanpa
    // seal tetap boleh watch — coarse/experimental — tapi tidak pernah
    // produksi-alert, walau field-lineage apa pun diklaim caller.
    const trustedLive = inWindow.filter(x =>
        isTrustedLiveRfObservation(x.obs, {
            sensorId: x.obs.attributes?.sensorId ?? null,
            captureSession: x.obs.attributes?.captureSession ?? null
        }));
    if (trustedLive.length === 0 && (riskState === "warning" || riskState === "critical")) {
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

module.exports = { evaluateRfPresenceRisk, HAZARD_TYPE };