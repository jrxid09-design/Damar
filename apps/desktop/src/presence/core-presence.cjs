'use strict';
// Core binding for DAMAR Presence. Same credential source as the CLI (src/cli/service.cjs: the private Core session
// directory's credentials.json, validated session.json address). Reads use only the least-privileged `requester`
// token and GET routes from a fixed allowlist. The single mutation, an Owner decision on a pending permission from
// the notch, uses the `owner` token in the main process only (decide()); nothing else is ever written to Core.
const fs = require('node:fs'), path = require('node:path');
const { coreEndpoint } = require('../cli/core-endpoint.cjs');
const { boundedResponse } = require('../cli/service.cjs');

const READS = Object.freeze(['/api/r9/lifecycle', '/api/r9/sessions', '/api/r9/pandawa/runs', '/api/r9/presence/settings', '/api/r9/cli/settings', '/api/r9/activity']);
const readAllowed = route => READS.includes(route) || /^\/api\/r9\/activity\?from=\d{1,9}$/.test(route);
// Contract agreed with Control (presence.* namespace). Defaults equal the Owner prototype values.
const DEFAULTS = Object.freeze({ idleToNotchMs: 10000, morphMs: 620, reducedMotion: 'system', notchEnabled: true, notificationPrivacy: 'redacted', display: 'primary', position: 'top-center', voiceEnabled: false, displayName: '' });
const KEYS = Object.freeze(Object.keys(DEFAULTS).map(k => 'presence.' + k));

// Accepts {presence:{idleToNotchMs,...}} or flat {'presence.idleToNotchMs':...}; invalid values fall back per key.
function settingsFrom(data) {
  const src = data?.presence && typeof data.presence === 'object' ? data.presence : {};
  const get = k => (src[k] !== undefined ? src[k] : data?.['presence.' + k]);
  const int = (v, lo, hi, d) => (Number.isSafeInteger(v) && v >= lo && v <= hi ? v : d);
  const one = (v, list, d) => (list.includes(v) ? v : d);
  const display = get('display');
  return {
    idleToNotchMs: int(get('idleToNotchMs'), 1000, 600000, DEFAULTS.idleToNotchMs),
    morphMs: int(get('morphMs'), 0, 5000, DEFAULTS.morphMs),
    reducedMotion: one(get('reducedMotion'), ['system', 'on', 'off'], DEFAULTS.reducedMotion),
    notchEnabled: typeof get('notchEnabled') === 'boolean' ? get('notchEnabled') : DEFAULTS.notchEnabled,
    notificationPrivacy: one(get('notificationPrivacy'), ['redacted', 'counts-only', 'hidden'], DEFAULTS.notificationPrivacy),
    // Same rule as core-settings.cjs PRESENCE_RULES.display; an id that matches no connected display -> primary (main.cjs).
    display: typeof display === 'string' && /^[A-Za-z0-9._:\\-]{1,64}$/.test(display) ? display : DEFAULTS.display,
    position: one(get('position'), ['top-center'], DEFAULTS.position),
    voiceEnabled: get('voiceEnabled') === true, // opt-in only: anything but literal true keeps the microphone off
    displayName: typeof get('displayName') === 'string' && get('displayName').length <= 40 && !/[\x00-\x1f\x7f]/.test(get('displayName')) ? get('displayName').trim() : '',
  };
}

// Installed data root, same rule as release/damar.cjs: DAMAR_DATA_ROOT (absolute) else %LOCALAPPDATA%\DAMAR.
function dataRoot(env = process.env) {
  if (env.DAMAR_DATA_ROOT && path.isAbsolute(env.DAMAR_DATA_ROOT)) return path.resolve(env.DAMAR_DATA_ROOT);
  return path.join(env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'DAMAR');
}
// Lookup order: explicit --session; the CLI profile's remembered core_session (src/cli/main.cjs:78-80; profile default
// <data root>\profile); the launcher's <data root>\state\last-core.json.
function resolveSessionDirectory({ session, profile, env = process.env } = {}) {
  if (session) return session;
  const root = dataRoot(env);
  try { const { UISettings } = require('../cli/ui-settings.cjs'); const s = new UISettings(profile || path.join(root, 'profile')).load().core_session; if (s) return s; } catch {}
  try { const s = JSON.parse(fs.readFileSync(path.join(root, 'state', 'last-core.json'), 'utf8')).session; if (typeof s === 'string' && path.isAbsolute(s)) return s; } catch {}
  return null;
}

