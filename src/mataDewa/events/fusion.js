/**
 * Spatial Fusion — mengkorelasikan SpatialObservation yang KOMPATIBEL menjadi
 * SpatialEvent dengan garis keturunan bukti yang dipertahankan.
 *
 * Hukum: JANGAN menggabungkan event hanya karena berdekatan. Fusi mempertimbangkan
 * waktu, geometri, tipe, kualitas sumber, confidence, pergerakan, dan
 * independensi provider. Observasi ≠ event.
 */

const { isValidPoint, haversineMeters, destinationPoint, bearingDegrees, isFiniteNumber } = require("../spatial/geo");
const { EPISTEMIC_STATUS } = require("../spatial/epistemic");
const { independentGroupCount, independenceGroupOf } = require("../spatial/lineage");
const { createEvent, SEVERITY } = require("./event");

/**
 * Apakah dua observasi kompatibel untuk digabung menjadi satu event.
 * Kompatibel = tipe sama + berdekatan dalam ruang DAN waktu. Bukan hanya dekat.
 */
function areCompatible(a, b, {
    maxDistanceM = 50000,
    maxTimeGapMs = 60 * 60 * 1000,
    requireSameType = true
} = {}) {
    if (!a || !b) return false;
    if (requireSameType && a.type !== b.type) return false;
    if (a.geometry?.type !== "point" || b.geometry?.type !== "point") return false;
    const distance = haversineMeters(a.geometry, b.geometry);
    if (!isFiniteNumber(distance) || distance > maxDistanceM) return false;
    const timeGap = Math.abs((a.observedAt ?? 0) - (b.observedAt ?? 0));
    if (timeGap > maxTimeGapMs) return false;
    return true;
}

/**
 * Apakah kandidat kompatibel dengan KLUSTER SEBAGAI KESELURUHAN?
 * MD-006 anti-bridge: kandidat harus kompatibel dengan SETIAP anggota
 * (dan tidak melebarkan envelope ruang/waktu kluster melebihi ambang),
 * bukan cukup dekat ke SATU anggota. A-B-C chaining (A dekat B, B dekat C,
 * A tidak kompatibel C) tidak lagi memaksa satu event.
 */
function isCompatibleWithCluster(candidate, cluster, opts) {
    return cluster.every(member => areCompatible(member, candidate, opts));
}

/**
 * Berapa banyak provider INDEPENDEN yang berkontribusi. Independensi provider
 * menaikkan confidence fusi (satu sumber mengulang ≠ dua sumber sepakat).
 */
function independentSourceCount(observations) {
    return new Set(observations.map(o => o.source)).size;
}

/**
 * Fusi satu kluster observasi kompatibel menjadi satu event.
 * Mengembalikan { ok, event } atau { ok:false, reason }.
 */
function fuseCluster(observations, {
    type = null,
    severity = SEVERITY.INFO,
    radiusM = null,
    nowMs = Date.now()
} = {}) {
    if (!Array.isArray(observations) || observations.length === 0) {
        return { ok: false, reason: "kluster kosong — butuh minimal satu observasi" };
    }
    const points = observations.filter(o => o.geometry?.type === "point");
    if (points.length === 0) {
        return { ok: false, reason: "tak ada observasi point dalam kluster" };
    }

    // Lokasi = centroid observasi point.
    const lat = points.reduce((s, o) => s + o.geometry.lat, 0) / points.length;
    const lon = points.reduce((s, o) => s + o.geometry.lon, 0) / points.length;

    const observedTimes = observations.map(o => o.observedAt).filter(isFiniteNumber);
    const firstObservedAt = Math.min(...observedTimes);
    const lastObservedAt = Math.max(...observedTimes);

    // Radius = sebaran maksimum dari centroid (atau override).
    let radius = radiusM;
    if (!isFiniteNumber(radius)) {
        radius = points.reduce((max, o) => {
            const d = haversineMeters({ lat, lon }, o.geometry);
            return isFiniteNumber(d) && d > max ? d : max;
        }, 0);
    }

    // MD-006: kemandirian dari lineage (independenceGroup), bukan dari
    // perbedaan string sumber — cermin upstream yang sama dihitung SATU.
    const groups = independentGroupCount(observations);
    // Confidence: rata-rata confidence observasi, dinaikkan oleh grup
    // kemandirian yang BENAR-BENAR berbeda (dibatasi ≤ 0.99), diturunkan
    // bila grup tunggal.
    const meanConfidence = observations.reduce((s, o) => s + (o.confidence ?? 0.5), 0) / observations.length;
    const independenceBonus = Math.min(0.2, (groups - 1) * 0.1);
    const confidence = Math.min(0.99, meanConfidence * (groups > 1 ? 1 : 0.85) + independenceBonus);

    const eventType = type ?? observations[0].type ?? "generic";

    return createEvent({
        type: eventType,
        location: { lat, lon },
        radiusM: radius,
        firstObservedAt,
        lastObservedAt,
        severity,
        confidence,
        epistemic: EPISTEMIC_STATUS.INFERRED,
        sources: [...new Set(observations.map(o => o.source))],
        evidence: observations.map(o => ({
            observationId: o.id,
            source: o.source,
            type: o.type,
            observedAt: o.observedAt,
            attribution: o.attribution ?? null,
            // Keturunan bukti: grup kemandirian per observasi — audit
            // bisa melihat berapa sumber INDEPENDEN yang benar-benar
            // mendukung event ini.
            independenceGroup: independenceGroupOf(o)
        })),
        lineage: {
            kind: "derived",
            providerId: `fusion:${eventType}`,
            providerFamily: "mata-dewa-fusion",
            independenceGroup: [...new Set(observations.map(independenceGroupOf))].sort().join("+"),
            upstreamDataset: null
        },
        createdAt: nowMs
    });
}

