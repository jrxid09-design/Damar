'use strict';
// feed table rev: 18386e413fbd0a98
// Mata Dewa feeds (public keyless + Owner-key feeds) and the `mataDewa.*` Core settings rules.
// Normalisers are ported from DAMAR's earlier Mata Dewa providers (usgs, openMeteo, adsbLol, celestrak, keyed) and
// adapted from gods-eye-view (MIT, see THIRD_PARTY_NOTICES.md). None of these feeds is DAMAR sensing: they are
// third-party observations with their own latency, coverage and terms.
// A feed has either url()+parse() (one GET through egress.fetchPublic) or load(area, cfg, ctx) for multi-step sources
// (OAuth token, WebSocket window). ctx = { fetch, key, ws, now }.

const imagery = require('./imagery.cjs');
const { normalizeBmkgQuakes } = require('./proactive/bmkg-providers.cjs');
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v, n = 120) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n) || null : null);
const round = (v, d) => (v === null ? null : Number(v.toFixed(d)));
const KM_PER_NM = 1.852, FT_PER_M = 3.28084, KT_PER_MS = 1.943844;
const fail = code => Object.assign(Error(code), { code });
const q = o => new URLSearchParams(o).toString();
const bbox = a => { const dLat = a.radiusKm / 111, dLon = a.radiusKm / (111 * Math.max(0.1, Math.cos(a.lat * Math.PI / 180)));
  return { s: Math.max(-90, a.lat - dLat), n: Math.min(90, a.lat + dLat), w: Math.max(-180, a.lon - dLon), e: Math.min(180, a.lon + dLon) }; };

// --- aircraft (Owner decision 2026-11-21) ------------------------------------------------------------------------
// Public ADS-B broadcasts are shown with full identifiers (hex, callsign, registration, type) for commercial,
// general, military and state aircraft. Aircraft in the FAA LADD / PIA privacy programs (adsb.lol dbFlags 8 / 4) are
// withheld entirely and only counted. Only the latest snapshot is held: no history, no tracks over time.
function redactAircraft(ac) {
  const flags = Number(ac?.dbFlags) || 0;
  if (flags & (4 | 8)) return null;
  const lat = num(ac?.lat), lon = num(ac?.lon);
  if (lat === null || lon === null) return null;
  return {
    hex: typeof ac.hex === 'string' && /^~?[0-9a-f]{6}$/i.test(ac.hex) ? ac.hex.toLowerCase() : null,
    callsign: str(ac.flight, 10), registration: str(ac.r, 12), type: str(ac.t, 6), military: !!(flags & 1),
    lat: round(lat, 4), lon: round(lon, 4), altitudeFt: ac.alt_baro === 'ground' ? 0 : num(ac.alt_baro),
    groundSpeedKt: round(num(ac.gs), 0), trackDeg: round(num(ac.track), 0), onGround: ac.alt_baro === 'ground',
  };
}
function parseAdsb(text) {
  const list = JSON.parse(text).ac || []; const items = list.map(redactAircraft).filter(Boolean).slice(0, 1000);
  return Object.assign(items, { withheld: list.filter(a => (Number(a?.dbFlags) || 0) & 12).length });
}
// OpenSky state vector -> same shape (OpenSky publishes no LADD/PIA flag; see FEATURE_MATRIX risk note).
function openskyState(s) {
  if (!Array.isArray(s)) return null;
  return redactAircraft({ hex: s[0], flight: s[1], lat: s[6], lon: s[5], alt_baro: s[8] ? 'ground' : (num(s[7]) === null ? null : Math.round(s[7] * FT_PER_M)), gs: num(s[9]) === null ? null : s[9] * KT_PER_MS, track: s[10] });
}

// --- vessels (AIS) ------------------------------------------------------------------------------------------------
// Identifiers (MMSI, IMO, name, call sign) are kept only for vessels that declare a commercial/service AIS ship type
// (passenger 60-69, cargo 70-79, tanker 80-89, high-speed 40-49, special craft 50-59, towing 31-32, dredging 33,
// diving 34, military 35). Pleasure craft (37), sailing (36), fishing (30) and unknown types are shown anonymously
// with positions rounded to 0.01 deg.
const COMMERCIAL_SHIP = t => (t >= 31 && t <= 35) || (t >= 40 && t <= 89);
function vesselsFrom(messages) {
  const byMmsi = new Map(), types = new Map();
  for (const m of messages) {
    const md = m?.MetaData || {}, mmsi = num(md.MMSI); if (!mmsi) continue;
    if (m.MessageType === 'ShipStaticData') { const s = m.Message?.ShipStaticData || {}; types.set(mmsi, { type: num(s.Type), imo: num(s.ImoNumber) || null, callSign: str(s.CallSign, 10), name: str(s.Name, 40), destination: str(s.Destination, 40) }); }
    if (m.MessageType === 'PositionReport') { const p = m.Message?.PositionReport || {}; byMmsi.set(mmsi, { lat: num(p.Latitude ?? md.latitude), lon: num(p.Longitude ?? md.longitude), sog: num(p.Sog), cog: num(p.Cog), name: str(md.ShipName, 40) }); }
  }
  const out = []; let anonymous = 0;
  for (const [mmsi, p] of byMmsi) {
    if (p.lat === null || p.lon === null) continue;
    const st = types.get(mmsi), commercial = !!st && COMMERCIAL_SHIP(st.type);
    if (!commercial) anonymous++;
    out.push(commercial ? { mmsi: String(mmsi), imo: st.imo ? String(st.imo) : null, name: st.name || p.name, callSign: st.callSign, shipType: st.type, destination: st.destination, lat: round(p.lat, 4), lon: round(p.lon, 4), speedKt: p.sog, courseDeg: p.cog }
      : { mmsi: null, name: null, shipType: st?.type ?? null, lat: round(p.lat, 2), lon: round(p.lon, 2), speedKt: p.sog, courseDeg: p.cog });
  }
  return Object.assign(out.slice(0, 1000), { anonymous });
}

