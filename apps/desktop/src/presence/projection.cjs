'use strict';
// Presence projection: Core read state -> the four read models the Owner Idle Presence page already consumes
// (/api/ui/presence/state, /approvals, /missions, /notifications), allowlisted and redacted.
// Port of the canonical rules in C/src/presence-ui/projection.js:6-45 (allowlist before DOM, sensitive items redacted
// unless revealed, missing/stale source stays UNKNOWN, voice never implies global health). A projection, never a state
// engine: it holds no authority and nothing in it can approve, cancel or start work.

const PRIVACY = ['redacted', 'counts-only', 'hidden'];
const text = (v, n = 120) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, ' ').slice(0, n) : null);
const RUN_STATE = { ACCEPTED: 'ACTIVE', RUNNING: 'ACTIVE', COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED', OUTCOME_UNKNOWN: 'UNKNOWN' };

// core: { reachable, lifecycle:{state,outstanding}, sessions:[...], runs:[...], media, asOf } from core-presence.cjs.
// Pandawa task text and output previews are user content: never projected (title = worker name only).
function project(core, { notificationPrivacy = 'redacted' } = {}) {
  const privacy = PRIVACY.includes(notificationPrivacy) ? notificationPrivacy : 'redacted';
  if (!core || core.reachable !== true) {
    return { status: 'NOT_CONNECTED', reason: 'DAMAR Core tidak terjangkau.', presence: null, approvals: null, missions: null, notifications: null };
  }
  const o = core.lifecycle?.outstanding || {};
  const n = k => (Number.isSafeInteger(o[k]) && o[k] >= 0 ? o[k] : 0);
  const pending = n('pendingPermissions'), activeTurns = n('activeTurns'), activeRuns = n('activePandawaRuns') + n('queuedPandawaRuns');
  const lifecycleState = text(core.lifecycle?.state?.state, 40) || 'UNKNOWN';
  // Only a count is known to Presence; the decision itself happens in CLI/Control with Owner auth.
  const approvals = Array.from({ length: Math.min(pending, 32) }, () => ({ approval_id: null, state: 'PENDING', effect: 'Permission waiting in DAMAR CLI', risk: null, authority_result: 'UNKNOWN', read_only: true }));
  const missions = (Array.isArray(core.runs) ? core.runs : []).slice(-32).map(r => ({
    mission_id: text(r.runId, 40), state: RUN_STATE[r.state] || 'UNKNOWN', label: 'Pandawa ' + (text(r.worker, 20) || 'run'),
  }));
  const raw = [];
  if (pending) raw.push({ kind: 'permission_request', summary: `${pending} permission request${pending === 1 ? '' : 's'} waiting. Answer in DAMAR CLI.`, privacy_sensitivity: 'NORMAL', urgency: 'HIGH' });
  for (const r of (core.runs || []).slice(-8)) if (r.state === 'FAILED' || r.state === 'OUTCOME_UNKNOWN')
    raw.push({ kind: 'pandawa_run', summary: `Pandawa ${text(r.worker, 20)} ${r.state === 'FAILED' ? 'gagal' : 'hasil belum diketahui'}: ${text(r.error || r.reason, 80) || ''}`.trim(), privacy_sensitivity: 'SENSITIVE', urgency: 'NORMAL' });
  const notifications = privacy === 'hidden' ? [] : raw.map((x, i) => ({
    notification_id: null, // no Core dismiss route: Presence cannot dismiss
    source_ref: { entity_type: x.kind, entity_id: String(i) },
    target_surfaces: ['idle_presence'], urgency: x.urgency, privacy_sensitivity: x.privacy_sensitivity,
    summary: privacy === 'counts-only' ? (x.kind === 'permission_request' ? 'Permission waiting' : 'Notification')
      : x.privacy_sensitivity !== 'NORMAL' ? 'Sensitive notification' : x.summary,
  }));
  const sessions = Array.isArray(core.sessions) ? core.sessions : [];
  const sessionPills = projectSessionPills(sessions, privacy);
  const media = projectMedia(core.media);
  return {
    status: 'CONNECTED', reason: '',
    providers: projectProviders(core.providers),
    matadewa: projectMataDewa(core.mataDewa),
    presence: { simulated: false, source: 'damar-core', lifecycle: lifecycleState, asOf: core.asOf || null,
      activity: { activeTurns, pendingPermissions: pending, activePandawaRuns: activeRuns, sessions: sessions.length },
      sessionPills, media,
      // Voice state is not read from Core here, and is never used to infer health.
      voice: { available: false, state: 'Unknown' } },
    approvals, missions, notifications,
  };
}

// Provider/model status for the page's Models portal: the registry's own view (GET /api/r9/provider),
// allowlisted to status fields only - no base URLs and no key material ever cross into the surface.
function projectProviders(data) {
  if (!data || typeof data !== 'object') return null;
  const rows = (Array.isArray(data.providers) ? data.providers : []).map(p => ({
    id: text(p.id, 40), label: text(p.label, 60), kind: text(p.kind, 20),
    baseUrl: text(p.baseUrl, 120),
    model: text(p.model, 80), executable: p.executable === true,
    grantStatus: text(p.grantStatus, 20), grantModel: text(p.grant?.model, 80),
    authorizedModels: (Array.isArray(p.authorizedModels) ? p.authorizedModels : []).map(m => text(m, 80)).filter(Boolean).slice(0, 8),
  }));
  const activeId = text(data.active, 40);
  const activeRow = rows.find(r => r.id === activeId) || null;
  return { active: activeId, model: activeRow?.model || '', executable: activeRow?.executable === true,
    liveInference: data.liveInferenceAuthorized === true, providers: rows };
}

// Mata Dewa for the Presence portal: watch points + general public feeds
// (global feeds when no watch point exists), allowlisted display fields only.
let lastChipKey = null; let lastChipShipAt = 0;
function projectMataDewa(m) {
  if (!m || typeof m !== 'object') { lastChipKey = null; return null; }
  const feedItems = (feed, pick) => {
    const items = feed?.results?.[0]?.items;
    return Array.isArray(items) ? items.slice(0, 4).map(pick).filter(Boolean) : [];
  };
  const feedCount = feed => { const r = feed?.results?.[0]; return typeof r?.count === 'number' ? r.count : (Array.isArray(r?.items) ? r.items.length : 0); };
  // Dated satellite imagery: one latest scene per configured location; the
  // chip pixels ride along only when the scene changes (same discipline as
  // the media artwork), so the poll never re-ships the image.
  const imageryItems = feedItems(m.feeds?.imagery, it => ({ name: text(it.name, 60), profile: text(it.profile, 12), product: text(it.productLabel, 40), day: text(it.day, 10), datetime: text(it.datetime, 30), cloudCoverPct: typeof it.cloudCoverPct === 'number' ? it.cloudCoverPct : null }));
  const chip = m.chip && typeof m.chip.jpeg === 'string' && m.chip.jpeg.length < 600000 ? m.chip : null;
  const chipChanged = !!chip && (chip.sceneKey !== lastChipKey || Date.now() - lastChipShipAt > 60000);
  if (chipChanged) { lastChipKey = chip.sceneKey; lastChipShipAt = Date.now(); }
  if (!chip && !m.feeds?.imagery) lastChipKey = null;
  return {
    consent: m.status?.consent === true,
    areas: (Array.isArray(m.status?.areas) ? m.status.areas : []).map(a => ({ name: text(a.name, 60), seeded: a.id === 'jakarta' })).filter(a => a.name),
    watchPoints: (Array.isArray(m.status?.watchPoints) ? m.status.watchPoints : []).map(w => ({ name: text(w.name, 60), profile: text(w.profile, 12), lat: typeof w.lat === 'number' ? w.lat : null, lon: typeof w.lon === 'number' ? w.lon : null })).filter(w => w.name),
    earthquakes: m.feeds?.earthquakes ? { attribution: text(m.feeds.earthquakes.attribution, 90), items: feedItems(m.feeds.earthquakes, q => ({ mag: typeof q.magnitude === 'number' ? q.magnitude : null, place: text(q.place, 90), depthKm: typeof q.depthKm === 'number' ? q.depthKm : null })) } : null,
    disasters: m.feeds?.disasters ? { attribution: text(m.feeds.disasters.attribution, 90), items: feedItems(m.feeds.disasters, d => ({ event: text(d.name || d.type, 90), country: text(d.country, 60), severity: text(d.severity, 30) })) } : null,
    weather: m.feeds?.weather ? { attribution: text(m.feeds.weather.attribution, 90), items: feedItems(m.feeds.weather, w => ({ temperatureC: typeof w.temperatureC === 'number' ? w.temperatureC : null, sky: text(w.sky || w.symbol, 40) })) } : null,
    cyclones: m.feeds?.cyclones ? { attribution: text(m.feeds.cyclones.attribution, 90), items: feedItems(m.feeds.cyclones, c => ({ name: text(c.name, 60), classification: text(c.classification, 20), intensityKt: typeof c.intensityKt === 'number' ? c.intensityKt : null })) } : null,
    airQuality: m.feeds?.airQuality ? { attribution: text(m.feeds.airQuality.attribution, 90), items: feedItems(m.feeds.airQuality, a => ({ europeanAqi: typeof a.europeanAqi === 'number' ? a.europeanAqi : null, pm25: typeof a.pm25 === 'number' ? a.pm25 : null })) } : null,
    launches: m.feeds?.launches ? { attribution: text(m.feeds.launches.attribution, 90), items: (Array.isArray(m.feeds.launches.results?.[0]?.items) ? m.feeds.launches.results[0].items : []).slice(0, 3).map(l => ({ name: text(l.name, 80), net: text(l.net, 30), provider: text(l.provider, 40) })) } : null,
    satellites: m.feeds?.satellites ? { count: feedCount(m.feeds.satellites) } : null,
    flights: m.feeds?.flights ? { count: feedCount(m.feeds.flights) } : null,
    imagery: m.feeds?.imagery ? { attribution: text(m.feeds.imagery.attribution, 90), items: imageryItems, ...(chipChanged ? { chip: 'data:image/jpeg;base64,' + chip.jpeg, chipFor: imageryItems[0]?.name || '' } : {}) } : null,
    alerts: m.proactive ? { enabled: m.proactive.status?.enabled === true, items: (Array.isArray(m.proactive.recent) ? m.proactive.recent : []).slice(0, 5).map(x => ({ at: text(x.at, 30), severity: text(x.severity, 12), location: text(x.location, 60), message: text(x.message, 140) })) } : null,
  };
}

// Per-session pills for the notch (Fase 3b): one pill per Core session, projected from the
// Core session registry (cli-sessions summaries via core-presence) - NEVER from surface-local
// state, so work arriving from the CLI or a headless mission shows up here exactly like work
// started from Presence itself. Allowlist is strict: the session id is a capability key and
// the cwd is user content, so neither is copied; the label is the session title (or a neutral
// placeholder), stripped entirely under counts-only/hidden privacy.
function projectSessionPills(sessions = [], privacy = 'redacted') {
  const rows = (Array.isArray(sessions) ? sessions : []).map(s => {
    if (!s || typeof s !== 'object') return null;
    const openOps = Array.isArray(s.openOperations) ? s.openOperations.length : 0;
    const activeSubs = Number.isSafeInteger(s.activeSubagentRuns) ? s.activeSubagentRuns : 0;
    const state = s.closed ? 'CLOSED' : (openOps > 0 || activeSubs > 0 ? 'WORKING' : (s.attached ? 'ATTACHED' : 'IDLE'));
    return {
      label: privacy === 'redacted' ? (text(s.title, 40) || 'CLI session') : 'CLI session',
      state,
      model: text(s.model, 60),
      openOperations: openOps,
      activeSubagentRuns: activeSubs,
      updatedAt: Number.isSafeInteger(s.updatedAt) ? s.updatedAt : null,
      closed: s.closed === true,
    };
  }).filter(Boolean);
  rows.sort((a, b) => (a.closed - b.closed) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
  // Identical pills carry no information (several Core sessions share the
  // title 'Damar Presence' after relaunches): collapse repeats by label,
  // keeping the most alive state (WORKING > ATTACHED > IDLE > CLOSED).
  const rank = { WORKING: 3, ATTACHED: 2, IDLE: 1, CLOSED: 0 };
  const byLabel = new Map();
  for (const row of rows) {
    const prev = byLabel.get(row.label);
    if (!prev || (rank[row.state] || 0) > (rank[prev.state] || 0)) byLabel.set(row.label, row);
  }
  return [...byLabel.values()].slice(0, 8).map(({ closed, ...pill }) => pill);
}

// Worker rows for the notch (Coucou agent-parity pass, Owner 2026-11-28):
// the agents Damar is connected to, projected from Core's own registries -
// NEVER from surface-local state. Two real sources exist in the desktop
// Core today: (1) Pandawa runs (Core's worker registry: ACCEPTED waits,
// RUNNING runs, terminal states land as done/failed and age out after
// 15 minutes so a finished worker is seen landing, not kept forever);
// (2) DAMAR gateway keys (external agents and harnesses connected to
// Damar's OpenAI-compatible gateway; a live key is a connection, not a
// task, so its state is 'connected' with its real usage count). External
// MCP worker sessions (agentfed Lane 2) are composed in the daemon, not
// in this Core, so they cannot appear here - no row is ever invented.
const WORKER_STATE = { ACCEPTED: 'waiting', RUNNING: 'running', COMPLETED: 'done', FAILED: 'failed', CANCELLED: 'done', OUTCOME_UNKNOWN: 'failed' };
const WORKER_RANK = { running: 0, waiting: 1, failed: 2, done: 3, connected: 4 };
function projectWorkers(runs = [], gateway = null, privacy = 'redacted', now = Date.now()) {
  const rows = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || typeof r !== 'object') continue;
    const state = WORKER_STATE[r.state];
    if (!state) continue;
    const updatedAt = Number.isSafeInteger(r.updatedAt) ? r.updatedAt : null;
    if ((state === 'done' || state === 'failed') && (updatedAt === null || now - updatedAt > 900000)) continue;
    const w = text(r.worker, 20);
    rows.push({ kind: 'pandawa', name: privacy === 'redacted' ? (w ? 'Pandawa ' + w.charAt(0).toUpperCase() + w.slice(1) : 'Pandawa') : 'Pekerja Damar',
      state, detail: privacy === 'redacted' ? text(r.model, 60) : null, at: updatedAt });
  }
  if (gateway && gateway.settings?.enabled === true && Array.isArray(gateway.keys)) {
    for (const k of gateway.keys) {
      if (!k || k.revokedAt) continue;
      const requests = Number.isSafeInteger(k.usage?.requests) ? k.usage.requests : 0;
      rows.push({ kind: 'gateway', name: privacy === 'redacted' ? (text(k.label, 40) || 'Agen gateway') : 'Agen terhubung',
        state: 'connected', detail: requests > 0 ? requests + ' permintaan' : null,
        at: typeof k.usage?.lastUsed === 'string' ? Date.parse(k.usage.lastUsed) || null : null });
    }
  }
  rows.sort((a, b) => (WORKER_RANK[a.state] - WORKER_RANK[b.state]) || ((b.at || 0) - (a.at || 0)));
  return rows.slice(0, 6);
}

