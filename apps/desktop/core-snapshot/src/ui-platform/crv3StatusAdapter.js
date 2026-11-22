'use strict';

const { normalizeReadModel } = require('./contracts');

const SOURCE_TOOL = 'r3_status_snapshot';
const WATCHDOG_TOOL = 'r4_watchdog_snapshot';
const SELF_HEALING_TOOL = 'r4_selfhealing_snapshot';
const SIMULATED_PROVENANCE = 'R3_OFFLINE_SYNTHETIC_FIXTURE';
const R4_SIMULATED_PROVENANCE = 'R4_OFFLINE_SYNTHETIC_FIXTURE';
const STATUS_VALUES = Object.freeze(['HEALTHY', 'DEGRADED', 'OFFLINE', 'UNKNOWN']);

const COMPONENTS = Object.freeze({
  CRV3: 'CRV3',
  WATCHDOG: 'Watchdog',
  SELF_HEALING: 'SelfHealing'
});

function boundedText(value, max = 160) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function baseModel(component, provenance) {
  return {
    data: Object.freeze({
      component, simulation: 'SIMULATED', status: 'UNKNOWN',
      summary: null, eventId: null, principalId: null,
      provenance, authorityRelevance: 'none'
    }),
    status: 'loading', freshness: 'UNKNOWN', provenance
  };
}

function waitingCrv3Status() {
  return normalizeReadModel(baseModel(COMPONENTS.CRV3, SIMULATED_PROVENANCE));
}

function rejectedCrv3Status() {
  const model = baseModel(COMPONENTS.CRV3, SIMULATED_PROVENANCE);
  model.status = 'failed';
  model.error = { kind: 'invalid_simulated_event', message: 'synthetic CRV3 event rejected' };
  return normalizeReadModel(model);
}

function projectCrv3ToolEvent(event) {
  const result = event?.result;
  if (event?.name !== SOURCE_TOOL || !result || result.simulated !== true ||
      result.provenance !== SIMULATED_PROVENANCE || result.authorityRelevance !== 'none' ||
      !STATUS_VALUES.includes(result.status)) {
    throw new TypeError('CRV3 status adapter accepts only the scoped offline fixture event');
  }

  const summary = boundedText(result.summary);
  const eventId = boundedText(event.toolCallId, 96);
  const principalId = boundedText(result.principalId, 96);
  if (!eventId || !principalId) {
    throw new TypeError('CRV3 status event identity is incomplete');
  }

  const data = Object.freeze({
    component: COMPONENTS.CRV3, simulation: 'SIMULATED', status: result.status,
    summary, eventId, principalId,
    provenance: SIMULATED_PROVENANCE, authorityRelevance: 'none'
  });
  return normalizeReadModel({
    data,
    status: summary ? 'ready' : 'empty',
    freshness: 'UNKNOWN',
    provenance: SIMULATED_PROVENANCE,
    requestId: eventId,
    redaction: 'no credentials or authority fields projected'
  });
}

function isCrv3ReadModel(value) {
  return Boolean(value && value.data?.component === COMPONENTS.CRV3 &&
    value.data?.simulation === 'SIMULATED' &&
    value.data?.authorityRelevance === 'none' &&
    value.provenance === SIMULATED_PROVENANCE);
}

function rejectedComponentStatus(component, provenance) {
  const model = baseModel(component, provenance);
  model.status = 'failed';
  model.error = { kind: 'invalid_simulated_event', message: `synthetic ${component} event rejected` };
  return normalizeReadModel(model);
}

function emptyComponentStatus(component, provenance, detail) {
  const model = baseModel(component, provenance);
  model.status = 'empty';
  model.error = { kind: 'no_event', message: detail };
  return normalizeReadModel(model);
}

function assertSyntheticComponentEvent(event, toolName, provenance, component) {
  const result = event?.result;
  if (event?.name !== toolName || !result || result.simulated !== true ||
      result.provenance !== provenance || result.authorityRelevance !== 'none' ||
      !STATUS_VALUES.includes(result.status)) {
    throw new TypeError(`${component} status adapter accepts only the scoped offline fixture event`);
  }

  const summary = boundedText(result.summary);
  const eventId = boundedText(event.toolCallId, 96);
  const principalId = boundedText(result.principalId, 96);
  if (!eventId || !principalId) {
    throw new TypeError(`${component} status event identity is incomplete`);
  }
  return { result, summary, eventId, principalId };
}

