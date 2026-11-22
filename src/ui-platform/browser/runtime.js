'use strict';
const { Router, routeFor } = require('../routing');
const { tokenStyle } = require('../tokens');
const { bindVisualState } = require('../stateBinding');
const { mountShell, renderIntegratedStatus } = require('../shells');
const { ApiClient } = require('../apiClient');
const { createTimeline } = require('../eventTimeline');
const {
  waitingCrv3Status, projectCrv3ToolEvent, rejectedCrv3Status, isCrv3ReadModel,
  waitingWatchdogStatus, projectWatchdogToolEvent, rejectedWatchdogStatus, isWatchdogReadModel,
  waitingSelfHealingStatus, projectSelfHealingToolEvent, rejectedSelfHealingStatus, isSelfHealingReadModel,
  fallbackSelfHealingStatus
} = require('../crv3StatusAdapter');

// Own only browser event attachment. Matching, registry, history and current state
// belong to the shared Router. Public navigation after unmount is a safe no-op.
function createRouter(window, render, options = {}) {
  const router = new Router({ ...options, history: window.history, onNavigate: render });
  const navigate = router.navigate.bind(router);
  let mounted = false;
  router.navigate = (path, options = {}) => mounted ? navigate(path, typeof options === 'boolean' ? { replace: options } : options) : router.current;
  const handlePopState = () => router.navigate(window.location.pathname, { replace: true });
  router.mount = () => { if (mounted) return; mounted = true; window.addEventListener('popstate', handlePopState); };
  router.unmount = () => { if (!mounted) return; mounted = false; window.removeEventListener('popstate', handlePopState); };
  Object.defineProperty(router, 'mounted', { get: () => mounted });
  return router;
}
function boot(document = globalThis.document, window = globalThis.window, options = {}) {
  if (!document || !window) throw new Error('browser globals required');
  const app = document.querySelector('#app'); if (!app) throw new Error('missing #app root');
  let timeline = null;
  timeline = createTimeline();
  let statusFeedController = null, statusFeedTimer = null;
  let shell = null; let disposeShell = null; let integratedPanel = null;
  const runtime = {
    visualState: bindVisualState({}).visualState, router: null, mounted: false,
    readModel: waitingCrv3Status(),
    readModels: {
      crv3: waitingCrv3Status(),
      watchdog: waitingWatchdogStatus(),
      selfHealing: waitingSelfHealingStatus()
    },
    applyTokens(values) {
      if (!runtime.mounted) return;
      for (const [name, value] of Object.entries(tokenStyle('dark', values))) document.documentElement.style.setProperty(name, value);
    },
    setState(projection) {
      if (!runtime.mounted) return;
      const binding = bindVisualState(projection);
      runtime.visualState = binding.visualState;
      const live = shell?.querySelector('.damar-state'); if (live) live.textContent = binding.visualState;
      return binding;
    },
    setReadModel(readModel) {
      if (!runtime.mounted) return null;
      if (!isCrv3ReadModel(readModel)) throw new TypeError('only simulated, non-authoritative CRV3 projections may be displayed');
      runtime.readModel = readModel;
      runtime.readModels.crv3 = readModel;
      renderIntegratedPanel();
      return readModel;
    },
    setWatchdogReadModel(readModel) {
      if (!runtime.mounted) return null;
      if (!isWatchdogReadModel(readModel)) throw new TypeError('only simulated, non-authoritative Watchdog projections may be displayed');
      runtime.readModels.watchdog = readModel;
      renderIntegratedPanel();
      return readModel;
    },
    setSelfHealingReadModel(readModel) {
      if (!runtime.mounted) return null;
      if (!isSelfHealingReadModel(readModel)) throw new TypeError('only simulated, non-authoritative SelfHealing projections may be displayed');
      runtime.readModels.selfHealing = readModel;
      renderIntegratedPanel();
      return readModel;
    },
    setIntegratedReadModels(next) {
      if (!runtime.mounted) return null;
      const { crv3 = runtime.readModels.crv3, watchdog = runtime.readModels.watchdog, selfHealing = runtime.readModels.selfHealing } = next ?? {};
      if (crv3 && !isCrv3ReadModel(crv3)) throw new TypeError('invalid CRV3 read model');
      if (watchdog && !isWatchdogReadModel(watchdog)) throw new TypeError('invalid Watchdog read model');
      if (selfHealing && !isSelfHealingReadModel(selfHealing)) throw new TypeError('invalid SelfHealing read model');
      runtime.readModels = { crv3: runtime.readModels.crv3, watchdog: runtime.readModels.watchdog, selfHealing: runtime.readModels.selfHealing };
      if (crv3) runtime.readModels.crv3 = crv3;
      if (watchdog) runtime.readModels.watchdog = watchdog;
      if (selfHealing) runtime.readModels.selfHealing = selfHealing;
      return renderIntegratedPanel();
    },
    getRuntimeSnapshot() { return runtime.runtimeSnapshot || null; },
    applyCrv3ToolEvent(event) {
      if (!runtime.mounted) return null;
      try {
        const readModel = runtime.setReadModel(projectCrv3ToolEvent(event));
        timeline?.record(readModel, { type: 'projection', correlationId: null });
        return readModel;
      }
      catch {
        const rejected = runtime.setReadModel(rejectedCrv3Status());
        timeline?.reject(event?.toolCallId, { component: 'CRV3', reason: 'synthetic CRV3 event rejected', provenance: event?.result?.provenance ?? null });
        return rejected;
      }
    },
    applyWatchdogToolEvent(event) {
      if (!runtime.mounted) return null;
      try {
        const readModel = runtime.setWatchdogReadModel(projectWatchdogToolEvent(event));
        timeline?.record(readModel, { type: 'projection', correlationId: null });
        return readModel;
      }
      catch {
        const rejected = runtime.setWatchdogReadModel(rejectedWatchdogStatus());
        timeline?.reject(event?.toolCallId, { component: 'Watchdog', reason: 'synthetic Watchdog event rejected', provenance: event?.result?.provenance ?? null });
        return rejected;
      }
    },
    applySelfHealingToolEvent(event) {
      if (!runtime.mounted) return null;
      try {
        const readModel = runtime.setSelfHealingReadModel(projectSelfHealingToolEvent(event));
        const correlationId = readModel.data?.relatedWatchdogEventId ?? null;
        const outcome = readModel.data?.outcome ?? null;
        timeline?.record(readModel, { type: 'projection', correlationId, outcome });
        return readModel;
      }
      catch {
        const rejected = runtime.setSelfHealingReadModel(rejectedSelfHealingStatus());
        timeline?.reject(event?.toolCallId, { component: 'SelfHealing', reason: 'synthetic SelfHealing event rejected', provenance: event?.result?.provenance ?? null });
        return rejected;
      }
    },
    getTimeline() { return timeline ? timeline.getHistory() : Object.freeze([]); },
    getTimelineFiltered(filter) { return timeline ? timeline.getHistory(filter) : Object.freeze([]); },
    getTimelineStats() { return timeline ? timeline.getStats() : null; },
    timelineToFixture() { return timeline ? timeline.toFixture() : null; },
    timelineFromFixture(json) {
      if (!timeline) return null;
      timeline.clear();
      return timeline.fromFixture(json);
    },
    applyRuntimeStatus(snapshot) {
      if (!runtime.mounted || !snapshot || snapshot.schema !== 'damar.r9r2.shadow-status/1' || snapshot.runId !== 'DAMAR_R9R3_CANONICAL_INTEGRATION_20261111' || snapshot.simulated !== true || snapshot.shadow !== true || snapshot.provenance !== 'R9R2_OFFLINE_OWNER_BOUND_SHADOW' || snapshot.authorityRelevance !== 'none' || !snapshot.readModels || !Array.isArray(snapshot.timeline) || !snapshot.shadowExecution) return false;
      if (snapshot.shadowExecution.provenance !== 'R9R2_OFFLINE_OWNER_BOUND_SHADOW' || snapshot.shadowExecution.grantObjectsExposed !== false || snapshot.shadowExecution.networkCalls !== 0 || snapshot.shadowExecution.credentialsUsed !== false || !Array.isArray(snapshot.shadowExecution.runtimeMethods)) return false;
      const execution = snapshot.execution, recovery = snapshot.recovery;
      const taskStates = ['IDLE', 'QUEUED', 'RUNNING', 'RECOVERING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'REJECTED'];
      const recoveryStates = ['IDLE', 'DETECTED', 'RECOVERING', 'RECOVERED', 'FAILED', 'REJECTED'];
      if (!execution || execution.component !== 'AgentHub' || execution.simulated !== true || execution.provenance !== 'R9R2_OFFLINE_BOUNDED_SIMULATION' || execution.authorityRelevance !== 'none' || !taskStates.includes(execution.status)) return false;
      if (!recovery || recovery.component !== 'SelfHealing' || recovery.simulated !== true || recovery.provenance !== 'R9R2_OFFLINE_BOUNDED_SIMULATION' || recovery.authorityRelevance !== 'none' || !recoveryStates.includes(recovery.state)) return false;
      if (snapshot.timeline.length > 200 || snapshot.timeline.some(entry => !entry || !(['AgentHub', 'CRV3', 'Watchdog', 'SelfHealing'].includes(entry.component) || (entry.component === 'UNKNOWN' && entry.type === 'rejection')) || !['HEALTHY', 'DEGRADED', 'OFFLINE', 'UNKNOWN'].includes(entry.status) || entry.authorityRelevance !== 'none' || !['R3_OFFLINE_SYNTHETIC_FIXTURE', 'R4_OFFLINE_SYNTHETIC_FIXTURE', 'R9R2_OFFLINE_BOUNDED_SIMULATION'].includes(entry.provenance))) return false;
      const previousSnapshot = runtime.runtimeSnapshot;
      runtime.runtimeSnapshot = snapshot;
      try {
        runtime.setIntegratedReadModels(snapshot.readModels);
        timeline.clear(); timeline.fromFixture(JSON.stringify({ entries: snapshot.timeline.slice(-200) }));
        renderIntegratedPanel();
      } catch { runtime.runtimeSnapshot = previousSnapshot; return false; }
      runtime.connection = snapshot.connected === true ? 'connected' : 'disconnected';
      return true;
    },
      attachRuntimeStatusFeed({ url = '/__r9r2/runtime-status', intervalMs = 500, fetchImpl = window.fetch?.bind(window) } = {}) {
      if (!runtime.mounted || typeof fetchImpl !== 'function') return () => {};
      statusFeedController?.abort(); clearTimeout(statusFeedTimer);
      const controller = new AbortController(); statusFeedController = controller;
      let active = true;
      const poll = async () => {
        if (!active || controller.signal.aborted || !runtime.mounted) return;
        try {
          const response = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
          if (!response.ok || !runtime.applyRuntimeStatus(await response.json())) throw new Error('runtime status unavailable or rejected');
        } catch { if (!controller.signal.aborted && runtime.mounted) runtime.connection = 'disconnected'; }
        if (active && !controller.signal.aborted && runtime.mounted) statusFeedTimer = window.setTimeout(poll, Math.max(100, Math.min(intervalMs, 10000)));
      };
      poll();
      return () => { if (!active) return; active = false; controller.abort(); clearTimeout(statusFeedTimer); statusFeedTimer = null; if (statusFeedController === controller) statusFeedController = null; };
    },
  };

  function renderIntegratedPanel() {
    if (!runtime.mounted) return null;
    const previous = integratedPanel;
    previous?.remove();
    const panel = renderIntegratedStatus(document, runtime.readModels);
    if (panel) {
      const executionPanel = document.createElement('section');
      executionPanel.className = 'damar-agenthub-execution';
      executionPanel.setAttribute('role', 'status');
      executionPanel.setAttribute('aria-live', 'polite');
      executionPanel.setAttribute('aria-label', 'Simulated AgentHub execution and recovery');
      const execution = runtime.runtimeSnapshot?.execution;
      const recovery = runtime.runtimeSnapshot?.recovery;
      const add = (label, value) => { const row = document.createElement('p'); row.textContent = `${label}: ${value}`; executionPanel.append(row); };
      const heading = document.createElement('h2'); heading.textContent = 'AgentHub simulation'; executionPanel.append(heading);
      add('Task', execution?.taskId || 'idle');
      add('AgentHub state', execution?.status || 'IDLE');
      add('Result', execution?.summary || 'No synthetic task dispatched.');
      add('Recovery', recovery?.state || 'IDLE');
      if (execution?.output) add('Output', typeof execution.output === 'string' ? execution.output : JSON.stringify(execution.output));
      if (execution?.error) add('Task error', execution.error);
       add('Runtime path', execution?.output?.runtimeMethods?.join(' → ') || runtime.runtimeSnapshot?.shadowExecution?.runtimeMethods?.join(' → ') || 'CRV3 shadow runtime awaiting task');
      add('Provenance', 'SIMULATED · SHADOW · NO BACKEND AUTHORITY');
      panel.append(executionPanel);
      const history = document.createElement('section');
      history.className = 'damar-agenthub-timeline';
      history.setAttribute('aria-label', 'Simulated event and recovery timeline');
      const historyHeading = document.createElement('h3'); historyHeading.textContent = 'Event and recovery timeline'; history.append(historyHeading);
      const list = document.createElement('ol');
      for (const event of runtime.getTimeline().slice(-8)) {
        const item = document.createElement('li');
        item.textContent = `${event.component} · ${event.recoveryState || event.status} — ${event.summary || 'No summary'}${event.eventId ? ` · ${event.eventId}` : ''}${event.correlationId ? ` · related ${event.correlationId}` : ''}`;
        list.append(item);
      }
      if (!list.children.length) { const item = document.createElement('li'); item.textContent = 'No simulated events yet.'; list.append(item); }
      history.append(list); panel.append(history);
      shell?.append(panel); integratedPanel = panel;
    }
    return integratedPanel;
  }

  const removeShell = () => { disposeShell?.(); disposeShell = null; shell = null; integratedPanel = null; };
  const render = ({ route }) => {
    if (!runtime.mounted) return; removeShell();
    disposeShell = mountShell(app, { kind: route.surface, router: runtime.router, route, state: { label: runtime.visualState }, readModels: runtime.readModels, onNavigate: ({ root }) => { shell = root; } });
    integratedPanel = shell?.querySelector('.damar-integrated-status');
  };
  runtime.router = createRouter(window, render, options);
  runtime.mount = () => {
    if (runtime.mounted) return;
    runtime.mounted = true; runtime.applyTokens(options.tokenValues); runtime.router.mount();
    const path = window.location.pathname;
    runtime.router.navigate(routeFor(path, runtime.router.routes) ? path : '/s/web_dashboard', { replace: true });
  };
  runtime.unmount = () => { if (!runtime.mounted) return; runtime.mounted = false; statusFeedController?.abort(); statusFeedController = null; clearTimeout(statusFeedTimer); statusFeedTimer = null; runtime.router.unmount(); removeShell(); };
  runtime.mount(); return runtime;
}
module.exports = { boot, route: routeFor, semanticTokens: tokenStyle, ApiClient };
