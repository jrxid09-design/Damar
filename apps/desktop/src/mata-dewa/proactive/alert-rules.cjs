'use strict';
// Proactive alert rules (Fase 6 framework). A rule is a pure function from
// normalized signal inputs + a reference location + config to zero or more
// signals. Adding a feed/rule never changes the engine: register the rule
// here (or pass extra rules to the engine) and provide its input.
// Profiles: 'personal' locations get safety rules (quake, storm); 'asset'
// locations (infrastructure watch points - any user's towers, warehouses,
// farms or sites) also get fire-hotspot alerts and satellite-imagery
// OBSERVATIONS. An observation is a recorded fact (a new Sentinel-2 scene
// exists), never a damage claim - escalation stays an evidence-chain
// judgment, per Owner direction.

const { haversineKm } = require('./location-source.cjs');

const SEVERITY_RANK = { watch: 1, warning: 2, critical: 3 };
const hourMs = 3600e3;

const quakeNear = {
  id: 'quake-near', profiles: ['personal', 'asset'], input: 'quakes',
  evaluate({ items = [], location, cfg, nowMs }) {
    const out = [];
    for (const q of items) {
      if (!Number.isFinite(q.magnitude) || q.magnitude < cfg.quakeMinMagnitude) continue;
      const at = Date.parse(q.time); if (!Number.isFinite(at) || nowMs - at > cfg.quakeMaxAgeHours * hourMs || at > nowMs + 5 * 60e3) continue;
      const distanceKm = Math.round(haversineKm(location, q));
      if (distanceKm > location.radiusKm) continue;
      out.push({ ruleId: 'quake-near', kind: 'alert', eventId: 'quake:' + q.id, severity: q.magnitude >= 6 ? 'critical' : q.magnitude >= 5.5 ? 'warning' : 'watch',
        data: { magnitude: q.magnitude, place: q.place || '', depthKm: q.depthKm, distanceKm, time: q.time, url: q.url || null, source: 'USGS' } });
    }
    return out;
  },
};

const weatherStorm = {
  id: 'weather-storm', profiles: ['personal', 'asset'], input: 'forecast',
  evaluate({ items = [], location, cfg, nowMs }) {
    const until = nowMs + cfg.weatherWindowHours * hourMs;
    const heavy = items.filter(e => {
      const at = Date.parse(e.time); if (!Number.isFinite(at) || at < nowMs - 30 * 60e3 || at > until) return false;
      e._thunder = typeof e.symbol === 'string' && e.symbol.includes('thunder');
      return e._thunder || (Number.isFinite(e.precipitationMm) && e.precipitationMm >= cfg.stormPrecipMm) || (Number.isFinite(e.windKmh) && e.windKmh >= cfg.stormWindKmh);
    }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    if (!heavy.length) return [];
    const e = heavy[0];
    const leadMinutes = Math.max(0, Math.round((Date.parse(e.time) - nowMs) / 60000));
    return [{ ruleId: 'weather-storm', kind: 'alert', eventId: 'storm:' + location.id + ':' + e.time.slice(0, 13), severity: e._thunder ? 'warning' : 'watch',
      data: { at: e.time, leadMinutes, precipitationMm: e.precipitationMm ?? null, symbol: e.symbol || null, thunder: !!e._thunder, windKmh: e.windKmh ?? null, source: 'MET Norway' } }];
  },
};

const fireNear = {
  id: 'fire-near', profiles: ['asset'], input: 'hotspots',
  evaluate({ items = [], location, cfg, nowMs }) {
    const out = [];
    for (const h of items) {
      if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
      const distanceKm = Math.round(haversineKm(location, h) * 10) / 10;
      if (distanceKm > location.radiusKm) continue;
      out.push({ ruleId: 'fire-near', kind: 'alert', eventId: 'fire:' + location.id + ':' + h.lat.toFixed(3) + ',' + h.lon.toFixed(3) + ':' + String(h.time || '').slice(0, 10), severity: (h.frp ?? 0) >= 20 ? 'critical' : 'warning',
        data: { distanceKm, frp: h.frp ?? null, time: h.time || null, source: 'NASA FIRMS' } });
    }
    return out;
  },
};

const imageryObservation = {
  id: 'imagery-observation', profiles: ['asset'], input: 'scenes',
  evaluate({ items = [], location, cfg, nowMs, knownScenes = {} }) {
    if (!items.length) return [];
    const latest = [...items].sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime))[0];
    if (!latest || knownScenes[location.id] === latest.id) return [];
    return [{ ruleId: 'imagery-observation', kind: 'observation', eventId: 'scene:' + location.id + ':' + latest.id, severity: 'watch',
      data: { sceneId: latest.id, datetime: latest.datetime, cloudCoverPct: latest.cloudCoverPct ?? null, previousSceneId: knownScenes[location.id] || null, source: 'Sentinel-2 (Copernicus/ESA)' } }];
  },
};

const RULES = [quakeNear, weatherStorm, fireNear, imageryObservation];
module.exports = { RULES, SEVERITY_RANK };
