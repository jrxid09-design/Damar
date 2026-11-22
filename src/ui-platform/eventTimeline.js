'use strict';

/**
 * Runtime Event Timeline — Workstream A (R5).
 *
 * Bounded, read-only history of projected offline status events
 * (CRV3 / Watchdog / SelfHealing). Never a production database,
 * never a canonical state source. Entries are derived exclusively
 * from verified synthetic projections; untrusted input never
 * reaches the timeline.
 *
 * Features:
 *   - timestamped, chronological history
 *   - chronological status transitions
 *   - Watchdog <-> SelfHealing event correlation
 *   - recovery attempt / outcome presentation
 *   - filtering by component and status
 *   - bounded retention (oldest dropped first)
 *   - deduplication of repeated event IDs
 *   - explicit stale, empty and rejected states
 */

const DEFAULT_MAX_RETENTION = 200;
const DEFAULT_STALE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

const COMPONENTS = Object.freeze({
  AGENT_HUB: 'AgentHub',
  CRV3: 'CRV3',
  WATCHDOG: 'Watchdog',
  SELF_HEALING: 'SelfHealing',
});

const ENTRY_TYPES = Object.freeze({
  PROJECTION: 'projection',
  REJECTION: 'rejection',
});

const STATUS_VALUES = Object.freeze(['HEALTHY', 'DEGRADED', 'OFFLINE', 'UNKNOWN']);

function nowIso() { return new Date().toISOString(); }

function boundedText(value, max = 160) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function isValidComponent(value) {
  return Object.values(COMPONENTS).includes(value);
}

function isValidStatus(value) {
  return STATUS_VALUES.includes(value);
}

/**
 * Create a new timeline instance.
 * @param {object} options { maxRetention?, staleMaxAgeMs? }
 */