function createCorePresence({ sessionDirectory, transport = fetch, endpoint = coreEndpoint() } = {}) {
  if (!sessionDirectory || !path.isAbsolute(sessionDirectory)) throw Error('EXPLICIT_PRIVATE_SESSION_REQUIRED');
  const token = (role = 'requester') => {
    const d = JSON.parse(fs.readFileSync(path.join(sessionDirectory, 'session.json'), 'utf8'));
    if (d.address !== endpoint) throw Error('SESSION_ENDPOINT_MISMATCH');
    const t = JSON.parse(fs.readFileSync(path.join(sessionDirectory, 'credentials.json'), 'utf8'))[role];
    if (typeof t !== 'string' || !t || t.length > 4096 || /[\r\n]/.test(t)) throw Error('INVALID_PRIVATE_CREDENTIAL');
    return t;
  };
  const activityLog = new Map(); let activityFrom = 0;
  async function get(route) {
    if (!readAllowed(route)) throw Error('PRESENCE_ROUTE_DENIED');
    const response = await transport(endpoint + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { accept: 'application/json', authorization: 'Bearer ' + token() } });
    return { ok: response.ok, status: response.status, body: await boundedResponse(response).catch(() => null) };
  }
  return {
    endpoint,
    async snapshot() {
      try {
        const [life, sessions, runs, activity] = await Promise.all(['/api/r9/lifecycle', '/api/r9/sessions', '/api/r9/pandawa/runs', '/api/r9/activity?from=' + activityFrom].map(get));
        if (!life.ok || life.body?.success !== true) return { reachable: false, status: life.status };
        const fresh = activity.ok && activity.body?.success === true ? activity.body.data : null;
        if (fresh) {
          for (const e of fresh.events || []) activityLog.set(e.seq, e);
          for (const k of [...activityLog.keys()].sort((a, b) => a - b).slice(0, Math.max(0, activityLog.size - 200))) activityLog.delete(k);
          activityFrom = Number.isSafeInteger(fresh.next) ? fresh.next : activityFrom;
        }
        return { reachable: true, asOf: new Date().toISOString(), lifecycle: life.body.data,
          sessions: sessions.ok ? sessions.body?.data?.sessions || [] : null, runs: runs.ok ? runs.body?.data?.runs || [] : null,
          activity: [...activityLog.values()], activityAvailable: !!fresh };
      } catch { return { reachable: false, status: 0 }; }
    },
    // UI language: Core's shared CLI appearance key cli.language ('en'|'id'); unset or unavailable -> English.
    async language() {
      try { const r = await get('/api/r9/cli/settings'); return r.ok && r.body?.data?.cli?.language === 'id' ? 'id' : 'en'; } catch { return 'en'; }
    },
    // Owner decision on a pending permission (main process only). permissionId/turnId come from Core's own activity
    // feed, never from the renderer; decision is one of once|session|deny.
    async decide({ turnId, permissionId, decision }) {
      if (!/^turn-[a-f0-9-]{36}$/.test(turnId || '') || !/^perm-[a-f0-9-]{36}$/.test(permissionId || '') || !['once', 'session', 'deny'].includes(decision)) throw Error('DECISION_INVALID');
      const response = await transport(`${endpoint}/api/r9/turns/${turnId}/permission`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + token('owner') },
        body: JSON.stringify({ permissionId, decision, surface: 'notch' }) });
      return { ok: response.ok, status: response.status, body: await boundedResponse(response).catch(() => null) };
    },
    // 404 (route not mounted yet) or any failure -> prototype defaults; source says which.
    async settings() {
      try {
        const r = await get('/api/r9/presence/settings');
        if (r.ok && r.body?.success === true) return { source: 'core', ...settingsFrom(r.body.data) };
        return { source: r.status === 404 ? 'defaults-route-absent' : 'defaults-unavailable', ...DEFAULTS };
      } catch { return { source: 'defaults-unavailable', ...DEFAULTS }; }
    },
  };
}

// Polls Core: state every stateMs, settings every settingsMs (live apply, no restart). Calls back only on change.
function watchCore(core, { onState, onSettings, stateMs = 2000, settingsMs = 5000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let lastState = '', lastSettings = '', stopped = false;
  const pollState = async () => { const s = await core.snapshot(); if (stopped) return; const { asOf, ...cmp } = s; const k = JSON.stringify(cmp); if (k !== lastState) { lastState = k; onState?.(s); } };
  const pollSettings = async () => { const s = await core.settings(); if (stopped) return; const k = JSON.stringify(s); if (k !== lastSettings) { lastSettings = k; onSettings?.(s); } };
  const a = setTimer(pollState, stateMs), b = setTimer(pollSettings, settingsMs);
  const ready = Promise.all([pollState(), pollSettings()]);
  return { ready, pollState, pollSettings, stop() { stopped = true; clearTimer(a); clearTimer(b); } };
}

module.exports = { createCorePresence, watchCore, settingsFrom, resolveSessionDirectory, dataRoot, DEFAULTS, KEYS, READS };
