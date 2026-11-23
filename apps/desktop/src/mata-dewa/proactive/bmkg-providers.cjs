'use strict';
// BMKG + PVMBG input providers for the proactive alert engine (Fase 6).
// All sources are official public data of the Indonesian agencies:
//   - BMKG earthquake lists: https://data.bmkg.go.id/DataMKG/TEWS/
//     (autogempa.json = latest, gempaterkini.json = recent M5+ list). The
//     `Potensi` field is BMKG's own tsunami-potential wording, carried
//     through verbatim - DAMAR relays it, never re-assesses it.
//   - BMKG village forecast: https://api.bmkg.go.id/publik/prakiraan-cuaca
//     (requires the wilayah code `adm4` of a watch point; points without
//     one are skipped honestly - no region is ever guessed).
//   - PVMBG volcano status (MAGMA Indonesia): no public machine-readable
//     feed could be verified, so - exactly like the Sentinel-2 scenes
//     input - the volcanoes provider is intentionally NOT composed live.
//     normalizeVolcanoStatus() below joins a status list (when one is
//     supplied through configuration) onto the built-in coordinate
//     catalog of major Indonesian volcanoes (public reference data,
//     PVMBG/GVP); unknown names are dropped, never geocoded by guess.

const QUAKE_URL = 'https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json';
const FORECAST_URL = 'https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=';
const QUAKE_CACHE_MS = 60e3;

function parseCoordinates(s) {
  const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(String(s || '').trim());
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

// BMKG quake JSON -> the engine's normalized quake shape (same fields the
// USGS-backed quake-near rule consumes, plus BMKG's verbatim `potensi`).
function normalizeBmkgQuakes(json) {
  const raw = json?.Infogempa?.gempa;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  for (const g of list) {
    const c = parseCoordinates(g?.Coordinates);
    const magnitude = num(g?.Magnitude);
    if (!c || magnitude === null) continue;
    const time = typeof g?.DateTime === 'string' ? g.DateTime : null;
    out.push({
      id: 'bmkg:' + (time || '') + ':' + c.lat.toFixed(2) + ',' + c.lon.toFixed(2),
      magnitude, depthKm: num(String(g?.Kedalaman || '').replace(/[^0-9.]/g, '')),
      lat: c.lat, lon: c.lon, time,
      place: typeof g?.Wilayah === 'string' ? g.Wilayah : '',
      potensi: typeof g?.Potensi === 'string' ? g.Potensi : '',
      url: null, source: 'BMKG',
    });
  }
  return out;
}

// BMKG village forecast JSON -> flat hourly entries for the storm rule.
function normalizeBmkgForecast(json) {
  const days = json?.data?.[0]?.cuaca;
  if (!Array.isArray(days)) return [];
  const out = [];
  for (const day of days) for (const e of Array.isArray(day) ? day : []) {
    if (!e || typeof e.datetime !== 'string') continue;
    out.push({
      time: e.datetime,
      weatherCode: Number.isSafeInteger(e.weather) ? e.weather : null,
      weatherDesc: typeof e.weather_desc === 'string' ? e.weather_desc : '',
      precipitationMm: typeof e.tp === 'number' ? e.tp : null,
      windKmh: typeof e.ws === 'number' ? e.ws : null,
    });
  }
  return out;
}

// Major Indonesian volcanoes: name -> summit coordinates (public
// reference data). Status levels always come from PVMBG via the feed;
// this catalog only supplies positions, never activity claims.
const VOLCANO_CATALOG = Object.freeze([
  ['Merapi', -7.540, 110.446], ['Semeru', -8.108, 112.922], ['Agung', -8.342, 115.508],
  ['Sinabung', 3.170, 98.392], ['Kelud', -7.930, 112.308], ['Bromo', -7.942, 112.953],
  ['Ijen', -8.058, 114.242], ['Tambora', -8.245, 117.991], ['Rinjani', -8.415, 116.457],
  ['Anak Krakatau', -6.102, 105.423], ['Kerinci', -1.697, 101.264], ['Dempo', -4.030, 103.130],
  ['Marapi', -0.381, 100.473], ['Slamet', -7.242, 109.208], ['Raung', -8.125, 114.042],
  ['Dukono', 1.699, 127.894], ['Ibu', 1.488, 127.630], ['Lewotobi', -8.542, 122.775],
  ['Ruang', 2.305, 125.365], ['Awu', 3.665, 125.503], ['Lokon', 1.358, 124.792],
  ['Soputan', 1.108, 124.737], ['Gamalama', 0.809, 127.322], ['Banda Api', -4.523, 129.871],
].map(([name, lat, lon]) => Object.freeze({ name, lat, lon })));

const LEVEL_LABELS = Object.freeze({ 1: 'Normal', 2: 'Waspada', 3: 'Siaga', 4: 'Awas' });
function levelOf(v) {
  if (Number.isSafeInteger(v) && v >= 1 && v <= 4) return v;
  const s = String(v || '').toLowerCase();
  for (const [n, label] of Object.entries(LEVEL_LABELS)) if (s.includes(label.toLowerCase())) return Number(n);
  if (s.includes('iv') || s.includes('awas')) return 4;
  if (s.includes('iii') || s.includes('siaga')) return 3;
  if (s.includes('ii') || s.includes('waspada')) return 2;
  if (s.includes('normal')) return 1;
  return null;
}

// A status list [{ name, level|status }] -> engine items with catalog
// coordinates. Names not in the catalog are dropped (never guessed).
function normalizeVolcanoStatus(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const row of list) {
    const name = String(row?.name || '').trim();
    const cat = VOLCANO_CATALOG.find(v => v.name.toLowerCase() === name.toLowerCase());
    const level = levelOf(row?.level ?? row?.status);
    if (!cat || level === null) continue;
    out.push({ name: cat.name, lat: cat.lat, lon: cat.lon, level, levelLabel: LEVEL_LABELS[level], source: 'PVMBG (MAGMA Indonesia)' });
  }
  return out;
}

// Engine providers. fetchText(url) -> Promise<string> is injected (the
// mata-dewa egress in production, a stub in tests).
function createBmkgProviders({ fetchText, now = Date.now } = {}) {
  if (typeof fetchText !== 'function') throw Error('BMKG_FETCH_REQUIRED');
  let quakeCache = null, quakeAt = 0;
  return Object.freeze({
    async bmkgQuakes() {
      if (quakeCache && now() - quakeAt < QUAKE_CACHE_MS) return quakeCache;
      const text = await fetchText(QUAKE_URL);
      quakeCache = normalizeBmkgQuakes(JSON.parse(text));
      quakeAt = now();
      return quakeCache;
    },
    async bmkgForecast(location) {
      if (!location || typeof location.adm4 !== 'string' || !/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/.test(location.adm4)) return [];
      const text = await fetchText(FORECAST_URL + encodeURIComponent(location.adm4));
      return normalizeBmkgForecast(JSON.parse(text));
    },
  });
}

module.exports = { createBmkgProviders, normalizeBmkgQuakes, normalizeBmkgForecast, normalizeVolcanoStatus, VOLCANO_CATALOG, LEVEL_LABELS, QUAKE_URL, FORECAST_URL };
