"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");
const { makeBus } = require("./helpers/busFactory");

test("routing: every kind has exactly one canonical route", () => {
  const expected = {
    MESSAGE: "CONVERSATION",
    CONTEXT_REFERENCE: "CONVERSATION",
    COMMAND: "COMMAND",
    APPROVAL_RESPONSE: "APPROVAL",
    STATUS_REQUEST: "STATUS",
    EVENT: "CONTROL",
    AUTH_EVIDENCE: "CONTROL"
  };
  for (const [kind, route] of Object.entries(expected)) {
    assert.equal(ib.routeForKind(kind), route);
    assert.equal(ib.KIND_TO_ROUTE[kind], route);
  }
});

test("routing: CANCEL_REQUEST is control-plane and not handler-routed", () => {
  assert.throws(() => ib.routeForKind("CANCEL_REQUEST"), /KIND_NOT_ROUTABLE/);
});

test("routing: non-kind input cannot select a destination", () => {
  for (const bad of ["message", "sudo", "", "MESSAGE; drop", null, 7]) {
    assert.throws(() => ib.routeForKind(bad), /KIND_NOT_ROUTABLE|INVALID_ENUM|cannot/);
  }
});

test("routing: handlers must declare kinds that canonically match their route", () => {
  const t = makeBus({ now: 1 });
  assert.throws(
    () =>
      t.bus.registerHandler({
        route: "APPROVAL",
        supportedKinds: ["MESSAGE"],
        handler: () => {}
      }),
    /HANDLER_ROUTE_MISMATCH/
  );
});

test("routing: ambiguous duplicate kind registration fails closed by default", () => {
  const t = makeBus({ now: 1 });
  const reg = { route: "CONVERSATION", supportedKinds: ["MESSAGE"], handler: () => {} };
  t.bus.registerHandler(reg);
  assert.throws(
    () =>
      t.bus.registerHandler({
        route: "CONVERSATION",
        supportedKinds: ["MESSAGE"],
        handler: () => {}
      }),
    /HANDLER_AMBIGUOUS/
  );
});

test("routing: highest-priority policy resolves deterministically, no fan-out", () => {
  const t = makeBus({ now: 1000, handlerAmbiguityPolicy: "highest-priority" });
  const calls = [];
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    priority: 5,
    handler: (env, c) => {
      calls.push("priority5");
      c.stream.emit("START");
      c.stream.emit("FINAL");
      c.stream.emit("COMPLETE");
    }
  });
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    priority: 10,
    handler: (env, c) => {
      calls.push("priority10");
      c.stream.emit("START");
      c.stream.emit("FINAL");
      c.stream.emit("COMPLETE");
    }
  });
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    priority: 10,
    handler: (env, c) => {
      calls.push("priority10-second");
      c.stream.emit("START");
      c.stream.emit("FINAL");
      c.stream.emit("COMPLETE");
    }
  });
  t.bus.registerTransport({ transportId: "tpt.a", origin: "TEST", capabilities: { acceptsText: true } });
  const result = t.bus.submit({
    transportId: "tpt.a",
    sessionId: "ses_prio",
    kind: "MESSAGE",
    payload: { text: "x" }
  });
  assert.equal(result.state, "COMPLETED");
  assert.deepEqual(calls, ["priority10"]);
});

test("routing: invalid registrations reject", () => {
  const t = makeBus({ now: 1 });
  assert.throws(() => t.bus.registerHandler({ route: "NOPE", supportedKinds: ["EVENT"], handler: () => {} }), /INVALID_ENUM|not a valid/);
  assert.throws(() => t.bus.registerHandler({ route: "CONTROL", supportedKinds: ["EVENT"], handler: "not-a-fn" }), /HANDLER_INVALID/);
  assert.throws(() => t.bus.registerHandler({ route: "CONTROL", supportedKinds: [], handler: () => {} }), /HANDLER_INVALID/);
  assert.throws(() => t.bus.registerHandler({ route: "CONTROL", supportedKinds: ["EVENT"], handler: () => {}, priority: 1.5 }), /HANDLER_INVALID/);
});

test("routing: serialized input can never invoke arbitrary handlers", () => {
  const t = makeBus({ now: 1000 });
  let secretHandlerCalled = false;
  t.bus.registerTransport({ transportId: "tpt.z", origin: "API", capabilities: { acceptsText: true, acceptsEvents: true } });
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      secretHandlerCalled = true;
      c.stream.emit("START");
      c.stream.emit("FINAL");
      c.stream.emit("COMPLETE");
    }
  });
  t.bus.submit({
    transportId: "tpt.z",
    sessionId: "ses_ser",
    kind: "MESSAGE",
    payload: { text: "__proto__.handler" },
    metadata: { handler: "secretHandler" },
    claimedMetadata: { route: "CONVERSATION", handler: "secretHandler" }
  });
  assert.equal(secretHandlerCalled, true, "only the code-registered CONVERSATION handler may run");
  const snapshot = t.bus.getStatus();
  assert.equal(snapshot.counters.completed, 1);
});
