"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");

test("enums: interaction origins are the closed canonical set", () => {
  assert.deepEqual([...ib.INTERACTION_ORIGINS], [
    "CONSOLE",
    "CLI",
    "VOICE",
    "PRESENCE",
    "HOTKEY",
    "OBSERVATORY",
    "TELEGRAM",
    "WHATSAPP",
    "COMPANION",
    "API",
    "SYSTEM",
    "TEST"
  ]);
});

test("enums: interaction kinds are the closed canonical set", () => {
  assert.deepEqual([...ib.INTERACTION_KINDS], [
    "MESSAGE",
    "COMMAND",
    "APPROVAL_RESPONSE",
    "CANCEL_REQUEST",
    "STATUS_REQUEST",
    "CONTEXT_REFERENCE",
    "AUTH_EVIDENCE",
    "EVENT",
    "ACTION_REQUEST"
  ]);
});

test("enums: interaction states are the closed canonical set", () => {
  assert.deepEqual([...ib.INTERACTION_STATES], [
    "RECEIVED",
    "VALIDATED",
    "QUEUED",
    "DISPATCHED",
    "STREAMING",
    "COMPLETED",
    "CANCEL_REQUESTED",
    "CANCELLED",
    "FAILED",
    "EXPIRED"
  ]);
});

test("enums: response kinds are the closed canonical set", () => {
  assert.deepEqual([...ib.RESPONSE_KINDS], [
    "TEXT_DELTA",
    "TEXT_FINAL",
    "VOICE_HINT",
    "STATUS",
    "APPROVAL_REQUIRED",
    "ERROR",
    "COMPLETE"
  ]);
});

test("enums: all enum containers are frozen", () => {
  for (const container of [
    ib.INTERACTION_ORIGINS,
    ib.INTERACTION_KINDS,
    ib.INTERACTION_STATES,
    ib.RESPONSE_KINDS,
    ib.ROUTES,
    ib.STREAM_EVENT_TYPES
  ]) {
    assert.equal(Object.isFrozen(container), true);
    assert.throws(() => {
      "use strict";
      container.push("HAX");
    });
  }
});

test("enums: assertEnum accepts members and rejects arbitrary strings", () => {
  assert.equal(ib.assertEnum("MESSAGE", ib.KIND_SET, "kind"), "MESSAGE");
  for (const bad of ["message", "SUPERADMIN", "", "system", null, 42]) {
    assert.throws(() => ib.assertEnum(bad, ib.KIND_SET, "kind"));
  }
});

test("enums: terminal state set is exactly the four terminal states", () => {
  assert.deepEqual([...ib.TERMINAL_STATES].sort(), ["CANCELLED", "COMPLETED", "EXPIRED", "FAILED"]);
});
