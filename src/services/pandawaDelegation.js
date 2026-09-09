"use strict";

const crypto = require("node:crypto");
const identity = require("./pandawaIdentity");

const issued = new WeakSet();
// F-04: canonical consumption ledger — replay protection is keyed by the
// immutable delegationId inside this module, NOT by caller-supplied fields.
//
// RC-02 bounded replay lifecycle (fail-closed after saturation):
//
//   1. Every issuance carries a bounded validity: generation (epoch at
//      creation) + expiresAt (creation + DELEGATION_TTL_MS). A delegation
//      outside its validity is rejected as STALE/EXPIRED — never accepted
//      merely because its tombstone happens to be absent.
//   2. Tombstones are keyed by delegationId and store the issuance expiry.
//      They are only pruned when the corresponding issuance is already
//      logically impossible to reuse (expired). CONSUMED != REUSABLE.
//   3. If the ledger saturates with still-valid tombstones, the epoch is
//      rotated: every outstanding issuance of the previous generation is
//      invalidated (STALE), which is exactly what makes forgetting their
//      tombstones safe. Bounded: the ledger never exceeds CONSUMED_LEDGER_BOUND.
//   4. No unbounded Set/Map exists in this module.
const CONSUMED_LEDGER_BOUND = 4096;
const DELEGATION_TTL_MS = boundTtlMs(Number(process.env.PANDAWA_DELEGATION_TTL_MS ?? 1800000));
const consumed = new Map();
const MAX_TEXT = 4096;
const MAX_REFS = 32;
let epoch = 1;

function boundTtlMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1800000;
  return Math.min(86400000, Math.max(1000, Math.round(n)));
}

function text(value, name) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT) throw new TypeError(`${name}_INVALID`);
  return value.trim();
}

function currentEpoch() { return epoch; }

function ledgerSize() { return consumed.size; }

function createDelegation({ fromEntity, toEntity, sourceSession, targetSession = null, objective, reason, contextRefs = [], requestedCapabilities = [] } = {}) {
  const from = identity.resolve(fromEntity);
  const to = identity.resolve(toEntity);
  if (!from || !to || from.id === to.id || from.id === "pandawa:colony" || to.id === "pandawa:colony") throw new TypeError("PANDAWA_DELEGATION_ENTITY_INVALID");
  if (!Array.isArray(contextRefs) || contextRefs.length > MAX_REFS || !contextRefs.every(ref => typeof ref === "string" && ref.length <= 256)) throw new TypeError("PANDAWA_HANDOFF_CONTEXT_INVALID");
  if (!Array.isArray(requestedCapabilities) || requestedCapabilities.length > MAX_REFS || !requestedCapabilities.every(cap => typeof cap === "string" && cap.length <= 128)) throw new TypeError("PANDAWA_REQUESTED_CAPABILITIES_INVALID");
  const createdAt = Date.now();
  const delegation = Object.freeze({
    delegationId: `pdl_${crypto.randomUUID().replaceAll("-", "")}`,
    fromEntity: from.id, toEntity: to.id, sourceSession: text(sourceSession, "SOURCE_SESSION"),
    targetSession: targetSession === null ? null : text(targetSession, "TARGET_SESSION"),
    objective: text(objective, "OBJECTIVE"), reason: text(reason, "REASON"),
    boundedContextRefs: Object.freeze([...contextRefs]), requestedCapabilities: Object.freeze([...requestedCapabilities]),
    createdAt,
    expiresAt: createdAt + DELEGATION_TTL_MS,
    generation: epoch,
    state: "ISSUED"
  });
  issued.add(delegation);
  return delegation;
}

// RC-02: prune ONLY tombstones whose issuance has expired — replaying such
// a delegation is already rejected by the expiry check, so forgetting the
// tombstone cannot resurrect it. Never prune a still-valid consumption.
function pruneExpiredTombstones(now) {
  for (const [key, entry] of consumed) if (entry.expiresAt <= now) consumed.delete(key);
}

function acceptDelegation(delegation, { receiver, sessionId, now = Date.now() } = {}) {
  if (!delegation || typeof delegation !== "object" || !issued.has(delegation)) throw new TypeError("PANDAWA_DELEGATION_UNTRUSTED");
  if (delegation.generation !== epoch) throw new TypeError("PANDAWA_DELEGATION_STALE");
  if (typeof delegation.expiresAt !== "number" || now > delegation.expiresAt) throw new TypeError("PANDAWA_DELEGATION_EXPIRED");
  const target = identity.resolve(receiver);
  if (!target || target.id !== delegation.toEntity || sessionId !== delegation.targetSession) throw new TypeError("PANDAWA_DELEGATION_TARGET_INVALID");
  if (delegation.state !== "ISSUED") throw new TypeError("PANDAWA_DELEGATION_ALREADY_CONSUMED");
  if (consumed.has(delegation.delegationId)) throw new TypeError("PANDAWA_DELEGATION_ALREADY_CONSUMED");
  if (consumed.size >= CONSUMED_LEDGER_BOUND) {
    pruneExpiredTombstones(now);
    if (consumed.size >= CONSUMED_LEDGER_BOUND) {
      // Saturation with still-valid tombstones: rotate the epoch. Every
      // outstanding issuance of the previous generation becomes STALE
      // (fail-closed), which is what makes evicting their tombstones safe.
      // Bounded, deterministic, and crash-free — no counter mutation.
      epoch++;
      consumed.clear();
    }
  }
  consumed.set(delegation.delegationId, { consumedAt: now, expiresAt: delegation.expiresAt, generation: delegation.generation, receiver: target.id, sessionId });
  return Object.freeze({ ...delegation, state: "ACCEPTED", acceptedAt: now });
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

function consumption(delegationId) { return consumed.get(String(delegationId)) ?? null; }

module.exports = Object.freeze({
  createDelegation, acceptDelegation, projectHandoff, consumption,
  isIssued: value => issued.has(value),
  ledgerSize, currentEpoch,
  CONSUMED_LEDGER_BOUND,
  DELEGATION_TTL_MS
});
