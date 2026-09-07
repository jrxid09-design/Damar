"use strict";

const identity = require("../../services/pandawaIdentity");

const STATES = new Set(["OFFLINE", "IDLE", "LISTENING", "THINKING", "WORKING", "WAITING", "BLOCKED", "DELEGATING", "REVIEWING"]);
const MAX_REFS = 32;

function createPandawaSessionRegistry({ now = () => Date.now(), maxSessions = 256 } = {}) {
  const sessions = new Map();

  function boundedRefs(refs) {
    if (refs === undefined) return Object.freeze([]);
    if (!Array.isArray(refs) || refs.length > MAX_REFS) throw new TypeError("PANDAWA_CONTEXT_REFS_INVALID");
    return Object.freeze(refs.map(ref => {
      if (typeof ref !== "string" || ref.length === 0 || ref.length > 256) throw new TypeError("PANDAWA_CONTEXT_REF_INVALID");
      return ref;
    }));
  }

  function create({ sessionId, targetEntity, ownerUserId, parentDamarSessionId = null, surface, channel, memoryNamespace, contextRefs = [], authorityContextRef = null } = {}) {
    const target = identity.resolve(targetEntity);
    if (!target || target.id === "pandawa:colony") throw new TypeError("PANDAWA_TARGET_INVALID");
    if (typeof sessionId !== "string" || !/^ses_[A-Za-z0-9_-]{1,120}$/.test(sessionId)) throw new TypeError("PANDAWA_SESSION_ID_INVALID");
    if (sessions.has(sessionId)) throw new TypeError("PANDAWA_SESSION_EXISTS");
    if (sessions.size >= maxSessions) throw new TypeError("PANDAWA_SESSION_LIMIT");
    if (typeof ownerUserId !== "string" || ownerUserId.length === 0 || ownerUserId.length > 128) throw new TypeError("PANDAWA_OWNER_INVALID");
    const at = now();
    const record = Object.freeze({
      sessionId, targetEntity: target.id, ownerUserId, parentDamarSessionId,
      surface: typeof surface === "string" ? surface.slice(0, 64) : null,
      channel: typeof channel === "string" ? channel.slice(0, 64) : null,
      state: "IDLE", activeTaskId: null, contextRefs: boundedRefs(contextRefs),
      memoryNamespace: memoryNamespace || target.id, authorityContextRef: null,
      createdAt: at, lastActiveAt: at, generation: 1
    });
    sessions.set(sessionId, record);
    return record;
  }

  function get(sessionId) { return sessions.get(sessionId) || null; }

  function resume(sessionId, { ownerUserId, targetEntity, nowMs = now() } = {}) {
    const current = get(sessionId);
    if (!current || current.ownerUserId !== ownerUserId) throw new TypeError("PANDAWA_SESSION_RESUME_DENIED");
    const target = identity.resolve(targetEntity);
    if (target && target.id !== current.targetEntity) throw new TypeError("PANDAWA_TARGET_MISMATCH");
    const next = Object.freeze({ ...current, lastActiveAt: nowMs, generation: current.generation + 1, authorityContextRef: null, state: "IDLE" });
    sessions.set(sessionId, next);
    return next;
  }

  function update(sessionId, patch = {}) {
    const current = get(sessionId);
    if (!current) throw new TypeError("PANDAWA_SESSION_NOT_FOUND");
    if (patch.state !== undefined && !STATES.has(patch.state)) throw new TypeError("PANDAWA_STATE_INVALID");
    const next = Object.freeze({ ...current, ...patch, sessionId: current.sessionId, targetEntity: current.targetEntity, lastActiveAt: now(), authorityContextRef: null });
    sessions.set(sessionId, next);
    return next;
  }

  return Object.freeze({ create, get, resume, update, size: () => sessions.size, snapshot: () => Object.freeze([...sessions.values()]) });
}

module.exports = { createPandawaSessionRegistry, STATES };
