"use strict";

const { BusError } = require("./errors");
const { assertEnum, ROUTE_SET, KIND_SET } = require("./enums");

const KIND_TO_ROUTE = Object.freeze({
  MESSAGE: "CONVERSATION",
  CONTEXT_REFERENCE: "CONVERSATION",
  COMMAND: "COMMAND",
  APPROVAL_RESPONSE: "APPROVAL",
  STATUS_REQUEST: "STATUS",
  EVENT: "CONTROL",
  AUTH_EVIDENCE: "CONTROL"
});

function routeForKind(kind) {
  const route = KIND_TO_ROUTE[kind];
  if (!route) {
    throw new BusError("KIND_NOT_ROUTABLE", `kind ${kind} has no canonical route`, { kind });
  }
  return route;
}

function createHandlerRegistry(policy) {
  const resolvedPolicy = policy === undefined ? "reject" : policy;
  if (resolvedPolicy !== "reject" && resolvedPolicy !== "highest-priority") {
    throw new BusError("INVALID_POLICY", "handler ambiguity policy must be reject or highest-priority");
  }
  const byRoute = new Map();

  function register(reg) {
    if (!reg || typeof reg !== "object") {
      throw new BusError("HANDLER_INVALID", "handler registration must be an object");
    }
    const route = assertEnum(reg.route, ROUTE_SET, "route");
    if (typeof reg.handler !== "function") {
      throw new BusError("HANDLER_INVALID", "handler must be a function", { route });
    }
    const kinds = reg.supportedKinds;
    if (!Array.isArray(kinds) || kinds.length === 0) {
      throw new BusError("HANDLER_INVALID", "supportedKinds must be a non-empty array", { route });
    }
    for (const kind of kinds) {
      assertEnum(kind, KIND_SET, "kind");
      if (routeForKind(kind) !== route) {
        throw new BusError("HANDLER_ROUTE_MISMATCH", `kind ${kind} canonically routes elsewhere`, {
          kind,
          route
        });
      }
    }
    const priority = reg.priority === undefined ? 0 : reg.priority;
    if (!Number.isSafeInteger(priority)) {
      throw new BusError("HANDLER_INVALID", "priority must be a safe integer", { route });
    }
    const entry = Object.freeze({
      route,
      handler: reg.handler,
      priority,
      seq: registrationSequence++,
      supportedKinds: Object.freeze([...kinds])
    });
    let list = byRoute.get(route);
    if (!list) {
      list = [];
      byRoute.set(route, list);
    }
    for (const existing of list) {
      const overlap = existing.supportedKinds.filter((k) => entry.supportedKinds.includes(k));
      if (overlap.length > 0) {
        if (resolvedPolicy === "reject") {
          throw new BusError("HANDLER_AMBIGUOUS", "multiple handlers claim the same kind on one route", {
            route,
            kinds: overlap
          });
        }
      }
    }
    list.push(entry);
    return entry;
  }

  let registrationSequence = 0;

  function resolve(kind) {
    const route = routeForKind(kind);
    const list = byRoute.get(route);
    if (!list || list.length === 0) return null;
    let match = null;
    for (const entry of list) {
      if (!entry.supportedKinds.includes(kind)) continue;
      if (match === null) {
        match = entry;
        continue;
      }
      if (resolvedPolicy === "highest-priority") {
        if (entry.priority > match.priority) match = entry;
        else if (entry.priority === match.priority && entry.seq < match.seq) match = entry;
      }
    }
    return match ? { route, handler: match.handler, priority: match.priority } : null;
  }

  function snapshot() {
    const out = [];
    for (const [route, list] of byRoute.entries()) {
      for (const entry of list) {
        out.push({ route, supportedKinds: entry.supportedKinds, priority: entry.priority });
      }
    }
    return Object.freeze(out);
  }

  return Object.freeze({ register, resolve, snapshot, policy: resolvedPolicy });
}

module.exports = { createHandlerRegistry, routeForKind, KIND_TO_ROUTE };
