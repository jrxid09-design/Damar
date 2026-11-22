'use strict';

/**
 * Provider Health Monitoring — Workstream D (R5).
 *
 * Synthetic, read-only provider-monitoring layer. Projects provider
 * availability, latency / timeout classification and bounded incident
 * history exclusively from synthetic fixtures. Observation surface only:
 * never an authority for execution, never automatic provider switching,
 * never real credentials or live provider requests.
 *
 * Follows existing DAMAR provider-category naming (model, gateway,
 * memory, security, cli, router) without introducing a new framework.
 */

const STATUS_VALUES = Object.freeze(['HEALTHY', 'DEGRADED', 'OFFLINE', 'UNKNOWN']);
const CLASSIFICATIONS = Object.freeze(['ok', 'slow', 'timeout', 'unavailable', 'unknown']);
const PROVIDER_CATEGORIES = Object.freeze(['model', 'gateway', 'memory', 'security', 'cli', 'router', 'other']);

const DEFAULT_MAX_INCIDENTS = 50;
const PROVENANCE = 'R5_OFFLINE_SYNTHETIC_FIXTURE';

function boundedText(value, max = 160) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function nowIso() { return new Date().toISOString(); }

function isValidStatus(value) { return STATUS_VALUES.includes(value); }
function isValidClassification(value) { return CLASSIFICATIONS.includes(value); }
function isValidCategory(value) { return PROVIDER_CATEGORIES.includes(value); }

// Latency -> classification transition rules (milliseconds).
// ok < 1000ms, slow 1000-5000ms, timeout >= 5000ms, unavailable when not ok.
function classify(latencyMs, ok) {
  if (ok === false) return 'unavailable';
  if (latencyMs == null) return 'unknown';
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return 'unknown';
  if (latencyMs >= 5000) return 'timeout';
  if (latencyMs >= 1000) return 'slow';
  return 'ok';
}

function statusFor(classification) {
  switch (classification) {
    case 'ok': return 'HEALTHY';
    case 'slow': return 'DEGRADED';
    case 'timeout': return 'OFFLINE';
    case 'unavailable': return 'OFFLINE';
    default: return 'UNKNOWN';
  }
}

// Health-state transition rules: HEALTHY <-> DEGRADED <-> OFFLINE.
function transition(prevStatus, currentStatus) {
  if (!isValidStatus(prevStatus) || !isValidStatus(currentStatus)) return 'unknown';
  if (prevStatus === currentStatus) return 'stable';
  const order = { HEALTHY: 0, DEGRADED: 1, OFFLINE: 2 };
  if (order[currentStatus] > order[prevStatus]) return 'degrading';
  return 'recovering';
}

function createProviderMonitor({ maxIncidents = DEFAULT_MAX_INCIDENTS } = {}) {
  if (!Number.isInteger(maxIncidents) || maxIncidents < 1) {
    throw new TypeError('maxIncidents must be a positive integer');
  }

  const incidents = []; // newest first
  const lastByProvider = new Map(); // name -> last projection

  function prune() {
    while (incidents.length > maxIncidents) incidents.pop();
  }

  /**
   * Project a synthetic provider snapshot into a read-only health record.
   * @param {object} snapshot { name, category, latencyMs, ok, error? }
   * @returns {object} frozen health projection
   */
  function project(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new TypeError('providerHealth.project requires a provider snapshot');
    }
    const name = boundedText(snapshot.name) || 'unknown-provider';
    const category = isValidCategory(snapshot.category) ? snapshot.category : 'other';
    const latencyMs = (typeof snapshot.latencyMs === 'number' && Number.isFinite(snapshot.latencyMs) && snapshot.latencyMs >= 0)
      ? snapshot.latencyMs : null;
    const ok = snapshot.ok === true;
    const classification = classify(latencyMs, ok);
    const status = statusFor(classification);
    const available = status === 'HEALTHY';

    const prev = lastByProvider.get(name);
    const transitionLabel = prev ? transition(prev.status, status) : 'initial';
    lastByProvider.set(name, { status, classification, at: nowIso() });

    let incident = null;
    if (status === 'OFFLINE') {
      incident = Object.freeze({
        id: name + ':' + nowIso(),
        at: nowIso(),
        provider: name,
        classification,
        detail: boundedText(snapshot.error) || (classification === 'timeout' ? 'provider request timed out' : 'provider unavailable')
      });
      incidents.unshift(incident);
      prune();
    }

    const projection = Object.freeze({
      name, category, status, latencyMs, classification, available,
      lastCheck: nowIso(),
      incident,
      transition: transitionLabel,
      authorityRelevance: 'none',
      simulated: true,
      provenance: PROVENANCE
    });
    return Object.freeze({ ...projection });
  }

  function getHistory() { return Object.freeze(incidents.slice()); } // newest first

  function getIncidentsFor(providerName) {
    if (!providerName) return Object.freeze([]);
    return Object.freeze(incidents.filter(i => i.provider === providerName).slice());
  }

  function getStats() {
    const total = incidents.length;
    const byClassification = {};
    for (const inc of incidents) {
      byClassification[inc.classification] = (byClassification[inc.classification] || 0) + 1;
    }
    return Object.freeze({
      totalIncidents: total,
      retained: maxIncidents,
      byClassification: Object.freeze(byClassification),
      providersTracked: lastByProvider.size
    });
  }

  function clear() { incidents.length = 0; lastByProvider.clear(); }

  function toFixture() {
    return JSON.stringify({ maxIncidents, incidents: incidents.map(i => ({ ...i })) });
  }

  function fromFixture(json) {
    let parsed;
    try { parsed = JSON.parse(json); } catch { throw new TypeError('invalid provider health fixture'); }
    clear();
    if (Number.isInteger(parsed.maxIncidents) && parsed.maxIncidents >= 1) {
      // keep original maxIncidents
    }
    for (const inc of (parsed.incidents || [])) {
      incidents.push(Object.freeze(inc));
    }
    prune();
    return getStats();
  }

  return Object.freeze({
    project,
    classify,
    statusFor,
    transition,
    getHistory,
    getIncidentsFor,
    getStats,
    clear,
    toFixture,
    fromFixture,
    STATUS_VALUES, CLASSIFICATIONS, PROVIDER_CATEGORIES, PROVENANCE
  });
}

module.exports = { createProviderMonitor, classify, statusFor, transition, DEFAULT_MAX_INCIDENTS, STATUS_VALUES, CLASSIFICATIONS, PROVIDER_CATEGORIES, PROVENANCE };
