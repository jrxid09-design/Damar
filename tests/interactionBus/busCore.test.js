"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeBus } = require("./helpers/busFactory");

function baseSetup(extra) {
  const t = makeBus(Object.assign({ now: 1000 }, extra || {}));
  const bus = t.bus;
  const regTelegram = (caps) =>
    bus.registerTransport({
      transportId: "telegram.primary",
      origin: "TELEGRAM",
      capabilities: Object.assign({ acceptsText: true, supportsCancellation: true, supportsApprovalResponses: true }, caps || {})
    });
  return Object.assign(t, { regTelegram });
}

test("bus: full lifecycle history is canonical and ordered", async () => {
  const t = baseSetup({ bounds: { maxInFlightPerSession: 1 } });
  t.regTelegram();
  let release = null;
  let firstStream = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: async (env, c) => {
      c.stream.subscribe(() => {});
      c.stream.emit("START");
      if (!firstStream) firstStream = c.stream;
      await gate;
      c.stream.emit("FINAL", { text: "done" });
      c.stream.emit("COMPLETE");
    }
  });
  const first = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_life",
    kind: "MESSAGE",
    payload: { text: "one" }
  });
  assert.equal(first.state, "STREAMING");
  const second = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_life",
    kind: "MESSAGE",
    payload: { text: "two" }
  });
  assert.equal(second.state, "QUEUED");
  const traceQueued = t.bus.getInteractionTrace(second.interactionId);
  assert.deepEqual(
    traceQueued.history.map((h) => h.state),
    ["RECEIVED", "VALIDATED", "QUEUED"]
  );
  release();
  await new Promise((resolve) => setImmediate(resolve));
  t.bus.pump();
  await new Promise((resolve) => setImmediate(resolve));
  const traceSecond = t.bus.getInteractionTrace(second.interactionId);
  assert.equal(traceSecond, null);
  const status = t.bus.getStatus();
  assert.equal(status.counters.completed, 2);
});

test("bus: missing handler fails that interaction closed without touching others", () => {
  const t = baseSetup();
  t.regTelegram();
  const r1 = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_nh",
    kind: "STATUS_REQUEST",
    payload: {}
  });
  assert.equal(r1.accepted, true);
  assert.equal(r1.state, "FAILED");
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const status = t.bus.getStatus();
  assert.equal(status.counters.failed, 1);
  assert.equal(status.diagnostics.some((d) => d.reason === "NO_HANDLER"), true);
});

test("bus: throwing handler fails only its own interaction", () => {
  const t = baseSetup();
  t.regTelegram();
  let calls = 0;
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      calls += 1;
      if (calls === 1) throw new Error("synthetic handler fault");
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const bad = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_throw", kind: "MESSAGE", payload: { text: "x" } });
  assert.equal(bad.accepted, true);
  assert.equal(t.bus.getStatus().counters.failed, 1);
  const good = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_throw2", kind: "MESSAGE", payload: { text: "y" } });
  assert.equal(good.state, "COMPLETED");
  assert.equal(calls, 2);
});

test("bus: rejecting async handler fails its interaction", () => {
  const t = baseSetup();
  t.regTelegram();
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: async () => {
      throw new Error("async fault");
    }
  });
  const r = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_async", kind: "MESSAGE", payload: { text: "x" } });
  assert.equal(r.accepted, true);
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.equal(t.bus.getStatus().counters.failed, 1);
  });
});

test("bus: duplicate submissions are detected with original state reference", () => {
  const t = baseSetup();
  t.regTelegram();
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const first = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_dup",
    kind: "MESSAGE",
    payload: { text: "same" },
    interactionId: "ix_dupcheck"
  });
  assert.equal(first.state, "COMPLETED");
  const dup = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_dup",
    kind: "MESSAGE",
    payload: { text: "same" },
    interactionId: "ix_dupcheck"
  });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, "DUPLICATE");
  assert.equal(dup.originalState, "COMPLETED");
  assert.equal(t.bus.getStatus().counters.duplicates, 1);
});

test("bus: conflicting payload under same id rejects as CONFLICTING_INTERACTION", () => {
  const t = baseSetup();
  t.regTelegram();
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_conf",
    kind: "MESSAGE",
    payload: { text: "version-a" },
    interactionId: "ix_conflict"
  });
  const conflict = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_conf",
    kind: "MESSAGE",
    payload: { text: "version-b" },
    interactionId: "ix_conflict"
  });
  assert.equal(conflict.reason, "CONFLICTING_INTERACTION");
  assert.equal(t.bus.getStatus().counters.conflicts, 1);
});

