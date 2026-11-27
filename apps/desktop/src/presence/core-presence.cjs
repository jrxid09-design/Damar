'use strict';
// presence channel tag: c48f335052cd4abe
// Core binding for DAMAR Presence. Same credential source as the CLI (src/cli/service.cjs: the private Core session
// directory's credentials.json, validated session.json address). Reads use only the least-privileged `requester`
// token and GET routes from a fixed allowlist. Mutations use the `owner` token in the main process only: an Owner
// decision on a pending permission from the notch (decide()), media control (mediaControl()), and the first-run
// onboarding writes (saveOnboarding(), connectProvider(), onboardingChat() - see presence-onboarding.js).
const fs = require('node:fs'), path = require('node:path');
const { coreEndpoint } = require('../cli/core-endpoint.cjs');
const { boundedResponse } = require('../cli/service.cjs');

const READS = Object.freeze(['/api/r9/lifecycle', '/api/r9/sessions', '/api/r9/pandawa/runs', '/api/r9/presence/settings', '/api/r9/cli/settings', '/api/r9/activity', '/api/r9/media']);
const readAllowed = route => READS.includes(route) || /^\/api\/r9\/activity\?from=\d{1,9}$/.test(route);
// Contract agreed with Control (presence.* namespace). Defaults equal the Owner prototype values.
const DEFAULTS = Object.freeze({ idleToNotchMs: 10000, morphMs: 620, reducedMotion: 'system', notchEnabled: true, notificationPrivacy: 'redacted', display: 'primary', position: 'top-center', voiceEnabled: false, displayName: 'Maronns', salutation: '', onboardingCompleted: false });
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
    displayName: typeof get('displayName') === 'string' && get('displayName').length <= 40 && !/[\x00-\x1f\x7f]/.test(get('displayName')) ? get('displayName').trim() : DEFAULTS.displayName,
    salutation: typeof get('salutation') === 'string' && get('salutation').length <= 40 && !/[\x00-\x1f\x7f]/.test(get('salutation')) ? get('salutation').trim() : '',
    onboardingCompleted: get('onboardingCompleted') === true, // strict: anything but literal true keeps the first-run gate open
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
  // Owner-token calls for the first-run onboarding writes (main process only; the key, when one is in flight,
  // travels in the connect body only and is never returned, logged or stored here - Core's DPAPI store keeps it).
  async function ownerPost(route, payload, ms = 15000) {
    const response = await transport(endpoint + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(ms),
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + token('owner') },
      body: JSON.stringify(payload) });
    return { ok: response.ok, status: response.status, body: await boundedResponse(response).catch(() => null) };
  }
  async function ownerGet(route) {
    const response = await transport(endpoint + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json', authorization: 'Bearer ' + token('owner') } });
    return { ok: response.ok, status: response.status, body: await boundedResponse(response).catch(() => null) };
  }
  return {
    endpoint,
    async snapshot() {
      try {
        const [life, sessions, runs, activity, media] = await Promise.all(['/api/r9/lifecycle', '/api/r9/sessions', '/api/r9/pandawa/runs', '/api/r9/activity?from=' + activityFrom, '/api/r9/media'].map(get));
        if (!life.ok || life.body?.success !== true) return { reachable: false, status: life.status };
        const fresh = activity.ok && activity.body?.success === true ? activity.body.data : null;
        if (fresh) {
          for (const e of fresh.events || []) activityLog.set(e.seq, e);
          for (const k of [...activityLog.keys()].sort((a, b) => a - b).slice(0, Math.max(0, activityLog.size - 200))) activityLog.delete(k);
          activityFrom = Number.isSafeInteger(fresh.next) ? fresh.next : activityFrom;
        }
        return { reachable: true, asOf: new Date().toISOString(), lifecycle: life.body.data,
          sessions: sessions.ok ? sessions.body?.data?.sessions || [] : null, runs: runs.ok ? runs.body?.data?.runs || [] : null,
          media: media.ok && media.body?.success === true ? media.body.data : null,
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
    // Owner media control from the notch (play/pause/next/previous). Main process only, owner
    // token - the same trust posture as decide(). Action allowlist enforced again in core-host.
    async mediaControl(action) {
      if (!['play', 'pause', 'next', 'previous'].includes(action)) throw Error('MEDIA_ACTION_INVALID');
      const response = await transport(endpoint + '/api/r9/media', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + token('owner') },
        body: JSON.stringify({ action }) });
      return { ok: response.ok, status: response.status, body: await boundedResponse(response).catch(() => null) };
    },
    // First-run onboarding: save the confirmed answers. The client shapes the body to the route's allowlist;
    // Core composes the settings update and sets presence.onboardingCompleted itself (the flag is never sent).
    async saveOnboarding(values = {}) {
      const payload = {};
      if (typeof values.displayName === 'string') payload.displayName = values.displayName;
      if (typeof values.salutation === 'string') payload.salutation = values.salutation;
      if (typeof values.voiceEnabled === 'boolean') payload.voiceEnabled = values.voiceEnabled;
      if (['id', 'en'].includes(values.language)) payload.language = values.language;
      return ownerPost('/api/r9/presence/onboarding', payload);
    },
    // First-run onboarding, step 0: connect the Owner's own OpenAI-compatible endpoint as the 'custom'
    // connection (key remembered in Core's DPAPI store via the existing connect route), prove the key with
    // the router's key test (reads /models, spends no tokens), then record the Owner's model grant for the
    // connection - the same journaled grant Control's quick action writes (approval reference
    // 'first-run-onboarding', all models, 30 days). V2: before selecting, Core probes the catalog
    // (capability-first policy in onboarding-chat.cjs: responds / tool-calling / streaming / latency;
    // brain = most capable at acceptable latency, token-heavy Astra class never a silent default) and the
    // probed brain is selected explicitly (Core requires an explicit, grant-covered model for a live
    // selection; the Owner can change it any time in Control). If the probe route is unavailable or no
    // model answers, selection falls back to the first catalog model (v1 behavior, flagged in the result).
    // Any stage failing leaves the flow free to fall back to the template.
    async connectProvider({ baseUrl, apiKey } = {}) {
      if (typeof baseUrl !== 'string' || !/^https?:\/\/\S{1,300}$/.test(baseUrl) || typeof apiKey !== 'string' || !apiKey || apiKey.length > 512) throw Error('CONNECT_INPUT_INVALID');
      let r = await ownerPost('/api/r9/connect', { provider: 'custom', baseUrl, apiKey, remember: true }, 20000);
      if (!r.ok || r.body?.success !== true) return { ok: false, stage: 'connect', status: r.status, error: r.body?.error || 'CONNECT_FAILED' };
      r = await ownerPost('/api/r9/provider-admin/test', { provider: 'custom', kind: 'keys' });
      const results = Array.isArray(r.body?.data) ? r.body.data : [];
      if (!r.ok || !results.some(k => k && k.ok)) return { ok: false, stage: 'test', status: r.status, error: results.find(k => k && !k.ok)?.error || r.body?.error || 'PROVIDER_TEST_FAILED' };
      const list = await ownerGet('/api/r9/provider');
      const prov = list.body?.data?.providers?.find(p => p.id === 'custom' && p.kind === 'live');
      if (!prov?.baseUrl || !prov.configurationVersion) return { ok: false, stage: 'state', status: list.status, error: 'PROVIDER_STATE_UNAVAILABLE' };
      const catalog = await ownerGet('/api/r9/models?provider=custom');
      const models = Array.isArray(catalog.body?.data?.models) ? catalog.body.data.models.filter(m => typeof m === 'string' && m) : [];
      if (!models.length) return { ok: false, stage: 'models', status: catalog.status, error: 'NO_MODELS_OFFERED' };
      r = await ownerPost('/api/r9/provider/model-grant', { expectedVersion: prov.configurationVersion, approval: 'first-run-onboarding', provider: 'custom', baseUrl: prov.baseUrl, model: '*', expiresAt: Date.now() + 30 * 86400000 });
      if (!r.ok || r.body?.success !== true) return { ok: false, stage: 'grant', status: r.status, error: r.body?.error || 'MODEL_GRANT_FAILED' };
      // V2 probing (bounded server-side; generous client timeout for a full catalog sweep).
      let brain = models[0], reflex = models[0], probes = null, brainTokenHeavy = false, probeUnavailable = false;
      const probe = await ownerPost('/api/r9/presence/onboarding/probe', {}, 180000);
      if (probe.ok && probe.body?.success === true && typeof probe.body.data?.brain === 'string' && models.includes(probe.body.data.brain)) {
        brain = probe.body.data.brain;
        reflex = typeof probe.body.data.reflex === 'string' ? probe.body.data.reflex : brain;
        probes = Array.isArray(probe.body.data.results) ? probe.body.data.results : null;
        brainTokenHeavy = probe.body.data.brainTokenHeavy === true;
      } else probeUnavailable = true;
      r = await ownerPost('/api/r9/provider', { provider: 'custom', model: brain });
      if (!r.ok || r.body?.success !== true) return { ok: false, stage: 'select', status: r.status, error: r.body?.error || 'PROVIDER_SELECT_FAILED' };
      return { ok: true, provider: 'custom', baseUrl: prov.baseUrl, model: brain, reflex, models: models.length, probes, brainTokenHeavy, ...(probeUnavailable ? { probeUnavailable: true } : {}) };
    },
    // First-run onboarding, branch A: one interview turn. Core holds the fixed system prompt and the model
    // choice; the renderer sends only user/assistant turns (validated again in Core).
    async onboardingChat(messages) {
      if (!Array.isArray(messages)) throw Error('ONBOARDING_MESSAGES_INVALID');
      const clean = messages.slice(-16).map(m => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content ?? '') }));
      return ownerPost('/api/r9/presence/onboarding/chat', { messages: clean }, 90000);
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
