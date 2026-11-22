'use strict';

/**
 * W7 read-model projections for provider, model, gateway-key and routing
 * evidence records (lane C candidate, not applied to canonical sources).
 *
 * Frozen contract: docs/uix-w2/PROVIDER_MODEL_PRODUCT_ARCHITECTURE.json
 * (schema uix-w2.provider-model.v1), MODEL_GATEWAY_CONTRACT.json,
 * AGENT_GATEWAY_CONTRACT.json and CANONICAL_STATE_OWNERSHIP.json.
 *
 * Rules this module enforces, one per frozen sentence:
 * - provider type, provider instance, model identity, logical alias, role
 *   assignment, availability, health, exposure and routing stay separate fields
 *   (docs/uix-w3/W7_VISUAL_HANDOFF.md);
 * - unknown is never healthy (SURFACE_COMMAND_READMODEL_MATRIX.json rule);
 * - routing and credentials never carry authority
 *   (PRODUCT_SURFACE_ARCHITECTURE.md invariant);
 * - only masked metadata and Secret Vault references leave this module
 *   (docs/uix-w4/W7_IMPLEMENTATION_HANDOFF.md);
 * - a simulated or not-configured record is never projected as live.
 */

const PROVIDER_HEALTH = Object.freeze([
  'UNKNOWN', 'HEALTHY', 'DEGRADED', 'RATE_LIMITED', 'QUOTA_EXHAUSTED',
  'AUTH_FAILED', 'UNREACHABLE', 'DISABLED'
]);

// assignment_state from provider_instance.model_registry in the frozen
// architecture document. GATEWAY_EXPOSED is the only exposure state.
const MODEL_ASSIGNMENT_STATES = Object.freeze([
  'AVAILABLE', 'DISCOVERED', 'ASSIGNABLE', 'ASSIGNED', 'GATEWAY_EXPOSED', 'HEALTHY'
]);

const KEY_STATES = Object.freeze(['ENABLED', 'DISABLED', 'REVOKED', 'EXPIRED']);
const QUOTA_STATES = Object.freeze(['UNKNOWN', 'AVAILABLE', 'EXHAUSTED', 'UNLIMITED']);
const ROUTING_STRATEGIES = Object.freeze([
  'round_robin', 'weighted', 'health_aware', 'quota_aware',
  'failure_fallback', 'rate_limit_fallback', 'endpoint_fallback', 'key_fallback'
]);

const LOGICAL_ALIASES = Object.freeze([
  'damar-general', 'damar-fast', 'damar-reasoning', 'damar-code', 'damar-vision'
]);

// Canonical W1 provider records, preserved verbatim per W7 handoff.
const W1_PROVIDER_RECORDS = Object.freeze([
  { id: 'openrouter', current_state: 'PARTIAL' },
  { id: 'provider-federation', current_state: 'CURRENT_RECORD' },
  { id: 'connectors', current_state: 'CURRENT_RECORD' },
  { id: 'mata-dewa', current_state: 'CURRENT_RECORD' },
  { id: 'llamacpp', current_state: 'PARTIAL' }
]);

// A record is live only when its source says so. Anything else is evidence
// about a capability that does not exist yet in this deployment.
const SIMULATION_MARKERS = Object.freeze(['SIMULATED', 'MOCK_ONLY', 'SANDBOX', 'MOCK', 'SIMULATED_SANDBOX']);

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function healthOf(value) { return oneOf(value, PROVIDER_HEALTH, 'UNKNOWN'); }

function text(value, limit = 200) {
  return typeof value === 'string' && value.trim() !== '' ? value.slice(0, limit) : null;
}

/** True when a status token means "not really running here". */
function isSimulationMarker(value) {
  return typeof value === 'string' && SIMULATION_MARKERS.includes(value.toUpperCase());
}

/**
 * Masked credential projection. The raw value is never read back: only
 * presence, the shape and the non-secret id survive. A `vault:` reference
 * is not a secret and is carried through so the UI can show where the
 * secret lives without ever showing the secret.
 */
function maskSecret(value) {
  if (value === undefined || value === null || value === '') return Object.freeze({ present: false, masked: null, vaultRef: null });
  if (typeof value === 'string') {
    return /^vault:/i.test(value)
      ? Object.freeze({ present: true, masked: 'vault:****', vaultRef: value })
      : Object.freeze({ present: true, masked: '****', vaultRef: null });
  }
  const vaultRef = text(value.secret_vault_ref ?? value.vaultRef, 300);
  return Object.freeze({ present: true, masked: vaultRef ? 'vault:****' : '****', vaultRef });
}

function providerProjection(record = {}) {
  const instanceId = text(record.provider_instance_id ?? record.providerInstanceId, 128);
  const providerType = text(record.provider_type ?? record.providerType, 128);
  const simulated = isSimulationMarker(record.state ?? record.status);
  const keys = (Array.isArray(record.keys) ? record.keys : []).map((key) => gatewayKeyProjection(key));
  return Object.freeze({
    entityType: 'provider',
    providerType,
    providerInstanceId: instanceId,
    endpoint: text(record.endpoint, 300),
    accountReference: text(record.account_reference ?? record.accountReference, 128),
    enabled: record.enabled !== false && !simulated,
    health: simulated ? 'UNKNOWN' : healthOf(record.health),
    lastFailure: text(record.last_failure ?? record.lastFailure, 300),
    routingWeight: Number.isFinite(record.routing_weight) ? record.routing_weight : null,
    priority: Number.isInteger(record.priority) ? record.priority : null,
    keys,
    // Routing and credential state is evidence about selection, never authority.
    authorityRelevance: 'none',
    simulation: simulated ? 'SIMULATED' : null,
    source: 'provider_health_projection',
    freshness: record.freshness ?? 'UNKNOWN'
  });
}

