/**
 * Primitif geodesi Mata Dewa — murni, tanpa I/O, tanpa dependensi.
 *
 * Semua fungsi memakai derajat di permukaan, radian di dalam. Jarak dalam
 * METER. Ini fondasi untuk spatial index, fusion, watch, dan route corridor.
 */

const EARTH_RADIUS_M = 6371008.8; // rata-rata IUGG

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function isValidLat(lat) {
    return isFiniteNumber(lat) && lat >= -90 && lat <= 90;
}

function isValidLon(lon) {
    return isFiniteNumber(lon) && lon >= -180 && lon <= 180;
}

function isValidPoint(point) {
    return !!point && isValidLat(point.lat) && isValidLon(point.lon);
}

function toRadians(deg) { return deg * DEG; }
function toDegrees(rad) { return rad * RAD; }

/** Jarak great-circle (haversine) antar dua titik, dalam meter. */
function haversineMeters(a, b) {
    if (!isValidPoint(a) || !isValidPoint(b)) return NaN;
    const dLat = toRadians(b.lat - a.lat);
    const dLon = toRadians(b.lon - a.lon);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bearing awal dari a ke b, derajat searah jarum jam dari utara [0,360). */
function bearingDegrees(a, b) {
    if (!isValidPoint(a) || !isValidPoint(b)) return NaN;
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const dLon = toRadians(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * RAD + 360) % 360;
}

/** Titik tujuan dari origin sejauh distanceM pada bearing tertentu. */
function destinationPoint(origin, bearingDeg, distanceM) {
    if (!isValidPoint(origin) || !isFiniteNumber(distanceM)) return null;
    const delta = distanceM / EARTH_RADIUS_M;
    const theta = toRadians(bearingDeg);
    const lat1 = toRadians(origin.lat);
    const lon1 = toRadians(origin.lon);
    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(delta) +
        Math.cos(lat1) * Math.sin(delta) * Math.cos(theta)
    );
    const lon2 = lon1 + Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
        Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2)
    );
    const lon = ((lon2 * RAD + 540) % 360) - 180; // normalisasi ke [-180,180)
    return { lat: lat2 * RAD, lon };
}

/**
 * Jarak titik ke segmen garis (proyeksi planar lokal — cukup akurat untuk
 * koridor rute berskala kota/region, tidak untuk antar-benua).
 */
function pointToSegmentMeters(p, a, b) {
    if (!isValidPoint(p) || !isValidPoint(a) || !isValidPoint(b)) return NaN;
    const latRef = toRadians((a.lat + b.lat + p.lat) / 3);
    const kx = 111320 * Math.cos(latRef);
    const ky = 110540;
    const ax = a.lon * kx, ay = a.lat * ky;
    const bx = b.lon * kx, by = b.lat * ky;
    const px = p.lon * kx, py = p.lat * ky;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return haversineMeters(p, a);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
}

/** Jarak minimum titik ke polyline (array titik {lat,lon}). */
function pointToPolylineMeters(p, line) {
    if (!Array.isArray(line) || line.length === 0) return NaN;
    if (line.length === 1) return haversineMeters(p, line[0]);
    let min = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
        const d = pointToSegmentMeters(p, line[i], line[i + 1]);
        if (d < min) min = d;
    }
    return min;
}

/**
 * Bounding box melingkar di sekitar titik, untuk pra-filter spatial index.
 * Mengembalikan { minLat, maxLat, minLon, maxLon }.
 */
function boundingBox(center, radiusM) {
    if (!isValidPoint(center) || !isFiniteNumber(radiusM) || radiusM < 0) return null;
    const deltaLat = (radiusM / EARTH_RADIUS_M) * RAD;
    let minLat = center.lat - deltaLat;
    let maxLat = center.lat + deltaLat;
    let minLon, maxLon;
    if (minLat > -90 && maxLat < 90) {
        const deltaLon = Math.asin(
            Math.min(1, Math.sin((radiusM / EARTH_RADIUS_M)) / Math.cos(toRadians(center.lat)))
        ) * RAD;
        minLon = center.lon - deltaLon;
        maxLon = center.lon + deltaLon;
    } else {
        minLat = Math.max(minLat, -90);
        maxLat = Math.min(maxLat, 90);
        minLon = -180;
        maxLon = 180;
    }
    return { minLat, maxLat, minLon, maxLon };
}

/** Apakah titik berada dalam bounding box (menangani antimeridian sederhana). */
function inBoundingBox(point, box) {
    if (!isValidPoint(point) || !box) return false;
    if (point.lat < box.minLat || point.lat > box.maxLat) return false;
    if (box.minLon <= box.maxLon) {
        return point.lon >= box.minLon && point.lon <= box.maxLon;
    }
    // antimeridian
    return point.lon >= box.minLon || point.lon <= box.maxLon;
}

module.exports = Object.freeze({
    EARTH_RADIUS_M,
    isValidLat,
    isValidLon,
    isValidPoint,
    isFiniteNumber,
    toRadians,
    toDegrees,
    haversineMeters,
    bearingDegrees,
    destinationPoint,
    pointToSegmentMeters,
    pointToPolylineMeters,
    boundingBox,
    inBoundingBox
});
