'use strict';
const { responsiveProps } = require('./responsive');
function shell(id, { children = [], density = 'NORMAL', handoff = null } = {}) { return Object.freeze({ shell_id: id, density, children, responsive: responsiveProps(), handoff, canonical_state_owner: 'none', boundary: true }); }
function idlePresenceShell(options) { return shell('idle_presence', options); }
function dashboardShell(options) { return shell('web_dashboard', options); }
function entityInspector(ref, { density = 'POWER' } = {}) { return Object.freeze({ type: 'entity_inspector', entity_ref: ref, density, state_owner: 'projection_only' }); }
function commandPalette({ entries = [] } = {}) { return Object.freeze({ type: 'command_palette', entries, authority: 'canonical_command_client_only' }); }
module.exports = { idlePresenceShell, dashboardShell, entityInspector, commandPalette };
