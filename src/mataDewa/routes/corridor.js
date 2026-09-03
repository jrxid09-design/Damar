/**
 * Route Corridor Engine — bahaya di sepanjang rute, event yang mendekati
 * rute, aset dekat rute, dampak akses/trafik.
 *
 * Core boot TIDAK butuh provider routing premium — koridor memakai geometri
 * rute publik (OSRM) atau geometri yang diberikan pemanggil.
 */

const { pointToPolylineMeters, haversineMeters, isFiniteNumber } = require("../spatial/geo");
const { SEVERITY } = require("../events/event");

/**
 * Analisis koridor rute.
 *
 * @param {{ route: { geometry: {lat,lon}[], distanceM?: number } }} route
 *   geometri rute (dari OSRM atau pemanggil)
 * @param {Array} events SpatialEvent aktif (dari fusion/watch)
 * @param {object} assetRegistry AssetRegistry (aset dekat koridor)
 * @param {{ corridorHalfWidthM?: number, approachSpeedFactor?: number }} opts
 * @returns {{ affectedEvents, approachingEvents, nearAssets, summary }}
 */
function analyzeCorridor(route, events = [], assetRegistry = null, { corridorHalfWidthM = 2000 } = {}) {
    const geometry = route?.geometry ?? [];
    if (!Array.isArray(geometry) || geometry.length < 2) {
        return { ok: false, reason: "rute butuh geometri minimal 2 titik" };
    }

    const affectedEvents = [];
    const approachingEvents = [];

    for (const event of events) {
        if (!event?.location || !isFiniteNumber(event.location.lat)) continue;
        const distanceToRoute = pointToPolylineMeters(event.location, geometry);

        // Event ON-corridor: pusatnya dalam koridor (atau radius event menyentuh).
        if (distanceToRoute <= corridorHalfWidthM ||
            (isFiniteNumber(event.radiusM) && distanceToRoute - event.radiusM <= corridorHalfWidthM)) {
            affectedEvents.push({ event, distanceToRouteM: Math.round(distanceToRoute) });
            continue;
        }

        // Event mendekat: ada pergerakan yang memproyeksikan mendekat ke koridor.
        // (Deteksi approach memakai movement evidence bila ada — dipasok lewat
        // event.movement; tanpa bukti pergerakan, tidak mengarang approach.)
        if (event.movement?.epistemic === "PREDICTED" && event.movement.projectedLocation) {
            const projected = pointToPolylineMeters(event.movement.projectedLocation, geometry);
            if (projected < distanceToRoute && projected <= corridorHalfWidthM * 4) {
                approachingEvents.push({
                    event,
                    distanceToRouteM: Math.round(distanceToRoute),
                    projectedDistanceM: Math.round(projected)
                });
            }
        }
    }

    affectedEvents.sort((a, b) => a.distanceToRouteM - b.distanceToRouteM);
    approachingEvents.sort((a, b) => a.projectedDistanceM - b.projectedDistanceM);

    // Aset dekat koridor (via registry; indeks per-aset kalau tersedia).
    let nearAssets = [];
    if (assetRegistry && typeof assetRegistry.list === "function") {
        const sampled = geometry.length > 200
            ? geometry.filter((_, i) => i % Math.ceil(geometry.length / 200) === 0)
            : geometry;
        const seen = new Set();
        for (const point of sampled) {
            for (const hit of assetRegistry.near(point, corridorHalfWidthM)) {
                if (seen.has(hit.asset.id)) continue;
                seen.add(hit.asset.id);
                nearAssets.push(hit);
            }
        }
        nearAssets.sort((a, b) => a.distanceM - b.distanceM);
    }

    const worst = affectedEvents.reduce((acc, x) => {
        const order = { info: 0, watch: 1, warning: 2, critical: 3 };
        return (order[x.event.severity] ?? 0) > (order[acc] ?? 0) ? x.event.severity : acc;
    }, null);

    return {
        ok: true,
        corridorHalfWidthM,
        routeDistanceM: route.distanceM ?? null,
        affectedEvents,
        approachingEvents,
        nearAssets: nearAssets.slice(0, 50),
        summary: {
            affectedCount: affectedEvents.length,
            approachingCount: approachingEvents.length,
            assetsAtRisk: nearAssets.length,
            worstSeverity: worst ?? null,
            routeBlockedLikely: affectedEvents.some(x => x.event.severity === SEVERITY.CRITICAL)
        }
    };
}

module.exports = { analyzeCorridor };
