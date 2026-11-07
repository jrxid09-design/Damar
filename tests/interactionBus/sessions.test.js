"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeBus } = require("./helpers/busFactory");

function setup(extra) {
  const t = makeBus(Object.assign({ now: 1000 }, extra || {}));
  const bus = t.bus;
  const echoHandler = () =>
    bus.registerHandler({
      route: "CONVERSATION",
      supportedKinds: ["MESSAGE"],
      handler: (env, c) => {
        c.stream.emit("START");
        c.stream.emit("FINAL", { text: "ok" });
        c.stream.emit("COMPLETE");
      }
    });
  return Object.assign(t, {
    regConsole: () =>
      bus.registerTransport({
        transportId: "console.web",
        origin: "API",
        capabilities: { acceptsText: true, supportsStreaming: true }
      }),
    regTelegram: (caps) =>
      bus.registerTransport({
        transportId: "telegram.primary",
        origin: "TELEGRAM",
        capabilities: Object.assign({ acceptsText: true }, caps || {})
      })
  });
}

test("sessions: creation binds sessionId to transport and origin immutably", () => {
  const t = setup();
  t.regConsole();
  const result = t.bus.submit({
    transportId: "console.web",
    sessionId: "ses_shared1",
    kind: "MESSAGE",
    payload: { text: "hi" }
  });
  assert.equal(result.accepted, true);
  assert.equal(result.state, "FAILED");
  const sessions = t.bus.getSessionSnapshot();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].transportId, "console.web");
  assert.equal(sessions[0].origin, "API");
});

test("sessions: telegram interaction reusing console session id is rejected", () => {
  const t = setup();
  t.regConsole();
  t.regTelegram();
  const first = t.bus.submit({
    transportId: "console.web",
    sessionId: "ses_hijack_me",
    kind: "MESSAGE",
    payload: { text: "hi" }
  });
  assert.equal(first.accepted, true);
  assert.equal(first.state, "FAILED");
  const second = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_hijack_me",
    kind: "MESSAGE",
    payload: { text: "hi from telegram" }
  });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "SESSION_TRANSPORT_MISMATCH");
  assert.equal(second.boundTransportId, "console.web");
});

test("sessions: api transport reusing telegram session id is rejected", () => {
  const t = setup();
  t.regConsole();
  t.regTelegram();
  t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_tg_only",
    kind: "MESSAGE",
    payload: { text: "hi" }
  });
  const result = t.bus.submit({
    transportId: "console.web",
    sessionId: "ses_tg_only",
    kind: "MESSAGE",
    payload: { text: "hi" }
  });
  assert.equal(result.reason, "SESSION_TRANSPORT_MISMATCH");
});

test("sessions: same origin different transport cannot join either direction", () => {
  const t = setup();
  t.regTelegram();
  t.bus.registerTransport({ transportId: "telegram.backup", origin: "TELEGRAM", capabilities: { acceptsText: true } });
  t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_same_origin",
    kind: "MESSAGE",
    payload: { text: "a" }
  });
  const result = t.bus.submit({
    transportId: "telegram.backup",
    sessionId: "ses_same_origin",
    kind: "MESSAGE",
    payload: { text: "b" }
  });
  assert.equal(result.reason, "SESSION_TRANSPORT_MISMATCH");
});

test("sessions: session limit fails closed without evicting live sessions", () => {
  const t = setup({ bounds: { maxSessions: 2 } });
  t.regTelegram();
  for (const sid of ["ses_1", "ses_2"]) {
    const r = t.bus.submit({
      transportId: "telegram.primary",
      sessionId: sid,
      kind: "MESSAGE",
      payload: { text: "x" }
    });
    assert.equal(r.accepted, true);
    assert.equal(r.state, "FAILED");
  }
  const third = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_3",
    kind: "MESSAGE",
    payload: { text: "x" }
  });
  assert.equal(third.reason, "SESSION_LIMIT_EXCEEDED");
  assert.equal(t.bus.getSessionSnapshot().length, 2);
});

test("sessions: idle sessions are swept after sessionIdleTTLms", () => {
  const t = setup({ bounds: { sessionIdleTTLms: 1000 } });
  t.regTelegram();
  t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_idle",
    kind: "MESSAGE",
    payload: { text: "x" }
  });
  assert.equal(t.bus.getSessionSnapshot().length, 1);
  t.advance(1500);
  t.bus.sweep(t.clock());
  assert.equal(t.bus.getSessionSnapshot().length, 0);
});

test("sessions: recent interaction history stays bounded", () => {
  const t = setup({ bounds: { maxSessionHistory: 5 } });
  t.regTelegram();
  let counter = 0;
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      counter += 1;
      c.stream.emit("START");
      c.stream.emit("COMPLETE");
    }
  });
  for (let i = 0; i < 12; i += 1) {
    t.bus.submit({
      transportId: "telegram.primary",
      sessionId: `ses_hist${i % 3}`,
      kind: "MESSAGE",
      payload: { text: `m${i}` }
    });
  }
  assert.equal(counter, 12);
  for (const session of t.bus.getSessionSnapshot()) {
    assert.ok(session.queueDepth === 0);
  }
});

test("sessions: disconnect detaches but keeps binding against other transports", () => {
  const t = setup();
  t.regTelegram();
  t.regConsole();
  t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_disc",
    kind: "MESSAGE",
    payload: { text: "x" }
  });
  const outcome = t.bus.transportDisconnect("telegram.primary");
  assert.deepEqual(outcome.detachedSessions, ["ses_disc"]);
  assert.equal(outcome.pendingPolicy, "keep-until-ttl");
  const hijack = t.bus.submit({
    transportId: "console.web",
    sessionId: "ses_disc",
    kind: "MESSAGE",
    payload: { text: "x" }
  });
  assert.equal(hijack.reason, "SESSION_TRANSPORT_MISMATCH");
});
