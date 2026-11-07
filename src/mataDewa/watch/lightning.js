/**
 * Lightning Watch — generic hazard observation → tower risk evaluation.
 *
 * Alur (Tower Lightning Watch):
 *   observasi petir → spatial index → menara/aset terdekat relevan → jarak
 *   → densitas/jendela waktu → pergerakan badai (HANYA bila ada bukti)
 *   → keadaan risiko (per-asset policy ring) → SpatialEvent terfusi
 *   → alert policy.
 *
 * Memakai indeks spasial (GridIndex), bukan pemindaian O(N) per kejadian.
 */

const { haversineMeters, isFiniteNumber } = require("../spatial/geo");
const { EPISTEMIC_STATUS } = require("../spatial/epistemic");
const { fuseCluster } = require("../events/fusion");
const { SEVERITY, canonicalSeverity } = require("../events/event");

/** Tipe hazard generik. */
const HAZARD_TYPE = Object.freeze({
    LIGHTNING: "lightning",
    HEAVY_RAIN: "heavy_rain",
    FLOOD: "flood",
    LANDSLIDE: "landslide",
    FIRE: "fire",
    WIND: "wind",
    ROUTE_DISRUPTION: "route_disruption"
});

/**
 * Evaluasi risiko petir untuk satu aset berdasarkan observasi petir terkini.
 *
 * @param {object} asset            SpatialAsset (watchPolicy.rings menentukan ambang)
 * @param {Array}  strikes          observasi lightning (point, observedAt)
 * @param {{ nowMs?: number, windowMs?: number }} opts
 * @returns null bila tidak ada strike relevan; { riskState, ring, nearestStrikeM,
 *   strikeCount, windowMs, epistemic, evidence }
 */
function evaluateLightningRisk(asset, strikes, { nowMs = Date.now(), windowMs = 15 * 60 * 1000 } = {}) {
    if (!asset?.geometry || asset.geometry.type !== "point") return null;
    if (!Array.isArray(strikes) || strikes.length === 0) return null;

    const policyRings = asset.watchPolicy?.rings ?? [];
    const criticalRing = policyRings.find(r => r.name === "critical");
    const warningRing = policyRings.find(r => r.name === "warning");
    const watchRing = policyRings.find(r => r.name === "watch");
    const maxRadiusM = policyRings.length ? policyRings[0].radiusM : 40000;

    // Jendela waktu: hanya strike dalam window dihitung; strike basi TIDAK
    // memicu risiko tinggi (stale lightning diturunkan).
    const windowStart = nowMs - windowMs;
    const inWindow = [];
    for (const strike of strikes) {
        if (strike.geometry?.type !== "point") continue;
        const d = haversineMeters(asset.geometry, strike.geometry);
        if (!isFiniteNumber(d) || d > maxRadiusM) continue;
        if (!isFiniteNumber(strike.observedAt) || strike.observedAt < windowStart) continue;
        inWindow.push({ strike, distanceM: d });
    }
    if (inWindow.length === 0) return null;

    inWindow.sort((a, b) => a.distanceM - b.distanceM);
    const nearest = inWindow[0];
    const strikeCount = inWindow.length;

    // Kepadatan dalam jendela (strike per menit) — badai aktif vs sekejap.
    const densityPerMinute = strikeCount / (windowMs / 60000);

    // Keadaan risiko dari ring kebijakan per-aset (bukan angka universal).
    let riskState = "watch";
    let ringName = watchRing?.name ?? "watch";
    const atOrBelow = (ring) => isFiniteNumber(ring?.radiusM) && nearest.distanceM <= ring.radiusM;
    if (atOrBelow(criticalRing)) { riskState = "critical"; ringName = criticalRing.name; }
    else if (atOrBelow(warningRing)) { riskState = "warning"; ringName = warningRing.name; }
    else if (atOrBelow(watchRing)) { riskState = "watch"; ringName = watchRing.name; }

    // Densitas tinggi menaikkan satu tingkat keparahan bila masih di bawah critical.
    if (densityPerMinute >= 5 && riskState === "watch") riskState = "warning";
    if (densityPerMinute >= 5 && riskState === "warning" && !atOrBelow(criticalRing)) {
        // tetap warning; critical hanya dari ring kebijakan.
    }

    // Kesegaran strike terdekat mempengaruhi klaim: strike basi ( > 1/3 window )
    // tidak boleh diklaim "live" — turunkan keparahan minimal satu tingkat.
    const freshest = Math.max(...inWindow.map(x => x.strike.observedAt));
    const stale = nowMs - freshest > windowMs / 3;
    if (stale && riskState === "critical") riskState = "warning";
    if (stale && riskState === "warning") riskState = "watch";

    const severityByRisk = { critical: SEVERITY.CRITICAL, warning: SEVERITY.WARNING, watch: SEVERITY.WATCH };

    return {
        riskState,
        ring: ringName,
        nearestStrikeM: Math.round(nearest.distanceM),
        strikeCount,
        densityPerMinute: Math.round(densityPerMinute * 100) / 100,
        stale,
        epistemic: EPISTEMIC_STATUS.INFERRED,
        evidence: inWindow.slice(0, 10).map(x => ({
            observationId: x.strike.id,
            distanceM: Math.round(x.distanceM),
            observedAt: x.strike.observedAt,
            source: x.strike.source
        })),
        severity: severityByRisk[riskState] ?? SEVERITY.WATCH
    };
}

/**
 * Deteksi pergerakan badai dari strike berurutan — HANYA dengan bukti.
 * Mengembalikan null bila perpindahan tidak berarti.
 */
function stormMovement(strikes) {
    const { estimateMovement } = require("../events/fusion");
    return estimateMovement(strikes.filter(s => s.type === HAZARD_TYPE.LIGHTNING || s.type === "generic"));
}

/**
 * Bangun SpatialEvent bahaya untuk sebuah aset (fusi observasi bahaya).
 */
function buildAssetHazardEvent(asset, evaluation, { hazardType = HAZARD_TYPE.LIGHTNING, nowMs = Date.now() } = {}) {
    if (!asset || !evaluation) return null;
    const fused = fuseCluster(
        (evaluation.evidence ?? []).map(e => ({ id: e.observationId, source: e.source, type: hazardType, observedAt: e.observedAt, geometry: { type: "point", lat: asset.geometry.lat, lon: asset.geometry.lon } })),
        { type: hazardType, severity: canonicalSeverity(evaluation.severity), radiusM: Math.max(0, evaluation.nearestStrikeM ?? 0), nowMs }
    );
    if (!fused.ok) return null;
    const { createEvent } = require("../events/event");
    const enriched = createEvent({
        ...fused.event,
        type: hazardType,
        severity: evaluation.severity,
        confidence: Math.min(0.99, fused.event.confidence),
        recommendedContext: {
            assetId: asset.id,
            assetType: asset.type,
            assetName: asset.metadata?.name ?? null,
            riskState: evaluation.riskState,
            ring: evaluation.ring,
            // MD-005: undefined ditolak kanonikalisasi — normalisasi ke null.
            nearestStrikeM: evaluation.nearestStrikeM ?? evaluation.nearestSensorM ?? null,
            strikeCount: evaluation.strikeCount ?? evaluation.presenceCount ?? null,
            stale: evaluation.stale ?? null
        }
    }, { nowMs });
    return enriched.ok ? enriched.event : null;
}

module.exports = {
    HAZARD_TYPE,
    evaluateLightningRisk,
    stormMovement,
    buildAssetHazardEvent
};
