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

const READS = Object.freeze(['/api/r9/lifecycle', '/api/r9/sessions', '/api/r9/pandawa/runs', '/api/r9/presence/settings', '/api/r9/cli/settings', '/api/r9/activity', '/api/r9/media', '/api/r9/provider', '/api/r9/mata-dewa/status']);
const readAllowed = route => READS.includes(route) || /^\/api\/r9\/activity\?from=\d{1,9}$/.test(route) || /^\/api\/r9\/mata-dewa\/feeds\/[a-z]+$/.test(route) || /^\/api\/r9\/mata-dewa\/imagery\/chip\?point=[a-z0-9-]{1,24}&day=\d{4}-\d{2}-\d{2}&product=(?:S30|L30)$/.test(route);
// Contract agreed with Control (presence.* namespace). Defaults equal the Owner prototype values.
const DEFAULTS = Object.freeze({ idleToOrbSec: 120, orbToNotchSec: 120, notchHideSec: 1800, morphMs: 620, reducedMotion: 'system', notchEnabled: true, notificationPrivacy: 'redacted', display: 'primary', position: 'top-center', voiceEnabled: false, characterSoundEnabled: true, characterSoundVolume: 30, displayName: 'Maronns', salutation: '', onboardingCompleted: false });
const KEYS = Object.freeze(Object.keys(DEFAULTS).map(k => 'presence.' + k));

