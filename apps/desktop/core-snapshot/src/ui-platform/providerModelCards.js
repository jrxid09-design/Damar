'use strict';

/**
 * W7 provider/model/gateway card binding (lane C candidate).
 *
 * These render functions are the seam between the read-model projection
 * (providerModelProjection.js) and a UI card. They consume a projected record
 * that has already passed through normalizeReadModel (status, freshness,
 * provenance preserved) and produce a display view-model.
 *
 * The binding proves the honesty rules survive to the card:
 * - a DEGRADED provider renders DEGRADED, never HEALTHY;
 * - a SIMULATED model renders DISCOVERED with a SIMULATED marker, never
 *   AVAILABLE or GATEWAY_EXPOSED;
 * - a gateway key never renders a secret value, only masked metadata and a
 *   vault reference;
 * - routing evidence renders as evidence, never authority.
 *
 * A card whose read model is not ready (degraded/failed/unknown) renders an
 * explicit unavailable state; it never fabricates a healthy value.
 */
const {
  providerProjection, modelProjection, gatewayKeyProjection, routingEvidenceProjection
} = require('./providerModelProjection.js');
const { normalizeReadModel } = require('./contracts.js');

function ready(rm) { return rm && rm.status === 'ready'; }

function providerCard(record, readModelMeta = {}) {
  const rm = normalizeReadModel({ data: providerProjection(record), status: readModelMeta.status ?? 'ready', freshness: readModelMeta.freshness ?? record.freshness ?? 'UNKNOWN', asOf: readModelMeta.asOf, revision: readModelMeta.revision, provenance: readModelMeta.provenance ?? 'provider_health_projection', requestId: readModelMeta.requestId });
  if (!ready(rm)) {
    return { entityType: 'provider', available: false, state: rm.status === 'failed' ? 'UNAVAILABLE' : 'DEGRADED', health: 'UNKNOWN', freshness: rm.freshness, provenance: rm.provenance };
  }
  const p = rm.data;
  return {
    entityType: 'provider', available: true,
    instanceId: p.providerInstanceId, providerType: p.providerType,
    state: p.enabled ? (p.health === 'HEALTHY' ? 'HEALTHY' : p.health) : 'DISABLED',
    health: p.health, endpoint: p.endpoint, accountReference: p.accountReference,
    keyCount: p.keys.length, simulation: p.simulation,
    freshness: rm.freshness, provenance: rm.provenance
  };
}

function modelCard(record, readModelMeta = {}) {
  const rm = normalizeReadModel({ data: modelProjection(record), status: readModelMeta.status ?? 'ready', freshness: readModelMeta.freshness ?? record.freshness ?? 'UNKNOWN', asOf: readModelMeta.asOf, revision: readModelMeta.revision, provenance: readModelMeta.provenance ?? 'model_registry_projection', requestId: readModelMeta.requestId });
  if (!ready(rm)) {
    return { entityType: 'model', available: false, assignmentState: 'DISCOVERED', health: 'UNKNOWN', exposure: false, freshness: rm.freshness, provenance: rm.provenance };
  }
  const m = rm.data;
  return {
    entityType: 'model', available: true,
    modelId: m.modelId, upstreamModelId: m.upstreamModelId, alias: m.alias,
    assignmentState: m.assignmentState, health: m.health, exposure: m.exposure,
    capabilities: m.capabilities, roleSuitability: m.roleSuitability, simulation: m.simulation,
    freshness: rm.freshness, provenance: rm.provenance
  };
}

function gatewayKeyCard(record, readModelMeta = {}) {
  const rm = normalizeReadModel({ data: gatewayKeyProjection(record), status: readModelMeta.status ?? 'ready', freshness: readModelMeta.freshness ?? record.freshness ?? 'UNKNOWN', asOf: readModelMeta.asOf, revision: readModelMeta.revision, provenance: readModelMeta.provenance ?? 'key_metadata_projection', requestId: readModelMeta.requestId });
  if (!ready(rm)) {
    return { entityType: 'gateway_key', available: false, state: 'UNAVAILABLE', quotaState: 'UNKNOWN', freshness: rm.freshness, provenance: rm.provenance };
  }
  const k = rm.data;
  return {
    entityType: 'gateway_key', available: true,
    keyId: k.keyId, vaultRef: k.vaultRef, state: k.state, quotaState: k.quotaState,
    health: k.health, allowedModels: k.allowedModels, allowedAliases: k.allowedAliases,
    secretExposure: k.secretExposure,
    freshness: rm.freshness, provenance: rm.provenance
  };
}

function routingEvidenceCard(record, readModelMeta = {}) {
  const rm = normalizeReadModel({ data: routingEvidenceProjection(record), status: readModelMeta.status ?? 'ready', freshness: readModelMeta.freshness ?? record.freshness ?? 'UNKNOWN', asOf: readModelMeta.asOf, revision: readModelMeta.revision, provenance: readModelMeta.provenance ?? 'provider_health_projection', requestId: readModelMeta.requestId });
  if (!ready(rm)) return { entityType: 'routing_evidence', available: false, strategy: null, freshness: rm.freshness, provenance: rm.provenance };
  const r = rm.data;
  return { entityType: 'routing_evidence', available: true, strategy: r.strategy, chain: r.chain, reasons: r.reasons, routingAuthorityBoundary: r.routingAuthorityBoundary, freshness: rm.freshness, provenance: rm.provenance };
}

module.exports = { providerCard, modelCard, gatewayKeyCard, routingEvidenceCard };
