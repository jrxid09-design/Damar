/**
 * Provider Open-Meteo weather — keyless, publik.
 *
 * Sumber: https://api.open-meteo.com/v1/forecast
 * Diverifikasi live (HTTP 200) saat adopsi. Tanpa kunci (non-komersial).
 * Dipakai untuk cuaca/curah hujan/angin di sekitar aset & lokasi prioritas.
 */

const { fetchJson } = require("./http");
const { PROVIDER_ACCESS_MODE } = require("../config");
const { ACCESS_CLASS } = require("../spatial/accessClass");
const { OBSERVATION_TYPE } = require("../observations/observation");
const { isValidPoint } = require("../spatial/geo");

const BASE_URL = "https://api.open-meteo.com/v1/forecast";

function toObservation(point, data) {
    const current = data?.current ?? data?.current_weather ?? {};
    const timeIso = current.time;
    const observedAt = timeIso ? Date.parse(timeIso) : NaN;
    if (!Number.isFinite(observedAt)) return null;
    const precipitation = Number.isFinite(Number(current.precipitation))
        ? Number(current.precipitation)
        : (Number.isFinite(Number(current.rain)) ? Number(current.rain) : null);
    const windSpeed = Number.isFinite(Number(current.wind_speed_10m))
        ? Number(current.wind_speed_10m)
        : (Number.isFinite(Number(current.windspeed)) ? Number(current.windspeed) : null);
    return {
        id: `wx_${point.lat.toFixed(3)}_${point.lon.toFixed(3)}`,
        type: OBSERVATION_TYPE.WEATHER,
        geometry: { type: "point", lat: point.lat, lon: point.lon },
        observedAt,
        confidence: 0.85,
        quality: 0.85,
        accessClass: ACCESS_CLASS.PUBLIC,
        attributes: {
            temperatureC: Number.isFinite(Number(current.temperature_2m))
                ? Number(current.temperature_2m)
                : (Number.isFinite(Number(current.temperature)) ? Number(current.temperature) : null),
            precipitationMm: precipitation,
            windSpeedKmh: windSpeed,
            weatherCode: Number.isFinite(Number(current.weather_code))
                ? Number(current.weather_code)
                : (Number.isFinite(Number(current.weathercode)) ? Number(current.weathercode) : null)
        },
        attribution: "Open-Meteo",
        license: "CC BY 4.0 (Open-Meteo)"
    };
}

function createOpenMeteoProvider() {
    return {
        id: "open-meteo",
        label: "Open-Meteo Weather",
        types: [OBSERVATION_TYPE.WEATHER],
        accessMode: PROVIDER_ACCESS_MODE.PUBLIC_NO_KEY,
        accessClass: ACCESS_CLASS.PUBLIC,
        coverage: { kind: "global" },
        freshnessMs: 15 * 60 * 1000,
        quality: 0.85,
        attribution: "Open-Meteo",
        license: "CC BY 4.0 (Open-Meteo)",
        fallbacks: [],
        /**
         * @param {{ bounds?: { lat:number, lon:number } | null }} ctx
         *   Open-Meteo bersifat per-titik; bila tak ada bounds, gunakan
         *   default Indonesia (bukan lokasi presisi pengguna).
         */
        async poll({ bounds } = {}) {
            const point = isValidPoint(bounds) ? bounds : { lat: -2.5, lon: 118.0 };
            const params = new URLSearchParams({
                latitude: String(point.lat),
                longitude: String(point.lon),
                current: "temperature_2m,precipitation,rain,weather_code,wind_speed_10m",
                timezone: "auto"
            });
            const data = await fetchJson(`${BASE_URL}?${params}`);
            const obs = toObservation(point, data);
            return obs ? [obs] : [];
        }
    };
}

module.exports = { createOpenMeteoProvider, toObservation, BASE_URL };