// Snippet vocabulary (Owner 2026-11-28): friendly Indonesian labels for the
// turn's real tool events, and plain-language provider failure kinds for the
// failure record. Lines are built only from Core turn events; nothing here
// invents activity.
const TOOL_LABELS = Object.freeze({ workspace_shell: 'Shell', workspace_run: 'Perintah', workspace_write: 'Tulis berkas', workspace_edit: 'Ubah berkas', workspace_read: 'Baca berkas', workspace_list: 'Lihat isi folder', workspace_grep: 'Cari teks', plan_update: 'Rencana', project_memory_add: 'Simpan catatan', trusted_plugin_execute: 'Plugin' });
const BADGE_LABELS = Object.freeze({ READ: 'Baca', GLOB: 'Lihat', GREP: 'Cari', RUN: 'Jalankan', VERIFY: 'Periksa', SHELL: 'Shell', PLUGIN: 'Plugin' });
const SNIPPET_ERROR_ID = Object.freeze({ QUOTA: 'kuota provider habis', AUTH: 'kunci provider ditolak', RATE_LIMIT: 'provider membatasi laju', TIMEOUT: 'provider tidak menjawab tepat waktu', UNAVAILABLE: 'provider tidak terjangkau' });
function clipLine(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Accepts {presence:{idleToNotchMs,...}} or flat {'presence.idleToNotchMs':...}; invalid values fall back per key.
function settingsFrom(data) {
  const src = data?.presence && typeof data.presence === 'object' ? data.presence : {};
  const get = k => (src[k] !== undefined ? src[k] : data?.['presence.' + k]);
  const int = (v, lo, hi, d) => (Number.isSafeInteger(v) && v >= lo && v <= hi ? v : d);
  const one = (v, list, d) => (list.includes(v) ? v : d);
  const display = get('display');
  return {
    idleToOrbSec: int(get('idleToOrbSec'), 5, 3600, DEFAULTS.idleToOrbSec),
    orbToNotchSec: int(get('orbToNotchSec'), 5, 3600, DEFAULTS.orbToNotchSec),
    notchHideSec: int(get('notchHideSec'), 10, 86400, DEFAULTS.notchHideSec),
    characterSoundEnabled: typeof get('characterSoundEnabled') === 'boolean' ? get('characterSoundEnabled') : DEFAULTS.characterSoundEnabled,
    characterSoundVolume: int(get('characterSoundVolume'), 0, 100, DEFAULTS.characterSoundVolume),
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
// Lookup order: explicit --session; the launcher's <data root>\state\last-core.json (the most recent Core the
// launcher started); the CLI profile's remembered core_session (src/cli/main.cjs:78-80; profile default
// <data root>\profile). Candidates are VALIDATED: the remembered profile session can be days stale - its
// directory deleted or its Core long gone - and binding to it silently left Presence "not connected" forever
// while the real Core was healthy (Owner report 2026-11-27). A candidate wins only if its session.json exists
// and names this endpoint; if none matches the endpoint, the first candidate that exists at all is used.
function resolveSessionDirectory({ session, profile, env = process.env } = {}) {
  if (session) return session;
  const root = dataRoot(env);
  const candidates = [];
  try { const s = JSON.parse(fs.readFileSync(path.join(root, 'state', 'last-core.json'), 'utf8')).session; if (typeof s === 'string' && path.isAbsolute(s)) candidates.push(s); } catch {}
  try { const { UISettings } = require('../cli/ui-settings.cjs'); const s = new UISettings(profile || path.join(root, 'profile')).load().core_session; if (s) candidates.push(s); } catch {}
  const read = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); } catch { return null; } };
  let endpoint = null; try { endpoint = coreEndpoint(env); } catch {}
  for (const dir of candidates) { const d = read(dir); if (d && endpoint && d.address === endpoint) return dir; }
  for (const dir of candidates) { if (read(dir)) return dir; }
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
  // Presence conversation state: its own attached CLI session (client 'damar-presence') + the turns brokered
  // through it. Core owns the turns; this cache only lets the page re-read what it already sent and received.
  const CHAT_CLIENT = 'damar-presence';
  const chatState = { sessionId: null, history: [] };
  async function get(route) {
    if (!readAllowed(route)) throw Error('PRESENCE_ROUTE_DENIED');
    const response = await transport(endpoint + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { accept: 'application/json', authorization: 'Bearer ' + token() } });
    return { ok: response.ok, status: response.status, body: await boundedResponse(response).catch(() => null) };
  }
  // Binary read for the dated satellite chip (JPEG); same allowlist + requester token.
  async function getBinary(route) {
    if (!readAllowed(route)) throw Error('PRESENCE_ROUTE_DENIED');
    const response = await transport(endpoint + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { accept: 'image/jpeg', authorization: 'Bearer ' + token() } });
    if (!response.ok) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.length >= 1024 && buf.length <= 2 * 1024 * 1024 ? buf : null;
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
  // The v1 console API on the same Core authenticates with the console
  // credential (console-credentials.json); used server-side only.
  const consoleToken = () => {
    const t = JSON.parse(fs.readFileSync(path.join(sessionDirectory, 'console-credentials.json'), 'utf8'))['console'];
    if (typeof t !== 'string' || !t || t.length > 4096 || /[\r\n]/.test(t)) throw Error('INVALID_PRIVATE_CREDENTIAL');
    return t;
  };
  async function consoleGet(route) {
    const response = await transport(endpoint + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: { accept: 'application/json', authorization: 'Bearer ' + consoleToken() } });
    return { ok: response.ok, status: response.status, body: await boundedResponse(response).catch(() => null) };
  }
  let extrasCache = { at: 0, value: null };
  return {
    endpoint,
    async snapshot() {
      try {
        const [life, sessions, runs, activity, media, provider] = await Promise.all(['/api/r9/lifecycle', '/api/r9/sessions', '/api/r9/pandawa/runs', '/api/r9/activity?from=' + activityFrom, '/api/r9/media', '/api/r9/provider'].map(get));
        if (!life.ok || life.body?.success !== true) return { reachable: false, status: life.status };
        const fresh = activity.ok && activity.body?.success === true ? activity.body.data : null;
        if (fresh) {
          for (const e of fresh.events || []) activityLog.set(e.seq, e);
          for (const k of [...activityLog.keys()].sort((a, b) => a - b).slice(0, Math.max(0, activityLog.size - 200))) activityLog.delete(k);
          activityFrom = Number.isSafeInteger(fresh.next) ? fresh.next : activityFrom;
        }
        let mataDewa = null;
        try {
          const st = await get('/api/r9/mata-dewa/status');
          if (st.ok && st.body?.success === true) {
            mataDewa = { status: st.body.data, feeds: {} };
            const enabledFeeds = new Set((mataDewa.status.feeds || []).filter(f => f.enabled).map(f => f.id));
            const want = mataDewa.status.consent ? ['weather', 'earthquakes', 'disasters', 'cyclones', 'airQuality', 'launches', 'satellites', 'flights', 'imagery'].filter(id => enabledFeeds.has(id)) : [];
            await Promise.all(want.map(async fid => {
              try { const fr = await get('/api/r9/mata-dewa/feeds/' + fid); if (fr.ok && fr.body?.success === true) mataDewa.feeds[fid] = fr.body.data; } catch {}
            }));
            try { const pv = await ownerGet('/api/r9/mata-dewa/proactive'); if (pv.ok && pv.body?.success === true) mataDewa.proactive = { status: pv.body.data.status, recent: pv.body.data.deliveries || [] }; } catch {}
            // Dated chip for the first location with a scene; the projection
            // re-ships the pixels only when the scene key changes.
            const img0 = mataDewa.feeds.imagery?.results?.[0]?.items?.[0];
            if (img0) {
              const point = String(img0.locationId || '').replace(/^(area|wp):/, '');
              try { const chip = await getBinary('/api/r9/mata-dewa/imagery/chip?point=' + point + '&day=' + img0.day + '&product=' + img0.product);
                if (chip) mataDewa.chip = { sceneKey: point + '|' + img0.day + '|' + img0.product, jpeg: chip.toString('base64') }; } catch {}
            }
          }
        } catch {}
        return { reachable: true, asOf: new Date().toISOString(), lifecycle: life.body.data, mataDewa,
          sessions: sessions.ok ? sessions.body?.data?.sessions || [] : null, runs: runs.ok ? runs.body?.data?.runs || [] : null,
          media: media.ok && media.body?.success === true ? media.body.data : null,
          providers: provider.ok && provider.body?.success === true ? provider.body.data : null,
          activity: [...activityLog.values()], activityAvailable: !!fresh };
      } catch { return { reachable: false, status: 0 }; }
    },
    // UI language: Core's shared CLI appearance key cli.language ('en'|'id'); unset or unavailable -> English.
    async language() {
      try { const r = await get('/api/r9/cli/settings'); return r.ok && r.body?.data?.cli?.language === 'id' ? 'id' : 'en'; } catch { return 'en'; }
    },
    // The pending permission's command detail, read with the OWNER credential:
    // the presence-role activity feed redacts `detail`, but the owner deciding
    // in his own surface must see WHAT he is deciding (Owner 2026-11-28).
    // Returns a short plain string or null.
    // Approval history (Owner 2026-11-28): the Authority surface shows the
    // RECORD, not only what is pending. Pairs this Core session's permission
    // requests with their answers from the owner activity feed: what was
    // asked, which turn raised it, the decision, and when.
    async approvalHistory() {
      const r = await ownerGet('/api/r9/activity');
      const events = r.body?.data?.events || [];
      const answers = new Map();
      for (const e of events) if (e.kind === 'permission_answer') answers.set(e.permissionId, e);
      const rows = [];
      for (const e of events) {
        if (e.kind !== 'permission') continue;
        const a = answers.get(e.permissionId);
        rows.push({ permissionId: e.permissionId, turnId: e.turnId || null,
          tool: typeof e.tool === 'string' ? e.tool.slice(0, 40) : null,
          detail: typeof e.detail === 'string' ? e.detail.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 140) : null,
          file: typeof e.file === 'string' ? e.file.slice(0, 120) : null,
          decision: a ? a.decision : null, at: e.at ?? null, answeredAt: a ? (a.at ?? null) : null });
      }
      return rows.slice(-12).reverse();
    },
    async permissionDetail(permissionId) {
      const r = await ownerGet('/api/r9/activity');
      const events = r.body?.data?.events || [];
      const ev = events.find(e => e.kind === 'permission' && e.permissionId === permissionId);
      return ev && typeof ev.detail === 'string' ? ev.detail.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 140) : null;
    },
    // Key-point extras for the Presence portals (Owner 2026-11-28): Devices,
    // Capabilities, Memory, Projects and Finance render REAL Core data, never
    // a bounce placeholder. Same stores Control reads. Cached 20 s.
    async extras() {
      if (extrasCache.value && Date.now() - extrasCache.at < 20000) return extrasCache.value;
      const [budget, gateway, sessionsR, mem, mcp, plugins, productivity] = await Promise.all([
        ownerGet('/api/r9/provider/budget').catch(() => null),
        ownerGet('/api/r9/gateway').catch(() => null),
        ownerGet('/api/r9/sessions').catch(() => null),
        consoleGet('/api/v1/console/memory/stats').catch(() => null),
        consoleGet('/api/v1/console/mcp/servers').catch(() => null),
        consoleGet('/api/v1/console/plugins').catch(() => null),
        consoleGet('/api/v1/console/mcp/productivity').catch(() => null),
      ]);
      const d = r => (r && r.ok && r.body?.success === true ? r.body.data : null);
      const b = d(budget), g = d(gateway), memd = d(mem), mcpd = d(mcp), plugd = d(plugins), prod = d(productivity);
      const sessions = d(sessionsR)?.sessions || [];
      const cwds = new Map();
      for (const s2 of sessions) {
        const c = typeof s2.cwd === 'string' ? s2.cwd : '';
        if (!c) continue;
        const e = cwds.get(c) || { cwd: c, sessions: 0, open: 0 };
        e.sessions++; if (!s2.closed) e.open++;
        cwds.set(c, e);
      }
      const prodServers = Array.isArray(prod?.servers) ? prod.servers : [];
      const connected = prodServers.filter(x => x.connected === true || x.status === 'connected' || x.state === 'connected').length;
      const value = {
        usage: b ? { attempts: b.attempts ?? null, totalTokens: b.totalTokens ?? null, limitTokens: b.limits?.totalTokens ?? null, blocked: !!b.blocked } : null,
        devices: { gateway: g ? { enabled: !!g.settings?.enabled, port: g.settings?.port ?? null, keys: Array.isArray(g.keys) ? g.keys.length : 0 } : null },
        projects: [...cwds.values()].slice(0, 6),
        memory: memd ? { memories: memd.memories?.total ?? null, entities: memd.entities?.total ?? null, documents: memd.documents?.total ?? null, embeddings: !!memd.embeddings?.available } : null,
        capabilities: (mcpd || plugd || prod) ? { toolsExposed: mcpd?.server?.exposed ?? null, toolsTotal: mcpd?.server?.total ?? null, clientsRunning: mcpd?.clients?.running ?? null, plugins: plugd?.total ?? null, mcpServers: prodServers.length || null, mcpConnected: connected } : null,
      };
      extrasCache = { at: Date.now(), value };
      return value;
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
    // Presence conversation: a real Core agent turn (turns.start) on Presence's own attached session - the same
    // machinery the CLI uses, with the Owner-configured provider. The session lease is refreshed while a turn
    // runs (Core stops work whose lease lapses). Permission pauses surface in the notch/CLI as usual; this call
    // simply waits for the final event, bounded to 4 minutes.
    async ensureChatSession() {
      const cwd = require('node:os').homedir();
      if (chatState.sessionId) {
        const attached = await ownerPost('/api/r9/sessions/' + chatState.sessionId + '/attach', { client: CHAT_CLIENT });
        if (attached.ok) return chatState.sessionId;
        chatState.sessionId = null;
      }
      // Reuse an existing session for this client when Core still knows one
      // (e.g. after a Presence relaunch): creating a fresh session on every
      // launch piled up identical 'Damar Presence' sessions in the registry.
      try {
        const list = await ownerGet('/api/r9/sessions');
        const rows = Array.isArray(list.body?.data?.sessions) ? list.body.data.sessions : [];
        const prior = rows.find(s => s && s.client === CHAT_CLIENT && !s.closed && typeof (s.sessionId || s.id) === 'string');
        const priorId = prior && (prior.sessionId || prior.id);
        if (priorId) {
          const re = await ownerPost('/api/r9/sessions/' + priorId + '/attach', { client: CHAT_CLIENT });
          if (re.ok) { chatState.sessionId = priorId; return priorId; }
        }
      } catch {}
      const created = await ownerPost('/api/r9/sessions', { client: CHAT_CLIENT, cwd, title: 'Damar Presence' });
      const id = created.body?.data?.sessionId;
      if (!created.ok || typeof id !== 'string') throw Error('PRESENCE_SESSION_CREATE_FAILED');
      chatState.sessionId = id;
      return id;
    },
    async chat(text, onDelta, onPhase, onStep) {
      if (typeof text !== 'string' || !text.trim() || text.length > 8000) return { ok: false, status: 400, error: 'TEXT_REQUIRED' };
      const cwd = require('node:os').homedir();
      let cliSession = await this.ensureChatSession();
      let started = await ownerPost('/api/r9/turns', { cliSession, client: CHAT_CLIENT, text, cwd }, 30000);
      if (!started.ok && ['SESSION_NOT_ATTACHED', 'SESSION_NOT_FOUND', 'SESSION_CLOSED'].includes(started.body?.error)) {
        chatState.sessionId = null;
        cliSession = await this.ensureChatSession();
        started = await ownerPost('/api/r9/turns', { cliSession, client: CHAT_CLIENT, text, cwd }, 30000);
      }
      if (!started.ok || typeof started.body?.data?.turnId !== 'string') return { ok: false, status: started.status, error: started.body?.error || 'TURN_START_FAILED' };
      const turnId = started.body.data.turnId;
      // Snippet tracker (Owner 2026-11-28): compact lines built ONLY from the
      // turn's real Core events, forwarded live via onStep so the response box
      // shows what Damar is doing; on failure the last step feeds the failure
      // record (essential lines, ellipsis-cut, full log in Control Diagnostik).
      const tracker = { last: '' };
      const emitStep = (line, key) => { if (typeof line === 'string' && line) { tracker.last = line; if (onStep) { try { onStep(line, key || null); } catch {} } } };
      const failWith = (error, status, kind) => {
        const code = typeof error === 'string' && error ? error : 'TURN_FAILED';
        const lines = [];
        if (code === 'TURN_TIMEOUT') lines.push('Sebab: melewati batas waktu pengerjaan.');
        else {
          if (tracker.last) lines.push('Gagal pada langkah: ' + tracker.last);
          lines.push('Sebab: ' + (kind && SNIPPET_ERROR_ID[kind] ? SNIPPET_ERROR_ID[kind] + ' (' + code + ')' : clipLine(code, 110)));
        }
        lines.push('Rincian lengkap ada di Control, menu Diagnostik.');
        return this._failTurn(text, code, status, lines);
      };
      // Turn accepted by Core: the surface's single status statement moves
      // from Mengirim to Berpikir here (the first delta moves it to Menjawab).
      if (onPhase) { try { onPhase('berpikir'); } catch {} }
      // Action/tool turns legitimately run for minutes (shell steps, media
      // actions). The deadline must outlast them: expiring it cancels the
      // SSE stream, which Core reads as CLIENT_DISCONNECTED and kills the
      // turn - a Presence-side timeout must never poison a working turn.
      const deadline = Date.now() + 900000;
      // Progressive path first: consume the turn's SSE event stream so the
      // surface renders the reply as it is produced (delta events), not only
      // when it completes. Any stream failure falls back to the status poll.
      try {
        const streamed = await this._streamTurn(turnId, text, deadline, onDelta, cliSession, onPhase, emitStep);
        if (streamed) {
          if (streamed.ok) return streamed;
          return failWith(streamed.error, streamed.status, streamed.errorKind);
        }
      } catch {}
      let lastAttach = Date.now();
      const pollDeadline = Date.now() + 300000;
      while (Date.now() < pollDeadline) {
        await new Promise(r => setTimeout(r, 800));
        if (Date.now() - lastAttach > 10000) { lastAttach = Date.now(); try { await ownerPost('/api/r9/sessions/' + cliSession + '/attach', { client: CHAT_CLIENT }); } catch {} }
        const st = await ownerGet('/api/r9/turns/' + turnId);
        const fin = st.body?.data?.final;
        if (fin) {
          if (fin.status === 'COMPLETED' && typeof fin.text === 'string') {
            chatState.history.push({ role: 'user', content: text }, { role: 'assistant', content: fin.text });
            if (chatState.history.length > 40) chatState.history.splice(0, chatState.history.length - 40);
            return { ok: true, answer: fin.text, turnId };
          }
          return failWith(fin.error || ('TURN_' + (fin.status || 'FAILED')), 502, fin.errorKind);
        }
      }
      return failWith('TURN_TIMEOUT', 504);
    },
    // Error containment (Owner 2026-11-28): a failed turn is answered INSIDE
    // the conversation with an honest Indonesian notice and recorded in the
    // history, so the surface never flips to UNAVAILABLE over one bad turn
    // and the next message continues on the same live session.
    _failTurn(text, error, status, failLines) {
      const code = typeof error === 'string' && error ? error : 'TURN_FAILED';
      const notice = code === 'TURN_TIMEOUT'
        ? 'Permintaan itu kuhentikan karena melewati batas waktu pengerjaan. Percakapan tetap tersambung, silakan lanjut.'
        : 'Maaf, permintaan itu gagal dijalankan (' + code + '). Percakapan tetap tersambung, silakan lanjut.';
      chatState.history.push({ role: 'user', content: text }, { role: 'assistant', content: notice });
      if (chatState.history.length > 40) chatState.history.splice(0, chatState.history.length - 40);
      return { ok: false, status: status || 502, error: code, notice, failLines: Array.isArray(failLines) ? failLines : [] };
    },
    async _streamTurn(turnId, text, deadline, onDelta, cliSession, onPhase, emitStep) {
      const response = await transport(endpoint + '/api/r9/turns/' + turnId + '/events?from=0', { method: 'GET', redirect: 'error',
        headers: { accept: 'text/event-stream', authorization: 'Bearer ' + token('owner') } });
      if (!response.ok || !response.body?.getReader) return null;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', acc = '', lastAttach = Date.now(), reasonBuf = '';
      const keepAlive = async () => {
        if (Date.now() - lastAttach <= 10000) return;
        lastAttach = Date.now();
        try { await ownerPost('/api/r9/sessions/' + cliSession + '/attach', { client: CHAT_CLIENT }); } catch {}
      };
      while (Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r(null), 5000))]);
        if (!chunk) { await keepAlive(); continue; }
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const rawEv = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = rawEv.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'delta' && typeof ev.text === 'string') { acc += ev.text; if (onDelta) { try { onDelta(acc); } catch {} } }
          // Progress phases for the surface's single status statement and its
          // silence watchdog: tool steps mean the turn is acting, reasoning
          // means it is still thinking. Neither carries answer text.
          if ((ev.type === 'tool_call' || ev.type === 'tool') && onPhase) { try { onPhase('bertindak'); } catch {} }
          if (ev.type === 'reasoning' && onPhase) { try { onPhase('berpikir'); } catch {} }
          // Snippet lines from the same real events (never decorative filler).
          if (emitStep) {
            if (ev.type === 'reasoning' && typeof ev.text === 'string') { reasonBuf = (reasonBuf + ' ' + ev.text).slice(-600); emitStep(clipLine(reasonBuf, 130), 'reason'); }
            else if (ev.type === 'tool_call') emitStep(TOOL_LABELS[ev.name] || String(ev.name || 'Alat'));
            else if (ev.type === 'tool') emitStep((BADGE_LABELS[ev.badge] || ev.badge || 'Alat') + ': ' + clipLine(ev.target, 105));
            else if (ev.type === 'run') emitStep(ev.exitCode === 0 ? 'Selesai: ' + clipLine(ev.target, 100) : 'Gagal (kode ' + ev.exitCode + '): ' + clipLine(ev.target, 85));
            else if (ev.type === 'diff') emitStep('Ubah ' + clipLine(ev.path, 85) + ' (+' + (ev.diff?.added || 0) + '/-' + (ev.diff?.removed || 0) + ')');
            else if (ev.type === 'plan' && Array.isArray(ev.steps)) { const doneN = ev.steps.filter(s => s.state === 'done').length; const actS = ev.steps.find(s => s.state === 'active'); emitStep('Rencana ' + doneN + '/' + ev.steps.length + (actS ? ': ' + clipLine(actS.label, 75) : ''), 'plan'); }
            else if (ev.type === 'permission') emitStep('Menunggu persetujuan: ' + clipLine(ev.card?.tool || 'tindakan', 35) + (ev.card?.run ? ' (' + clipLine(ev.card.run, 65) + ')' : ''));
            else if (ev.type === 'permission_answer') emitStep(ev.decision === 'deny' ? 'Ditolak oleh pemilik' : ev.decision === 'session' ? 'Disetujui untuk sesi ini' : 'Disetujui sekali');
          }
          if (ev.type === 'final') {
            try { reader.cancel(); } catch {}
            if (ev.status === 'COMPLETED' && typeof ev.text === 'string') {
              chatState.history.push({ role: 'user', content: text }, { role: 'assistant', content: ev.text });
              if (chatState.history.length > 40) chatState.history.splice(0, chatState.history.length - 40);
              return { ok: true, answer: ev.text, turnId };
            }
            return { ok: false, status: 502, error: ev.error || ('TURN_' + (ev.status || 'FAILED')), errorKind: ev.errorKind || null };
          }
        }
        await keepAlive();
      }
      try { reader.cancel(); } catch {}
      return null;
    },
    conversationHistory() { return chatState.history.slice(); },
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
