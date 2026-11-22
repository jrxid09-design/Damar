'use strict';

// Read-only bridge for the original W5 Idle Presence prototype in the
// loopback-only R9R3 preview. It never binds a command or grants authority.
(() => {
  if (!new URLSearchParams(window.location.search).has('r9r2-demo')) return;
  const URL = '/__r9r2/runtime-status';
  const expectedRun = 'DAMAR_R9R3_CANONICAL_INTEGRATION_20261111';
  const expectedProvenance = 'R9R2_OFFLINE_OWNER_BOUND_SHADOW';
  let active = true;
  let timer = null;
  let label = null;

  function ensureLabel() {
    if (label?.isConnected) return label;
    const badge = document.getElementById('dynamicStatusBadge');
    if (!badge) return null;
    label = document.createElement('span');
    label.id = 'r9r3PreviewStatus';
    label.setAttribute('role', 'status');
    label.setAttribute('aria-live', 'polite');
    label.title = 'Synthetic R9R3 read-only runtime projection. No backend authority.';
    label.style.cssText = 'display:inline-block;margin-left:6px;padding:2px 5px;border:1px solid rgba(229,193,101,.35);border-radius:6px;color:#e5c165;font:600 8px/1.35 Segoe UI,sans-serif;';
    badge.append(label);
    return label;
  }

  async function refresh() {
    if (!active) return;
    const node = ensureLabel();
    if (!node) { timer = window.setTimeout(refresh, 150); return; }
    try {
      const response = await fetch(URL, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error('status unavailable');
      const snapshot = await response.json();
      if (snapshot.runId !== expectedRun || snapshot.simulated !== true || snapshot.shadow !== true || snapshot.provenance !== expectedProvenance || snapshot.authorityRelevance !== 'none') throw new Error('untrusted preview snapshot');
      node.textContent = `SHADOW · ${snapshot.execution?.status || 'UNKNOWN'} · ${snapshot.recovery?.state || 'UNKNOWN'}`;
      const detail = document.getElementById('greetingSub');
      if (detail) detail.textContent = 'R9R3 synthetic read-only state · no provider, command, or backend authority';
    } catch {
      node.textContent = 'SHADOW STATUS UNAVAILABLE';
    }
    timer = window.setTimeout(refresh, 1000);
  }

  window.addEventListener('pagehide', () => { active = false; window.clearTimeout(timer); }, { once: true });
  refresh();
})();
