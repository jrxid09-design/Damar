/**
 * Provider USGS earthquakes — keyless, publik.
 *
 * Sumber: https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson
 * Diverifikasi live (HTTP 200) saat adopsi. Tanpa kunci, tanpa akun.
 */

const { fetchJson } = require("./http");
const { PROVIDER_ACCESS_MODE } = require("../config");
const { ACCESS_CLASS } = require("../spatial/accessClass");
const { OBSERVATION_TYPE } = require("../observations/observation");

const FEED_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";

function toObservation(feature) {
    const props = feature?.properties ?? {};
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const timeMs = Number(props.time);
    if (!Number.isFinite(timeMs)) return null;
    return {
        id: typeof feature.id === "string" && feature.id ? `usgs_${feature.id}` : undefined,
        type: OBSERVATION_TYPE.EARTHQUAKE,
        geometry: { type: "point", lat, lon },
        observedAt: timeMs,
        confidence: 0.95,
        quality: 0.9,
        accessClass: ACCESS_CLASS.PUBLIC,
        attributes: {
            magnitude: Number.isFinite(Number(props.mag)) ? Number(props.mag) : null,
            place: props.place ?? null,
            depthKm: Number.isFinite(Number(coords[2])) ? Number(coords[2]) : null,
            url: props.url ?? null,
            tsunami: props.tsunami === 1
        },
        attribution: "USGS Earthquake Hazards Program",
        license: "public domain (USGS)"
    };
}

function createUsgsProvider() {
    return {
        id: "usgs-earthquakes",
        label: "USGS Earthquakes",
        types: [OBSERVATION_TYPE.EARTHQUAKE],
        accessMode: PROVIDER_ACCESS_MODE.PUBLIC_NO_KEY,
        accessClass: ACCESS_CLASS.PUBLIC,
        coverage: { kind: "global" },
        freshnessMs: 60 * 1000,
        quality: 0.9,
        attribution: "USGS Earthquake Hazards Program",
        license: "public domain (USGS)",
        fallbacks: [],
        async poll() {
            const data = await fetchJson(FEED_URL);
            const features = Array.isArray(data?.features) ? data.features : [];
            return features.map(toObservation).filter(Boolean);
        }
    };
}

module.exports = { createUsgsProvider, FEED_URL };
