"use strict";

const { BusError } = require("./errors");
const { assertCanonicalId } = require("./ids");
const { assertEnum, ORIGIN_SET } = require("./enums");

function createSessionRegistry(bounds) {
  const sessions = new Map();
  const order = [];

  function ensure(sessionId, origin, transportId, now) {
    assertCanonicalId("sessionId", sessionId);
    assertEnum(origin, ORIGIN_SET, "origin");
    assertCanonicalId("transportId", transportId);
    const existing = sessions.get(sessionId);
    if (existing) {
      if (existing.transportId !== transportId || existing.origin !== origin) {
        throw new BusError("SESSION_TRANSPORT_MISMATCH", "session is bound to a different transport identity", {
          sessionId,
          boundTransportId: existing.transportId,
          requestedTransportId: transportId
        });
      }
      existing.lastActivityAt = now;
      if (existing.state === "DETACHED") {
        existing.state = "ACTIVE";
      }
      return existing;
    }
    if (sessions.size >= bounds.maxSessions) {
      throw new BusError("SESSION_LIMIT_EXCEEDED", "session registry is full", {
        maxSessions: bounds.maxSessions
      });
    }
    const record = {
      sessionId,
      origin,
      transportId,
      createdAt: now,
      lastActivityAt: now,
      generation: null,
      state: "ACTIVE",
      queue: [],
      inflightCount: 0,
      recentInteractionIds: []
    };
    sessions.set(sessionId, record);
    order.push(sessionId);
    return record;
  }

  function get(sessionId) {
    return sessions.get(sessionId) || null;
  }

  function requireOwned(sessionId, transportId) {
    const record = sessions.get(sessionId);
    if (!record || record.transportId !== transportId) return null;
    return record;
  }

  function touch(sessionId, now) {
    const record = sessions.get(sessionId);
    if (record) record.lastActivityAt = now;
  }

  function rememberInteraction(sessionId, interactionId) {
    const record = sessions.get(sessionId);
    if (!record) return;
    record.recentInteractionIds.push(interactionId);
    while (record.recentInteractionIds.length > bounds.maxSessionHistory) {
      record.recentInteractionIds.shift();
    }
  }

  function detachTransport(transportId, now) {
    const detached = [];
    for (const record of sessions.values()) {
      if (record.transportId === transportId && record.state === "ACTIVE") {
        record.state = "DETACHED";
        record.lastActivityAt = now;
        detached.push(record.sessionId);
      }
    }
    return detached;
  }

  function sweepIdle(now) {
    const expired = [];
    for (const [sessionId, record] of sessions.entries()) {
      if (now - record.lastActivityAt > bounds.sessionIdleTTLms) {
        record.state = "CLOSED_IDLE";
        sessions.delete(sessionId);
        const idx = order.indexOf(sessionId);
        if (idx >= 0) order.splice(idx, 1);
        expired.push(record);
      }
    }
    return expired;
  }

  function remove(sessionId) {
    sessions.delete(sessionId);
    const idx = order.indexOf(sessionId);
    if (idx >= 0) order.splice(idx, 1);
  }

  function snapshot() {
    const list = [];
    for (const record of sessions.values()) {
      list.push(
        Object.freeze({
          sessionId: record.sessionId,
          origin: record.origin,
          transportId: record.transportId,
          createdAt: record.createdAt,
          lastActivityAt: record.lastActivityAt,
          state: record.state,
          queueDepth: record.queue.length,
          inflight: record.inflightCount
        })
      );
    }
    return Object.freeze(list);
  }

  return Object.freeze({
    ensure,
    get,
    requireOwned,
    touch,
    rememberInteraction,
    detachTransport,
    sweepIdle,
    remove,
    snapshot,
    size: () => sessions.size,
    orderSnapshot: () => Object.freeze([...order])
  });
}

module.exports = { createSessionRegistry };
