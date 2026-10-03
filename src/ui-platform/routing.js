'use strict';

const { deepLink } = require('./entityRefs');

const ROUTES = Object.freeze([
  { route_id: 'idle.home', surface: 'idle_presence', path_pattern: '/s/idle_presence', entity_type: null, implementation_state: 'shell', auth_requirement: 'session', density_modes: ['NORMAL'], current_future_classification: 'CURRENT_IMPLEMENTED' },
  { route_id: 'dashboard.home', surface: 'web_dashboard', path_pattern: '/s/web_dashboard', entity_type: null, implementation_state: 'shell', auth_requirement: 'session', density_modes: ['NORMAL', 'POWER', 'FORENSIC'], current_future_classification: 'CURRENT_IMPLEMENTED' },
  { route_id: 'entity.generic', surface: 'web_dashboard', path_pattern: '/s/web_dashboard/entity/:entity_type/:entity_id', entity_type: '*', implementation_state: 'contract', auth_requirement: 'session', density_modes: ['NORMAL', 'POWER', 'FORENSIC'], current_future_classification: 'CURRENT_IMPLEMENTED' },
  ...['mission', 'approval', 'device', 'capability', 'provider', 'model', 'model_gateway', 'agent_gateway', 'security_incident', 'audit_event', 'memory_item', 'notification', 'project', 'repository', 'workspace', 'coding_mission'].map((type) => ({ route_id: `entity.${type}`, surface: 'web_dashboard', path_pattern: `/s/web_dashboard/entity/${type}/:entity_id`, entity_type: type, implementation_state: 'contract', auth_requirement: 'session', density_modes: ['NORMAL', 'POWER', 'FORENSIC'], current_future_classification: type === 'project' || type === 'repository' || type === 'workspace' || type === 'coding_mission' ? 'DESIGNED_FOR_IMPLEMENTATION' : 'CURRENT_IMPLEMENTED' }))
]);

function routeFor(path) {
  const match = ROUTES.find((route) => {
    const pattern = route.path_pattern.replace(/:[^/]+/g, '[^/]+').replace('*', '[^/]+');
    return new RegExp(`^${pattern}$`).test(path);
  });
  return match ?? null;
}

class Router {
  constructor({ routes = ROUTES, history = globalThis.history, onNavigate = () => {} } = {}) { this.routes = routes; this.history = history; this.onNavigate = onNavigate; this.current = null; }
  navigate(path, { replace = false, state = null } = {}) { const route = routeFor(path); if (!route) throw new Error(`unknown route: ${path}`); (replace ? this.history?.replaceState : this.history?.pushState)?.call(this.history, state, '', path); this.current = { route, path, state }; this.onNavigate(this.current); return this.current; }
  navigateEntity(ref, options) { return this.navigate(deepLink(ref, options).path); }
}

module.exports = { ROUTES, routeFor, Router };
