"use strict";

const { BusError } = require("./errors");

const DEFAULT_BOUNDS = Object.freeze({
  maxSessions: 256,
  maxPendingInteractions: 1024,
  maxPendingPerSession: 32,
  maxInFlightPerSession: 8,
  maxStreamBufferEvents: 256,
  maxPayloadBytes: 32768,
  maxTextChars: 4096,
  maxMetadataBytes: 2048,
  maxMetadataKeys: 32,
  maxContextRefs: 16,
  maxAuthEvidenceRefs: 8,
  maxAttachments: 8,
  maxAttachmentAggregateBytes: 50 * 1024 * 1024,
  maxCommandArgs: 16,
  maxClaimedFields: 8,
  maxSessionHistory: 64,
  maxDiagnostics: 100,
  maxDedupeLedger: 4096,
  interactionTTLms: 300000,
  sessionIdleTTLms: 3600000
});

const BOUND_KEYS = Object.freeze(Object.keys(DEFAULT_BOUNDS));

function resolveBounds(overrides) {
  const merged = Object.assign({}, DEFAULT_BOUNDS, overrides || {});
  for (const key of BOUND_KEYS) {
    const value = merged[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BusError("INVALID_BOUNDS", `bound ${key} must be a positive safe integer`, {
        bound: key,
        value
      });
    }
  }
  return Object.freeze(merged);
}

module.exports = { DEFAULT_BOUNDS, BOUND_KEYS, resolveBounds };