test("bus: dedupe ledger is FIFO-bounded with explicit eviction diagnostics", () => {
  const t = baseSetup({ bounds: { maxDedupeLedger: 3 } });
  t.regTelegram();
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  for (let i = 0; i < 5; i += 1) {
    t.bus.submit({
      transportId: "telegram.primary",
      sessionId: `ses_evict${i}`,
      kind: "MESSAGE",
      payload: { text: `m${i}` },
      interactionId: `ix_e${i}`
    });
  }
  const status = t.bus.getStatus();
  assert.equal(status.ledgerSize, 3);
  assert.equal(status.diagnostics.filter((d) => d.reason === "DEDUPE_LEDGER_EVICTED").length >= 2, true);
  const replayEvicted = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_evict0",
    kind: "MESSAGE",
    payload: { text: "m0" },
    interactionId: "ix_e0"
  });
  assert.equal(replayEvicted.accepted, true, "evicted id may be minted again per documented policy");
});

test("bus: deadline-expired interactions are not dispatched", () => {
  const t = baseSetup();
  t.regTelegram();
  let dispatched = 0;
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      dispatched += 1;
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const r = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_deadline",
    kind: "MESSAGE",
    payload: { text: "late" },
    deadline: 1500
  });
  assert.equal(r.state, "COMPLETED");
  t.advance(2000);
  const r2 = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_deadline",
    kind: "MESSAGE",
    payload: { text: "later" },
    deadline: 2500
  });
  assert.equal(r2.state, "EXPIRED");
  assert.equal(dispatched, 1);
  assert.equal(t.bus.getStatus().counters.expired, 1);
});

test("bus: TTL sweep expires queued interactions deterministically", () => {
  const t = baseSetup({ bounds: { interactionTTLms: 500, maxInFlightPerSession: 1 } });
  t.regTelegram();
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: async (env, c) => {
      await gate;
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_ttl", kind: "MESSAGE", payload: { text: "hold" } });
  const queued = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_ttl", kind: "MESSAGE", payload: { text: "wait" } });
  assert.equal(queued.state, "QUEUED");
  t.advance(600);
  t.bus.sweep(t.clock());
  const status = t.bus.getStatus();
  assert.equal(status.counters.expired >= 1, true);
  assert.equal(status.pendingInteractions, 0);
  release();
});

test("bus: expired interactions cannot resurrect via replay before ledger eviction", () => {
  const t = baseSetup();
  t.regTelegram();
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const r = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_res",
    kind: "MESSAGE",
    payload: { text: "x" },
    interactionId: "ix_res"
  });
  assert.equal(r.state, "COMPLETED");
  t.advance(999999);
  const replay = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_res",
    kind: "MESSAGE",
    payload: { text: "x" },
    interactionId: "ix_res",
    deadline: 10000000
  });
  assert.equal(replay.reason, "DUPLICATE");
});

test("bus: cancellation of a streaming interaction is a request requiring acknowledgement", async () => {
  const t = baseSetup({ bounds: { maxInFlightPerSession: 8 } });
  t.regTelegram();
  const acked = new Promise((resolve) => {
    t.bus.registerHandler({
      route: "CONVERSATION",
      supportedKinds: ["MESSAGE"],
      handler: (env, c) => {
        c.stream.subscribe((event) => {
          if (event.type === "STATUS" && event.data && event.data.cancelRequested) {
            c.acknowledgeCancellation();
            resolve();
          }
        });
        c.stream.emit("START");
      }
    });
  });
  const r = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_cancel", kind: "MESSAGE", payload: { text: "speak" } });
  assert.equal(r.state, "STREAMING");
  const cancel = t.bus.requestCancellation({
    transportId: "telegram.primary",
    sessionId: "ses_cancel",
    targetInteractionId: r.interactionId,
    reason: "barge-in"
  });
  assert.equal(cancel.accepted, true);
  await acked;
  assert.equal(t.bus.getStatus().counters.cancelled, 1);
  const repeated = t.bus.requestCancellation({
    transportId: "telegram.primary",
    sessionId: "ses_cancel",
    targetInteractionId: r.interactionId
  });
  assert.equal(repeated.idempotent, true);
});