// Now-playing for the music pill (Fase 3a): projected from the SMTC sense in core-host
// (core.media). Unavailable stays null - the notch shows no pill rather than a fake track.
// Artwork (the session's real SMTC thumbnail, a data URL from core-host) is only
// re-sent when the track identity changes; on repeats the field is omitted and
// the surface keeps the artwork it already shows (the string is heavy).
let lastArtKey = null;
function projectMedia(media) {
  if (!media || media.available !== true) { lastArtKey = null; return null; }
  const status = text(media.status, 20) || 'Unknown';
  const artKey = [media.title, media.artist, media.sourceApp].join('|');
  const artChanged = artKey !== lastArtKey;
  if (artChanged) lastArtKey = artKey;
  return { title: text(media.title, 120), artist: text(media.artist, 80), sourceApp: text(media.sourceApp, 60),
    status, playing: status === 'Playing',
    positionSec: Number.isFinite(media.positionSec) ? media.positionSec : 0,
    durationSec: Number.isFinite(media.durationSec) ? media.durationSec : 0,
    ...(artChanged ? { artwork: typeof media.artwork === 'string' && media.artwork.length < 600000 ? media.artwork : '' } : {}) };
}

// One status line for the notch (counts only, no user content).
function statusLine(p) {
  if (!p || p.status !== 'CONNECTED') return 'DAMAR Core not connected';
  const a = p.presence.activity, parts = ['Core ' + p.presence.lifecycle];
  if (a.pendingPermissions) parts.push(`${a.pendingPermissions} permission waiting · answer in CLI`);
  if (a.activeTurns) parts.push(`${a.activeTurns} turn${a.activeTurns === 1 ? '' : 's'} running`);
  if (a.activePandawaRuns) parts.push(`${a.activePandawaRuns} Pandawa run${a.activePandawaRuns === 1 ? '' : 's'}`);
  if (parts.length === 1) parts.push('idle');
  return parts.join(' · ');
}

