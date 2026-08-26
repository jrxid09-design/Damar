"use strict";

const { BusError } = require("./errors");
const { assertCanonicalId } = require("./ids");
const { assertEnum, ORIGIN_SET } = require("./enums");
const { isPlainObject, validateBoundedRecord } = require("./payloads");

const CAPABILITY_NAMES = Object.freeze([
  "acceptsText",
  "acceptsCommands",
  "supportsStreaming",
  "supportsCancellation",
  "supportsApprovalResponses",
  "supportsBinaryAttachments",
  "supportsVoiceHints",
  "acceptsAuthEvidence",
  "acceptsEvents"
]);

const DEFAULT_CAPABILITIES = Object.freeze({
  acceptsText: false,
  acceptsCommands: false,
  supportsStreaming: false,
  supportsCancellation: false,
  supportsApprovalResponses: false,
  supportsBinaryAttachments: false,
  supportsVoiceHints: false,
  acceptsAuthEvidence: false,
  acceptsEvents: false
});

const KIND_CAPABILITY_REQUIREMENTS = Object.freeze({
  MESSAGE: ["acceptsText"],
  CONTEXT_REFERENCE: ["acceptsText"],
  COMMAND: ["acceptsCommands"],
  CANCEL_REQUEST: ["supportsCancellation"],
  APPROVAL_RESPONSE: ["supportsApprovalResponses"],
  AUTH_EVIDENCE: ["acceptsAuthEvidence"],
  STATUS_REQUEST: [],
  EVENT: ["acceptsEvents"]
});

function createTransportRegistry() {
  const transports = new Map();

  function register(descriptor) {
    if (!isPlainObject(descriptor)) {
      throw new BusError("TRANSPORT_INVALID", "transport descriptor must be a plain object");
    }
    const unknown = Object.keys(descriptor).filter(
      (k) => !["transportId", "origin", "capabilities", "metadata"].includes(k)
    );
    if (unknown.length > 0) {
      throw new BusError("TRANSPORT_FIELD_FORBIDDEN", "unknown transport descriptor fields", {
        fields: unknown
      });
    }
    const transportId = assertCanonicalId("transportId", descriptor.transportId);
    const origin = assertEnum(descriptor.origin, ORIGIN_SET, "origin");
    if (transports.has(transportId)) {
      throw new BusError("TRANSPORT_ALREADY_REGISTERED", "transport id already registered", {
        transportId
      });
    }
    let capabilities = { ...DEFAULT_CAPABILITIES };
    if (descriptor.capabilities !== undefined) {
      if (!isPlainObject(descriptor.capabilities)) {
        throw new BusError("TRANSPORT_INVALID", "capabilities must be a plain object");
      }
      const caps = descriptor.capabilities;
      for (const key of Object.keys(caps)) {
        if (!CAPABILITY_NAMES.includes(key)) {
          throw new BusError("TRANSPORT_FIELD_FORBIDDEN", "unknown capability", { field: key });
        }
        if (typeof caps[key] !== "boolean") {
          throw new BusError("TRANSPORT_INVALID", "capability values must be booleans", { field: key });
        }
        capabilities[key] = caps[key];
      }
    }
    capabilities = Object.freeze(capabilities);
    const metadata =
      validateBoundedRecord(descriptor, "metadata", { maxClaimedFields: 8, maxMetadataBytes: 2048 }, "transport") ||
      {};
    const record = Object.freeze({
      transportId,
      origin,
      capabilities,
      metadata: Object.freeze(metadata),
      registeredAt: null
    });
    transports.set(transportId, record);
    return record;
  }

  function get(transportId) {
    return transports.get(transportId) || null;
  }

  function requireRegistered(transportId) {
    const record = transports.get(transportId);
    if (!record) {
      throw new BusError("TRANSPORT_NOT_REGISTERED", "transport is not registered", { transportId });
    }
    return record;
  }

  function checkKindAllowed(transportId, kind) {
    const record = requireRegistered(transportId);
    const required = KIND_CAPABILITY_REQUIREMENTS[kind];
    if (required === undefined) {
      throw new BusError("CAPABILITY_VIOLATION", `kind ${kind} is not emittable by transports`, {
        kind
      });
    }
    const missing = required.filter((cap) => !record.capabilities[cap]);
    if (missing.length > 0) {
      throw new BusError("CAPABILITY_VIOLATION", "kind outside registered transport contract", {
        transportId,
        kind,
        missingCapabilities: missing
      });
    }
    return record;
  }

  function snapshot() {
    return Object.freeze([...transports.values()]);
  }

  return Object.freeze({ register, get, requireRegistered, checkKindAllowed, snapshot, size: () => transports.size });
}

module.exports = {
  createTransportRegistry,
  CAPABILITY_NAMES,
  DEFAULT_CAPABILITIES,
  KIND_CAPABILITY_REQUIREMENTS
};
