/**
 * Provider OpenStreetMap — keyless geodata (reverse geocode + fitur via Overpass).
 *
 * Sumber:
 *   Nominatim reverse: https://nominatim.openstreetmap.org/reverse
 *   Overpass fitur   : https://overpass-api.de/api/interpreter (+ mirror)
 * Tanpa kunci. Dipakai untuk konteks tempat & fitur OSM di sekitar lokasi.
 * Mematuhi kebijakan penggunaan Nominatim (User-Agent jelas, rate dibatasi).
 */

const { fetchJson, fetchPostJson } = require("./http");
const { PROVIDER_ACCESS_MODE } = require("../config");
const { ACCESS_CLASS } = require("../spatial/accessClass");
const { OBSERVATION_TYPE } = require("../observations/observation");
const { isValidPoint } = require("../spatial/geo");

const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter"
];

const OSM_TYPE = "place";
const OSM_FEATURE = "osm_feature";

/** Reverse geocode sebuah titik → konteks tempat. */
async function reverseGeocode(point) {
    if (!isValidPoint(point)) return null;
    const params = new URLSearchParams({
        lat: String(point.lat),
        lon: String(point.lon),
        format: "jsonv2",
        zoom: "14"
    });
    const data = await fetchJson(`${NOMINATIM_REVERSE}?${params}`, { timeoutMs: 8000, allowedHosts: ["nominatim.openstreetmap.org"] });
    if (!data || data.error) return null;
    return {
        id: `place_${data.place_id ?? `${point.lat.toFixed(3)}_${point.lon.toFixed(3)}`}`,
        type: OSM_TYPE,
        geometry: { type: "point", lat: point.lat, lon: point.lon },
        observedAt: Date.now(),
        confidence: 0.9,
        quality: 0.85,
        accessClass: ACCESS_CLASS.PUBLIC,
        attributes: {
            displayName: data.display_name ?? null,
            category: data.category ?? data.type ?? null,
            address: data.address ?? null
        },
        attribution: "© OpenStreetMap contributors (Nominatim)",
        license: "ODbL (OpenStreetMap contributors)"
    };
}

/** Query fitur OSM di sekitar titik via Overpass (bounded, POST urlencoded). */
async function nearbyFeatures(point, { radiusM = 2000, filter = "node[\"amenity\"]" } = {}) {
    if (!isValidPoint(point)) return [];
    const query = `[out:json][timeout:25];(${filter}(around:${Math.round(radiusM)},${point.lat},${point.lon}););out body 50;`;
    const body = `data=${encodeURIComponent(query)}`;
    let lastError = null;
    for (const mirror of OVERPASS_MIRRORS) {
        try {
            const data = await fetchPostJson(mirror, body, { timeoutMs: 20000, allowedHosts: ["overpass-api.de", "overpass.kumi.systems", "lz4.overpass-api.de"] });
            return normalizeOverpass(data, point);
        }
        catch (error) {
            lastError = error;
            continue;
        }
    }
    throw lastError ?? new Error("semua mirror Overpass gagal");
}

function normalizeOverpass(data, origin) {
    const elements = Array.isArray(data?.elements) ? data.elements : [];
    const out = [];
    for (const el of elements.slice(0, 50)) {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        out.push({
            id: `osm_${el.type}_${el.id}`,
            type: OSM_FEATURE,
            geometry: { type: "point", lat, lon },
            observedAt: Date.now(),
            confidence: 0.85,
            quality: 0.8,
            accessClass: ACCESS_CLASS.PUBLIC,
            attributes: {
                osmType: el.type,
                osmId: el.id,
                tags: el.tags ?? {}
            },
            attribution: "© OpenStreetMap contributors (Overpass)",
            license: "ODbL (OpenStreetMap contributors)"
        });
    }
    return out;
}

function createOsmProvider() {
    return {
        id: "osm-geodata",
        label: "OpenStreetMap",
        types: [OSM_TYPE, OSM_FEATURE, OBSERVATION_TYPE.GENERIC],
        accessMode: PROVIDER_ACCESS_MODE.PUBLIC_NO_KEY,
        accessClass: ACCESS_CLASS.PUBLIC,
        coverage: { kind: "global" },
        freshnessMs: 24 * 60 * 60 * 1000,
        quality: 0.85,
        attribution: "© OpenStreetMap contributors",
        license: "ODbL (OpenStreetMap contributors)",
        fallbacks: [],
        async poll({ bounds } = {}) {
            if (!isValidPoint(bounds)) return [];
            const place = await reverseGeocode(bounds).catch(() => null);
            return place ? [place] : [];
        },
        // Permukaan tambahan untuk query fitur kaya (dipakai route/asset engine).
        reverseGeocode,
        nearbyFeatures
    };
}

module.exports = { createOsmProvider, reverseGeocode, nearbyFeatures, NOMINATIM_REVERSE, OVERPASS_MIRRORS };
