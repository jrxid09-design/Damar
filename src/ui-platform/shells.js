'use strict';
const { responsiveProps } = require('./responsive');
const { Button, renderPrimitive } = require('./components');
function shell(id, { children = [], density = 'NORMAL', handoff = null } = {}) { return Object.freeze({ shell_id: id, density, children, responsive: responsiveProps(), handoff, canonical_state_owner: 'none', boundary: true }); }
function idlePresenceShell(options) { return shell('idle_presence', options); }
function dashboardShell(options) { return shell('web_dashboard', options); }
function entityInspector(ref, { density = 'POWER' } = {}) { return Object.freeze({ type: 'entity_inspector', entity_ref: ref, density, state_owner: 'projection_only' }); }
function commandPalette({ entries = [] } = {}) { return Object.freeze({ type: 'command_palette', entries, authority: 'canonical_command_client_only' }); }

function readModelLabel(readModel) {
  return readModel ? `${readModel.data?.component ?? ''} ${readModel.data?.status ?? ''}` : 'no-read-model';
}

function renderReadOnlyPanel(document, readModel, { kind, label, boundaryText }) {
  if (!readModel) return null;
  const data = readModel.data ?? {};
  const panel = document.createElement('section');
  panel.className = `damar-read-only-panel damar-${kind}-read-model`;
  panel.dataset.status = readModel.status;
  panel.setAttribute('role', readModel.status === 'failed' ? 'alert' : 'status');
  panel.setAttribute('aria-live', readModel.status === 'failed' ? 'assertive' : 'polite');
  panel.setAttribute('aria-label', label);

  const heading = document.createElement('h2');
  heading.textContent = label;
  panel.append(heading);

  const detail = document.createElement('p');
  if (readModel.status === 'loading') detail.textContent = 'Waiting for an offline synthetic event.';
  else if (readModel.status === 'empty') detail.textContent = data.summary ?? 'Valid fixture contained no status summary.';
  else if (readModel.status === 'failed') detail.textContent = 'The event was rejected. No status changed.';
  else detail.textContent = `${data.status}: ${data.summary ?? 'No summary supplied.'}`;
  panel.append(detail);

  if (data.eventId && data.principalId) {
    const provenance = document.createElement('p');
    provenance.textContent = `Event ${data.eventId}. Principal ${data.principalId}. Source ${data.provenance}.`;
    panel.append(provenance);
  }

  if (data.checks && data.checks.length) {
    const checks = document.createElement('p');
    checks.textContent = 'Checks: ' + data.checks.map(c => `${c.name} (${c.state})`).join('; ');
    panel.append(checks);
  }
  if (data.actions && data.actions.length) {
    const actions = document.createElement('p');
    actions.textContent = 'Watchdog actions: ' + data.actions.map(a => a.action).join('; ');
    panel.append(actions);
  }
  if (data.classification) {
    const classification = document.createElement('p');
    classification.textContent = `Classification: ${data.classification}. Recovery: ${data.outcome.ok ? 'ok' : 'failed'}.`;
    panel.append(classification);
  }
  if (data.attempts && data.attempts.length) {
    const attempts = document.createElement('p');
    attempts.textContent = 'Attempts: ' + data.attempts.map(a => `${a.strategy}:${a.ok ? 'ok' : 'failed'}`).join('; ');
    panel.append(attempts);
  }
  if (data.relatedWatchdogEventId) {
    const link = document.createElement('p');
    link.textContent = `Related watchdog event: ${data.relatedWatchdogEventId}.`;
    panel.append(link);
  }

  const boundary = document.createElement('p');
  boundary.textContent = boundaryText ?? 'Offline fixture only. This projection does not represent live telemetry or authority.';
  panel.append(boundary);
  return panel;
}

function renderCrv3ReadModelStatus(document, readModel) {
  return renderReadOnlyPanel(document, readModel, {
    kind: 'crv3',
    label: 'Simulated CRV3 status',
    boundaryText: 'Offline fixture only. This projection does not represent live telemetry or authority.'
  });
}

function renderWatchdogReadModelStatus(document, readModel) {
  return renderReadOnlyPanel(document, readModel, {
    kind: 'watchdog',
    label: 'Simulated Watchdog status',
    boundaryText: 'Offline fixture only. Watchdog monitoring state is read-only; it is not a live authority signal.'
  });
}