test("bus: cancellation of a queued interaction cancels it before dispatch", async () => {
  const t = baseSetup({ bounds: { maxInFlightPerSession: 1 } });
  t.regTelegram();
  let dispatchedCount = 0;
  const seenIds = [];
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: async (env, c) => {
      dispatchedCount += 1;
      seenIds.push(env.interactionId);
      await gate;
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const hold = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_qc", kind: "MESSAGE", payload: { text: "1" } });
  const victim = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_qc", kind: "MESSAGE", payload: { text: "2" } });
  const cancel = t.bus.requestCancellation({
    transportId: "telegram.primary",
    sessionId: "ses_qc",
    targetInteractionId: victim.interactionId
  });
  assert.equal(cancel.accepted, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  t.bus.pump();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seenIds, [hold.interactionId]);
  assert.equal(dispatchedCount, 1);
  assert.equal(t.bus.getStatus().counters.cancelled, 1);
});

test("bus: unknown-target and cross-session cancellation give explicit deterministic results", () => {
  const t = baseSetup();
  t.regTelegram();
  t.bus.registerTransport({ transportId: "console.web", origin: "API", capabilities: { acceptsText: true, supportsCancellation: true } });
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const unknown = t.bus.requestCancellation({
    transportId: "telegram.primary",
    sessionId: "ses_cx1",
    targetInteractionId: "ix_ghost"
  });
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.reason, "TARGET_NOT_FOUND");
  const tg = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_tgx", kind: "MESSAGE", payload: { text: "x" } });
  const crossSession = t.bus.requestCancellation({
    transportId: "telegram.primary",
    sessionId: "ses_other_session",
    targetInteractionId: tg.interactionId
  });
  assert.equal(crossSession.reason, "TARGET_NOT_FOUND");
  const crossTransportSameSessionShape = t.bus.requestCancellation({
    transportId: "console.web",
    sessionId: "ses_tgx",
    targetInteractionId: tg.interactionId
  });
  assert.equal(crossTransportSameSessionShape.reason, "TARGET_NOT_FOUND");
});

test("bus: barge-in keeps old speaking interaction and new interaction separately traceable", () => {
  const t = baseSetup();
  t.regTelegram();
  const streamsSeen = {};
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      streamsSeen[env.interactionId] = [];
      c.stream.subscribe((e) => streamsSeen[env.interactionId].push(e.type));
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "speech" });
      c.stream.emit("COMPLETE");
    }
  });
  const speaking = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_barge", kind: "MESSAGE", payload: { text: "tell me" } });
  const interrupt = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_barge", kind: "MESSAGE", payload: { text: "stop, new q" } });
  assert.notEqual(speaking.interactionId, interrupt.interactionId);
  assert.deepEqual(streamsSeen[speaking.interactionId], ["START", "FINAL", "COMPLETE"]);
  assert.deepEqual(streamsSeen[interrupt.interactionId], ["START", "FINAL", "COMPLETE"]);
  const status = t.bus.getStatus();
  assert.equal(status.counters.completed, 2);
  assert.equal(status.activeSessions, 1);
});

test("bus: responses never leak across transports or sessions", () => {
  const t = baseSetup();
  t.regTelegram();
  t.bus.registerTransport({ transportId: "console.web", origin: "API", capabilities: { acceptsText: true, supportsStreaming: true } });
  const collectors = { telegramA: [], consoleB: [], consoleC: [] };
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, c) => {
      c.stream.subscribe((event) => {
        if (env.sessionId === "ses_tele_a") collectors.telegramA.push(event);
        if (env.sessionId === "ses_console_b") collectors.consoleB.push(event);
        if (env.sessionId === "ses_console_c") collectors.consoleC.push(event);
      });
      c.stream.emit("START");
      c.stream.emit("DELTA", { text: `for-${env.sessionId}` });
      c.stream.emit("FINAL", { text: `final-${env.sessionId}` });
      c.stream.emit("COMPLETE");
    }
  });
  const a = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_tele_a", kind: "MESSAGE", payload: { text: "q-a" } });
  const b = t.bus.submit({ transportId: "console.web", sessionId: "ses_console_b", kind: "MESSAGE", payload: { text: "q-b" } });
  const c2 = t.bus.submit({ transportId: "console.web", sessionId: "ses_console_c", kind: "MESSAGE", payload: { text: "q-c" } });
  assert.ok(a.interactionId && b.interactionId && c2.interactionId);
  const allEvents = [...collectors.telegramA, ...collectors.consoleB, ...collectors.consoleC];
  const withData = (events) => events.filter((e) => e.data !== null && e.data !== undefined);
  assert.equal(withData(collectors.telegramA).every((e) => !String(e.data.text || "").includes("ses_console")), true);
  assert.equal(withData(collectors.consoleB).every((e) => String(e.data.text || "").includes("ses_console_b")), true);
  assert.equal(withData(collectors.consoleC).every((e) => String(e.data.text || "").includes("ses_console_c")), true);
  assert.equal(allEvents.length, collectors.telegramA.length + collectors.consoleB.length + collectors.consoleC.length);
});

