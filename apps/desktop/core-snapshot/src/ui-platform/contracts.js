'use strict';

const DENSITIES = Object.freeze(['NORMAL', 'POWER', 'FORENSIC']);
const FEATURE_CLASSES = Object.freeze([
  'CURRENT_IMPLEMENTED', 'CURRENT_PARTIAL', 'CURRENT_INTERNAL',
  'DESIGNED_FOR_IMPLEMENTATION', 'FUTURE_CAPABILITY_DEPENDENT'
]);
const COMMAND_KINDS = Object.freeze([
  'READ', 'NONCONSEQUENTIAL_COMMAND', 'CONSEQUENTIAL_COMMAND',
  'APPROVAL_DECISION', 'CONFIGURATION', 'ADMINISTRATION', 'FORENSIC'
]);

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function assertOneOf(value, values, field) {
  if (!values.includes(value)) throw new TypeError(`${field} must be one of ${values.join(', ')}`);
  return value;
}

function normalizeFreshness(value) {
  return assertOneOf(value ?? 'UNKNOWN', ['LIVE', 'EVENTUAL', 'STALE', 'UNKNOWN'], 'freshness');
}

function normalizeReadModel(record = {}) {
  return Object.freeze({
    data: record.data,
    status: assertOneOf(record.status ?? 'unknown', ['loading', 'ready', 'empty', 'stale', 'unknown', 'degraded', 'failed'], 'status'),
    freshness: normalizeFreshness(record.freshness),
    asOf: record.asOf ?? null,
    revision: record.revision ?? null,
    cursor: record.cursor ?? null,
    provenance: record.provenance ?? null,
    redaction: record.redaction ?? null,
    requestId: record.requestId ?? null,
    error: record.error ?? null
  });
}

function assertDensity(value) { return assertOneOf(value, DENSITIES, 'density'); }
function assertFeatureClass(value) { return assertOneOf(value, FEATURE_CLASSES, 'current_future_classification'); }

function assertNoCanonicalOwnership(moduleRecord) {
  if (moduleRecord.state_ownership === 'canonical backend state') {
    throw new Error(`UI module ${moduleRecord.module_id} cannot own canonical backend state`);
  }
  return true;
}

module.exports = {
  DENSITIES, FEATURE_CLASSES, COMMAND_KINDS,
  requiredString, assertOneOf, assertDensity, assertFeatureClass,
  normalizeReadModel, assertNoCanonicalOwnership
};
