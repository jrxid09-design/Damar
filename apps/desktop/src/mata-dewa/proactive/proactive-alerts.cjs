'use strict';
// Proactive alert engine (Fase 6) - runs in Core as part of its continuous
// operation. An internal timer evaluates Mata Dewa signals against the
// Owner's configured locations on its own cadence; alerts arise from
// DAMAR's own evaluation, never from a user request. The user's only
// involvement is the initial configuration (channels, thresholds, locations,
// quiet hours, salutation) in the centralized Core settings.
//
// Framework shape: signal providers (quakes / forecast / hotspots / scenes)
// -> rules (alert-rules.cjs) -> dedupe + quiet-hours discipline -> message
// composed from the event's data with the configured salutation -> delivery
// to configured channels. The internal channel is the delivery log + the
// Notch hook; external channels (Telegram/WhatsApp) use DAMAR's OWN channel
// configuration - when a channel is enabled but not configured with its own
// credential/target, its status is "ready" (siap diaktifkan) and deliveries
// are recorded as such, never silently sent elsewhere.
//
// Design constraint (open-source-general): DAMAR is built for public use.
// Nothing personal to any one user (names, locations, workplaces, private
// links, credentials) may live in code, defaults, examples or docs - such
// values exist only as that user's private configuration. Defaults shipped
// here are neutral; examples use fictional data.

const { resolveLocations } = require('./location-source.cjs');
const { RULES, SEVERITY_RANK } = require('./alert-rules.cjs');
const { composeMessage } = require('./alert-composer.cjs');

const rank = s => SEVERITY_RANK[s] || 0;
// Per-point rule switches (watch point `rules`): a rule belongs to one family;
// a family switched off for a point silences only that family for that point.
// Imagery observations additionally honour the global imageryAlerts switch.
const RULE_FAMILY = Object.freeze({ 'quake-near': 'quake', 'bmkg-quake-near': 'quake', 'tsunami-relay': 'quake',
  'weather-storm': 'storm', 'bmkg-extreme-weather': 'storm', 'volcano-status': 'storm', 'fire-near': 'fire', 'imagery-observation': 'imagery' });
function inQuietHours(nowMs, qh) {
  if (!qh || !/^\d{2}:\d{2}$/.test(qh.start || '') || !/^\d{2}:\d{2}$/.test(qh.end || '')) return false;
  const d = new Date(nowMs), mins = d.getHours() * 60 + d.getMinutes();
  const [sh, sm] = qh.start.split(':').map(Number), [eh, em] = qh.end.split(':').map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  return start <= end ? (mins >= start && mins < end) : (mins >= start || mins < end);
}

