/**
 * Provider OSRM routing — keyless routing/geodata publik.
 *
 * Sumber: https://routing.openstreetmap.de/routed-{profile}/route/v1/...
 * Tanpa kunci. Inti boot Mata Dewa TIDAK bergantung pada provider routing
 * premium; fallback ke routing publik/lokal. Dipakai Route Corridor Engine.
 */

const { fetchJson } = require("./http");
const { PROVIDER_ACCESS_MODE } = require("../config");
const { ACCESS_CLASS } = require("../spatial/accessClass");
const { isValidPoint } = require("../spatial/geo");

const BASE = "https://routing.openstreetmap.de";
const PROFILES = { car: "routed-car", foot: "routed-foot", bike: "routed-bike" };
const OSRM_PROFILE = { car: "driving", foot: "walking", bike: "cycling" };

/**
 * Hitung rute melalui titik-titik (waypoints [{lat,lon}, ...]).
 * Mengembalikan { ok, route: { geometry:[{lat,lon}], distanceM, durationS } }
 * atau { ok:false, reason }.
 */
async function computeRoute(waypoints, { profile = "car" } = {}) {
    if (!Array.isArray(waypoints) || waypoints.length < 2 || !waypoints.every(isValidPoint)) {
        return { ok: false, reason: "butuh minimal 2 waypoint valid" };
    }
    const service = PROFILES[profile] ?? PROFILES.car;
    const osrmProfile = OSRM_PROFILE[profile] ?? "driving";
    const coords = waypoints.map(p => `${p.lon},${p.lat}`).join(";");
    const url = `${BASE}/${service}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    const data = await fetchJson(url, { timeoutMs: 15000 });
    const route = data?.routes?.[0];
    if (!route) return { ok: false, reason: "rute tidak ditemukan" };
    const geometry = (route.geometry?.coordinates ?? [])
        .map(c => ({ lat: c[1], lon: c[0] }))
        .filter(isValidPoint);
    if (geometry.length < 2) return { ok: false, reason: "geometri rute malformed" };
    return {
        ok: true,
        route: {
            geometry,
            distanceM: Number.isFinite(Number(route.distance)) ? Number(route.distance) : null,
            durationS: Number.isFinite(Number(route.duration)) ? Number(route.duration) : null,
            attribution: "© OpenStreetMap contributors (OSRM via routing.openstreetmap.de)",
            license: "ODbL (OpenStreetMap contributors)"
        }
    };
}

function createOsrmProvider() {
    return {
        id: "osrm-routing",
        label: "OSRM Routing",
        types: ["route"],
        accessMode: PROVIDER_ACCESS_MODE.PUBLIC_NO_KEY,
        accessClass: ACCESS_CLASS.PUBLIC,
        coverage: { kind: "global" },
        freshnessMs: null,
        quality: 0.8,
        attribution: "© OpenStreetMap contributors (OSRM)",
        license: "ODbL (OpenStreetMap contributors)",
        fallbacks: [],
        // Routing tidak menghasilkan observasi pada poll biasa.
        poll: null,
        computeRoute
    };
}

module.exports = { createOsrmProvider, computeRoute, BASE };