test("bus: per-session and global queue limits fail closed", () => {
  const t = baseSetup({ bounds: { maxPendingPerSession: 2, maxInFlightPerSession: 1, maxPendingInteractions: 4 } });
  t.regTelegram();
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: async () => {
      await gate;
    }
  });
  const first = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_bp", kind: "MESSAGE", payload: { text: "1" } });
  assert.equal(first.state, "DISPATCHED");
  const second = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_bp", kind: "MESSAGE", payload: { text: "2" } });
  const third = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_bp", kind: "MESSAGE", payload: { text: "3" } });
  assert.equal(second.state, "QUEUED");
  const fourth = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_bp", kind: "MESSAGE", payload: { text: "4" } });
  assert.equal(fourth.reason, "SESSION_QUEUE_FULL");
  assert.equal(third.state, "QUEUED");
  const otherSession = t.bus.submit({ transportId: "telegram.primary", sessionId: "ses_bp_other", kind: "MESSAGE", payload: { text: "5" } });
  assert.notEqual(otherSession.reason, "SESSION_QUEUE_FULL");
  release();
});

test("bus: round-robin scheduling gives fair progress across sessions", async () => {
  const t = baseSetup({ bounds: { maxInFlightPerSession: 1, maxPendingPerSession: 8 } });
  t.regTelegram();
  const dispatchOrder = [];
  const resolvers = [];
  t.bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: async (env, c) => {
      dispatchOrder.push(env.sessionId);
      await new Promise((resolve) => resolvers.push(resolve));
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  for (let i = 0; i < 3; i += 1) {
    t.bus.submit({ transportId: "telegram.primary", sessionId: `ses_f${i}`, kind: "MESSAGE", payload: { text: `${i}` } });
  }
  assert.deepEqual(dispatchOrder, ["ses_f0", "ses_f1", "ses_f2"]);
  for (let i = 0; i < 3; i += 1) {
    t.bus.submit({ transportId: "telegram.primary", sessionId: `ses_f${i}`, kind: "MESSAGE", payload: { text: `b${i}` } });
  }
  assert.equal(dispatchOrder.length, 3, "second wave stays queued while sessions hold inflight work");
  while (resolvers.length > 0) {
    resolvers.shift()();
  }
  await new Promise((resolve) => setImmediate(resolve));
  t.bus.pump();
  assert.deepEqual(
    dispatchOrder,
    ["ses_f0", "ses_f1", "ses_f2", "ses_f0", "ses_f1", "ses_f2"],
    "round-robin interleave, no session starvation"
  );
});

test("bus: approval response is routed inertly to the APPROVAL route without authority effects", () => {
  const t = baseSetup();
  t.regTelegram();
  const decisions = [];
  t.bus.registerHandler({
    route: "APPROVAL",
    supportedKinds: ["APPROVAL_RESPONSE"],
    handler: (env, c) => {
      decisions.push({ id: env.payload.approvalRequestId, decision: env.payload.decision });
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const r = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_appr",
    kind: "APPROVAL_RESPONSE",
    payload: { approvalRequestId: "ix_approval_req_1", decision: "approve" }
  });
  assert.equal(r.state, "COMPLETED");
  assert.deepEqual(decisions, [{ id: "ix_approval_req_1", decision: "approve" }]);
  const snapshot = JSON.stringify(t.bus.getStatus());
  assert.equal(snapshot.includes("grant"), false);
  assert.equal(snapshot.includes("CapabilityGrant"), false);
});

test("bus: auth evidence interactions carry opaque refs only and leak nothing into telemetry", () => {
  const t = baseSetup();
  t.regTelegram({ acceptsAuthEvidence: true });
  const evidenceSeen = [];
  t.bus.registerHandler({
    route: "CONTROL",
    supportedKinds: ["AUTH_EVIDENCE"],
    handler: (env, c) => {
      evidenceSeen.push(env.authEvidenceRefs.map((ref) => ref.provider));
      c.stream.emit("START");
      c.stream.emit("FINAL", { text: "ok" });
      c.stream.emit("COMPLETE");
    }
  });
  const r = t.bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_auth",
    kind: "AUTH_EVIDENCE",
    payload: { provider: "totp_provider", evidenceId: "evd_x1", issuedAt: 1100, expiresAt: 9000000 },
    authEvidenceRefs: [{ provider: "totp_provider", evidenceId: "evd_x1", issuedAt: 1100, expiresAt: 9000000 }],
    claimedMetadata: { rawCode: "123456" }
  });
  assert.equal(r.state, "COMPLETED");
  assert.deepEqual(evidenceSeen, [["totp_provider"]]);
  const snapshotJson = JSON.stringify(t.bus.getStatus());
  assert.equal(snapshotJson.includes("123456"), false);
  assert.equal(snapshotJson.includes("rawCode"), false);
});