function renderSelfHealingReadModelStatus(document, readModel) {
  return renderReadOnlyPanel(document, readModel, {
    kind: 'selfhealing',
    label: 'Simulated SelfHealing status',
    boundaryText: 'Offline fixture only. SelfHealing recovery projections are read-only; no recovery is triggered from this UI.'
  });
}

function renderIntegratedStatus(document, { crv3, watchdog, selfHealing } = {}) {
  const container = document.createElement('section');
  container.className = 'damar-integrated-status';
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', 'Simulated CRV3 Watchdog SelfHealing status');

  const heading = document.createElement('h2');
  heading.textContent = 'Simulated CRV3 Watchdog SelfHealing status';
  container.append(heading);

  const crv3Panel = renderCrv3ReadModelStatus(document, crv3);
  const watchdogPanel = renderWatchdogReadModelStatus(document, watchdog);
  const selfHealingPanel = renderSelfHealingReadModelStatus(document, selfHealing);

  if (crv3Panel) container.append(crv3Panel);
  if (watchdogPanel) container.append(watchdogPanel);
  if (selfHealingPanel) container.append(selfHealingPanel);

  const disclaimer = document.createElement('p');
  disclaimer.textContent = 'All three panels project verified synthetic offline events only. Untrusted input is rejected before rendering.';
  container.append(disclaimer);
  return container;
}

function mountShell(container, { kind = 'idle_presence', density = 'NORMAL', router = null, onNavigate = () => {}, state = {}, route = null, readModel = null, readModels = null } = {}) {
  if (!container?.ownerDocument) throw new TypeError('container must be a DOM element');
  const doc = container.ownerDocument; const root = doc.createElement('main'); root.className = `damar-shell damar-shell-${kind}`; root.dataset.density = density; root.tabIndex = -1; root.setAttribute('aria-label', kind === 'idle_presence' ? 'Damar Idle foundation' : 'Damar Dashboard foundation');
  const status = doc.createElement('div'); status.className = 'damar-status damar-state'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.textContent = state.label || 'Ready';
  if (kind === 'idle_presence') { const presence = doc.createElement('section'); presence.className = 'damar-presence-slot'; presence.setAttribute('aria-label', 'Presence core slot'); presence.textContent = 'Presence foundation'; const overlay = doc.createElement('aside'); overlay.className = 'damar-overlay-slot'; overlay.setAttribute('aria-label', 'Overlay layer slot'); overlay.hidden = true; root.append(presence, overlay); }
  else { const nav = doc.createElement('nav'); nav.className = 'damar-navigation'; nav.setAttribute('aria-label', 'Dashboard navigation'); for (const [label, path] of [['Idle', '/s/idle_presence'], ['Overview', '/s/web_dashboard']]) { const button = renderPrimitive(doc, Button({ text: label, onClick: () => router?.navigate(path) })); nav.append(button); } const outlet = doc.createElement('section'); outlet.className = 'damar-route-outlet'; outlet.setAttribute('aria-label', 'Route outlet'); if (route) { outlet.setAttribute('data-route-id', route.route_id); outlet.textContent = route.route_id === 'dashboard.home' ? 'Dashboard foundation' : `Route foundation: ${route.route_id}`; } const entity = doc.createElement('section'); entity.className = 'damar-entity-outlet'; entity.setAttribute('aria-label', 'Entity view outlet'); const inspector = doc.createElement('aside'); inspector.className = 'damar-inspector'; inspector.setAttribute('aria-label', 'Inspector and drawer region'); root.append(nav, outlet, entity, inspector); }
  root.append(status);
  if (readModels) {
    const integrated = renderIntegratedStatus(doc, readModels);
    if (integrated) root.append(integrated);
  } else if (readModel) {
    const crv3ReadModel = renderCrv3ReadModelStatus(doc, readModel);
    if (crv3ReadModel) root.append(crv3ReadModel);
  }
  container.replaceChildren(root); onNavigate({ root, status }); return () => { root.replaceChildren(); root.remove(); };
}
module.exports = { idlePresenceShell, dashboardShell, entityInspector, commandPalette, renderCrv3ReadModelStatus, renderWatchdogReadModelStatus, renderSelfHealingReadModelStatus, renderIntegratedStatus, mountShell };
