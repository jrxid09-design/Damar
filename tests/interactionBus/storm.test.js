"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeBus } = require("./helpers/busFactory");

function buildStormBus() {
  const t = makeBus({
    now: 1000,
    bounds: {
      maxSessions: 64,
      maxPendingInteractions: 512,
      maxPendingPerSession: 16,
      maxInFlightPerSession: 2,
      maxStreamBufferEvents: 8,
      maxDiagnostics: 50,
      maxDedupeLedger: 256,
      interactionTTLms: 100000
    },
    handlerAmbiguityPolicy: "highest-priority"
  });
  const bus = t.bus;
  bus.registerTransport({ transportId: "voice.main", origin: "VOICE", capabilities: { acceptsText: true, supportsStreaming: true, supportsCancellation: true } });
  bus.registerTransport({ transportId: "telegram.storm", origin: "TELEGRAM", capabilities: { acceptsText: true, supportsCancellation: true, acceptsAuthEvidence: true } });
  bus.registerTransport({ transportId: "observatory.storm", origin: "OBSERVATORY", capabilities: { acceptsText: true, supportsStreaming: true } });
  bus.registerTransport({ transportId: "api.client", origin: "API", capabilities: { acceptsText: true, acceptsCommands: true, supportsStreaming: true, supportsCancellation: true } });
  bus.registerTransport({ transportId: "hotkey.global", origin: "HOTKEY", capabilities: { acceptsCommands: true } });

  const behavior = { faults: 0, dispatchedSessions: new Map(), slowConsumerStreams: 0 };
  let callIndex = 0;
  const noteDispatch = (sessionId) => {
    behavior.dispatchedSessions.set(sessionId, (behavior.dispatchedSessions.get(sessionId) || 0) + 1);
  };
  bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    priority: 10,
    handler: (env, ctx) => {
      callIndex += 1;
      noteDispatch(env.sessionId);
      const mode = callIndex % 23;
      if (mode === 5) {
        behavior.faults += 1;
        throw new Error("storm synthetic fault");
      }
      ctx.stream.emit("START");
      if (mode === 7) {
        behavior.slowConsumerStreams += 1;
        const sub = ctx.stream.subscribe(() => {});
        sub.pause();
        for (let i = 0; i < 40; i += 1) {
          ctx.stream.emit("DELTA", { text: `d${i}` });
        }
        return;
      }
      ctx.stream.emit("DELTA", { text: "ok" });
      ctx.stream.emit("FINAL", { text: "done" });
      ctx.stream.emit("COMPLETE");
    }
  });
  bus.registerHandler({
    route: "COMMAND",
    supportedKinds: ["COMMAND"],
    handler: (env, ctx) => {
      noteDispatch(env.sessionId);
      ctx.stream.emit("START");
      ctx.stream.emit("FINAL", { command: env.payload.command });
      ctx.stream.emit("COMPLETE");
    }
  });
  bus.registerHandler({
    route: "CONTROL",
    supportedKinds: ["AUTH_EVIDENCE"],
    handler: (env, ctx) => {
      noteDispatch(env.sessionId);
      ctx.stream.emit("START");
      ctx.stream.emit("FINAL", { provider: env.payload.provider });
      ctx.stream.emit("COMPLETE");
    }
  });
  return Object.assign(t, { behavior });
}

const ORIGIN_PLAN = [
  ["voice.main", "VOICE"],
  ["telegram.storm", "TELEGRAM"],
  ["observatory.storm", "OBSERVATORY"],
  ["api.client", "API"],
  ["hotkey.global", "HOTKEY"]
];

function kindFor(transportId, i) {
  if (transportId === "api.client") return i % 4 === 3 ? "COMMAND" : "MESSAGE";
  if (transportId === "hotkey.global") return "COMMAND";
  if (transportId === "telegram.storm" && i % 11 === 10) return "AUTH_EVIDENCE";
  return "MESSAGE";
}