// --- TLE (CelesTrak) ----------------------------------------------------------------------------------------------
// Mean elements only (no SGP4 propagation): epoch, inclination, period and mean perigee/apogee altitude.
const MU = 398600.4418, RE = 6378.137;
function tleEpoch(line1) {
  const m = /^1 .{16}(\d{2})(\d{3}\.\d+)/.exec(line1 || ''); if (!m) return null;
  const yy = Number(m[1]); return Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (Number(m[2]) - 1) * 86400000;
}
function parseTle(text, limit = 300) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean), out = [];
  for (let i = 0; i + 2 < lines.length && out.length < limit; i++) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
    i += 2;
    const epoch = tleEpoch(l1), inc = num(l2.slice(8, 16)), ecc = num('0.' + l2.slice(26, 33).trim()), mm = num(l2.slice(52, 63));
    if (!epoch || inc === null || ecc === null || !mm) continue;
    const n = mm * 2 * Math.PI / 86400, a = Math.cbrt(MU / (n * n));
    out.push({ name: str(name.replace(/^0 /, ''), 40), noradId: str(l2.slice(2, 7)), epoch: new Date(epoch).toISOString(), inclinationDeg: round(inc, 2),
      periodMin: round(1440 / mm, 1), perigeeKm: Math.round(a * (1 - ecc) - RE), apogeeKm: Math.round(a * (1 + ecc) - RE) });
  }
  return out;
}

function parseFirmsCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (!/^latitude,longitude,/.test(lines[0] || '')) throw fail('UPSTREAM_KEY_REJECTED');
  const h = lines[0].split(','), ix = k => h.indexOf(k);
  return lines.slice(1, 2001).map(l => { const c = l.split(','); const lat = num(c[ix('latitude')]), lon = num(c[ix('longitude')]); if (lat === null || lon === null) return null;
    return { lat: round(lat, 4), lon: round(lon, 4), acquired: str(c[ix('acq_date')] + 'T' + String(c[ix('acq_time')] || '').padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2') + 'Z', 24),
      confidence: str(c[ix('confidence')], 8), frpMw: num(c[ix('frp')]), satellite: str(c[ix('satellite')], 8), dayNight: str(c[ix('daynight')], 2) }; }).filter(Boolean);
}

const SAT_GROUPS = ['stations', 'visual', 'weather', 'gps-ops', 'science', 'geo'];

