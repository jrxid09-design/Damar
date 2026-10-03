'use strict';

const ENTITY_TYPES = Object.freeze([
  'mission', 'approval', 'device', 'capability', 'provider', 'model', 'model_gateway',
  'agent_gateway', 'security_incident', 'audit_event', 'memory_item', 'notification',
  'project', 'repository', 'workspace', 'coding_mission', 'diff', 'review'
]);

function entityRef(entityType, entityId, options = {}) {
  if (!ENTITY_TYPES.includes(entityType)) throw new TypeError(`unknown entity type: ${entityType}`);
  if (typeof entityId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(entityId)) throw new TypeError('entity_id must be a safe canonical identifier');
  return Object.freeze({ entity_type: entityType, entity_id: entityId, context: options.context ?? null, source_surface: options.sourceSurface ?? null });
}

function deepLink(ref, options = {}) {
  const value = typeof ref === 'string' ? JSON.parse(ref) : ref;
  const normalized = entityRef(value.entity_type, value.entity_id, value);
  const surface = options.surface ?? value.source_surface ?? 'web_dashboard';
  if (!['idle_presence', 'web_dashboard', 'cli', 'companion', 'voice'].includes(surface)) throw new TypeError('unsupported handoff surface');
  const path = `/s/${encodeURIComponent(surface)}/entity/${encodeURIComponent(normalized.entity_type)}/${encodeURIComponent(normalized.entity_id)}`;
  return Object.freeze({ ...normalized, surface, path, query: options.query ?? null });
}

function parseDeepLink(url, base = 'http://localhost') {
  const parsed = new URL(url, base);
  const match = parsed.pathname.match(/^\/s\/([^/]+)\/entity\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return deepLink(entityRef(decodeURIComponent(match[2]), decodeURIComponent(match[3]), { sourceSurface: decodeURIComponent(match[1]) }));
}

module.exports = { ENTITY_TYPES, entityRef, deepLink, parseDeepLink };
