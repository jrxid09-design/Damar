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
      data: { at: e.time, leadMinutes, precipitationMm: e.precipitationMm ?? null, symbol: e.symbol || null, thunder: !!e._thunder, windKmh: e.windKmh ?? null, source: e.source || 'MET Norway' } }];
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

// BMKG quake list as an input equivalent to USGS for the same rule: the
// evaluation is quake-near's, re-attributed - event ids and source say BMKG.
const bmkgQuakeNear = {
  id: 'bmkg-quake-near', profiles: ['personal', 'asset'], input: 'bmkgQuakes',
  evaluate(ctx) {
    return quakeNear.evaluate(ctx).map(s => ({ ...s, ruleId: 'bmkg-quake-near', eventId: 'bmkg-' + s.eventId,
      data: { ...s.data, source: 'BMKG' } }));
  },
};

// Tsunami relay (design principle): when BMKG's own published Potensi
// wording flags tsunami potential for a relevant quake, DAMAR relays that
// official wording verbatim with attribution and localizes it to the
// watch point. DAMAR never issues its own tsunami assessment: a negative
// or absent BMKG flag never fires, and the relayed text is BMKG's.
const tsunamiRelay = {
  id: 'tsunami-relay', profiles: ['personal', 'asset'], input: 'bmkgQuakes',
  evaluate({ items = [], location, cfg, nowMs }) {
    const out = [];
    const minMag = cfg.tsunamiMinMagnitude ?? 7;
    for (const q of items) {
      const potensi = String(q.potensi || '').toLowerCase();
      if (!potensi.includes('berpotensi tsunami') || potensi.includes('tidak berpotensi')) continue;
      if (!Number.isFinite(q.magnitude) || q.magnitude < minMag) continue;
      const at = Date.parse(q.time); if (!Number.isFinite(at) || nowMs - at > (cfg.quakeMaxAgeHours ?? 6) * hourMs || at > nowMs + 5 * 60e3) continue;
      const distanceKm = Math.round(haversineKm(location, q));
      if (distanceKm > location.radiusKm) continue;
      out.push({ ruleId: 'tsunami-relay', kind: 'alert', eventId: 'tsunami:' + q.id, severity: 'critical',
        data: { magnitude: q.magnitude, place: q.place || '', depthKm: q.depthKm, distanceKm, time: q.time, potensi: q.potensi, source: 'BMKG' } });
    }
    return out;
  },
};

// BMKG extreme weather: the official village forecast (api.bmkg.go.id)
// for watch points that carry a wilayah code (adm4). Thunderstorm codes
// 95/97 (or a "petir" description) warn; heavy-rain code 63 (or "lebat")
// watches. Points without adm4 receive no items from the provider.
const bmkgExtremeWeather = {
  id: 'bmkg-extreme-weather', profiles: ['personal', 'asset'], input: 'bmkgForecast',
  evaluate({ items = [], location, cfg, nowMs }) {
    const until = nowMs + (cfg.weatherWindowHours ?? 6) * hourMs;
    const severe = items.filter(e => {
      const at = Date.parse(e.time); if (!Number.isFinite(at) || at < nowMs - 30 * 60e3 || at > until) return false;
      const desc = String(e.weatherDesc || '').toLowerCase();
      e._thunder = e.weatherCode === 95 || e.weatherCode === 97 || desc.includes('petir');
      e._heavy = e.weatherCode === 63 || desc.includes('lebat');
      return e._thunder || e._heavy;
    }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    if (!severe.length) return [];
    const e = severe[0];
    const leadMinutes = Math.max(0, Math.round((Date.parse(e.time) - nowMs) / 60000));
    return [{ ruleId: 'bmkg-extreme-weather', kind: 'alert', eventId: 'bmkgwx:' + location.id + ':' + e.time.slice(0, 13), severity: e._thunder ? 'warning' : 'watch',
      data: { at: e.time, leadMinutes, weatherDesc: e.weatherDesc || '', thunder: !!e._thunder, precipitationMm: e.precipitationMm ?? null, windKmh: e.windKmh ?? null, source: 'BMKG' } }];
  },
};

// PVMBG volcano status: fires when a volcano within range stands at or
// above the configured activity level (default III - Siaga). Status data
// comes from PVMBG (MAGMA Indonesia) through the volcanoes provider;
// levels are the agency's own (I Normal / II Waspada / III Siaga / IV Awas).
const volcanoStatus = {
  id: 'volcano-status', profiles: ['personal', 'asset'], input: 'volcanoes',
  evaluate({ items = [], location, cfg, nowMs }) {
    const out = [];
    const minLevel = cfg.volcanoMinLevel ?? 3;
    const radiusKm = cfg.volcanoRadiusKm ?? location.radiusKm;
    for (const v of items) {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon) || !Number.isSafeInteger(v.level) || v.level < minLevel) continue;
      const distanceKm = Math.round(haversineKm(location, v));
      if (distanceKm > radiusKm) continue;
      out.push({ ruleId: 'volcano-status', kind: 'alert', eventId: 'volcano:' + v.name + ':' + v.level, severity: v.level >= 4 ? 'critical' : 'warning',
        data: { volcano: v.name, level: v.level, levelLabel: v.levelLabel || '', distanceKm, source: v.source || 'PVMBG (MAGMA Indonesia)' } });
    }
    return out;
  },
};

// Live lightning (Vaisala Xweather, keyed): a strike inside the point's
// radius within the last 15 minutes warns once per storm cell window; the
// nearest strike and the strike count are the facts carried. Source
// attribution rides on every signal.
const lightningNear = {
  id: 'lightning-near', profiles: ['personal', 'asset'], input: 'strikes',
  evaluate({ items = [], location, cfg, nowMs }) {
    const fresh = [];
    for (const s of items) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const at = Date.parse(s.time); if (!Number.isFinite(at) || nowMs - at > 15 * 60e3 || at > nowMs + 2 * 60e3) continue;
      const distanceKm = Math.round(haversineKm(location, s) * 10) / 10;
      if (distanceKm > location.radiusKm) continue;
      fresh.push({ ...s, distanceKm });
    }
    if (!fresh.length) return [];
    fresh.sort((a, b) => a.distanceKm - b.distanceKm);
    const n = fresh[0];
    return [{ ruleId: 'lightning-near', kind: 'alert', eventId: 'lightning:' + location.id + ':' + String(n.time).slice(0, 13), severity: n.distanceKm <= 10 ? 'critical' : 'warning',
      data: { distanceKm: n.distanceKm, count: fresh.length, time: n.time, source: 'Vaisala Xweather' } }];
  },
};

const RULES = [quakeNear, weatherStorm, fireNear, imageryObservation, bmkgQuakeNear, tsunamiRelay, bmkgExtremeWeather, volcanoStatus, lightningNear];
module.exports = { RULES, SEVERITY_RANK };
