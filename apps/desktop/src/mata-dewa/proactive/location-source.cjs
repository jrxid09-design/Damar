'use strict';
// Location sources for proactive Mata Dewa alert evaluation (Owner mandate,
// 2026-11-24). Two source kinds, both fully Owner-controlled from the
// centralized Core configuration:
//   (a) GPS of a registered mobile node - the user's actual position as
//       reported by DAMAR Mobile. Freshness is explicit: a position older
//       than GPS_FRESH_MS is labeled stale and every evaluation (and alert
//       message) acknowledges that.
//   (b) Watch points - named locations in Core settings: the Mata Dewa feed
//       `areas` (personal/regional) plus the dedicated `watchPoints` list
//       (personal locations and infrastructure assets - towers, warehouses,
//       farms, sites - imported in bulk from a My Maps link). Each watch
//       point has a profile: 'personal' | 'asset'; rules follow the profile.
// Location data is used ONLY for alert evaluation; nothing here invents a
// location - with no source configured the result is an explicit empty list
// and the engine records that state instead of guessing.

const EARTH_R_KM = 6371;
const GPS_FRESH_MS = 15 * 60 * 1000;

function haversineKm(a, b) {
  const rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function resolveLocations({ areas = [], watchPoints = [], gps = null, gpsEnabled = true, defaultRadiusKm = 150, nowMs = Date.now() } = {}) {
  const locations = [];
  const notes = [];
  if (!gpsEnabled) notes.push('GPS_DISABLED');
  else if (gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon) && Number.isFinite(gps.at)) {
    const ageMs = Math.max(0, nowMs - gps.at);
    locations.push({
      kind: 'gps', id: 'gps', label: 'posisi Anda', profile: 'personal',
      lat: gps.lat, lon: gps.lon, radiusKm: Number.isFinite(gps.radiusKm) ? gps.radiusKm : defaultRadiusKm,
      at: gps.at, ageMs, stale: ageMs > GPS_FRESH_MS, sourceUrl: null,
    });
    if (ageMs > GPS_FRESH_MS) notes.push('GPS_STALE');
  } else notes.push('GPS_ABSENT');
  for (const a of Array.isArray(areas) ? areas : []) {
    locations.push({ kind: 'watchpoint', id: 'area:' + a.id, label: a.name, profile: 'personal', lat: a.lat, lon: a.lon, radiusKm: a.radiusKm, stale: false, sourceUrl: a.sourceUrl || null });
  }
  for (const w of Array.isArray(watchPoints) ? watchPoints : []) {
    locations.push({ kind: 'watchpoint', id: 'wp:' + w.id, label: w.name, profile: w.profile === 'asset' ? 'asset' : 'personal', lat: w.lat, lon: w.lon, radiusKm: w.radiusKm, stale: false, sourceUrl: w.sourceUrl || null, adm4: typeof w.adm4 === 'string' ? w.adm4 : null });
  }
  return { locations, notes, hasLocation: locations.length > 0 };
}

module.exports = { haversineKm, resolveLocations, GPS_FRESH_MS };