const FEEDS = Object.freeze({
  // Indonesia first (Owner rule 2026-11-28): BMKG is the primary earthquake
  // source for Indonesia; the USGS feed below is the global backfill. BMKG's
  // own tsunami-potential wording (`potensi`) is carried verbatim on every
  // item and relayed, never rewritten (see the tsunami-relay rule).
  bmkgEarthquakes: {
    label: 'Gempa bumi (BMKG)', host: 'data.bmkg.go.id', perArea: false, minRefreshSec: 60, defaultRefreshSec: 300, maxBytes: 1024 * 1024,
    attribution: 'BMKG (Badan Meteorologi, Klimatologi, dan Geofisika)', license: 'Data terbuka BMKG', commercial: 'yes', limits: 'No key. Recent M5+ list plus the latest quake, republished by BMKG from its TEWS network.',
    url: () => 'https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json',
    parse: text => normalizeBmkgQuakes(JSON.parse(text)).map(g => ({ id: g.id, lat: round(g.lat, 3), lon: round(g.lon, 3), depthKm: g.depthKm, magnitude: g.magnitude,
      place: str(g.place, 160), time: g.time, potensi: str(g.potensi, 200), source: 'BMKG' })).filter(g => g.lat !== null && g.lon !== null).slice(0, 100),
  },
  earthquakes: {
    label: 'Earthquakes (24 h)', host: 'earthquake.usgs.gov', perArea: false, minRefreshSec: 60, defaultRefreshSec: 300, maxBytes: 4 * 1024 * 1024,
    attribution: 'USGS Earthquake Hazards Program', license: 'U.S. public domain', commercial: 'yes', limits: 'No key. Feed regenerated every minute.',
    url: () => 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    parse: text => (JSON.parse(text).features || []).map(f => {
      const c = f?.geometry?.coordinates, p = f?.properties || {};
      if (!Array.isArray(c) || num(c[0]) === null || num(c[1]) === null || !num(p.time)) return null;
      return { id: str(f.id, 40), lat: round(Number(c[1]), 3), lon: round(Number(c[0]), 3), depthKm: round(num(c[2]), 1), magnitude: num(p.mag), place: str(p.place),
        time: new Date(Number(p.time)).toISOString(), tsunami: p.tsunami === 1,
        url: typeof p.url === 'string' && p.url.startsWith('https://earthquake.usgs.gov/') ? p.url.slice(0, 200) : null };
    }).filter(Boolean).sort((a, b) => (b.magnitude ?? -9) - (a.magnitude ?? -9)).slice(0, 300),
  },
  weather: {
    label: 'Weather now (MET Norway)', host: 'api.met.no', perArea: true, minRefreshSec: 600, defaultRefreshSec: 1800, maxBytes: 512 * 1024,
    attribution: 'Data from MET Norway (The Norwegian Meteorological Institute)', license: 'CC BY 4.0 / NLOD 2.0', commercial: 'yes (attribution; identifying User-Agent required)',
    limits: 'No key. Must send an identifying User-Agent (DAMAR/<version> + optional contact); ≤ 20 req/s; DAMAR caches ≥ 10 min.',
    url: a => 'https://api.met.no/weatherapi/locationforecast/2.0/compact?' + q({ lat: a.lat.toFixed(4), lon: a.lon.toFixed(4) }),
    parse: text => { const ts = JSON.parse(text).properties?.timeseries?.[0]; const d = ts?.data?.instant?.details; if (!d) return [];
      const n1 = ts.data.next_1_hours || {};
      return [{ time: str(ts.time, 32), temperatureC: num(d.air_temperature), humidityPct: num(d.relative_humidity), precipitationMm: num(n1.details?.precipitation_amount), symbol: str(n1.summary?.symbol_code, 40),
        cloudCoverPct: num(d.cloud_area_fraction), windKmh: num(d.wind_speed) === null ? null : round(d.wind_speed * 3.6, 1), windDirDeg: num(d.wind_from_direction), pressureHpa: num(d.air_pressure_at_sea_level) }]; },
  },
  openMeteo: {
    label: 'Weather now (Open-Meteo, non-commercial)', host: 'api.open-meteo.com', perArea: true, minRefreshSec: 600, defaultRefreshSec: 900, maxBytes: 64 * 1024,
    attribution: 'Weather data by Open-Meteo.com', license: 'CC BY 4.0 data; free API is non-commercial only', commercial: 'no (needs Open-Meteo paid API)', limits: 'No key. Free tier < 10,000 calls/day, non-commercial.',
    url: a => 'https://api.open-meteo.com/v1/forecast?' + q({ latitude: a.lat.toFixed(4), longitude: a.lon.toFixed(4), timezone: 'UTC',
      current: 'temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m' }),
    parse: text => { const c = JSON.parse(text).current || {}; if (!c.time) return [];
      return [{ time: str(c.time, 32), temperatureC: num(c.temperature_2m), apparentC: num(c.apparent_temperature), precipitationMm: num(c.precipitation), weatherCode: num(c.weather_code),
        cloudCoverPct: num(c.cloud_cover), windKmh: num(c.wind_speed_10m), windDirDeg: num(c.wind_direction_10m) }]; },
  },
  airQuality: {
    label: 'Air quality now (Open-Meteo, non-commercial)', host: 'air-quality-api.open-meteo.com', perArea: true, minRefreshSec: 900, defaultRefreshSec: 1800, maxBytes: 64 * 1024,
    attribution: 'Air quality by Open-Meteo.com (CAMS)', license: 'CC BY 4.0; CAMS © ECMWF/Copernicus; free API non-commercial', commercial: 'no (needs Open-Meteo paid API)', limits: 'No key. Open-Meteo free-tier limits. Model estimate, not a monitor reading.',
    url: a => 'https://air-quality-api.open-meteo.com/v1/air-quality?' + q({ latitude: a.lat.toFixed(4), longitude: a.lon.toFixed(4), timezone: 'UTC', current: 'european_aqi,us_aqi,pm2_5,pm10' }),
    parse: text => { const c = JSON.parse(text).current || {}; if (!c.time) return [];
      return [{ time: str(c.time, 32), europeanAqi: num(c.european_aqi), usAqi: num(c.us_aqi), pm25: num(c.pm2_5), pm10: num(c.pm10) }]; },
  },
  flights: {
    label: 'Aircraft in area (ADS-B)', host: 'api.adsb.lol', perArea: true, minRefreshSec: 30, defaultRefreshSec: 120, maxBytes: 4 * 1024 * 1024,
    attribution: 'adsb.lol contributors', license: 'ODbL 1.0 (attribution + share-alike on the data)', commercial: 'yes with ODbL attribution/share-alike', limits: 'No key. No published quota; ≥ 30 s per area, radius ≤ 250 nm.',
    url: a => `https://api.adsb.lol/v2/lat/${a.lat.toFixed(3)}/lon/${a.lon.toFixed(3)}/dist/${Math.min(250, Math.max(1, Math.round(a.radiusKm / KM_PER_NM)))}`,
    parse: parseAdsb,
  },
  military: {
    label: 'Military & state aircraft (worldwide)', host: 'api.adsb.lol', perArea: false, minRefreshSec: 60, defaultRefreshSec: 300, maxBytes: 4 * 1024 * 1024,
    attribution: 'adsb.lol contributors', license: 'ODbL 1.0', commercial: 'yes with ODbL attribution/share-alike', limits: 'No key. ≥ 60 s.',
    url: () => 'https://api.adsb.lol/v2/mil',
    parse: parseAdsb,
  },
  satellites: {
    label: 'Satellites (orbital elements)', host: 'celestrak.org', perArea: false, minRefreshSec: 7200, defaultRefreshSec: 21600, maxBytes: 2 * 1024 * 1024,
    attribution: 'CelesTrak (T.S. Kelso)', license: 'Public data; citation requested', commercial: 'yes (citation)', limits: 'No key. ≤ 1 download per group per 2 h.',
    url: (_a, s) => 'https://celestrak.org/NORAD/elements/gp.php?' + q({ GROUP: SAT_GROUPS.includes(s?.satelliteGroup) ? s.satelliteGroup : 'stations', FORMAT: 'tle' }),
    parse: text => parseTle(text),
  },
  launches: {
    label: 'Upcoming launches', host: 'll.thespacedevs.com', perArea: false, minRefreshSec: 600, defaultRefreshSec: 3600, maxBytes: 1024 * 1024,
    attribution: 'Launch Library 2 — The Space Devs', license: 'The Space Devs terms (free use, attribution encouraged)', commercial: 'yes', limits: 'No key: 15 calls/hour. ≥ 10 min.',
    url: () => 'https://ll.thespacedevs.com/2.3.0/launches/upcoming/?' + q({ limit: '10', mode: 'normal' }),
    parse: text => (JSON.parse(text).results || []).slice(0, 10).map(r => ({ name: str(r.name), net: str(r.net, 32), status: str(r.status?.abbrev, 24),
      provider: str(r.launch_service_provider?.name, 80), orbit: str(r.mission?.orbit?.abbrev, 16), pad: str(r.pad?.name, 80), location: str(r.pad?.location?.name, 80),
      lat: num(r.pad?.latitude), lon: num(r.pad?.longitude) })),
  },
  cyclones: {
    label: 'Tropical cyclones (NHC/CPHC)', host: 'www.nhc.noaa.gov', perArea: false, minRefreshSec: 300, defaultRefreshSec: 900, maxBytes: 512 * 1024,
    attribution: 'NOAA/NWS National Hurricane Center & Central Pacific Hurricane Center', license: 'U.S. public domain (NWS)', commercial: 'yes', limits: 'No key. Atlantic and eastern/central North Pacific only.',
    url: () => 'https://www.nhc.noaa.gov/CurrentStorms.json',
    parse: text => (JSON.parse(text).activeStorms || []).slice(0, 50).map(s => ({ id: str(s.id, 16), name: str(s.name, 40), classification: str(s.classification, 4),
      intensityKt: num(s.intensity), pressureMb: num(s.pressure), lat: num(s.latitudeNumeric), lon: num(s.longitudeNumeric), movementDir: num(s.movementDir), movementKt: num(s.movementSpeed), updated: str(s.lastUpdate, 32) })).filter(s => s.lat !== null && s.lon !== null),
  },
  disasters: {
    label: 'Global disaster alerts (GDACS)', host: 'www.gdacs.org', perArea: false, minRefreshSec: 600, defaultRefreshSec: 1800, maxBytes: 4 * 1024 * 1024,
    attribution: 'GDACS — Global Disaster Alert and Coordination System (UN, European Commission JRC)', license: 'GDACS terms of use; JRC content under the EC reuse policy (CC BY 4.0) unless stated — confirm for commercial use',
    commercial: 'likely (EC reuse policy) — confirm', limits: 'No key. Tropical cyclones (all basins incl. western Pacific), earthquakes, floods, volcanoes, droughts, wildfires. Indicative only.',
    url: () => 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC;EQ;FL;VO;DR;WF',
    parse: text => (JSON.parse(text).features || []).map(f => { const p = f.properties || {}, c = f.geometry?.coordinates || [];
      if (num(c[0]) === null || num(c[1]) === null) return null;
      return { id: str(String(p.eventtype) + '-' + String(p.eventid), 32), type: str(p.eventtype, 4), name: str(p.name, 100), alert: str(p.alertlevel, 8), country: str(p.country, 80),
        severity: str(p.severitydata?.severitytext, 120), from: str(p.fromdate, 32), to: str(p.todate, 32), lat: round(num(c[1]), 3), lon: round(num(c[0]), 3),
        url: typeof p.url?.report === 'string' && p.url.report.startsWith('https://www.gdacs.org/') ? p.url.report.slice(0, 200) : null }; })
      .filter(Boolean).sort((a, b) => ({ Red: 0, Orange: 1, Green: 2 }[a.alert] ?? 3) - ({ Red: 0, Orange: 1, Green: 2 }[b.alert] ?? 3)).slice(0, 300),
  },
  imagery: {
    label: 'Satellite imagery (latest dated pass)', host: 'cmr.earthdata.nasa.gov', perArea: false, minRefreshSec: 900, defaultRefreshSec: 3600, maxBytes: 2 * 1024 * 1024,
    attribution: 'NASA EOSDIS HLS (GIBS / Worldview); contains modified Copernicus Sentinel data', license: 'NASA open data; Sentinel-2 data via ESA/Copernicus (free, full and open access)', commercial: 'yes',
    limits: 'No key. One latest dated pass per watch location (Sentinel-2 / Landsat via HLS, 30 m). Revisit is days, not a live feed; the acquisition date is always shown.',
    async load(_a, cfg, ctx) {
      const locations = [
        ...(cfg.areas || []).map(a => ({ locationId: 'area:' + a.id, name: a.name, profile: 'personal', lat: a.lat, lon: a.lon })),
        ...(cfg.watchPoints || []).map(w => ({ locationId: 'wp:' + w.id, name: w.name, profile: w.profile, lat: w.lat, lon: w.lon })),
      ];
      const items = [];
      for (const loc of locations) {
        try {
          const scenes = await imagery.latestScenes(loc, ctx);
          const s = scenes[0];
          if (s) items.push({ locationId: loc.locationId, name: loc.name, profile: loc.profile, lat: loc.lat, lon: loc.lon,
            product: s.product, productLabel: s.label, sceneId: s.id, datetime: s.datetime, day: s.day, cloudCoverPct: s.cloudCoverPct });
        } catch {}
      }
      if (!items.length && locations.length) throw fail('IMAGERY_NO_SCENES');
      return items;
    },
  },
  // ---- Owner-key feeds (key stored DPAPI as matadewa-<feed>, never returned) ----
  openaq: {
    label: 'Air quality, measured (OpenAQ)', host: 'api.openaq.org', perArea: true, minRefreshSec: 900, defaultRefreshSec: 1800, maxBytes: 2 * 1024 * 1024,
    credential: { fields: ['apiKey'], signupUrl: 'https://explore.openaq.org/register' },
    attribution: 'OpenAQ and the originating data providers', license: 'OpenAQ terms; data licence per provider (mostly CC BY 4.0)', commercial: 'yes per provider licence (check each source)',
    limits: 'Free key: 60 req/min, 2,000/hour. DAMAR: nearest station within 25 km, 2 requests per refresh.',
    async load(a, _cfg, ctx) {
      const h = { headers: { 'x-api-key': ctx.key }, maxBytes: this.maxBytes };
      const locs = JSON.parse(await ctx.fetch('https://api.openaq.org/v3/locations?' + q({ coordinates: a.lat.toFixed(4) + ',' + a.lon.toFixed(4), radius: '25000', limit: '5' }), h)).results || [];
      const loc = locs[0]; if (!loc || !Number.isSafeInteger(loc.id)) return [];
      const params = new Map((loc.sensors || []).map(s => [s.id, s.parameter || {}]));
      const latest = JSON.parse(await ctx.fetch(`https://api.openaq.org/v3/locations/${loc.id}/latest`, h)).results || [];
      return [{ station: str(loc.name, 80), locality: str(loc.locality, 80), lat: num(loc.coordinates?.latitude), lon: num(loc.coordinates?.longitude),
        readings: latest.slice(0, 20).map(r => { const p = params.get(r.sensorsId) || {}; return { parameter: str(p.name, 16), units: str(p.units, 16), value: num(r.value), time: str(r.datetime?.utc, 32) }; }).filter(r => r.parameter) }];
    },
  },
  opensky: {
    label: 'Aircraft in area (OpenSky)', host: 'opensky-network.org', perArea: true, minRefreshSec: 60, defaultRefreshSec: 300, maxBytes: 4 * 1024 * 1024,
    credential: { fields: ['clientId', 'clientSecret'], signupUrl: 'https://opensky-network.org/my-opensky/account' },
    attribution: 'The OpenSky Network, https://opensky-network.org', license: 'OpenSky terms: non-commercial research/education', commercial: 'no (needs an OpenSky commercial agreement)', limits: 'Credit-based (about 4,000 credits/day for registered users).',
    async load(a, _cfg, ctx) {
      const [clientId, clientSecret] = String(ctx.key).split('\n');
      const tok = JSON.parse(await ctx.fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', { method: 'POST', maxBytes: 16 * 1024,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret || '' }) }));
      if (!tok.access_token) throw fail('UPSTREAM_AUTH_REJECTED');
      const b = bbox(a);
      const data = JSON.parse(await ctx.fetch('https://opensky-network.org/api/states/all?' + q({ lamin: b.s.toFixed(3), lomin: b.w.toFixed(3), lamax: b.n.toFixed(3), lomax: b.e.toFixed(3) }),
        { maxBytes: this.maxBytes, headers: { authorization: 'Bearer ' + tok.access_token } }));
      return (data.states || []).map(openskyState).filter(Boolean).slice(0, 1000);
    },
  },
  vessels: {
    label: 'Vessels in area (AIS)', host: 'stream.aisstream.io', perArea: true, minRefreshSec: 120, defaultRefreshSec: 600, maxBytes: 4 * 1024 * 1024,
    credential: { fields: ['apiKey'], signupUrl: 'https://aisstream.io/authenticate' },
    attribution: 'AISStream.io', license: 'AISStream beta terms (free; AIS is a public broadcast)', commercial: 'unclear (beta, no formal terms)', limits: 'Free key. DAMAR listens 8 s per refresh, ≤ 1,000 vessels.',
    async load(a, _cfg, ctx) {
      const b = bbox(a);
      const messages = await ctx.ws('wss://stream.aisstream.io/v0/stream', { APIKey: ctx.key, BoundingBoxes: [[[b.s, b.w], [b.n, b.e]]], FilterMessageTypes: ['PositionReport', 'ShipStaticData'] }, { windowMs: 8000, maxBytes: this.maxBytes, maxMessages: 5000 });
      return vesselsFrom(messages);
    },
  },
  fires: {
    label: 'Active fires (NASA FIRMS VIIRS, 24 h)', host: 'firms.modaps.eosdis.nasa.gov', perArea: true, minRefreshSec: 600, defaultRefreshSec: 1800, maxBytes: 2 * 1024 * 1024,
    credential: { fields: ['apiKey'], signupUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/' },
    attribution: 'NASA FIRMS (LANCE/EOSDIS)', license: 'NASA open data (no restriction; citation requested)', commercial: 'yes (citation)', limits: 'Free MAP_KEY: 5,000 transactions / 10 min.',
    async load(a, _cfg, ctx) {
      const b = bbox(a);
      const box = [b.w, b.s, b.e, b.n].map(v => v.toFixed(3)).join(',');
      // Both VIIRS near-real-time products are queried and merged: on
      // 2026-11-28 VIIRS_SNPP_NRT answered a valid CSV header with zero
      // rows worldwide while VIIRS_NOAA20_NRT carried the live detections,
      // so a single-product feed would have shown a false empty map.
      let netErr = null;
      const one = async product => { try { return parseFirmsCsv(await ctx.fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(ctx.key)}/${product}/${box}/1`, { maxBytes: this.maxBytes })); } catch (e) { if (e && e.code !== 'UPSTREAM_KEY_REJECTED') netErr = netErr || e; return null; } };
      const [noaa20, snpp] = await Promise.all([one('VIIRS_NOAA20_NRT'), one('VIIRS_SNPP_NRT')]);
      if (noaa20 === null && snpp === null) { if (netErr) throw netErr; throw fail('UPSTREAM_KEY_REJECTED'); }
      const seen = new Set(), out = [];
      for (const row of [...(noaa20 || []), ...(snpp || [])]) { const k = row.lat + ',' + row.lon + ',' + row.acquired; if (seen.has(k)) continue; seen.add(k); out.push(row); }
      return out;
    },
  },
  // Lightning (Owner order 2026-11-28): keyed-only by design. Blitzortung's
  // published terms refuse third-party use of its live data stream (the raw
  // data is reserved to contributing station operators; commercial use is
  // prohibited), so no free live source is wired. A Vaisala Xweather app key
  // (client id + secret) lights this layer up: the standard lightning access
  // serves the past 5 minutes via `closest`, radius capped at 100 km.
  lightning: {
    label: 'Sambaran petir (Vaisala Xweather)', host: 'data.api.xweather.com', perArea: true, minRefreshSec: 60, defaultRefreshSec: 300, maxBytes: 1024 * 1024,
    credential: { fields: ['clientId', 'clientSecret'], signupUrl: 'https://www.xweather.com/' },
    attribution: 'Vaisala Xweather (lightning data: Vaisala GLD360 / NLDN)', license: 'Xweather terms of service (subscription)', commercial: 'per Xweather plan', limits: 'App key (client id + secret). Standard access: strikes of the past 5 minutes, radius up to 100 km, up to 1,000 strikes per query.',
    async load(a, _cfg, ctx) {
      const [clientId, clientSecret] = String(ctx.key).split('\n');
      const radiusMiles = Math.max(1, Math.min(62, Math.round(a.radiusKm * 0.621371)));
      const data = JSON.parse(await ctx.fetch('https://data.api.xweather.com/lightning/closest?' + q({ p: a.lat.toFixed(4) + ',' + a.lon.toFixed(4), radius: radiusMiles + 'miles', limit: '1000', format: 'json', client_id: clientId, client_secret: clientSecret || '' }), { maxBytes: this.maxBytes }));
      if (!data || data.success !== true) throw fail('UPSTREAM_KEY_REJECTED');
      return (data.response || []).map(s => { const loc = s?.loc || {}, ob = s?.ob || {};
        const lat = num(loc.lat), lon = num(loc.long); if (lat === null || lon === null) return null;
        return { id: str(s.id, 40), lat: round(lat, 4), lon: round(lon, 4), time: str(ob.dateTimeISO, 32), type: str(ob.type || ob.pulseType, 8), peakAmp: num(ob.peakAmps ?? ob.amperage ?? ob.peakCurrent) }; }).filter(Boolean);
    },
  },
  traffic: {
    label: 'Traffic flow at area centre (TomTom)', host: 'api.tomtom.com', perArea: true, minRefreshSec: 120, defaultRefreshSec: 600, maxBytes: 256 * 1024,
    credential: { fields: ['apiKey'], signupUrl: 'https://developer.tomtom.com/user/register' },
    attribution: '© TomTom', license: 'TomTom API terms (free tier: evaluation/non-commercial limits apply)', commercial: 'per TomTom plan', limits: 'Free tier 2,500 requests/day.',
    async load(a, _cfg, ctx) {
      const d = JSON.parse(await ctx.fetch('https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?' + q({ point: a.lat.toFixed(5) + ',' + a.lon.toFixed(5), key: ctx.key }), { maxBytes: this.maxBytes })).flowSegmentData;
      if (!d) return [];
      return [{ roadClass: str(d.frc, 8), currentKmh: num(d.currentSpeed), freeFlowKmh: num(d.freeFlowSpeed), congestionPct: num(d.currentSpeed) !== null && num(d.freeFlowSpeed) ? Math.round(100 * (1 - d.currentSpeed / d.freeFlowSpeed)) : null,
        confidence: num(d.confidence), closed: d.roadClosure === true }];
    },
  },
});
const FEED_IDS = Object.freeze(Object.keys(FEEDS));
const KEY_FEEDS = Object.freeze(FEED_IDS.filter(id => FEEDS[id].credential));

// --- settings: mataDewa.* -----------------------------------------------------------------------------------------
// consent: Owner's acknowledgement (Control) that Core may contact the disclosed public hosts; nothing is fetched before.
// cctvNoticeAt / alprNoticeAt: when the Owner accepted the CCTV / ALPR legal notice in Control (null = not accepted).
const AREA_ID = /^[a-z0-9-]{1,24}$/, AREA_NAME = /^[\p{L}\p{N} .,'()_-]{1,40}$/u;
const CCTV_SOURCES = ['tfl-london', 'fintraffic', 'bpjt-tol', 'atcs-bandung', 'cctv-jogja'];
// Default feeds are the commercially usable keyless ones; Open-Meteo/OpenSky stay optional and labelled non-commercial.
// contactUrl: optional https:// or mailto: contact appended to the User-Agent (MET Norway asks for one); empty by default.
const SETTINGS_DEFAULTS = () => ({ consent: false, contactUrl: '', feeds: ['bmkgEarthquakes', 'earthquakes', 'weather', 'disasters', 'satellites', 'launches', 'imagery'],
  areas: [{ id: 'jakarta', name: 'Jakarta', lat: -6.2, lon: 106.8, radiusKm: 150 }],
  refreshSec: Object.fromEntries(FEED_IDS.map(id => [id, FEEDS[id].defaultRefreshSec])), satelliteGroup: 'stations',
  cctvSources: [], cctvNoticeAt: null, alprNoticeAt: null, alprRetentionDays: 30, alprIntervalSec: 15, watchPoints: [], alerts: ALERTS_DEFAULTS() });
const validArea = a => !!a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).sort().join() === 'id,lat,lon,name,radiusKm' &&
  AREA_ID.test(a.id) && typeof a.name === 'string' && AREA_NAME.test(a.name) && Number.isFinite(a.lat) && a.lat >= -90 && a.lat <= 90 &&
  Number.isFinite(a.lon) && a.lon >= -180 && a.lon <= 180 && Number.isFinite(a.radiusKm) && a.radiusKm >= 5 && a.radiusKm <= 460;
const validStamp = v => v === null || (typeof v === 'string' && v.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)));
// Proactive alerts (Fase 6): thresholds/channels/quiet hours for the Core alert engine.
// Defaults are neutral product values; a user's own thresholds live only in their config.
const ALERTS_DEFAULTS = () => ({ enabled: true, quakeMinMagnitude: 5, quakeMaxAgeHours: 6, quakeRadiusKm: 150,
  weatherWindowHours: 6, stormPrecipMm: 4, stormWindKmh: 60, tickMinutes: 10, gpsEnabled: true, imageryAlerts: false,
  tsunamiMinMagnitude: 7, volcanoMinLevel: 3, volcanoRadiusKm: 150,
  quietHours: { start: '22:00', end: '06:00' }, channels: { notch: true, telegram: false, whatsapp: false },
  channelTargets: { telegram: { chatId: '' }, whatsapp: { phoneNumberId: '', to: '' } } });
function sanitizeAlerts(v) {
  const d = ALERTS_DEFAULTS(); if (!v || typeof v !== 'object' || Array.isArray(v)) return d;
  const num = (k, min, max) => { if (Number.isFinite(v[k]) && v[k] >= min && v[k] <= max) d[k] = v[k]; };
  if (typeof v.enabled === 'boolean') d.enabled = v.enabled;
  num('quakeMinMagnitude', 3, 10); num('quakeMaxAgeHours', 1, 48); num('quakeRadiusKm', 10, 1000);
  num('weatherWindowHours', 1, 24); num('stormPrecipMm', 0.5, 50); num('stormWindKmh', 20, 200); num('tickMinutes', 1, 120);
  if (typeof v.gpsEnabled === 'boolean') d.gpsEnabled = v.gpsEnabled;
  if (typeof v.imageryAlerts === 'boolean') d.imageryAlerts = v.imageryAlerts;
  if (v.quietHours && /^\d{2}:\d{2}$/.test(v.quietHours.start || '') && /^\d{2}:\d{2}$/.test(v.quietHours.end || '')) d.quietHours = { start: v.quietHours.start, end: v.quietHours.end };
  if (v.channels && typeof v.channels === 'object') for (const k of ['notch', 'telegram', 'whatsapp']) if (typeof v.channels[k] === 'boolean') d.channels[k] = v.channels[k];
  num('tsunamiMinMagnitude', 5, 10); num('volcanoRadiusKm', 10, 1000);
  if (Number.isSafeInteger(v.volcanoMinLevel) && v.volcanoMinLevel >= 2 && v.volcanoMinLevel <= 4) d.volcanoMinLevel = v.volcanoMinLevel;
  // Channel targets are NON-SECRET routing config for DAMAR's own external
  // channels; the tokens themselves live in DAMAR's vault, never in settings.
  if (v.channelTargets && typeof v.channelTargets === 'object') {
    const t = v.channelTargets.telegram, w = v.channelTargets.whatsapp;
    if (t && typeof t.chatId === 'string' && t.chatId.length <= 64 && /^-?[0-9]*$/.test(t.chatId)) d.channelTargets.telegram.chatId = t.chatId;
    if (w && typeof w.phoneNumberId === 'string' && w.phoneNumberId.length <= 32 && /^[0-9]*$/.test(w.phoneNumberId)) d.channelTargets.whatsapp.phoneNumberId = w.phoneNumberId;
    if (w && typeof w.to === 'string' && w.to.length <= 32 && /^[0-9]*$/.test(w.to)) d.channelTargets.whatsapp.to = w.to;
  }
  return d;
}
// Watch points: named locations for proactive alert evaluation - personal
// locations and infrastructure assets alike (any user's towers, warehouses,
// farms, sites). sourceUrl keeps the provenance of an imported point.
const validWatchPoint = w => !!w && typeof w === 'object' && !Array.isArray(w) &&
  ['id', 'lat', 'lon', 'name', 'radiusKm', 'profile'].every(k => k in w) && Object.keys(w).every(k => ['id', 'lat', 'lon', 'name', 'radiusKm', 'profile', 'sourceUrl', 'adm4', 'rules'].includes(k)) &&
  (w.rules === undefined || (!!w.rules && typeof w.rules === 'object' && !Array.isArray(w.rules) && Object.keys(w.rules).every(k => ['quake', 'storm', 'fire', 'imagery'].includes(k) && typeof w.rules[k] === 'boolean'))) &&
  AREA_ID.test(w.id) && typeof w.name === 'string' && AREA_NAME.test(w.name) && Number.isFinite(w.lat) && w.lat >= -90 && w.lat <= 90 &&
  Number.isFinite(w.lon) && w.lon >= -180 && w.lon <= 180 && Number.isFinite(w.radiusKm) && w.radiusKm >= 1 && w.radiusKm <= 460 &&
  (w.profile === 'personal' || w.profile === 'asset') &&
  (w.sourceUrl === undefined || (typeof w.sourceUrl === 'string' && w.sourceUrl.length <= 300 && w.sourceUrl.startsWith('https://'))) &&
  (w.adm4 === undefined || (typeof w.adm4 === 'string' && /^\d{2}\.\d{2}\.\d{2}\.\d{4}$/.test(w.adm4)));
const SETTINGS_RULES = {
  consent: v => typeof v === 'boolean',
  feeds: v => Array.isArray(v) && v.length <= FEED_IDS.length && new Set(v).size === v.length && v.every(id => FEED_IDS.includes(id)),
  areas: v => Array.isArray(v) && v.length <= 4 && v.every(validArea) && new Set(v.map(a => a.id)).size === v.length,
  refreshSec: v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([k, s]) => FEEDS[k] && Number.isSafeInteger(s) && s >= FEEDS[k].minRefreshSec && s <= 86400),
  satelliteGroup: v => SAT_GROUPS.includes(v),
  cctvSources: v => Array.isArray(v) && new Set(v).size === v.length && v.every(s => CCTV_SOURCES.includes(s)),
  cctvNoticeAt: validStamp, alprNoticeAt: validStamp,
  contactUrl: v => v === '' || (typeof v === 'string' && v.length <= 200 && /^(https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?|mailto:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)$/.test(v)),
  alprRetentionDays: v => Number.isSafeInteger(v) && v >= 1 && v <= 365,
  alprIntervalSec: v => Number.isSafeInteger(v) && v >= 5 && v <= 3600,
  watchPoints: v => Array.isArray(v) && v.length <= 200 && v.every(validWatchPoint) && new Set(v.map(w => w.id)).size === v.length,
  alerts: v => !!v && typeof v === 'object' && !Array.isArray(v),
};
const copy = (k, v) => k === 'areas' ? v.map(a => ({ id: a.id, name: a.name, lat: a.lat, lon: a.lon, radiusKm: a.radiusKm })) : k === 'watchPoints' ? v.map(w => ({ ...w, ...(w.rules ? { rules: { ...w.rules } } : {}) })) : Array.isArray(v) ? [...v] : v;
// Stored values that no longer validate are dropped (defaults apply), like presence.*.
function sanitizeSettings(v) {
  const d = SETTINGS_DEFAULTS(); if (!v || typeof v !== 'object' || Array.isArray(v)) return d;
  for (const k of Object.keys(SETTINGS_RULES)) if (v[k] !== undefined && SETTINGS_RULES[k](v[k])) d[k] = k === 'refreshSec' ? { ...d.refreshSec, ...v[k] } : k === 'alerts' ? sanitizeAlerts(v[k]) : copy(k, v[k]);
  return d;
}
// Owner partial update; every key is validated before anything changes. Throws MATA_DEWA_SETTINGS_INVALID.
function mergeSettings(current, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !SETTINGS_RULES[k] || !SETTINGS_RULES[k](input[k])))
    throw Object.assign(Error('MATA_DEWA_SETTINGS_INVALID'), { status: 400 });
  const next = sanitizeSettings(current);
  for (const k of Object.keys(input)) next[k] = k === 'refreshSec' ? { ...next.refreshSec, ...input[k] } : k === 'alerts' ? sanitizeAlerts(input[k]) : copy(k, input[k]);
  return next;
}

module.exports = { FEEDS, FEED_IDS, KEY_FEEDS, SAT_GROUPS, CCTV_SOURCES, redactAircraft, openskyState, vesselsFrom, parseTle, parseFirmsCsv, bbox, SETTINGS_DEFAULTS, SETTINGS_RULES, sanitizeSettings, mergeSettings, sanitizeAlerts, ALERTS_DEFAULTS, validWatchPoint };
