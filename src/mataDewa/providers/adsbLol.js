/**
 * Provider adsb.lol flights — keyless, publik (ODbL).
 *
 * Sumber: https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{radiusNm}
 * Diverifikasi live (HTTP 200) saat adopsi. Tanpa kunci. Fallback regional
 * untuk pelacakan penerbangan sipil (OpenSky berkunci diklasifikasikan
 * terpisah sebagai PLUS/OAuth — tidak ditembus).
 */

const { fetchJson } = require("./http");
const { PROVIDER_ACCESS_MODE } = require("../config");
const { ACCESS_CLASS } = require("../spatial/accessClass");
const { OBSERVATION_TYPE } = require("../observations/observation");
const { isValidPoint } = require("../spatial/geo");

const BASE_URL = "https://api.adsb.lol";
const DEFAULT_RADIUS_NM = 100;

function toObservation(ac, nowMs) {
    const lat = Number(ac?.lat);
    const lon = Number(ac?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // adsb.lol memberi "seen" (detik sejak terlihat); turunkan observedAt.
    const seenSec = Number.isFinite(Number(ac?.seen)) ? Number(ac.seen) : 0;
    const observedAt = nowMs - Math.max(0, seenSec) * 1000;
    const hex = typeof ac?.hex === "string" ? ac.hex : null;
    return {
        id: hex ? `adsb_${hex}` : undefined,
        type: OBSERVATION_TYPE.FLIGHT,
        geometry: { type: "point", lat, lon },
        observedAt,
        confidence: 0.9,
        quality: 0.8,
        accessClass: ACCESS_CLASS.PUBLIC,
        attributes: {
            icao24: hex,
            callsign: typeof ac?.flight === "string" ? ac.flight.trim() : null,
            altitudeFt: Number.isFinite(Number(ac?.alt_baro)) ? Number(ac.alt_baro) : null,
            groundSpeedKt: Number.isFinite(Number(ac?.gs)) ? Number(ac.gs) : null,
            trackDeg: Number.isFinite(Number(ac?.track)) ? Number(ac.track) : null,
            onGround: ac?.alt_baro === "ground"
        },
        attribution: "adsb.lol",
        license: "ODbL (adsb.lol / OpenStreetMap contributors)"
    };
}

function createAdsbLolProvider() {
    return {
        id: "adsb-lol-flights",
        label: "adsb.lol Flights",
        types: [OBSERVATION_TYPE.FLIGHT],
        accessMode: PROVIDER_ACCESS_MODE.PUBLIC_NO_KEY,
        accessClass: ACCESS_CLASS.PUBLIC,
        coverage: { kind: "regional" },
        freshnessMs: 10 * 1000,
        quality: 0.8,
        attribution: "adsb.lol",
        license: "ODbL (adsb.lol / OpenStreetMap contributors)",
        fallbacks: [],
        async poll({ bounds } = {}) {
            const point = isValidPoint(bounds) ? bounds : { lat: -6.2, lon: 106.8 }; // default Jakarta region
            const url = `${BASE_URL}/v2/lat/${point.lat.toFixed(3)}/lon/${point.lon.toFixed(3)}/dist/${DEFAULT_RADIUS_NM}`;
            const nowMs = Date.now();
            const data = await fetchJson(url, { allowedHosts: ["api.adsb.lol"] });
            const list = Array.isArray(data?.ac) ? data.ac : [];
            return list.map(ac => toObservation(ac, nowMs)).filter(Boolean);
        }
    };
}

module.exports = { createAdsbLolProvider, toObservation, BASE_URL };
