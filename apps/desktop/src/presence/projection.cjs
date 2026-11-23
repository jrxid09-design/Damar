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
    return { status: 'NOT_CONNECTED', reason: 'DAMAR Core is not reachable.', presence: null, approvals: null, missions: null, notifications: null };
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
    raw.push({ kind: 'pandawa_run', summary: `Pandawa ${text(r.worker, 20)} ${r.state === 'FAILED' ? 'failed' : 'outcome unknown'}: ${text(r.error || r.reason, 80) || ''}`.trim(), privacy_sensitivity: 'SENSITIVE', urgency: 'NORMAL' });
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
    presence: { simulated: false, source: 'damar-core', lifecycle: lifecycleState, asOf: core.asOf || null,
      activity: { activeTurns, pendingPermissions: pending, activePandawaRuns: activeRuns, sessions: sessions.length },
      sessionPills, media,
      // Voice state is not read from Core here, and is never used to infer health.
      voice: { available: false, state: 'Unknown' } },
    approvals, missions, notifications,
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
  return rows.slice(0, 8).map(({ closed, ...pill }) => pill);
}

// Now-playing for the music pill (Fase 3a): projected from the SMTC sense in core-host
// (core.media). Unavailable stays null - the notch shows no pill rather than a fake track.
function projectMedia(media) {
  if (!media || media.available !== true) return null;
  const status = text(media.status, 20) || 'Unknown';
  return { title: text(media.title, 120), artist: text(media.artist, 80), sourceApp: text(media.sourceApp, 60),
    status, playing: status === 'Playing' };
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
// `allowable`: the notch may offer Allow only when the whole request is visible there — a workspace file write/edit
// with its file name (and diff counts). Commands, shell, memory, delegation, plugins and Computer Use are Deny-or-CLI.
const NOTCH_ALLOW = new Set(['workspace_write', 'workspace_edit']);
function pendingPermission(activity = []) {
  const answered = new Set(), ended = new Set();
  for (const a of activity) { if (a.kind === 'permission_answer') answered.add(a.permissionId); if (a.kind === 'final') ended.add(a.turnId); }
  const open = activity.filter(a => a.kind === 'permission' && !answered.has(a.permissionId) && !ended.has(a.turnId));
  const p = open[open.length - 1];
  if (!p) return null;
  return { turnId: p.turnId, permissionId: p.permissionId, tool: text(p.tool, 40), file: text(p.file, 120),
    added: Number.isSafeInteger(p.added) ? p.added : null, removed: Number.isSafeInteger(p.removed) ? p.removed : null,
    allowable: NOTCH_ALLOW.has(p.tool) && !!p.file };
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

module.exports = { project, statusLine, pendingPermission, activityRow, activityRows, projectSessionPills, projectMedia, PRIVACY };