/**
 * Fusi sekumpulan observasi menjadi event-event (greedy clustering per tipe).
 * Mengembalikan { events, unclustered }.
 */
function fuseObservations(observations, opts = {}) {
    const groups = new Map();
    for (const obs of observations) {
        if (obs.geometry?.type !== "point") continue;
        const key = obs.type ?? "generic";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(obs);
    }

    const events = [];
    const unclustered = [];

    for (const [, group] of groups) {
        const visited = new Set();
        for (let i = 0; i < group.length; i++) {
            if (visited.has(i)) continue;
            const cluster = [group[i]];
            visited.add(i);
            for (let j = i + 1; j < group.length; j++) {
                if (visited.has(j)) continue;
                // MD-006 anti-bridge: kompatibel dengan KLUSTER SEBAGAI
                // KESELURUHAN, bukan hanya satu anggota.
                if (isCompatibleWithCluster(group[j], cluster, opts)) {
                    cluster.push(group[j]);
                    visited.add(j);
                }
            }
            if (cluster.length >= (opts.minClusterSize ?? 2)) {
                const fused = fuseCluster(cluster, { type: group[i].type, ...opts });
                if (fused.ok) events.push(fused.event);
                else unclustered.push(...cluster);
            } else {
                unclustered.push(...cluster);
            }
        }
    }

    return { events, unclustered };
}

/**
 * Estimasi pergerakan kluster (PREDICTED) — HANYA bila ada bukti pergerakan
 * (≥2 titik berurutan waktu dengan perpindahan nyata). Mengembalikan null bila
 * bukti tidak cukup; Mata Dewa tidak mengarang pergerakan.
 */
function estimateMovement(observations) {
    const timed = observations
        .filter(o => o.geometry?.type === "point" && isFiniteNumber(o.observedAt))
        .sort((a, b) => a.observedAt - b.observedAt);
    if (timed.length < 2) return null;

    const first = timed[0];
    const last = timed[timed.length - 1];
    const dtMs = last.observedAt - first.observedAt;
    const distance = haversineMeters(first.geometry, last.geometry);
    if (!isFiniteNumber(distance) || dtMs <= 0 || distance < 100) {
        return null; // perpindahan < 100 m bukan bukti pergerakan yang berarti
    }

    const bearing = bearingDegrees(first.geometry, last.geometry);
    const speedMps = distance / (dtMs / 1000);

    return {
        epistemic: EPISTEMIC_STATUS.PREDICTED,
        bearingDeg: bearing,
        speedMps,
        evidence: [
            { at: first.observedAt, location: first.geometry },
            { at: last.observedAt, location: last.geometry }
        ]
    };
}

/** Proyeksikan posisi masa depan dari bukti pergerakan (PREDICTED). */
function projectPosition(observations, aheadMs) {
    const movement = estimateMovement(observations);
    if (!movement) return null;
    const last = movement.evidence[movement.evidence.length - 1];
    const distanceM = movement.speedMps * (aheadMs / 1000);
    const projected = destinationPoint(last.location, movement.bearingDeg, distanceM);
    if (!projected) return null;
    return {
        epistemic: EPISTEMIC_STATUS.PREDICTED,
        location: projected,
        atMs: last.at + aheadMs,
        basedOn: movement
    };
}

module.exports = {
    areCompatible,
    independentSourceCount,
    fuseCluster,
    fuseObservations,
    estimateMovement,
    projectPosition
};
