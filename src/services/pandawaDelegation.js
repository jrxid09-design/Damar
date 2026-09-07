"use strict";

const crypto = require("node:crypto");
const identity = require("./pandawaIdentity");

const issued = new WeakSet();
const MAX_TEXT = 4096;
const MAX_REFS = 32;

function text(value, name) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT) throw new TypeError(`${name}_INVALID`);
  return value.trim();
}

function createDelegation({ fromEntity, toEntity, sourceSession, targetSession = null, objective, reason, contextRefs = [], requestedCapabilities = [] } = {}) {
  const from = identity.resolve(fromEntity);
  const to = identity.resolve(toEntity);
  if (!from || !to || from.id === to.id || from.id === "pandawa:colony" || to.id === "pandawa:colony") throw new TypeError("PANDAWA_DELEGATION_ENTITY_INVALID");
  if (!Array.isArray(contextRefs) || contextRefs.length > MAX_REFS || !contextRefs.every(ref => typeof ref === "string" && ref.length <= 256)) throw new TypeError("PANDAWA_HANDOFF_CONTEXT_INVALID");
  if (!Array.isArray(requestedCapabilities) || requestedCapabilities.length > MAX_REFS || !requestedCapabilities.every(cap => typeof cap === "string" && cap.length <= 128)) throw new TypeError("PANDAWA_REQUESTED_CAPABILITIES_INVALID");
  const delegation = Object.freeze({
    delegationId: `pdl_${crypto.randomUUID().replaceAll("-", "")}`,
    fromEntity: from.id, toEntity: to.id, sourceSession: text(sourceSession, "SOURCE_SESSION"),
    targetSession: targetSession === null ? null : text(targetSession, "TARGET_SESSION"),
    objective: text(objective, "OBJECTIVE"), reason: text(reason, "REASON"),
    boundedContextRefs: Object.freeze([...contextRefs]), requestedCapabilities: Object.freeze([...requestedCapabilities]),
    createdAt: Date.now(), state: "ISSUED"
  });
  issued.add(delegation);
  return delegation;
}

function acceptDelegation(delegation, { receiver, sessionId } = {}) {
  if (!delegation || typeof delegation !== "object" || !issued.has(delegation)) throw new TypeError("PANDAWA_DELEGATION_UNTRUSTED");
  const target = identity.resolve(receiver);
  if (!target || target.id !== delegation.toEntity || sessionId !== delegation.targetSession) throw new TypeError("PANDAWA_DELEGATION_TARGET_INVALID");
  return Object.freeze({ ...delegation, state: "ACCEPTED", acceptedAt: Date.now() });
}

function projectHandoff(delegation, { receiver, sessionId } = {}) {
  const accepted = acceptDelegation(delegation, { receiver, sessionId });
  return Object.freeze({
    delegationId: accepted.delegationId, fromEntity: accepted.fromEntity, toEntity: accepted.toEntity,
    sourceSession: accepted.sourceSession, targetSession: accepted.targetSession, objective: accepted.objective,
    reason: accepted.reason, contextRefs: accepted.boundedContextRefs, createdAt: accepted.createdAt,
    provenance: Object.freeze({ kind: "pandawa-handoff", delegationId: accepted.delegationId })
  });
}

module.exports = Object.freeze({ createDelegation, acceptDelegation, projectHandoff, isIssued: value => issued.has(value) });
