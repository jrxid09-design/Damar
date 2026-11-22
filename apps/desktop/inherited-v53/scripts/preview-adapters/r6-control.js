'use strict';
(() => {
  const app = window.__DAMAR_APP__;
  if (!app) return;
  const panel = document.createElement('section');
  panel.id = 'werkudara-panel'; panel.setAttribute('aria-labelledby', 'werkudara-title');
  panel.innerHTML = `<h2 id="werkudara-title">Werkudara: Supervisory Mode</h2>
    <p id="werkudara-status" role="status">Loading local supervisory state...</p>
    <p>Candidate jobs only. No production authority. No model provider configured.</p>
    <form id="werkudara-form">
      <label>Owner test credential <input id="werkudara-key" type="password" autocomplete="off" spellcheck="false"></label>
      <label>Mode <select id="werkudara-mode"><option value="EVENT_ONLY">Event only (no model)</option><option value="MILESTONE_REVIEW">Milestone review (provider required)</option></select></label>
      <label>Maximum calls per run <input id="werkudara-calls" type="number" min="1" max="100" required></label>
      <label>Maximum spend units <input id="werkudara-spend" type="number" min="1" max="10000" required></label>
      <button type="submit">Enable supervision</button>
      <button type="button" id="werkudara-off">Switch OFF / stop</button>
      <button type="button" id="werkudara-refresh">Refresh state</button>
    </form>
    <p id="werkudara-feedback" role="status" aria-live="polite"></p>
    <h3>Budget and activity</h3><pre id="werkudara-budget"></pre>
    <h3>Alerts and evidence</h3><ul id="werkudara-alerts"></ul>`;
  const style = document.createElement('style');
  style.textContent = `#werkudara-panel{margin:16px;padding:20px;background:#181c23;color:#f2f4f7;border:1px solid #657182;border-radius:8px;max-width:100%;overflow-wrap:anywhere}#werkudara-panel h2{font-size:20px}#werkudara-panel form{display:flex;gap:12px;flex-wrap:wrap;align-items:end}#werkudara-panel label{display:flex;flex-direction:column;gap:6px;max-width:100%;font-size:14px}#werkudara-panel input,#werkudara-panel select,#werkudara-panel button{min-height:44px;max-width:100%;padding:8px;border:1px solid #94a3b8;border-radius:4px;background:#242b35;color:#fff;font:inherit}#werkudara-panel :focus-visible{outline:3px solid #f5c85b;outline-offset:3px}#werkudara-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}#werkudara-panel p{color:#e1e7ef}`;
  document.head.append(style);
  const mount = document.querySelector('main') || document.body;
  mount.parentNode.insertBefore(panel, mount);
  let timer, active, stopped = false;
  const element = id => document.getElementById(id);
  const lockLegacy = () => document.querySelectorAll('#topbarNewTaskBtn,#qaNewTaskBtn,#submitNewTaskBtn,[data-approve-id],[data-reject-id],[data-set-default-model],#saveEndpointSettingBtn').forEach(button => { button.disabled = true; button.title = 'Unavailable in this isolated read-only view. Use the authenticated candidate CLI.'; });
  const say = value => { element('werkudara-feedback').textContent = value; };
  async function refresh() {
    active?.abort(); active = new AbortController();
    const deadline = setTimeout(() => active.abort(), 4000);
    try {
      const response = await fetch('/api/r6/control', { cache: 'no-store', signal: active.signal });
      if (!response.ok) throw Error();
      const value = await response.json();
      if (value.schemaVersion !== 1 || value.authority !== 'isolated-test') throw Error();
      if (stopped) return;
      const s = value.supervisor;
      element('werkudara-status').textContent = `${s.enabled ? 'ON' : 'OFF'} | ${s.mode} | ${s.reason || 'Ready'}`;
      const remaining = s.budget ? { calls:Math.max(0,s.budget.maxCallsRun-s.usage.calls), inputTokens:Math.max(0,s.budget.maxInputTokens-s.usage.inputTokens), outputTokens:Math.max(0,s.budget.maxOutputTokens-s.usage.outputTokens), spendUnits:Math.max(0,s.budget.maxSpendUnits-s.usage.spendUnits) } : null;
      element('werkudara-budget').textContent = JSON.stringify({ budget: s.budget, remaining, usage: s.usage, monitoredJobs:new Set((s.events || []).map(e=>e.taskId)).size, lastTrigger:(s.events || []).at(-1) || null, counts: s.counts, inflight: s.inflight }, null, 2);
      const alerts = element('werkudara-alerts'); alerts.replaceChildren();
      for (const alert of (s.alerts || []).slice(-10)) { const li = document.createElement('li'); li.textContent = JSON.stringify(alert); alerts.append(li); }
      if (!alerts.children.length) { const li = document.createElement('li'); li.textContent = 'No alerts recorded. Only real accepted candidate job events are monitored.'; alerts.append(li); }
      const state = app.getState();
      state.models = []; state.providers = []; state.agents = []; state.logs = []; state.traces = []; state.approvals = [];
      state.endpointPort = '127.0.0.1:2906';
      const plans = value.jobs.plans || [];
      state.tasks = plans.map(p => ({ id:p.planId || p.id,title:'Isolated SHA-256 plan',status:p.status,subsystem:'R6 candidate',priority:'P0',steps:[],measurable:false,summary:`Version ${p.version}; fixed synthetic text operation.` }));
      state.activities = (value.jobs.events || []).map(e => ({ id:e.eventId,title:e.type,category:'R6 candidate',detail:`Task ${e.taskId} version ${e.version}`,time:String(e.at),status:'RECORDED',actor:'Local service' }));
      const core = state.systemHealth?.find(item=>item.id==='sh-core'); if(core) Object.assign(core,{status:'ISOLATED_TEST',stateLabel:'R6 isolated service',detail:'Real bounded jobs; no production authority.'});
      for(const health of state.systemHealth || []) if(health!==core) Object.assign(health,{status:'UNVERIFIED',stateLabel:'Not queried by R6',detail:'No live status is asserted.'});
      app.navigateTo(state.activeView || 'overview');
      lockLegacy();
      const endpoint = element('sidebarEndpointLabel'); if (endpoint) endpoint.textContent = state.endpointPort;
      window.__DAMAR_R6_CONTROL__ = value;
    } catch { element('werkudara-status').textContent = 'Disconnected. Last shown state may be stale. Refresh after the local service returns.'; window.__DAMAR_R6_CONTROL__ = null; }
    finally { clearTimeout(deadline); if (!stopped) timer = setTimeout(refresh, 3000); }
  }
  async function command(action, body) {
    const key = element('werkudara-key').value; element('werkudara-key').value = '';
    if (!key) { say('Enter the owner test credential for this action. It is not saved.'); return; }
    try {
      const response = await fetch(`/api/r6/supervisor/${action}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const result = await response.json(); say(result.ok ? `Supervision ${action} accepted.` : `Action denied: ${result.code || result.error || 'unavailable'}`);
    } catch { say('Action unavailable. State was not assumed changed.'); }
    await refresh();
  }
  element('werkudara-form').addEventListener('submit', event => {
    event.preventDefault();
    const calls = Number(element('werkudara-calls').value), spend = Number(element('werkudara-spend').value);
    if (!Number.isSafeInteger(calls) || calls < 1 || !Number.isFinite(spend) || spend <= 0) return say('Set finite positive limits before enabling.');
    command('on', { mode: element('werkudara-mode').value, budget: { maxCallsRun: calls, maxCallsHour: calls, maxCallsDay: calls, maxInputTokens: 2048, maxOutputTokens: 512, maxSpendUnits: spend, cooldownMs: 60000, maxConcurrency: 1 } });
  });
  element('werkudara-off').addEventListener('click', () => command('off', {}));
  element('werkudara-refresh').addEventListener('click', () => { clearTimeout(timer); refresh(); });
  document.addEventListener('click', event => {
    if (!event.target.closest?.('#openIdlePresenceSidebarBtn,#qaIdlePresenceBtn,#runtimeOpenIdleBtn')) return;
    event.preventDefault(); event.stopImmediatePropagation(); location.assign('/s/idle_presence?r6=1');
  }, true);
  document.addEventListener('submit', event => { if(event.target.id!=='cliCommandForm')return;event.preventDefault();event.stopImmediatePropagation();const box=element('cliTranscriptBox');if(box)box.textContent='Use the authenticated Node/Python candidate CLI. Browser command execution is unavailable.'; },true);
  const observer=new MutationObserver(lockLegacy);observer.observe(document.body,{childList:true,subtree:true});
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); active?.abort(); observer.disconnect();element('werkudara-key').value = ''; }, { once: true });
  refresh();
})();
