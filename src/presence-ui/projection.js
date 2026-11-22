'use strict';
const { bindVisualState, motionFor } = require('../ui-platform/stateBinding');
const { approvalProjection, notificationProjection } = require('../ui-platform/projections');
const { STATES: VOICE_STATES } = require('../voice/stateMachine');

// A projection adapter, never a state engine. Missing source remains UNKNOWN.
// All display data is allowlisted before it can reach DOM or presentation cache.
function text(value, limit = 500) { return typeof value === 'string' ? value.slice(0, limit) : null; }
function project(record = {}, { revealed = false, reducedMotion = false } = {}) {
  const source = record.data || {};
  const fresh = ['LIVE', 'EVENTUAL'].includes(record.freshness) && record.status === 'ready';
  const sensitive = source.privacy_sensitivity && source.privacy_sensitivity !== 'NORMAL';
  const redact = sensitive && !revealed;
  const safe = fresh ? source : { freshness: record.freshness === 'STALE' ? 'STALE' : 'UNKNOWN' };
  const binding = bindVisualState(safe);
  const approval = fresh && source.approval ? approvalProjection(source.approval) : null;
  const notifications = fresh ? (source.notifications || []).filter(n => n.target_surfaces?.includes('idle_presence')).map(n => ({
    ...notificationProjection(n),
    summary: n.privacy_sensitivity && n.privacy_sensitivity !== 'NORMAL' && !revealed ? 'Sensitive notification' : text(n.summary),
  })) : [];
  return Object.freeze({ binding, motion: motionFor(binding.visualState, reducedMotion),
    freshness: record.freshness || 'UNKNOWN', asOf: record.asOf || null,
    privacy: redact ? 'SENSITIVE_REDACTED' : revealed ? 'USER_REVEALED' : 'NORMAL_DISPLAY',
    mission: fresh && source.mission ? { id: text(source.mission.mission_id), title: redact ? 'Sensitive mission' : text(source.mission.title), state: text(source.mission.state), activity: redact ? null : text(source.mission.activity), verification: text(source.verificationResult), progress: binding.progress } : null,
    approval: approval ? { ...approval, effect: redact ? 'Sensitive action requires approval' : text(approval.effect), risk: text(approval.risk) } : null,
    notifications,
    security: fresh && source.securityAlert ? { id: text(source.security?.incident_id), summary: redact ? 'Security attention required' : text(source.security?.summary), severity: text(source.security?.severity) } : null,
    voice: fresh ? { available: source.voice?.available === true, state: text(source.voice?.state) || 'Unknown' } : { available: false, state: 'Unknown' },
    messages: fresh && !redact ? (source.messages || []).filter(m => ['user', 'assistant'].includes(m.role)).slice(-100).map(m => ({ role: m.role, content: text(m.content, 12000) || '' })) : [],
  });
}

// Existing status API describes voice, not global Presence health or authority.
// A stopped microphone must never set offline=true on Damar.
function voiceStatusRecord(record) {
  if (record.status !== 'ready' || record.data?.success !== true) return { ...record, error: null, data: null, freshness: 'UNKNOWN', status: 'unknown' };
  const runtime = record.data.data?.runtime;
  const state = Object.values(VOICE_STATES).includes(runtime?.state) ? runtime.state : 'UNKNOWN';
  const running = runtime?.running === true;
  return { ...record, error: null, data: { freshness: 'UNKNOWN',
    ...(running && state === VOICE_STATES.LISTENING ? { listening: true, freshness: record.freshness } : {}),
    ...(running && state === VOICE_STATES.THINKING ? { presence: 'thinking', freshness: record.freshness } : {}),
    voice: { available: running, state: running ? state : 'Unavailable' },
  } };
}
module.exports = { project, voiceStatusRecord };
