/**
 * Provider berkunci opsional (PLUS/PRO) — adapter jujur di atas jahitan vault.
 *
 * HUKUM:
 *  - Semua adapter menerima kredensial HANYA lewat credentialResolver
 *    (Secret Vault). Tidak ada kunci dari env yang dibaca di sini, tidak ada
 *    bypass autentikasi provider.
 *  - Tanpa kredensial → provider melaporkan UNAVAILABLE "credentials_absent"
 *    dan kemampuan premium hilang secara jujur. Core tetap hidup keyless.
 *  - Kegagalan upstream ≠ kegagalan Mata Dewa.
 *
 * Adapter yang butuh WebSocket/OAuth multi-langkah (aisstream, opensky OAuth
 * penuh) diimplementasikan sebagai REST/endpoint sederhana atau stub fail-
 * closed yang jujur — bukan integrasi palsu.
 */

const { fetchJson, fetchText } = require("./http");
const { PROVIDER_ACCESS_MODE } = require("../config");
const { ACCESS_CLASS } = require("../spatial/accessClass");
const { OBSERVATION_TYPE } = require("../observations/observation");
const { isValidPoint } = require("../spatial/geo");

/** TomTom traffic — PRO, API_KEY. Flow segment di sekitar titik. */
function createTomTomProvider() {
    return {
        id: "tomtom",
        label: "TomTom Traffic",
        types: [OBSERVATION_TYPE.TRAFFIC],
        accessMode: PROVIDER_ACCESS_MODE.API_KEY,
        accessClass: ACCESS_CLASS.RESTRICTED,
        credentialTier: "PRO",
        coverage: { kind: "global" },
        freshnessMs: 2 * 60 * 1000,
        quality: 0.9,
        attribution: "TomTom Traffic Index",
        license: "TomTom ToS (restricted)",
        fallbacks: [],
        async poll({ bounds, credential }) {
            if (!isValidPoint(bounds)) return [];
            const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${bounds.lat},${bounds.lon}&key=${encodeURIComponent(credential)}`;
            const data = await fetchJson(url, { timeoutMs: 10000 });
            const flow = data?.flowSegmentData;
            if (!flow) return [];
            return [{
                type: OBSERVATION_TYPE.TRAFFIC,
                geometry: { type: "point", lat: bounds.lat, lon: bounds.lon },
                observedAt: Date.now(),
                confidence: 0.9,
                quality: 0.9,
                accessClass: ACCESS_CLASS.RESTRICTED,
                attributes: {
                    currentSpeedKmh: flow.currentSpeed ?? null,
                    freeFlowSpeedKmh: flow.freeFlowSpeed ?? null,
                    // 0 = bebas macet, 10 = tertutup (skala TomTom)
                    congestion: flow.currentTravelTime > flow.freeFlowTravelTime
                        ? Math.min(10, Math.round(((flow.currentTravelTime - flow.freeFlowTravelTime) / flow.freeFlowTravelTime) * 10))
                        : 0,
                    roadName: flow.roadName ?? null
                },
                attribution: "TomTom Traffic Index",
                license: "TomTom ToS (restricted)"
            }];
        }
    };
}

/**
 * NASA FIRMS active fires — PLUS, API_KEY (free account).
 * CSV area API. Data publik tapi butuh MAP_KEY (akun gratis).
 */
function createFirmsProvider() {
    return {
        id: "firms",
        label: "NASA FIRMS Active Fires",
        types: [OBSERVATION_TYPE.FIRE],
        accessMode: PROVIDER_ACCESS_MODE.API_KEY,
        accessClass: ACCESS_CLASS.PUBLIC,
        credentialTier: "PLUS",
        coverage: { kind: "global" },
        freshnessMs: 60 * 60 * 1000,
        quality: 0.85,
        attribution: "NASA FIRMS (VIIRS S-NPP/NOAA-20)",
        license: "NASA open data (FIRMS terms)",
        fallbacks: [],
        async poll({ bounds, credential }) {
            if (!isValidPoint(bounds)) return [];
            const south = (bounds.lat - 2).toFixed(2);
            const west = (bounds.lon - 2).toFixed(2);
            const north = (bounds.lat + 2).toFixed(2);
            const east = (bounds.lon + 2).toFixed(2);
            const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(credential)}/VIIRS_SNPP_NRT/${west},${south},${east},${north}/1`;
            const text = await fetchText(url, { timeoutMs: 15000 });
            const lines = String(text).split(/\r?\n/).filter(l => l.trim());
            if (lines.length < 2) return [];
            const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
            const out = [];
            for (const line of lines.slice(1, 501)) { // bounded 500 titik
                const cells = line.split(",");
                const row = {};
                headers.forEach((h, i) => { row[h] = cells[i]; });
                const lat = Number(row.latitude), lon = Number(row.longitude);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                out.push({
                    type: OBSERVATION_TYPE.FIRE,
                    geometry: { type: "point", lat, lon },
                    observedAt: Date.parse(`${row.acq_date}T${String(row.acq_time ?? "0000").padStart(4, "0").replace(/(\d{2})(\d{2})/, "$1:$2")}:00Z`) || Date.now(),
                    confidence: Math.min(0.95, (Number(row.confidence) || 50) / 100 + 0.3),
                    quality: 0.85,
                    accessClass: ACCESS_CLASS.PUBLIC,
                    attributes: {
                        brightnessK: Number(row.bright_ti4) || null,
                        frp: Number(row.frp) || null,
                        satellite: row.satellite ?? "VIIRS",
                        dayNight: row.daynight ?? null
                    },
                    attribution: "NASA FIRMS (VIIRS S-NPP/NOAA-20)",
                    license: "NASA open data (FIRMS terms)"
                });
            }
            return out;
        }
    };
}

