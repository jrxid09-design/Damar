'use strict';

const { deepLink } = require('./entityRefs');

// F-006/F-007 reconciled route table.
// - F-006: terminal.future is declared here so the runtime resolves the route
//   that data/uix-w4-routes.json declares (and platform.test.js locks as
//   CURRENT_PARTIAL / not implemented).
// - F-007: implementation_state matches the frozen JSON's no-overclaim reading.
//   The JSON claimed 'implemented' for the home and entity routes, but the
//   runtime renders only "Route foundation"/"Dashboard foundation" scaffolds
//   (shells.js), so the honest state is 'shell' (home) and 'contract' (entity).
//   The JSON is corrected to match in the reconciled fixture; the canonical JSON
//   change is a proposed owner sign-off (see F006F007-PROPOSAL.md).
// - CAND-003 (F-004): typed entity routes precede entity.generic so first-match
//   resolution reaches the specific route; entity.generic stays the fallback.
// CAND-002: registry/gateway architecture beyond W1 is future capability.
const FUTURE_ENTITY_TYPES = Object.freeze(['provider', 'model', 'model_gateway', 'agent_gateway']);
const PROJECT_ENTITY_TYPES = Object.freeze(['project', 'repository', 'workspace', 'coding_mission']);
const ENTITY_TYPES = ['mission', 'approval', 'device', 'capability', ...FUTURE_ENTITY_TYPES, 'security_incident', 'audit_event', 'memory_item', 'notification', ...PROJECT_ENTITY_TYPES];
const ENTITY_ROUTES = ENTITY_TYPES.map((type) => ({ route_id: `entity.${type}`, surface: 'web_dashboard', path_pattern: `/s/web_dashboard/entity/${type}/:entity_id`, entity_type: type, implementation_state: 'contract', auth_requirement: 'session', density_modes: ['NORMAL', 'POWER', 'FORENSIC'], current_future_classification: FUTURE_ENTITY_TYPES.includes(type) ? 'FUTURE_CAPABILITY_DEPENDENT' : PROJECT_ENTITY_TYPES.includes(type) ? 'DESIGNED_FOR_IMPLEMENTATION' : 'CURRENT_IMPLEMENTED' }));

const ROUTES = Object.freeze([
  { route_id: 'idle.home', surface: 'idle_presence', path_pattern: '/s/idle_presence', entity_type: null, implementation_state: 'shell', auth_requirement: 'session', density_modes: ['NORMAL'], current_future_classification: 'CURRENT_IMPLEMENTED' },
  { route_id: 'dashboard.home', surface: 'web_dashboard', path_pattern: '/s/web_dashboard', entity_type: null, implementation_state: 'shell', auth_requirement: 'session', density_modes: ['NORMAL', 'POWER', 'FORENSIC'], current_future_classification: 'CURRENT_IMPLEMENTED' },
  ...ENTITY_ROUTES,
  { route_id: 'entity.generic', surface: 'web_dashboard', path_pattern: '/s/web_dashboard/entity/:entity_type/:entity_id', entity_type: '*', implementation_state: 'contract', auth_requirement: 'session', density_modes: ['NORMAL', 'POWER', 'FORENSIC'], current_future_classification: 'CURRENT_IMPLEMENTED' },
  { route_id: 'terminal.future', surface: 'web_dashboard', path_pattern: '/s/web_dashboard/terminal', entity_type: null, implementation_state: 'contract', auth_requirement: 'session', density_modes: ['FORENSIC'], current_future_classification: 'CURRENT_PARTIAL' }
]);

function routeFor(path, routes = ROUTES) {
  const match = routes.find((route) => {
    const pattern = route.path_pattern.replace(/:[^/]+/g, '[^/]+').replace('*', '[^/]+');
    return new RegExp(`^${pattern}$`).test(path);
  });
  return match ?? null;
}

class Router {
  constructor({ routes = ROUTES, history = globalThis.history, onNavigate = () => {} } = {}) { this.routes = routes; this.history = history; this.onNavigate = onNavigate; this.current = null; }
  navigate(path, { replace = false, state = null } = {}) { const route = routeFor(path, this.routes); if (!route) throw new Error(`unknown route: ${path}`); (replace ? this.history?.replaceState : this.history?.pushState)?.call(this.history, state, '', path); this.current = { route, path, state }; this.onNavigate(this.current); return this.current; }
  navigateEntity(ref, options) { return this.navigate(deepLink(ref, options).path); }
}

module.exports = { ROUTES, routeFor, Router };
