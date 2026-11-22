'use strict';
(() => {
  const app = window.__DAMAR_APP__;
  if (!app) return;
  let timer, active, stopped = false, failures = 0;
  const lock = () => document.querySelectorAll('[data-approve-id],[data-reject-id],[data-set-default-model],#saveEndpointSettingBtn,#topbarNewTaskBtn,#qaNewTaskBtn,#submitNewTaskBtn')
    .forEach(button => { button.disabled = true; button.setAttribute('aria-disabled', 'true'); button.title = 'Use the authenticated isolated-test CLI. Production actions are unavailable.'; });
  async function refresh() {
    active = new AbortController();
    const deadline = setTimeout(() => active.abort(), 5000);
    try {
      const response = await fetch('/api/r5/control-state', { cache: 'no-store', credentials: 'omit', signal: active.signal });
      if (!response.ok) throw new Error('STATE_UNAVAILABLE');
      const value = await response.json();
      if (value.schema !== 'damar.control.isolated.v1' || value.authority !== 'isolated-test' || value.productionAuthority !== false) throw new Error('PROVENANCE_REJECTED');
      if (stopped) return;
      failures = 0;
      const state = app.getState();
      state.endpointPort = '127.0.0.1:2906';
      state.models = []; state.providers = []; state.agents = [];
      state.traces = []; state.logs = [];
      const endpoint = document.getElementById('sidebarEndpointLabel');
      if (endpoint) endpoint.textContent = state.endpointPort;
      state.tasks = value.plans.map(plan => ({ id: plan.id, title: 'Isolated SHA-256 test plan',
        subsystem: 'R5 isolated-test', status: plan.status || 'UNKNOWN', progress: 0, measurable: false,
        assignedAgent: 'Authenticated test requester', priority: 'P0', steps: [],
        summary: `Version ${plan.version}; no production or physical capability.` }));
      state.activities = value.events.map(event => ({ id: event.eventId, time: String(event.at || ''),
        category: 'R5 isolated-test', title: event.type || 'Event', detail: `Plan ${event.planId || 'none'} version ${event.version || 0}`, status: 'RECORDED', actor: 'Isolated service' }));
      state.approvals = [];
      const core = state.systemHealth?.find(item => item.id === 'sh-core');
      if (core) Object.assign(core, { status: 'ISOLATED_TEST', stateLabel: 'Isolated test service', detail: 'Real bounded test operation. Production authority unavailable.' });
      const gateway = state.systemHealth?.find(item => item.id === 'sh-gateway');
      if (gateway) Object.assign(gateway, { status: 'UNKNOWN', stateLabel: 'Not queried', detail: value.providers.reason });
      window.__DAMAR_R5_CONTROL__ = Object.freeze(value);
      app.navigateTo(state.activeView || 'overview');
      lock();
    } catch {
      failures = Math.min(failures + 1, 5);
      const state = app.getState();
      const core = state.systemHealth?.find(item => item.id === 'sh-core');
      if (core) Object.assign(core, { status: 'DISCONNECTED', stateLabel: 'Disconnected', detail: 'Last recorded isolated state may be stale; actions remain unavailable.' });
      window.__DAMAR_R5_CONTROL__ = null;
      if (!stopped) { app.navigateTo(state.activeView || 'overview'); lock(); }
    } finally {
      clearTimeout(deadline);
      if (!stopped) timer = setTimeout(refresh, Math.min(30000, 1000 * 2 ** failures));
    }
  }
  document.addEventListener('click', event => {
    if (!event.target.closest?.('#openIdlePresenceSidebarBtn,#qaIdlePresenceBtn,#runtimeOpenIdleBtn')) return;
    event.preventDefault(); event.stopImmediatePropagation(); location.assign('/s/idle_presence?r5=1');
  }, true);
  document.addEventListener('submit', event => {
    if (event.target.id !== 'cliCommandForm') return;
    event.preventDefault(); event.stopImmediatePropagation();
    const box = document.getElementById('cliTranscriptBox');
    if (box) box.textContent = 'Use the authenticated isolated-test CLI in a terminal. This read-only Control view cannot grant approval or dispatch commands.';
  }, true);
  const observer = new MutationObserver(lock); observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); active?.abort(); observer.disconnect(); }, { once: true });
  lock(); refresh();
})();