function projectWatchdogToolEvent(event) {
  const { result, summary, eventId, principalId } =
    assertSyntheticComponentEvent(event, WATCHDOG_TOOL, R4_SIMULATED_PROVENANCE, COMPONENTS.WATCHDOG);

  const checks = Array.isArray(result.checks) ? result.checks : [];
  const normalizedChecks = Object.freeze(checks.slice(0, 8).map(check => Object.freeze({
    name: boundedText(check?.name, 64) ?? 'unnamed-check',
    state: STATUS_VALUES.includes(check?.state) ? check.state : 'UNKNOWN',
    detail: boundedText(check?.detail, 160)
  })));

  const actions = Array.isArray(result.actions) ? result.actions : [];
  const normalizedActions = Object.freeze(actions.slice(0, 8).map(action =>
    Object.freeze({ action: boundedText(action?.action ?? action, 64) ?? 'unknown-action' })));

  const data = Object.freeze({
    component: COMPONENTS.WATCHDOG, simulation: 'SIMULATED', status: result.status,
    summary, eventId, principalId,
    provenance: R4_SIMULATED_PROVENANCE, authorityRelevance: 'none',
    checks: normalizedChecks, actions: normalizedActions,
    relatedSelfHealingEventId: null
  });
  return normalizeReadModel({
    data,
    status: summary || normalizedChecks.length ? 'ready' : 'empty',
    freshness: 'UNKNOWN',
    provenance: R4_SIMULATED_PROVENANCE,
    requestId: eventId,
    redaction: 'no credentials or authority fields projected'
  });
}

function isWatchdogReadModel(value) {
  return Boolean(value && value.data?.component === COMPONENTS.WATCHDOG &&
    value.data?.simulation === 'SIMULATED' &&
    value.data?.authorityRelevance === 'none' &&
    value.provenance === R4_SIMULATED_PROVENANCE);
}

function rejectedWatchdogStatus() {
  return rejectedComponentStatus(COMPONENTS.WATCHDOG, R4_SIMULATED_PROVENANCE);
}

function waitingWatchdogStatus() {
  return normalizeReadModel(baseModel(COMPONENTS.WATCHDOG, R4_SIMULATED_PROVENANCE));
}

function projectSelfHealingToolEvent(event) {
  const { result, summary, eventId, principalId } =
    assertSyntheticComponentEvent(event, SELF_HEALING_TOOL, R4_SIMULATED_PROVENANCE, COMPONENTS.SELF_HEALING);

  const classification = boundedText(result.classification, 32) ?? 'unknown';
  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  const normalizedAttempts = Object.freeze(attempts.slice(0, 8).map(attempt => Object.freeze({
    strategy: boundedText(attempt?.strategy, 64) ?? 'unknown-strategy',
    ok: attempt?.ok === true
  })));

  const outcomeOk = result.outcome?.ok === true;
  const outcome = Object.freeze({
    ok: outcomeOk,
    error: outcomeOk ? null : (boundedText(result.outcome?.error, 160) ?? 'recovery reported failure')
  });

  const watchdogEventId = result.watchdogEventId == null ? null : boundedText(result.watchdogEventId, 96);

  const data = Object.freeze({
    component: COMPONENTS.SELF_HEALING, simulation: 'SIMULATED', status: result.status,
    summary, eventId, principalId,
    provenance: R4_SIMULATED_PROVENANCE, authorityRelevance: 'none',
    classification, attempts: normalizedAttempts, outcome,
    relatedWatchdogEventId: watchdogEventId
  });
  return normalizeReadModel({
    data,
    status: summary || normalizedAttempts.length ? 'ready' : 'empty',
    freshness: 'UNKNOWN',
    provenance: R4_SIMULATED_PROVENANCE,
    requestId: eventId,
    redaction: 'no credentials or authority fields projected'
  });
}

function isSelfHealingReadModel(value) {
  return Boolean(value && value.data?.component === COMPONENTS.SELF_HEALING &&
    value.data?.simulation === 'SIMULATED' &&
    value.data?.authorityRelevance === 'none' &&
    value.provenance === R4_SIMULATED_PROVENANCE);
}

function rejectedSelfHealingStatus() {
  return rejectedComponentStatus(COMPONENTS.SELF_HEALING, R4_SIMULATED_PROVENANCE);
}

function waitingSelfHealingStatus() {
  return normalizeReadModel(baseModel(COMPONENTS.SELF_HEALING, R4_SIMULATED_PROVENANCE));
}

function fallbackSelfHealingStatus(watchdogModel = null) {
  const model = baseModel(COMPONENTS.SELF_HEALING, R4_SIMULATED_PROVENANCE);
  model.status = 'empty';
  model.error = { kind: 'no_event', message: 'no SelfHealing recovery event yet; watchdog monitoring continues' };
  const related = isWatchdogReadModel(watchdogModel) ? watchdogModel.data?.eventId : null;
  const data = Object.freeze({ ...model.data, relatedWatchdogEventId: related ?? null });
  return normalizeReadModel({ ...model, data });
}

module.exports = {
  SOURCE_TOOL, WATCHDOG_TOOL, SELF_HEALING_TOOL,
  SIMULATED_PROVENANCE, R4_SIMULATED_PROVENANCE, STATUS_VALUES,
  COMPONENTS,
  waitingCrv3Status, rejectedCrv3Status, projectCrv3ToolEvent, isCrv3ReadModel,
  waitingWatchdogStatus, rejectedWatchdogStatus, projectWatchdogToolEvent, isWatchdogReadModel,
  waitingSelfHealingStatus, rejectedSelfHealingStatus, projectSelfHealingToolEvent, isSelfHealingReadModel,
  fallbackSelfHealingStatus
};