function createProactiveAlerts({ getSettings, getProfile, getGps, providers = {}, channels = {}, rules = RULES, now = Date.now, maxDeliveries = 200 } = {}) {
  const seen = new Map();          // dedupe key -> { rank, at }
  const deferredKeys = new Set();  // quiet-hours deferrals already logged
  const knownScenes = {};          // locationId -> last Sentinel scene id (observations)
  const deliveries = [];
  let timer = null, lastTickAt = null, lastSummary = null, lastNoLocationAt = null;

  const pushDelivery = (entry) => { deliveries.push(entry); if (deliveries.length > maxDeliveries) deliveries.splice(0, deliveries.length - maxDeliveries); };

  async function inputFor(input, location, cache) {
    if (cache.has(input + '|' + (input === 'quakes' ? '' : location.id))) return cache.get(input + '|' + (input === 'quakes' ? '' : location.id));
    const key = input + '|' + (input === 'quakes' ? '' : location.id);
    let items = [];
    try { items = (providers[input] ? await providers[input](location) : []) || []; }
    catch (e) { cache.set('err:' + input, String(e && e.message || e).slice(0, 120)); }
    cache.set(key, items);
    return items;
  }

  async function tick(reason = 'schedule') {
    const cfg = (typeof getSettings === 'function' ? getSettings() : {}) || {};
    const a = cfg.alerts || {};
    const nowMs = now();
    lastTickAt = new Date(nowMs).toISOString();
    if (!a.enabled) { lastSummary = { at: lastTickAt, reason, skipped: 'ALERTS_DISABLED' }; return lastSummary; }
    const { locations, notes } = resolveLocations({ areas: cfg.areas || [], watchPoints: cfg.watchPoints || [], gps: typeof getGps === 'function' ? getGps() : null, gpsEnabled: a.gpsEnabled !== false, defaultRadiusKm: a.quakeRadiusKm || 150, nowMs });
    if (!locations.length) {
      lastNoLocationAt = lastTickAt;
      lastSummary = { at: lastTickAt, reason, fired: 0, outcome: 'NO_LOCATION', notes };
      return lastSummary;
    }
    const profile = (typeof getProfile === 'function' ? getProfile() : {}) || {};
    const salutation = (typeof profile.salutation === 'string' && profile.salutation.trim()) || (typeof profile.displayName === 'string' ? profile.displayName.trim() : '');
    const cache = new Map();
    let fired = 0, deduped = 0, deferred = 0;
    for (const location of locations) {
      for (const rule of rules) {
        if (!rule.profiles.includes(location.profile)) continue;
        const family = RULE_FAMILY[rule.id];
        if (family && location.rules && location.rules[family] === false) continue;
        const items = await inputFor(rule.input, location, cache);
        let signals = [];
        try { signals = rule.evaluate({ items, location, cfg: a, nowMs, knownScenes }) || []; } catch { signals = []; }
        for (const signal of signals) {
          const key = signal.ruleId + '|' + location.id + '|' + signal.eventId;
          const prev = seen.get(key);
          if (prev && prev.rank >= rank(signal.severity)) { deduped++; continue; }
          if (signal.kind === 'alert' && inQuietHours(nowMs, a.quietHours) && signal.severity !== 'critical') {
            deferred++;
            if (!deferredKeys.has(key)) { deferredKeys.add(key); pushDelivery({ at: lastTickAt, type: 'deferred-quiet', alertId: key, ruleId: signal.ruleId, location: location.label }); }
            continue;
          }
          const message = composeMessage(signal, location, { salutation });
          const alert = { id: key, at: lastTickAt, ruleId: signal.ruleId, kind: signal.kind, severity: signal.severity, location: location.label, locationKind: location.kind, profile: location.profile, message, data: signal.data };
          const channelResults = {};
          if (signal.kind === 'observation') {
            channelResults.log = 'recorded';
            if (signal.ruleId === 'imagery-observation' && signal.data?.sceneId) knownScenes[location.id] = signal.data.sceneId;
          } else {
            if (a.channels?.notch !== false && channels.notch?.send) { try { await channels.notch.send(alert); channelResults.notch = 'sent'; } catch (e) { channelResults.notch = 'error:' + String(e && e.message || e).slice(0, 60); } }
            for (const name of ['telegram', 'whatsapp']) {
              if (!a.channels?.[name]) { channelResults[name] = 'off'; continue; }
              const ch = channels[name];
              if (ch?.configured && ch.send) { try { await ch.send(message, alert); channelResults[name] = 'sent'; } catch (e) { channelResults[name] = 'error:' + String(e && e.message || e).slice(0, 60); } }
              else channelResults[name] = 'ready';
            }
          }
          pushDelivery({ at: lastTickAt, type: signal.kind, alertId: key, ruleId: signal.ruleId, severity: signal.severity, location: location.label, channels: channelResults, message });
          seen.set(key, { rank: rank(signal.severity), at: nowMs });
          if (seen.size > 1000) seen.delete(seen.keys().next().value);
          fired++;
        }
      }
    }
    const errors = [...cache.keys()].filter(k => k.startsWith('err:')).map(k => k.slice(4) + ': ' + cache.get(k));
    lastSummary = { at: lastTickAt, reason, locations: locations.length, locationNotes: notes, fired, deduped, deferred, errors };
    return lastSummary;
  }

  function start(intervalMs) {
    if (timer) return;
    const ms = Math.max(1000, intervalMs || 10 * 60 * 1000);
    timer = setInterval(() => { tick('schedule').catch(() => {}); }, ms);
    timer.unref?.();
    void tick('start').catch(() => {});
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function status() {
    const cfg = (typeof getSettings === 'function' ? getSettings() : {}) || {};
    const a = cfg.alerts || {};
    const channelStatus = (name) => !a.channels?.[name] ? 'off' : (channels[name]?.configured ? 'live' : 'ready');
    return { enabled: !!a.enabled, running: !!timer, lastTickAt, lastSummary, lastNoLocationAt, deliveries: deliveries.length, seenKeys: seen.size,
      channels: { notch: a.channels?.notch === false ? 'off' : (channels.notch?.send ? 'live' : 'log-only'), telegram: channelStatus('telegram'), whatsapp: channelStatus('whatsapp') } };
  }
  const recentDeliveries = (limit = 20) => deliveries.slice(-Math.max(1, limit)).reverse();
  return { tick, start, stop, status, recentDeliveries, _seen: seen, _knownScenes: knownScenes };
}

module.exports = { createProactiveAlerts, inQuietHours };