/**
 * AISStream — PLUS, API_KEY. Streaming WebSocket di upstream GEV; Mata Dewa
 * v1 menahan diri: butuh koneksi ws persisten. Stub fail-closed yang jujur —
 * provider terdaftar dengan kelas akses benar dan TIDAK berpura-pura hidup.
 */
function createAisStreamProvider() {
    return {
        id: "aisstream",
        label: "AISStream Live Vessels",
        types: [OBSERVATION_TYPE.VESSEL],
        accessMode: PROVIDER_ACCESS_MODE.API_KEY,
        accessClass: ACCESS_CLASS.PUBLIC,
        credentialTier: "PLUS",
        coverage: { kind: "global" },
        freshnessMs: 60 * 1000,
        quality: 0.8,
        attribution: "AISStream.io",
        license: "AISStream ToS",
        fallbacks: [],
        // v1: butuh sesi WebSocket persisten; tidak dipoll di sini.
        poll: null,
        streaming: true,
        notes: "Butuh sesi WebSocket persisten dengan API key; aktivasi v2."
    };
}

/**
 * OpenSky — PLUS, OAUTH (client credentials). Token di-mint via jalur vault
 * saat dipoll; tanpa client_id/secret → credentials_absent (jujur).
 */
function createOpenSkyProvider() {
    return {
        id: "opensky-network",
        label: "OpenSky Network",
        types: [OBSERVATION_TYPE.FLIGHT],
        accessMode: PROVIDER_ACCESS_MODE.OAUTH,
        accessClass: ACCESS_CLASS.PUBLIC,
        credentialTier: "PLUS",
        coverage: { kind: "global" },
        freshnessMs: 10 * 1000,
        quality: 0.9,
        attribution: "The OpenSky Network",
        license: "OpenSky ToS (non-commercial default)",
        fallbacks: ["adsb-lol-flights"],
        async poll({ bounds, credential }) {
            // credential = { client_id, client_secret } dari vault (resolveIn)
            if (!isValidPoint(bounds)) return [];
            const token = await mintOpenSkyToken(credential);
            const url = `https://opensky-network.org/api/states/all?lamin=${(bounds.lat - 2).toFixed(2)}&lomin=${(bounds.lon - 2).toFixed(2)}&lamax=${(bounds.lat + 2).toFixed(2)}&lomax=${(bounds.lon + 2).toFixed(2)}`;
            const data = await fetchJson(url, { timeoutMs: 15000, headers: { Authorization: `Bearer ${token}` } });
            const states = Array.isArray(data?.states) ? data.states : [];
            const nowMs = Date.now();
            return states.slice(0, 300).map(s => ({
                type: OBSERVATION_TYPE.FLIGHT,
                geometry: s[5] != null && s[6] != null ? { type: "point", lat: s[6], lon: s[5] } : null,
                observedAt: Number.isFinite(Number(s[3])) ? Number(s[3]) * 1000 : nowMs,
                confidence: 0.9,
                quality: 0.9,
                accessClass: ACCESS_CLASS.PUBLIC,
                attributes: {
                    icao24: s[0] ?? null,
                    callsign: typeof s[1] === "string" ? s[1].trim() : null,
                    altitudeM: s[7] ?? null,
                    onGround: s[8] === true
                },
                attribution: "The OpenSky Network",
                license: "OpenSky ToS (non-commercial default)"
            })).filter(o => o.geometry && !o.attributes.onGround);
        }
    };
}

