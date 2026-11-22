'use strict';
(() => {
  if (document.getElementById('werkudara-r7-panel')) return;
  const panel = document.createElement('section');
  panel.id = 'werkudara-r7-panel';
  panel.setAttribute('aria-labelledby', 'werkudara-r7-title');
  panel.innerHTML = `<h2 id="werkudara-r7-title">Werkudara review</h2>
    <p id="werkudara-r7-state" role="status" aria-live="polite">Loading review state…</p>
    <p id="werkudara-r7-provider">Provider state not checked.</p>
    <form id="werkudara-r7-form">
      <label>Owner test credential <input id="werkudara-r7-key" type="password" autocomplete="off" spellcheck="false"></label>
      <label>Supervision mode <select id="werkudara-r7-mode"><option value="EVENT_ONLY">Event only · zero model budget</option><option value="EVENT_REVIEW">Event review · finite model budget</option></select></label>
      <label>Maximum spend units <input id="werkudara-r7-spend" type="number" min="1" max="1000" value="1" required></label>
      <label>Maximum calls <input id="werkudara-r7-calls" type="number" min="1" max="3" value="1" required></label>
      <button id="werkudara-r7-on" type="submit" disabled>Enable review</button>
      <button id="werkudara-r7-off" type="button">Switch OFF / stop</button>
      <button id="werkudara-r7-refresh" type="button">Refresh</button>
    </form>
    <h3>Budget</h3><pre id="werkudara-r7-budget">No budget data loaded.</pre>
    <h3>Recent advisories</h3><ul id="werkudara-r7-advisories"><li>No advisories recorded.</li></ul>
    <h3>Alerts</h3><ul id="werkudara-r7-alerts"><li>No alerts recorded.</li></ul>`;
  const style = document.createElement('style');
  style.textContent = `#werkudara-r7-panel{margin:16px;padding:18px 20px;background:#181c23;color:#f2f4f7;border:1px solid #657182;border-radius:6px;max-width:100%;overflow-wrap:anywhere}#werkudara-r7-panel h2{font-size:20px;margin:0 0 10px}#werkudara-r7-panel h3{font-size:16px;margin:18px 0 6px}#werkudara-r7-panel p{color:#e1e7ef}#werkudara-r7-panel form{display:flex;gap:12px;flex-wrap:wrap;align-items:end}#werkudara-r7-panel label{display:flex;flex-direction:column;gap:6px;max-width:100%;font-size:14px}#werkudara-r7-panel input,#werkudara-r7-panel button{min-height:44px;max-width:100%;padding:8px;border:1px solid #94a3b8;border-radius:4px;background:#242b35;color:#fff;font:inherit}#werkudara-r7-panel button:disabled{color:#d2d7de;background:#303640}#werkudara-r7-panel #werkudara-r7-off{border-color:#f5c85b;color:#fff3c4}#werkudara-r7-panel :focus-visible{outline:3px solid #f5c85b;outline-offset:3px}#werkudara-r7-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}#werkudara-r7-panel li{margin:5px 0}`;
  document.head.append(style);
  (document.querySelector('main') || document.body).append(panel);
  const el = id => document.getElementById(id);
  let stopped = false;
  function syncMode() {
    const eventOnly = el('werkudara-r7-mode').value === 'EVENT_ONLY';
    el('werkudara-r7-spend').disabled = eventOnly;
    el('werkudara-r7-calls').disabled = eventOnly;
    el('werkudara-r7-on').textContent = eventOnly ? 'Enable event-only' : 'Enable review';
  }
  async function refresh() {
    el('werkudara-r7-state').textContent = 'Loading local review state…';
    try {
      const response = await fetch('/api/r7/control', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw Error('Local candidate service did not return status.');
      const data = await response.json();
      if (stopped || data.schemaVersion !== 1 || data.authority !== 'isolated-test') throw Error('Candidate status schema was not accepted.');
      el('werkudara-r7-state').textContent = `${data.enabled ? 'ON' : 'OFF'} · ${data.mode} · owner control required`;
       el('werkudara-r7-mode').value = data.mode === 'EVENT_ONLY' ? 'EVENT_ONLY' : 'EVENT_REVIEW';
       syncMode();
       el('werkudara-r7-provider').textContent = data.providerKind === 'MOCKED' ? 'Provider: injected mock for candidate tests. No live billing.' : 'Provider unavailable. EVENT_ONLY remains available; model review is disabled.';
       el('werkudara-r7-on').disabled = !data.providerAvailable && data.mode !== 'EVENT_ONLY';
      el('werkudara-r7-budget').textContent = JSON.stringify({ budget: data.budget,
        monitoredJobs: data.monitoredJobs, lastTrigger: data.lastTrigger,
        inFlightModels: data.budget.inFlight, ownerPermission: data.ownerPermission,
        stopAvailable: data.stopAvailable }, null, 2);
      const rows = (id, values, empty) => {
        const list = el(id); list.replaceChildren();
        if (!values.length) { const item = document.createElement('li'); item.textContent = empty; list.append(item); return; }
        for (const value of values) { const item = document.createElement('li'); item.textContent = JSON.stringify(value); list.append(item); }
      };
      rows('werkudara-r7-advisories', data.advisories || [], 'No event-triggered review has completed.');
      rows('werkudara-r7-alerts', data.alerts || [], 'No supervisor alerts recorded.');
    } catch (error) {
      if (!stopped) { el('werkudara-r7-state').textContent = 'Disconnected. Refresh after the local candidate service returns.'; el('werkudara-r7-provider').textContent = error.message; }
    }
  }
  async function command(action, body) {
    const input = el('werkudara-r7-key'); const ownerToken = input.value; input.value = '';
    if (!ownerToken) { el('werkudara-r7-state').textContent = 'Enter the owner test credential for this action. It is cleared after use.'; return; }
    try {
      const response = await fetch(`/api/r7/supervisor/${action}`, { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      el('werkudara-r7-state').textContent = response.ok ? `Supervision ${action} accepted.` : `Action denied: ${result.error || 'request rejected'}`;
    } catch { el('werkudara-r7-state').textContent = 'Action unavailable. Current state was not assumed to change.'; }
    await refresh();
  }
  el('werkudara-r7-form').addEventListener('submit', event => {
    event.preventDefault();
    const mode = el('werkudara-r7-mode').value;
    if (mode === 'EVENT_ONLY') { command('on', { mode }); return; }
    const maxSpendUnits = Number(el('werkudara-r7-spend').value), maxCalls = Number(el('werkudara-r7-calls').value);
    if (!Number.isSafeInteger(maxSpendUnits) || maxSpendUnits < 1 || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 3) {
      el('werkudara-r7-state').textContent = 'Enter finite positive limits. Maximum calls is three.'; return;
    }
    command('on', { mode, maxSpendUnits, maxCalls });
  });
  el('werkudara-r7-mode').addEventListener('change', syncMode);
  el('werkudara-r7-off').addEventListener('click', () => command('off', {}));
  el('werkudara-r7-refresh').addEventListener('click', refresh);
  window.addEventListener('pagehide', () => { stopped = true; el('werkudara-r7-key').value = ''; }, { once: true });
  refresh();
})();
