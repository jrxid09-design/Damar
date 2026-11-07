const path = require("node:path");
const JsonStore = require("../core/config/JsonStore");
const telemetry = require("./telemetryService");

/**
 * weatherService — cuaca terkini untuk Dashboard. Data NYATA dari
 * Open-Meteo (gratis, tanpa API key). Lokasi otomatis dideteksi via IP
 * (ip-api, gratis) atau di-override di configs/weather.json {lat,lon,label}.
 * Di-cache 10 menit; degradasi anggun bila offline.
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "weather.json"),
    { lat: null, lon: null, label: null }
);

let cache = null, cacheAt = 0, autoLoc = null;

const CODES = {
    0: "Cerah", 1: "Cerah berawan", 2: "Berawan sebagian", 3: "Berawan",
    45: "Berkabut", 48: "Berkabut", 51: "Gerimis", 53: "Gerimis", 55: "Gerimis",
    61: "Hujan ringan", 63: "Hujan", 65: "Hujan lebat", 66: "Hujan beku", 67: "Hujan beku",
    71: "Bersalju", 73: "Bersalju", 75: "Bersalju lebat", 80: "Hujan lokal", 81: "Hujan lokal",
    82: "Hujan deras", 85: "Salju lokal", 86: "Salju lebat", 95: "Badai petir", 96: "Badai petir", 99: "Badai petir"
};

async function location() {
    const c = store.read();
    if (c.lat != null && c.lon != null) return { lat: c.lat, lon: c.lon, label: c.label || "Lokasi" };
    if (autoLoc) return autoLoc;
    try {
        const r = await fetch("http://ip-api.com/json/?fields=status,city,regionName,lat,lon",
            { signal: AbortSignal.timeout(6000) });
        const j = await r.json();
        if (j.status === "success") {
            autoLoc = { lat: j.lat, lon: j.lon, label: j.city || j.regionName || "Lokasi" };
            return autoLoc;
        }
    }
    catch { /* offline / diblokir */ }
    return null;
}

async function current() {
    if (cache && Date.now() - cacheAt < 10 * 60 * 1000) return cache;

    const l = await location();
    if (!l) return { available: false, reason: "Lokasi tak terdeteksi. Atur di configs/weather.json." };

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${l.lat}&longitude=${l.lon}` +
            `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        const cur = j.current || {};
        cache = {
            available: true,
            label: l.label,
            tempC: Math.round(cur.temperature_2m),
            feelsC: Math.round(cur.apparent_temperature),
            humidity: cur.relative_humidity_2m,
            wind: cur.wind_speed_10m,
            code: cur.weather_code,
            desc: CODES[cur.weather_code] ?? "—",
            at: new Date().toISOString()
        };
        cacheAt = Date.now();
        return cache;
    }
    catch (e) {
        telemetry.warn(`[weather] gagal: ${e.message}`);
        return { available: false, reason: "Gagal mengambil cuaca (offline?)." };
    }
}

function setConfig({ lat, lon, label } = {}) {
    store.write({
        lat: lat != null ? Number(lat) : null,
        lon: lon != null ? Number(lon) : null,
        label: label || null
    });
    cache = null; autoLoc = null;
    return store.read();
}

module.exports = { current, setConfig };
