"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");
const { makeBus } = require("./helpers/busFactory");

function setup() {
  const ctx = makeBus({ now: 1000 });
  const bus = ctx.bus;
  const reg = (transportId, origin, caps) =>
    bus.registerTransport({ transportId, origin, capabilities: caps || {} });
  return Object.assign(ctx, { reg });
}

test("transports: registration returns immutable descriptor binding", () => {
  const t = setup();
  const record = t.reg("telegram.primary", "TELEGRAM", { acceptsText: true });
  assert.equal(record.transportId, "telegram.primary");
  assert.equal(record.origin, "TELEGRAM");
  assert.equal(record.capabilities.acceptsText, true);
  assert.equal(Object.isFrozen(record.capabilities), true);
});

test("transports: duplicate transport id registration fails closed", () => {
  const t = setup();
  t.reg("telegram.primary", "TELEGRAM");
  assert.throws(() => t.reg("telegram.primary", "API"), /TRANSPORT_ALREADY_REGISTERED/);
});

test("transports: unknown descriptor fields are rejected", () => {
  const t = setup();
  assert.throws(
    () => t.bus.registerTransport({ transportId: "tpt.x", origin: "API", exec: "require('child')" }),
    /TRANSPORT_FIELD_FORBIDDEN/
  );
});

test("transports: unknown capability names and non-boolean values reject", () => {
  const t = setup();
  assert.throws(
    () => t.reg("tpt.a", "API", { canRoot: true }),
    /TRANSPORT_FIELD_FORBIDDEN/
  );
  assert.throws(
    () => t.reg("tpt.b", "API", { acceptsText: "yes" }),
    /TRANSPORT_INVALID/
  );
});

test("transports: MESSAGE without acceptsText fails closed with explicit reason", () => {
  const t = setup();
  t.reg("voice.minimal", "VOICE");
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, s) => s.stream.emit("COMPLETE")
  });
  const result = t.bus.submit({
    transportId: "voice.minimal",
    sessionId: "ses_v",
    kind: "MESSAGE",
    payload: { text: "hi" }
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "CAPABILITY_VIOLATION");
  assert.deepEqual(result.missingCapabilities, ["acceptsText"]);
});

test("transports: STATUS_REQUEST needs no capability; EVENT requires acceptsEvents", () => {
  const t = setup();
  t.reg("tpt.status", "OBSERVATORY");
  t.bus.registerHandler({
    route: "STATUS",
    supportedKinds: ["STATUS_REQUEST"],
    handler: (env, c) => {
      c.stream.emit("START");
      c.stream.emit("FINAL", { scope: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const status = t.bus.submit({
    transportId: "tpt.status",
    sessionId: "ses_s1",
    kind: "STATUS_REQUEST",
    payload: { scope: "SESSION" }
  });
  assert.equal(status.accepted, true);
  const event = t.bus.submit({
    transportId: "tpt.status",
    sessionId: "ses_s2",
    kind: "EVENT",
    payload: { eventType: "ping" }
  });
  assert.equal(event.reason, "CAPABILITY_VIOLATION");
  assert.deepEqual(event.missingCapabilities, ["acceptsEvents"]);
});

test("transports: CANCEL_REQUEST requires supportsCancellation", () => {
  const t = setup();
  t.reg("tpt.nocancel", "API");
  const result = t.bus.submit({
    transportId: "tpt.nocancel",
    sessionId: "ses_c",
    kind: "CANCEL_REQUEST",
    payload: { targetInteractionId: "ix_missing" }
  });
  assert.equal(result.reason, "CAPABILITY_VIOLATION");
  assert.deepEqual(result.missingCapabilities, ["supportsCancellation"]);
});

test("transports: unregistered transport cannot submit at all", () => {
  const t = setup();
  const result = t.bus.submit({
    transportId: "ghost.transport",
    sessionId: "ses_g",
    kind: "MESSAGE",
    payload: { text: "hi" }
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "TRANSPORT_NOT_REGISTERED");
});