// The newest still-pending permission from Core's redacted activity feed (no answer and its turn not final).
// `allowable`: since the Owner ruling of 2026-11-28 the full decision set is
// offered wherever the request is presented with its key points; the
// Authority Gate remains the enforcing layer server-side.
function pendingPermission(activity = []) {
  const answered = new Set(), ended = new Set();
  for (const a of activity) { if (a.kind === 'permission_answer') answered.add(a.permissionId); if (a.kind === 'final') ended.add(a.turnId); }
  const open = activity.filter(a => a.kind === 'permission' && !answered.has(a.permissionId) && !ended.has(a.turnId));
  const p = open[open.length - 1];
  if (!p) return null;
  return { turnId: p.turnId, permissionId: p.permissionId, tool: text(p.tool, 40), file: text(p.file, 120),
    detail: text(p.detail, 140),
    added: Number.isSafeInteger(p.added) ? p.added : null, removed: Number.isSafeInteger(p.removed) ? p.removed : null,
    // Owner ruling 2026-11-28: wherever a request is presented WITH its key
    // points (tool, file or command detail), the full decision set is offered
    // (once / session / deny). The Authority Gate still enforces server-side.
    allowable: true };
}
// Renderer copy of activity rows: allowlisted fields only (the feed is already redacted for the requester role).
const int = v => (Number.isSafeInteger(v) ? v : null);
const activityRow = a => ({ seq: a.seq, turnId: text(a.turnId, 60), kind: text(a.kind, 20), file: text(a.file, 120), added: int(a.added),
  removed: int(a.removed), status: text(a.status, 20), at: a.at ?? null,
  // Mata Dewa watchlist alert: source + label ("<camera> · watchlist match"); the plate (detail) is owner-only and never copied.
  ...(a.kind === 'alert' ? { source: text(a.source, 20), label: text(a.label, 80) } : {}),
  // Pandawa discussion progress: ids/round/state only, never text.
  ...(a.kind === 'discussion' ? { discussionId: text(a.discussionId, 60), round: int(a.round), of: int(a.of), state: text(a.state, 20) } : {}) });
// Rows the notch may show under presence.notificationPrivacy: 'hidden' drops alerts, 'counts-only' strips their label.
function activityRows(activity = [], privacy = 'redacted') {
  return activity.map(activityRow).filter(a => !(a.kind === 'alert' && privacy === 'hidden'))
    .map(a => (a.kind === 'alert' && privacy === 'counts-only' ? { ...a, label: null } : a));
}

module.exports = { project, statusLine, pendingPermission, activityRow, activityRows, projectSessionPills, projectMedia, projectWorkers, PRIVACY };
