'use strict';
const w3States = require('../../docs/uix-w3/VISUAL_STATE_MODEL.json');
const priority = require('../../docs/uix-w3/STATE_PRIORITY_MATRIX.json');

const VISUAL_STATES = Object.freeze(w3States.states.map((state) => state.visual_state_id));
const PRIORITY = Object.freeze(priority.precedence_high_to_low);

function mapSource(source = {}) {
  if (source.securityAlert) return 'SECURITY_ALERT';
  if (source.attention) return 'ATTENTION';
  if (source.approval?.state === 'PENDING' || source.authorityResult === 'DEFER') return 'WAITING_FOR_AUTHORITY';
  if (source.mission?.state === 'WAITING_FOR_USER' || source.task?.state === 'BLOCKED_USER_INPUT') return 'WAITING_FOR_USER';
  if (source.verificationPending) return 'VERIFYING';
  if (source.mission?.state === 'RUNNING' || source.task?.state === 'EXECUTING') return 'ACTING';
  if (source.degraded || source.freshness === 'STALE') return 'DEGRADED';
  if (source.offline) return 'OFFLINE';
  if (source.freshness === 'UNKNOWN') return 'UNKNOWN';
  if (source.presence === 'thinking' || source.conversation === 'processing') return 'THINKING';
  if (source.listening) return 'LISTENING';
  if (source.mission?.state === 'COMPLETED' && (!source.verificationRequired || source.verificationResult === 'PASS')) return 'COMPLETED';
  if (source.presence === 'dormant') return 'DORMANT';
  return 'IDLE';
}

function resolveVisualState(candidates) { const values = candidates.filter((state) => VISUAL_STATES.includes(state)); return PRIORITY.find((state) => values.includes(state)) ?? 'UNKNOWN'; }
function bindVisualState(source) { const base = mapSource(source); const candidates = [base]; if (source.securityAlert) candidates.push('SECURITY_ALERT'); if (source.attention) candidates.push('ATTENTION'); return Object.freeze({ visualState: resolveVisualState(candidates), baseState: base, progress: typeof source.progress === 'number' && source.progress >= 0 && source.progress <= 1 ? source.progress : null, source: 'read_model_projection', isCanonical: false }); }
function motionFor(visualState, reducedMotion = false) { const record = w3States.states.find((state) => state.visual_state_id === visualState); return Object.freeze({ profile: record?.motion_profile ?? 'unknown_static', reducedMotion: Boolean(reducedMotion), mode: reducedMotion ? 'static_semantic_fallback' : 'semantic_motion' }); }

module.exports = { VISUAL_STATES, PRIORITY, mapSource, resolveVisualState, bindVisualState, motionFor };