function runStorm(t, options) {
  const opts = options || {};
  const results = [];
  for (let i = 0; i < 2200; i += 1) {
    const [transportId] = ORIGIN_PLAN[i % ORIGIN_PLAN.length];
    const kind = kindFor(transportId, i);
    const sessionId = `ses_${transportId.split(".")[0]}_s${i % 25}`;
    const payload =
      kind === "MESSAGE"
        ? { text: `storm message ${i} ${opts.noise || ""}` }
        : kind === "COMMAND"
          ? { command: `op${i % 3}`, arguments: [String(i)] }
          : { provider: "storm_provider", evidenceId: "evd_x", issuedAt: 1000, expiresAt: 900000 };
    if (i % 97 === 0 && results.length > 0) {
      const prior = results[(i * 13) % results.length];
      if (prior.result.interactionId) {
        t.bus.submit({
          transportId: prior.transportId,
          sessionId: prior.sessionId,
          kind: prior.kind,
          payload: prior.payload,
          interactionId: prior.result.interactionId
        });
      }
      continue;
    }
    if (i % 89 === 0 && results.length > 0) {
      const victim = results[(i * 7) % results.length];
      if (victim.result.interactionId) {
        t.bus.requestCancellation({
          transportId: victim.transportId,
          sessionId: victim.sessionId,
          targetInteractionId: victim.result.interactionId,
          reason: "storm-cancel"
        });
      }
    }
    if (i % 101 === 0 && results.length > 0) {
      const prior = results[(i * 17) % results.length];
      if (prior.kind === "MESSAGE" && prior.result.interactionId) {
        t.bus.submit({
          transportId: prior.transportId,
          sessionId: prior.sessionId,
          kind: "MESSAGE",
          payload: { text: `${prior.payload.text} TAMPERED` },
          interactionId: prior.result.interactionId
        });
      }
    }
    const result = t.bus.submit({
      transportId,
      sessionId,
      kind,
      payload,
      deadline: i % 53 === 0 ? t.clock() - 1 : undefined
    });
    results.push({ transportId, sessionId, kind, payload, result });
    if ((i + 1) % 400 === 0) t.advance(25000);
  }
  t.bus.sweep(t.clock());
  return results;
}

test("storm: 2000 mixed interactions keep every buffer bounded with clean counters", () => {
  const t = buildStormBus();
  const results = runStorm(t);
  const status = t.bus.getStatus();
  assert.equal(results.length >= 2000, true);
  assert.ok(status.pendingInteractions <= status.bounds.maxPendingInteractions, "global pending bounded");
  assert.ok(status.activeSessions <= status.bounds.maxSessions, "sessions bounded");
  assert.ok(status.diagnostics.length <= status.bounds.maxDiagnostics, "diagnostics bounded");
  assert.ok(status.counters.duplicates > 0, "duplicates exercised");
  assert.ok(status.counters.conflicts > 0, "conflicts exercised");
  assert.ok(status.counters.expired > 0, "expiry exercised");
  assert.ok(t.behavior.faults > 0, "handler faults exercised");
  assert.ok(t.behavior.slowConsumerStreams > 0, "slow consumers exercised");
  assert.equal(status.counters.negativeCounterGuards, 0, "no negative counter guards fired");
  assert.equal(status.counters.doubleTerminalGuards, 0, "no double terminal transitions");
});

test("storm: telemetry stays metadata-only under load", () => {
  const t = buildStormBus();
  runStorm(t);
  const snapshotJson = JSON.stringify(t.bus.getStatus());
  assert.equal(snapshotJson.includes("storm message"), false, "no message content in status");
  assert.equal(snapshotJson.includes("TAMPERED"), false, "no tampered payloads leak");
  for (const diagnostic of t.bus.getStatus().diagnostics) {
    assert.equal(diagnostic.detail === null || typeof diagnostic.detail === "object", true);
    assert.equal(JSON.stringify(diagnostic).includes("storm message"), false);
  }
});

test("storm: dedupe ledger stays bounded under duplicate pressure", () => {
  const t = buildStormBus();
  for (let i = 0; i < 600; i += 1) {
    t.bus.submit({
      transportId: "telegram.storm",
      sessionId: `ses_dup${(i % 50) % 3}`,
      kind: "MESSAGE",
      payload: { text: `dup-${i % 50}` },
      interactionId: `ix_d${i % 50}`
    });
  }
  const status = t.bus.getStatus();
  assert.ok(status.ledgerSize <= status.bounds.maxDedupeLedger, "ledger bounded");
  assert.ok(status.counters.duplicates > 300, "duplicate detection active");
});

test("storm: fair progress — every session dispatches and spread stays bounded", () => {
  const t = buildStormBus();
  runStorm(t);
  const dispatchCounts = [...t.behavior.dispatchedSessions.values()];
  assert.equal(t.behavior.dispatchedSessions.size >= 25, true, "all sessions progressed");
  const min = Math.min(...dispatchCounts);
  const max = Math.max(...dispatchCounts);
  assert.ok(max / min <= 8, `fairness spread bounded (min=${min}, max=${max})`);
});

test("storm: identical runs produce bit-identical final status (determinism)", () => {
  const runOnce = () => {
    const t = buildStormBus();
    runStorm(t, { noise: "deterministic" });
    return JSON.stringify(t.bus.getStatus());
  };
  assert.equal(runOnce(), runOnce());
});
