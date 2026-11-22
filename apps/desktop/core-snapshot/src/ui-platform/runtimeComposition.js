'use strict';

const { createTimeline } = require('./eventTimeline');
const { createProviderMonitor } = require('./providerHealth');
const { normalizeReadModel } = require('./contracts');
const { createBoundedAutonomyCycle } = require('./boundedAutonomyCycle');
const { createOwnerBoundShadowBridge, PROVENANCE: SHADOW_PROVENANCE } = require('./ownerBoundShadowBridge');
const adapter = require('./crv3StatusAdapter');
const canonicalAgentHub = require('../services/agentHub');
const canonicalWatchdogClass = require('../autonomy/watchdog').Watchdog;

const FIXTURE_PROVENANCE = 'R9R2_OFFLINE_BOUNDED_SIMULATION';
const VALID_STATUSES = new Set(adapter.STATUS_VALUES);

function createRuntimeComposition({ maxEvents = 200, staleAfterMs = 30 * 60 * 1000, agentHub = null, watchdogClass = null, isolatedSelfHealingEngine = null } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new TypeError('maxEvents must be a positive integer');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1) throw new TypeError('staleAfterMs must be positive');
  if (agentHub !== null && agentHub !== canonicalAgentHub) throw new TypeError('R9R2 composition only accepts the canonical DAMAR AgentHub');
  if (watchdogClass !== null && watchdogClass !== canonicalWatchdogClass) throw new TypeError('R9R2 composition only accepts the canonical DAMAR Watchdog class');

  // Fixture events carry no execution authority. Identity is the object-private
  // brand below; the UI can neither forge nor retrieve a projection token.
  const brandedEvents = new WeakSet();
  const timeline = createTimeline({ maxRetention: maxEvents, staleMaxAgeMs: staleAfterMs });
  const providerMonitor = createProviderMonitor({ maxIncidents: Math.min(maxEvents, 50) });
  const listeners = new Set();
  const seenEventKeys = new Set();
  const initialReadModels = () => ({ crv3: adapter.waitingCrv3Status(), watchdog: adapter.waitingWatchdogStatus(), selfHealing: adapter.waitingSelfHealingStatus() });
  let readModels = initialReadModels();
  let providers = [];
  let execution = Object.freeze({ component: 'AgentHub', taskId: null, correlationId: null, agent: null, status: 'IDLE', eventId: null, summary: 'No synthetic task dispatched.', output: null, error: null, simulated: true, provenance: FIXTURE_PROVENANCE, authorityRelevance: 'none' });
  let recovery = Object.freeze({ component: 'SelfHealing', state: 'IDLE', incidentId: null, taskId: null, handler: null, outcome: null, eventId: null, simulated: true, provenance: FIXTURE_PROVENANCE, authorityRelevance: 'none' });
  let lifecycle = 'stopped';
  let revision = 0;
  let staleTimer = null;
  const shadowBridge = createOwnerBoundShadowBridge();

  function modelFromCycleEvent(event) {
    if (event.component === 'AgentHub') {
      execution = Object.freeze({
        component: 'AgentHub', taskId: event.taskId ?? null, correlationId: event.correlationId ?? null,
        agent: 'damar', taskType: event.taskType ?? null, status: event.taskState ?? 'UNKNOWN',
        eventId: event.eventId, summary: event.summary ?? null, output: event.output ?? null, error: event.error ?? null,
        simulated: true, provenance: FIXTURE_PROVENANCE, authorityRelevance: 'none'
      });
      const status = event.status && VALID_STATUSES.has(event.status) ? event.status : 'UNKNOWN';
      return normalizeReadModel({ data: Object.freeze({ ...execution, status }), status: 'ready', freshness: 'UNKNOWN', provenance: FIXTURE_PROVENANCE, requestId: event.eventId, redaction: 'bounded synthetic task output only' });
    }
    if (event.component === 'Watchdog' && event.type === 'INCIDENT_DETECTED') {
      const model = adapter.projectWatchdogToolEvent({
        toolCallId: event.eventId, name: adapter.WATCHDOG_TOOL,
        result: { status: 'DEGRADED', summary: event.summary, simulated: true, provenance: adapter.R4_SIMULATED_PROVENANCE,
           principalId: event.principalId, authorityRelevance: 'none', checks: [{ name: 'agenthub-heartbeat', state: 'DEGRADED', detail: 'bounded synthetic task heartbeat expired' }], actions: (event.watchdogPolicyActions || []).map(action => ({ action, executed: false })) }
      });
      return normalizeReadModel({ ...model, data: Object.freeze({ ...model.data, incidentId: event.incidentId, taskId: event.taskId, correlationId: event.correlationId }) });
    }
    if (event.component === 'SelfHealing') {
      const state = event.recoveryState || (event.type === 'RECOVERY_REJECTED' ? 'REJECTED' : 'UNKNOWN');
      recovery = Object.freeze({
        component: 'SelfHealing', state, incidentId: event.incidentId ?? null, taskId: event.taskId ?? null,
        watchdogEventId: event.watchdogEventId ?? null,
        handler: event.outcome?.handler ?? (state === 'RECOVERING' ? 'simulation-noop' : null),
        outcome: event.outcome ?? null, eventId: event.eventId, summary: event.summary ?? null,
        simulated: true, provenance: FIXTURE_PROVENANCE, authorityRelevance: 'none'
      });
      if (state === 'REJECTED') return null;
      const status = state === 'RECOVERED' ? 'HEALTHY' : state === 'FAILED' ? 'DEGRADED' : 'DEGRADED';
      const eventModel = adapter.projectSelfHealingToolEvent({
        toolCallId: event.eventId, name: adapter.SELF_HEALING_TOOL,
        result: { status, summary: event.summary || `Simulation recovery ${state.toLowerCase()}.`, simulated: true,
          provenance: adapter.R4_SIMULATED_PROVENANCE, principalId: event.principalId || 'r7-selfhealing-simulation',
          authorityRelevance: 'none', classification: 'transient', attempts: [{ strategy: event.outcome?.handler || 'simulation-noop', ok: event.outcome?.ok === true }],
          outcome: { ok: event.outcome?.ok === true, error: event.outcome?.ok === false ? (event.outcome.detail || event.summary) : null },
          watchdogEventId: event.watchdogEventId || event.incidentId }
      });
      return normalizeReadModel({ ...eventModel, data: Object.freeze({ ...eventModel.data, recoveryState: state, incidentId: event.incidentId ?? null, taskId: event.taskId ?? null, correlationId: event.correlationId ?? null, simulationProvenance: FIXTURE_PROVENANCE }) });
    }
    return null;
  }

  let activeCycle = null;
  activeCycle = createBoundedAutonomyCycle({ agentHubExecutionPort: shadowBridge.executionPort, isolatedSelfHealingEngine, onEvent(event) {
    if (event.component === 'Runtime') return;
    const model = modelFromCycleEvent(event);
    if (model) {
      if (event.component === 'AgentHub') {
        timeline.record(model, { type: 'projection', correlationId: event.correlationId, outcome: event.error ? { ok: false, error: event.error } : event.taskState === 'COMPLETED' ? { ok: true } : null });
      } else if (event.component === 'Watchdog') {
        readModels = { ...readModels, watchdog: model };
        timeline.record(model, { type: 'projection', correlationId: event.correlationId });
      } else if (event.component === 'SelfHealing') {
        readModels = { ...readModels, selfHealing: model };
        timeline.record(model, { type: 'projection', correlationId: event.watchdogEventId || event.correlationId || event.incidentId, outcome: event.outcome ?? null });
      }
    } else if (event.component === 'SelfHealing' && event.type === 'RECOVERY_REJECTED') {
      timeline.reject(event.eventId, { component: 'SelfHealing', reason: event.summary || event.reason || 'recovery request rejected', provenance: FIXTURE_PROVENANCE });
    }
    publish();
  } });

  function snapshot() {
    const last = timeline.getLatest();
    const stale = Boolean(last && Date.now() - Date.parse(last.timestamp) > staleAfterMs);
    return Object.freeze({
      schema: 'damar.r9r2.shadow-status/1', runId: 'DAMAR_R9R3_CANONICAL_INTEGRATION_20261111',
      lifecycle, revision, connected: lifecycle === 'running', simulated: true,
      provenance: SHADOW_PROVENANCE, shadow: true, authorityRelevance: 'none', stale,
      readModels: Object.freeze({ ...readModels }), timeline: timeline.getHistory(),
      timelineStats: timeline.getStats(), providers: Object.freeze(providers.slice()),
      incidents: Object.freeze([...providerMonitor.getHistory(), ...activeCycle.snapshot().incidents]),
      execution, recovery, shadowExecution: shadowBridge.snapshot(), activeCycle: activeCycle.snapshot()
    });
  }

  function publish() {
    revision += 1;
    const value = snapshot();
    for (const listener of [...listeners]) {
      try { listener(value); } catch { /* one surface cannot interrupt the source */ }
    }
    return value;
  }

  function buildFixtureEvent({ component, eventId, status, summary, principalId = 'r6-offline-fixture', checks = [], classification = 'transient', attempts = [], outcome = { ok: true }, relatedWatchdogEventId = null }) {
    if (lifecycle !== 'running') throw new Error('runtime composition is not running');
    if (!['CRV3', 'Watchdog', 'SelfHealing'].includes(component)) throw new TypeError('unsupported fixture component');
    if (!VALID_STATUSES.has(status)) throw new TypeError('invalid fixture status');
    if (typeof eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/.test(eventId)) throw new TypeError('invalid fixture event id');
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 160) throw new TypeError('invalid fixture summary');
    const toolName = component === 'CRV3' ? adapter.SOURCE_TOOL : component === 'Watchdog' ? adapter.WATCHDOG_TOOL : adapter.SELF_HEALING_TOOL;
    const provenance = component === 'CRV3' ? adapter.SIMULATED_PROVENANCE : adapter.R4_SIMULATED_PROVENANCE;
    const event = Object.freeze({ toolCallId: eventId, name: toolName, result: Object.freeze({
      status, summary: summary.trim(), simulated: true, provenance, principalId,
      authorityRelevance: 'none', ...(component === 'Watchdog' ? { checks, actions: [] } : {}),
      ...(component === 'SelfHealing' ? { classification, attempts, outcome, watchdogEventId: relatedWatchdogEventId } : {})
    }) });
    brandedEvents.add(event);
    return event;
  }

  function dispatch(event) {
    if (lifecycle !== 'running') return Object.freeze({ accepted: false, reason: 'disconnected', snapshot: publish() });
    if (!event || !brandedEvents.has(event)) {
      timeline.reject(event?.toolCallId, { component: event?.name || 'UNKNOWN', reason: 'unbranded or forged offline event rejected', provenance: event?.result?.provenance ?? null });
      return Object.freeze({ accepted: false, reason: 'untrusted_event', snapshot: publish() });
    }
    let model;
    try {
      if (event.name === adapter.SOURCE_TOOL) model = adapter.projectCrv3ToolEvent(event);
      else if (event.name === adapter.WATCHDOG_TOOL) model = adapter.projectWatchdogToolEvent(event);
      else if (event.name === adapter.SELF_HEALING_TOOL) model = adapter.projectSelfHealingToolEvent(event);
      else throw new TypeError('unsupported event tool');
    } catch (error) {
      timeline.reject(event.toolCallId, { component: event.name, reason: error.message, provenance: event.result?.provenance ?? null });
      return Object.freeze({ accepted: false, reason: 'invalid_projection', snapshot: publish() });
    }
    const eventKey = `${model.data.component}:${model.data.eventId}`;
    if (seenEventKeys.has(eventKey)) return Object.freeze({ accepted: false, reason: 'duplicate_event', snapshot: snapshot() });
    seenEventKeys.add(eventKey);
    const key = model.data.component === 'CRV3' ? 'crv3' : model.data.component === 'Watchdog' ? 'watchdog' : 'selfHealing';
    readModels = { ...readModels, [key]: model };
    timeline.record(model, { type: 'projection', correlationId: model.data.relatedWatchdogEventId ?? null, outcome: model.data.outcome ?? null });
    return Object.freeze({ accepted: true, readModel: model, snapshot: publish() });
  }

  function projectProvider(snapshotValue) {
    if (lifecycle !== 'running') throw new Error('runtime composition is not running');
    const projection = providerMonitor.project(snapshotValue);
    providers = [...providers.filter(item => item.name !== projection.name), Object.freeze({
      name: projection.name, category: projection.category, status: projection.status,
      detail: projection.classification, latency: projection.latencyMs === null ? '—' : `${projection.latencyMs} ms`,
      provenance: projection.provenance, simulated: projection.simulated, authorityRelevance: projection.authorityRelevance
    })];
    publish();
    return projection;
  }

  function subscribe(listener, { emitCurrent = true } = {}) {
    if (typeof listener !== 'function') throw new TypeError('subscriber must be a function');
    listeners.add(listener);
    if (emitCurrent) listener(snapshot());
    let active = true;
    return () => { if (!active) return; active = false; listeners.delete(listener); };
  }

  function start() {
    if (lifecycle === 'running') return snapshot();
    if (lifecycle === 'stopped') {
      readModels = initialReadModels(); providers = []; timeline.clear(); providerMonitor.clear(); seenEventKeys.clear();
    }
    lifecycle = 'running';
    activeCycle.start();
    clearInterval(staleTimer);
    staleTimer = setInterval(() => { if (lifecycle === 'running' && timeline.getLatest()) publish(); }, Math.min(staleAfterMs, 30000));
    staleTimer.unref?.();
    return publish();
  }

  function disconnect() {
    if (lifecycle !== 'running') return snapshot();
    lifecycle = 'disconnected'; clearInterval(staleTimer); staleTimer = null;
    activeCycle.stop();
    return publish();
  }

  function stop() {
    if (lifecycle === 'stopped') return snapshot();
    lifecycle = 'stopped'; clearInterval(staleTimer); staleTimer = null;
    activeCycle.stop();
    listeners.clear(); readModels = initialReadModels(); providers = []; timeline.clear(); providerMonitor.clear(); seenEventKeys.clear();
    execution = Object.freeze({ component: 'AgentHub', taskId: null, correlationId: null, agent: null, status: 'IDLE', eventId: null, summary: 'No synthetic task dispatched.', output: null, error: null, simulated: true, provenance: FIXTURE_PROVENANCE, authorityRelevance: 'none' });
    recovery = Object.freeze({ component: 'SelfHealing', state: 'IDLE', incidentId: null, taskId: null, handler: null, outcome: null, eventId: null, simulated: true, provenance: FIXTURE_PROVENANCE, authorityRelevance: 'none' });
    revision += 1;
    return snapshot();
  }

  const metadata = Object.freeze({
    agentHubAvailable: typeof canonicalAgentHub.agents === 'function',
    agentCount: typeof canonicalAgentHub.agents === 'function' ? canonicalAgentHub.agents().length : 0,
    crv3Binding: 'DAMAR AIRuntime + RuntimeExecutor + ToolExecutor; offline fake provider only',
    agentHubBinding: activeCycle.metadata.agentHubDispatch,
    grantBinding: activeCycle.metadata.taskGrantScope.join(', ') + ' / ' + activeCycle.metadata.recoveryGrantScope.join(', '),
    watchdogBinding: activeCycle.metadata.watchdogClass,
    selfHealingBinding: activeCycle.metadata.selfHealing,
    watchdogClassAvailable: typeof canonicalWatchdogClass.prototype?.tick === 'function',
    watchdogDetectionEnabled: true, watchdogRemediationEnabled: false,
    selfHealingSimulationEnabled: true, productionSelfHealingInvoked: false,
    privateGrantScope: 'simulation-only exact-match capability scopes; no production tools'
  });

  return Object.freeze({
    start, stop, disconnect, subscribe, snapshot, buildFixtureEvent, dispatch, projectProvider,
    runAutonomousCycle: scenario => { if (lifecycle !== 'running') throw new Error('runtime composition is not running'); return activeCycle.runScenario(scenario); },
    cancelSimulationTask: taskId => activeCycle.cancelTask(taskId),
    probeTaskAuthorization: request => activeCycle.attemptTask(request),
    probeRecoveryAuthorization: (incident, grant) => activeCycle.attemptRecovery(incident, grant),
    probeOwnerBoundShadowAuthorization: kind => shadowBridge.probeAuthorization(kind),
    probeShadowAuthorization: kind => shadowBridge.probeAuthorization(kind),
    metadata, get lifecycle() { return lifecycle; },
    get subscriberCount() { return listeners.size; }
  });
}

module.exports = { createRuntimeComposition, FIXTURE_PROVENANCE };