function createTimeline({ maxRetention = DEFAULT_MAX_RETENTION, staleMaxAgeMs = DEFAULT_STALE_MAX_AGE_MS } = {}) {
  if (!Number.isInteger(maxRetention) || maxRetention < 1) {
    throw new TypeError('maxRetention must be a positive integer');
  }
  if (!Number.isInteger(staleMaxAgeMs) || staleMaxAgeMs < 1) {
    throw new TypeError('staleMaxAgeMs must be a positive integer');
  }

  const entries = []; // chronological, newest last
  const byEventId = new Map(); // eventId -> index in entries

  function prune() {
    while (entries.length > maxRetention) {
      const removed = entries.shift();
      if (removed && removed.eventId) byEventId.delete(removed.eventId);
    }
  }

  function isStale(entry) {
    const age = Date.now() - new Date(entry.timestamp).getTime();
    return age > staleMaxAgeMs;
  }

  /**
   * Record a projected read model into the timeline.
   * @param {object} readModel - normalized read model from an adapter projector
   * @param {object} context { type, eventId?, correlationId?, outcome? }
   * @returns {object} the recorded timeline entry (frozen)
   */
  function record(readModel, { type = ENTRY_TYPES.PROJECTION, correlationId = null, outcome = null } = {}) {
    if (!readModel || typeof readModel !== 'object') {
      throw new TypeError('timeline.record requires a read model');
    }
    const data = readModel.data || {};
    const component = data.component;
    const status = data.status;
    const eventId = data.eventId || null;
    const eventIdentity = eventId ? `${component}:${eventId}` : null;

    // Deduplicate repeated event IDs: keep the first observation.
    if (eventIdentity && byEventId.has(eventIdentity)) {
      const existing = entries[byEventId.get(eventIdentity)];
      return Object.freeze({ ...existing, reObservedAt: nowIso() });
    }

    const entry = Object.freeze({
      id: `${component}:${eventId || 'no-event'}:${nowIso()}`,
      eventId,
      timestamp: nowIso(),
      component: isValidComponent(component) ? component : 'UNKNOWN',
      type,
      status: isValidStatus(status) ? status : 'UNKNOWN',
      recoveryState: boundedText(data.recoveryState, 32),
      statusState: readModel.status || 'unknown',
      summary: boundedText(data.summary),
      principalId: boundedText(data.principalId),
      provenance: boundedText(readModel.provenance) || null,
      authorityRelevance: data.authorityRelevance || null,
      correlationId: boundedText(correlationId) || null,
      outcome: outcome ? Object.freeze({ ok: !!outcome.ok, error: outcome.error ? boundedText(outcome.error, 160) : null }) : null,
      reObservedAt: null,
    });

    entries.push(entry);
    if (eventIdentity) byEventId.set(eventIdentity, entries.length - 1);
    prune();
    return Object.freeze({ ...entry });
  }

  /**
   * Record a rejected event into the timeline.
   */
  function reject(eventId, { component = 'UNKNOWN', reason = 'rejected', provenance = null } = {}) {
    const entry = Object.freeze({
      id: `${component}:rejected:${eventId || 'no-event'}:${nowIso()}`,
      eventId: eventId || null,
      timestamp: nowIso(),
      component: isValidComponent(component) ? component : 'UNKNOWN',
      type: ENTRY_TYPES.REJECTION,
      status: 'UNKNOWN',
      statusState: 'failed',
      summary: boundedText(reason),
      principalId: null,
      provenance: boundedText(provenance) || null,
      authorityRelevance: 'none',
      correlationId: null,
      outcome: Object.freeze({ ok: false, error: boundedText(reason) }),
      reObservedAt: null,
    });
    entries.push(entry);
    prune();
    return Object.freeze({ ...entry });
  }

  function getHistory({ component, status, type, since, limit, includeStale = false } = {}) {
    let result = entries;
    if (component) result = result.filter(e => e.component === component);
    if (status) result = result.filter(e => e.status === status);
    if (type) result = result.filter(e => e.type === type);
    if (since) {
      const sinceMs = new Date(since).getTime();
      result = result.filter(e => new Date(e.timestamp).getTime() >= sinceMs);
    }
    if (!includeStale) result = result.filter(e => !isStale(e));
    // chronological, newest last already; return a shallow copy (frozen entries)
    if (Number.isInteger(limit) && limit >= 0) result = result.slice(-limit);
    return Object.freeze(result.slice());
  }

  function getLatest() {
    return entries.length ? Object.freeze({ ...entries[entries.length - 1] }) : null;
  }

  function getCorrelated(correlationId) {
    if (!correlationId) return Object.freeze([]);
    return Object.freeze(entries.filter(e => e.correlationId === correlationId || e.eventId === correlationId).slice());
  }

  function getStats() {
    const total = entries.length;
    const byComponent = {};
    const byStatus = {};
    const byType = {};
    let rejected = 0;
    for (const e of entries) {
      byComponent[e.component] = (byComponent[e.component] || 0) + 1;
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      byType[e.type] = (byType[e.type] || 0) + 1;
      if (e.type === ENTRY_TYPES.REJECTION) rejected += 1;
    }
    return Object.freeze({
      total,
      retained: maxRetention,
      byComponent: Object.freeze(byComponent),
      byStatus: Object.freeze(byStatus),
      byType: Object.freeze(byType),
      rejected,
      oldest: entries.length ? entries[0].timestamp : null,
      newest: entries.length ? entries[entries.length - 1].timestamp : null,
    });
  }

  function clear() {
    entries.length = 0;
    byEventId.clear();
  }

  function toFixture() {
    return JSON.stringify({ maxRetention, staleMaxAgeMs, entries: entries.map(e => ({ ...e })) });
  }

  function fromFixture(json) {
    let parsed;
    try { parsed = JSON.parse(json); } catch { throw new TypeError('invalid timeline fixture'); }
    clear();
    if (Number.isInteger(parsed.maxRetention) && parsed.maxRetention >= 1) {
      // cannot change maxRetention after creation; keep original
    }
    for (const e of (parsed.entries || [])) {
      entries.push(Object.freeze(e));
      if (e.eventId) byEventId.set(`${e.component}:${e.eventId}`, entries.length - 1);
    }
    prune();
    return getStats();
  }

  return Object.freeze({
    record,
    reject,
    getHistory,
    getLatest,
    getCorrelated,
    getStats,
    clear,
    toFixture,
    fromFixture,
    COMPONENTS,
    ENTRY_TYPES,
    STATUS_VALUES,
  });
}

module.exports = { createTimeline, DEFAULT_MAX_RETENTION, DEFAULT_STALE_MAX_AGE_MS, COMPONENTS, ENTRY_TYPES, STATUS_VALUES };
