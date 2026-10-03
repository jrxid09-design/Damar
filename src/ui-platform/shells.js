'use strict';
const { responsiveProps } = require('./responsive');
const { Button, renderPrimitive } = require('./components');
function shell(id, { children = [], density = 'NORMAL', handoff = null } = {}) { return Object.freeze({ shell_id: id, density, children, responsive: responsiveProps(), handoff, canonical_state_owner: 'none', boundary: true }); }
function idlePresenceShell(options) { return shell('idle_presence', options); }
function dashboardShell(options) { return shell('web_dashboard', options); }
function entityInspector(ref, { density = 'POWER' } = {}) { return Object.freeze({ type: 'entity_inspector', entity_ref: ref, density, state_owner: 'projection_only' }); }
function commandPalette({ entries = [] } = {}) { return Object.freeze({ type: 'command_palette', entries, authority: 'canonical_command_client_only' }); }
function mountShell(container, { kind = 'idle_presence', density = 'NORMAL', router = null, onNavigate = () => {}, state = {}, route = null } = {}) {
  if (!container?.ownerDocument) throw new TypeError('container must be a DOM element');
  const doc = container.ownerDocument; const root = doc.createElement('main'); root.className = `damar-shell damar-shell-${kind}`; root.dataset.density = density; root.tabIndex = -1; root.setAttribute('aria-label', kind === 'idle_presence' ? 'Damar Idle foundation' : 'Damar Dashboard foundation');
  const status = doc.createElement('div'); status.className = 'damar-status damar-state'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.textContent = state.label || 'Ready';
  if (kind === 'idle_presence') { const presence = doc.createElement('section'); presence.className = 'damar-presence-slot'; presence.setAttribute('aria-label', 'Presence core slot'); presence.textContent = 'Presence foundation'; const overlay = doc.createElement('aside'); overlay.className = 'damar-overlay-slot'; overlay.setAttribute('aria-label', 'Overlay layer slot'); overlay.hidden = true; root.append(presence, overlay); }
  else { const nav = doc.createElement('nav'); nav.className = 'damar-navigation'; nav.setAttribute('aria-label', 'Dashboard navigation'); for (const [label, path] of [['Idle', '/s/idle_presence'], ['Overview', '/s/web_dashboard']]) { const button = renderPrimitive(doc, Button({ text: label, onClick: () => router?.navigate(path) })); nav.append(button); } const outlet = doc.createElement('section'); outlet.className = 'damar-route-outlet'; outlet.setAttribute('aria-label', 'Route outlet'); if (route) { outlet.setAttribute('data-route-id', route.route_id); outlet.textContent = route.route_id === 'dashboard.home' ? 'Dashboard foundation' : `Route foundation: ${route.route_id}`; } const entity = doc.createElement('section'); entity.className = 'damar-entity-outlet'; entity.setAttribute('aria-label', 'Entity view outlet'); const inspector = doc.createElement('aside'); inspector.className = 'damar-inspector'; inspector.setAttribute('aria-label', 'Inspector and drawer region'); root.append(nav, outlet, entity, inspector); }
  root.append(status); container.replaceChildren(root); onNavigate({ root, status }); return () => { root.replaceChildren(); root.remove(); };
}
module.exports = { idlePresenceShell, dashboardShell, entityInspector, commandPalette, mountShell };