function modelProjection(record = {}) {
  const simulated = isSimulationMarker(record.status ?? record.state);
  return Object.freeze({
    entityType: 'model',
    modelId: text(record.model_id ?? record.modelId, 128),
    providerInstanceId: text(record.provider_instance_id ?? record.providerInstanceId, 128),
    upstreamModelId: text(record.upstream_model_id ?? record.upstreamModelId, 256),
    capabilities: Array.isArray(record.capabilities) ? record.capabilities.map((c) => text(c, 64)).filter(Boolean) : [],
    contextLength: Number.isFinite(record.context_length) ? record.context_length : null,
    modality: Array.isArray(record.modality) ? record.modality.map((m) => text(m, 64)).filter(Boolean) : [],
    roleSuitability: Array.isArray(record.role_suitability) ? record.role_suitability.map((r) => text(r, 64)).filter(Boolean) : [],
    alias: oneOf(record.alias ?? record.logical_alias, LOGICAL_ALIASES, null),
    // A simulated record is at most DISCOVERED: MODEL_ASSIGNMENT_STATES has no
    // UNKNOWN member, and DISCOVERED is the only state that does not claim the
    // model can be assigned, exposed or healthy.
    assignmentState: simulated ? 'DISCOVERED' : oneOf(record.assignment_state ?? record.assignmentState, MODEL_ASSIGNMENT_STATES, 'DISCOVERED'),
    health: simulated ? 'UNKNOWN' : healthOf(record.health),
    costMetadata: record.cost_metadata ?? record.costMetadata ?? null,
    exposure: record.assignment_state === 'GATEWAY_EXPOSED' && !simulated,
    authorityRelevance: 'none',
    simulation: simulated ? 'SIMULATED' : null,
    source: 'model_registry_projection',
    freshness: record.freshness ?? 'UNKNOWN'
  });
}

/**
 * Gateway key metadata. Non-secret fields only: id, state, quota, expiry,
 * network restrictions and usage counters. `secret_exposure: never return
 * after creation` from the frozen multi_key contract.
 */
function gatewayKeyProjection(record = {}) {
  const keyId = text(record.key_id ?? record.keyId, 128);
  const secret = maskSecret(record.secret_vault_ref ?? record.secretVaultRef ?? record.secret);
  return Object.freeze({
    entityType: 'gateway_key',
    keyId,
    vaultRef: secret.vaultRef,
    secretExposure: 'never_returned',
    state: oneOf(record.state, KEY_STATES, 'DISABLED'),
    enabled: record.enabled === true,
    quotaState: oneOf(record.quota_state ?? record.quotaState, QUOTA_STATES, 'UNKNOWN'),
    health: healthOf(record.health),
    rateLimitState: record.rate_limit_state ?? record.rateLimitState ?? null,
    expiresAt: text(record.expires_at ?? record.expiresAt, 64),
    networkRestrictions: Array.isArray(record.network_restrictions) ? record.network_restrictions.map((n) => text(n, 64)).filter(Boolean) : [],
    allowedModels: Array.isArray(record.allowed_models) ? record.allowed_models.map((m) => text(m, 128)).filter(Boolean) : [],
    allowedAliases: Array.isArray(record.allowed_aliases) ? record.allowed_aliases.map((a) => text(a, 64)).filter(Boolean) : [],
    usageAccounting: record.usage_accounting ?? record.usageAccounting ?? null,
    rotation: text(record.rotation, 64),
    authorityRelevance: 'authentication/quota only',
    source: 'key_metadata_projection',
    freshness: record.freshness ?? 'UNKNOWN'
  });
}

/**
 * Routing evidence. The W7 visual handoff requires fallback and
 * quota/rate/auth/network reasons to be shown as routing evidence, never
 * authority. `routing_authority_boundary` is therefore a fixed label.
 */
function routingEvidenceProjection(record = {}) {
  const reasons = Array.isArray(record.reasons) ? record.reasons : [];
  return Object.freeze({
    entityType: 'routing_evidence',
    requestedRole: text(record.requested_role ?? record.requestedRole, 64),
    requestedAlias: oneOf(record.requested_alias ?? record.requestedAlias, LOGICAL_ALIASES, null),
    strategy: oneOf(record.strategy, ROUTING_STRATEGIES, null),
    // Present only when a strategy actually exists; absence stays visible.
    chain: Array.isArray(record.chain) ? record.chain.map((c) => text(typeof c === 'string' ? c : c.id, 128)).filter(Boolean) : [],
    selected: text(record.selected, 128),
    reasons: reasons.map((r) => text(r, 200)).filter(Boolean),
    routingAuthorityBoundary: 'routing choice is never action authority',
    authorityRelevance: 'none',
    source: 'provider_health_projection',
    freshness: record.freshness ?? 'UNKNOWN'
  });
}

module.exports = {
  PROVIDER_HEALTH, MODEL_ASSIGNMENT_STATES, KEY_STATES, QUOTA_STATES,
  ROUTING_STRATEGIES, LOGICAL_ALIASES, W1_PROVIDER_RECORDS, SIMULATION_MARKERS,
  providerProjection, modelProjection, gatewayKeyProjection,
  routingEvidenceProjection, maskSecret, isSimulationMarker, healthOf
};
