'use strict';

// Keep the R9R3 Dashboard source-derived status adapter read-only. The UI's
// demo state remains local, but it cannot be mistaken for approval/config
// authority or used to send protected commands.
(() => {
  const app = window.__DAMAR_APP__;
  if (!app || typeof app.getState !== 'function') return;
  let lastRevision = null;
  let disposed = false;
  let timer = null;
  let failures = 0;
  let activeRequest = null;

  function lockProtectedControls() {
    document.querySelectorAll('[data-approve-id], [data-reject-id], [data-set-default-model], #saveEndpointSettingBtn').forEach(button => {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.title = 'Disabled in the read-only local preview; canonical owner authorization is unavailable.';
    });
    const configInput = document.getElementById('settingsEndpointInput');
    if (configInput) { configInput.disabled = true; configInput.setAttribute('aria-disabled', 'true'); }
  }

  async function refreshSyntheticReadModel() {
    if (disposed) return;
    const controller = new AbortController();
    activeRequest = controller;
    const deadline = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/__r9r2/runtime-status', { cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('R9R3 read model unavailable');
      const snapshot = await response.json();
      if (snapshot.runId !== 'DAMAR_R9R3_CANONICAL_INTEGRATION_20261111' || snapshot.simulated !== true || snapshot.shadow !== true || snapshot.provenance !== 'R9R2_OFFLINE_OWNER_BOUND_SHADOW' || snapshot.authorityRelevance !== 'none') throw new Error('R9R3 read model provenance mismatch');
      if (disposed) return;
      const recovering = failures > 0;
      failures = 0;
      if (lastRevision === snapshot.revision && !recovering) return;
      lastRevision = snapshot.revision;
      const state = app.getState();
      const core = state.systemHealth?.find(item => item.id === 'sh-core');
      if (core) {
        core.status = 'SIMULATED';
        core.stateLabel = 'R9R3 Shadow';
        core.latency = 'offline';
        core.detail = `Synthetic AgentHub ${snapshot.execution?.status || 'UNKNOWN'}; SelfHealing ${snapshot.recovery?.state || 'UNKNOWN'}; production authority OFF.`;
      }
      const gateway = state.systemHealth?.find(item => item.id === 'sh-gateway');
      if (gateway) {
        gateway.status = 'SIMULATED'; gateway.stateLabel = 'Synthetic read model'; gateway.latency = 'offline';
        gateway.detail = `${snapshot.providers?.length || 0} synthetic provider-health projections; no provider endpoint or credential was queried.`;
      }
      if (snapshot.execution?.taskId && Array.isArray(state.tasks)) {
        const id = `R9R3-${snapshot.execution.taskId}`;
        let task = state.tasks.find(item => item.id === id);
        if (!task) {
          task = { id, title: 'R9R3 synthetic shadow cycle', subsystem: 'R9R3', status: 'SIMULATED', progress: 0,
            measurable: false, startedAt: 'local preview', assignedAgent: 'Synthetic AgentHub', priority: 'P2',
            summary: 'Offline read-model only; this preview did not dispatch production tools.', steps: [] };
          state.tasks.unshift(task);
        }
        task.status = 'SIMULATED'; task.progress = snapshot.execution.status === 'COMPLETED' ? 100 : 50;
        task.summary = `Synthetic AgentHub ${snapshot.execution.status}; SelfHealing ${snapshot.recovery?.state || 'UNKNOWN'}.`;
      }
      if (Array.isArray(snapshot.timeline) && Array.isArray(state.activities)) {
        const events = snapshot.timeline.slice(-12).map(event => ({
          id: `R9R3-${event.eventId}`, time: event.at || 'local preview',
          category: event.component || 'R9R3', title: `${event.component || 'Runtime'} ${event.recoveryState || event.taskState || event.type}`,
          detail: `${event.summary || 'Synthetic event'} · shadow/read-only`, status: 'SIMULATED', actor: 'R9R3 fixture'
        }));
        const ids = new Set(events.map(event => event.id));
        state.activities = [...events, ...state.activities.filter(event => !ids.has(event.id))].slice(0, 30);
      }
      app.navigateTo(state.activeView || 'overview');
      lockProtectedControls();
    } catch {
      if (disposed) return;
      failures = Math.min(failures + 1, 5);
      const state = app.getState();
      const core = state.systemHealth?.find(item => item.id === 'sh-core');
      if (core) { core.status = 'DISCONNECTED'; core.stateLabel = 'Disconnected'; core.detail = 'R9R3 synthetic read model unavailable.'; }
      const gateway = state.systemHealth?.find(item => item.id === 'sh-gateway');
      if (gateway) { gateway.status = 'DISCONNECTED'; gateway.stateLabel = 'Disconnected'; gateway.detail = 'Synthetic projection unavailable; provider health is unknown.'; }
      app.navigateTo(state.activeView || 'overview');
      lockProtectedControls();
    } finally {
      window.clearTimeout(deadline);
      activeRequest = null;
      if (!disposed) timer = window.setTimeout(refreshSyntheticReadModel, Math.min(30000, 1000 * (2 ** failures)));
    }
  }

  // If older localStorage selected the embedded Idle screen, route to the one
  // approved W5 Presence surface rather than rendering a second Orb/Dashboard.
  const state = app.getState();
  if (state?.surface === 'idle-presence') {
    window.location.replace('/s/idle_presence?r9r2-demo=1');
    return;
  }

  const goToIdle = event => {
    const target = event.target?.closest?.('#openIdlePresenceSidebarBtn, #qaIdlePresenceBtn, #runtimeOpenIdleBtn');
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.location.assign('/s/idle_presence?r9r2-demo=1');
  };
  document.addEventListener('click', goToIdle, true);

  document.addEventListener('submit', event => {
    if (event.target?.id !== 'cliCommandForm') return;
    const input = document.getElementById('cliCommandInput');
    if (/^\s*\/approve\b/i.test(input?.value || '')) {
      event.preventDefault(); event.stopImmediatePropagation();
      const box = document.getElementById('cliTranscriptBox');
      if (box) box.textContent += '\nSIMULATED APPROVAL DISABLED: canonical owner-bound authorization is unavailable.';
      input.value = '';
    }
  }, true);

  lockProtectedControls();
  const observer = new MutationObserver(lockProtectedControls);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => { disposed = true; activeRequest?.abort(); window.clearTimeout(timer); observer.disconnect(); }, { once: true });
  refreshSyntheticReadModel();
})();