/** Mint token OpenSky dari kredensial vault (tidak pernah di-log). */
async function mintOpenSkyToken(credential) {
    if (!credential?.client_id || !credential?.client_secret) {
        throw new Error("OpenSky client_id/client_secret tidak lengkap");
    }
    const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credential.client_id,
        client_secret: credential.client_secret
    });
    const data = await fetchJson("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", {
        timeoutMs: 10000
    }).catch(async () => {
        // POST form diperlukan untuk token endpoint.
        const { fetchPostJson } = require("./http");
        return fetchPostJson("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", body.toString(), { timeoutMs: 10000 });
    });
    if (!data?.access_token) throw new Error("OpenSky token gagal di-mint");
    return data.access_token;
}

/**
 * Vaisala/Xweather lightning — PRO. Endpoint komersial proprietary;
 * v1 stub fail-closed jujur sampai kredensial+endpoint dikonfirmasi pemilik.
 */
function createVaisalaLightningProvider() {
    return {
        id: "vaisala-xweather",
        label: "Vaisala Xweather Lightning",
        types: ["lightning"],
        accessMode: PROVIDER_ACCESS_MODE.API_KEY,
        accessClass: ACCESS_CLASS.RESTRICTED,
        credentialTier: "PRO",
        coverage: { kind: "global" },
        freshnessMs: 60 * 1000,
        quality: 0.95,
        attribution: "Vaisala Xweather",
        license: "Vaisala commercial terms (restricted)",
        fallbacks: [],
        poll: null,
        notes: "Endpoint komersial proprietary — aktif hanya dengan kredensial terkonfirmasi."
    };
}

/**
 * Daftarkan provider opsional berkunci. Aman dipanggil saat boot — provider
 * yang butuh kredensial melapor UNAVAILABLE secara jujur sampai kredensial
 * terpasang via vault.
 */
function registerKeyedProviders(service) {
    const factories = [
        createTomTomProvider,
        createFirmsProvider,
        createAisStreamProvider,
        createOpenSkyProvider,
        createVaisalaLightningProvider
    ];
    const registered = [];
    for (const factory of factories) {
        const descriptor = factory();
        if (service.registry.getProvider(descriptor.id)) continue;
        try {
            registered.push(service.registerProvider(descriptor));
        }
        catch { /* satu provider gagal ≠ baseline gagal */ }
    }
    return registered;
}

module.exports = {
    registerKeyedProviders,
    createTomTomProvider,
    createFirmsProvider,
    createAisStreamProvider,
    createOpenSkyProvider,
    createVaisalaLightningProvider
};
