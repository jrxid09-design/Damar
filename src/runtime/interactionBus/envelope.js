"use strict";

const crypto = require("node:crypto");
const { BusError } = require("./errors");
const { assertCanonicalId } = require("./ids");
const { assertEnum, ORIGIN_SET, KIND_SET } = require("./enums");
const {
  canonicalize,
  byteLength,
  isPlainObject,
  validatePayload,
  validateContextRef,
  validateAuthEvidence,
  validateBoundedRecord
} = require("./payloads");

const ENVELOPE_SCHEMA_VERSION = 1;

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function resolveDeadline(rawDeadline, now) {
  if (rawDeadline === undefined || rawDeadline === null) return null;
  let ms;
  if (typeof rawDeadline === "number") {
    if (!Number.isSafeInteger(rawDeadline) || rawDeadline <= 0) {
      throw new BusError("INVALID_DEADLINE", "deadline must be a positive epoch-ms integer or ISO-8601 string");
    }
    ms = rawDeadline;
  } else if (typeof rawDeadline === "string") {
    const parsed = Date.parse(rawDeadline);
    if (!Number.isFinite(parsed)) {
      throw new BusError("INVALID_DEADLINE", "deadline string is not parseable as a date");
    }
    ms = parsed;
  } else {
    throw new BusError("INVALID_DEADLINE", "deadline must be epoch-ms number or ISO-8601 string");
  }
  return Object.freeze({ at: ms, expiredAtReceipt: ms <= now });
}

const ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion",
  "interactionId",
  "sessionId",
  "turnId",
  "correlationId",
  "origin",
  "kind",
  "receivedAt",
  "payload",
  "contextRefs",
  "authEvidenceRefs",
  "metadata",
  "deadline",
  "generation",
  "provenance"
]);

function buildEnvelope(spec, bounds) {
  // The envelope former is also directly exported for deterministic tests and
  // local composition. Reject an accessor/Proxy-bearing spec before reading
  // even the timestamp or provenance fields.
  if (!isPlainObject(spec)) {
    throw new BusError("ENVELOPE_INPUT_INVALID", "envelope spec must be an accessor-free plain object");
  }
  const now = spec.receivedAt;
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new BusError("INVALID_TIME", "receivedAt must be a positive epoch-ms integer");
  }

  const interactionId = assertCanonicalId("interactionId", spec.interactionId);
  const sessionId = assertCanonicalId("sessionId", spec.sessionId);
  const origin = assertEnum(spec.origin, ORIGIN_SET, "origin");
  const kind = assertEnum(spec.kind, KIND_SET, "kind");

  let turnId = null;
  if (spec.turnId !== undefined && spec.turnId !== null) {
    turnId = assertCanonicalId("turnId", spec.turnId);
  }
  let correlationId = null;
  if (spec.correlationId !== undefined && spec.correlationId !== null) {
    correlationId = assertCanonicalId("correlationId", spec.correlationId);
  }
  let generation = null;
  if (spec.generation !== undefined && spec.generation !== null) {
    generation = assertCanonicalId("runtimeGenerationId", spec.generation);
  }

  const payload = validatePayload(kind, spec.payload, bounds);

  let contextRefs = [];
  if (spec.contextRefs !== undefined) {
    if (!Array.isArray(spec.contextRefs) || spec.contextRefs.length > bounds.maxContextRefs) {
      throw new BusError("BOUNDS_EXCEEDED", "too many contextRefs", { field: "contextRefs" });
    }
    contextRefs = Object.freeze(spec.contextRefs.map(validateContextRef));
  }

  let authEvidenceRefs = [];
  if (spec.authEvidenceRefs !== undefined) {
    if (
      !Array.isArray(spec.authEvidenceRefs) ||
      spec.authEvidenceRefs.length > bounds.maxAuthEvidenceRefs
    ) {
      throw new BusError("BOUNDS_EXCEEDED", "too many authEvidenceRefs", {
        field: "authEvidenceRefs"
      });
    }
    authEvidenceRefs = Object.freeze(spec.authEvidenceRefs.map(validateAuthEvidence));
  }

  const metadata = validateBoundedRecord(spec, "metadata", bounds, "envelope") || {};

  const deadline = resolveDeadline(spec.deadline, now);

  const provenanceSpec = spec.provenance;
  if (!isPlainObject(provenanceSpec)) {
    throw new BusError("PROVENANCE_REQUIRED", "envelope requires core-derived provenance");
  }
  const transportId = assertCanonicalId("transportId", provenanceSpec.transportId);
  const provenanceOrigin = assertEnum(provenanceSpec.origin, ORIGIN_SET, "origin");
  if (provenanceOrigin !== origin) {
    throw new BusError("ORIGIN_PROVENANCE_MISMATCH", "envelope origin must equal registered transport origin");
  }
  const claimedIdentity =
    validateBoundedRecord(provenanceSpec, "claimedIdentity", bounds, "provenance") || {};
  const claimedMetadata =
    validateBoundedRecord(provenanceSpec, "claimedMetadata", bounds, "provenance") || {};

  const envelope = deepFreeze({
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    interactionId,
    sessionId,
    turnId,
    correlationId,
    origin,
    kind,
    receivedAt: now,
    payload,
    contextRefs,
    authEvidenceRefs,
    metadata,
    deadline,
    generation,
    provenance: deepFreeze({
      transportId,
      origin: provenanceOrigin,
      claimedIdentity,
      claimedMetadata
    })
  });

  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_FIELDS.includes(key)) {
      throw new BusError("ENVELOPE_FIELD_FORBIDDEN", `unknown envelope field ${key}`);
    }
  }
  return envelope;
}

function interactionDigest(envelope) {
  const basis = canonicalize({
    interactionId: envelope.interactionId,
    sessionId: envelope.sessionId,
    kind: envelope.kind,
    payload: envelope.payload
  });
  return crypto.createHash("sha256").update(basis).digest("hex");
}

module.exports = {
  ENVELOPE_SCHEMA_VERSION,
  ENVELOPE_FIELDS,
  buildEnvelope,
  deepFreeze,
  interactionDigest,
  canonicalize
};
