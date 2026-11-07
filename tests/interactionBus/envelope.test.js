"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");
const { makeBus } = require("./helpers/busFactory");

function setupBus(extra) {
  const { bus } = makeBus(Object.assign({ now: 1000 }, extra || {}));
  bus.registerTransport({
    transportId: "telegram.primary",
    origin: "TELEGRAM",
    capabilities: { acceptsText: true, acceptsCommands: true, supportsCancellation: true }
  });
  return bus;
}

function registerCapture(bus) {
  const seen = [];
  bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env) => {
      seen.push(env);
    }
  });
  return seen;
}

function registerEcho(bus) {
  bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (env, ctx) => {
      ctx.stream.emit("START");
      ctx.stream.emit("FINAL", { text: "ok" });
      ctx.stream.emit("COMPLETE");
    }
  });
}

function submitMessage(bus, overrides) {
  return bus.submit(
    Object.assign(
      {
        transportId: "telegram.primary",
        sessionId: "ses_a",
        kind: "MESSAGE",
        payload: { text: "hello" }
      },
      overrides || {}
    )
  );
}

test("envelope: accepted interaction completes and exposes canonical state", () => {
  const bus = setupBus();
  registerEcho(bus);
  const result = submitMessage(bus);
  assert.equal(result.accepted, true);
  assert.equal(result.state, "COMPLETED");
});

test("envelope: privileged-looking payload fields are rejected as unknown", () => {
  const bus = setupBus();
  registerEcho(bus);
  for (const poison of [
    { role: "system" },
    { superadmin: true },
    { authority: "root" },
    { trusted: true },
    { owner: true },
    { capabilities: ["*"] }
  ]) {
    const result = submitMessage(bus, {
      payload: Object.assign({ text: "hi" }, poison)
    });
    assert.equal(result.accepted, false, JSON.stringify(poison));
    assert.equal(result.reason, "PAYLOAD_FIELD_FORBIDDEN");
  }
});

test("envelope: unknown request-level fields never become trusted envelope state", () => {
  const bus = setupBus();
  const seen = registerCapture(bus);
  const result = submitMessage(bus, {
    role: "system",
    superadmin: true,
    authority: "root"
  });
  assert.equal(result.accepted, true);
  assert.equal(seen.length, 1);
  const keys = Object.keys(seen[0]);
  for (const key of ["role", "superadmin", "authority"]) {
    assert.equal(keys.includes(key), false, `envelope must not contain ${key}`);
  }
  assert.equal(JSON.stringify(seen[0]).includes('"superadmin"'), false);
});

test("envelope: provenance derives from registered transport, not caller claims", () => {
  const bus = setupBus();
  const seen = registerCapture(bus);
  const result = submitMessage(bus, {
    claimedIdentity: { owner: true, role: "system" },
    claimedMetadata: { source: "console" }
  });
  assert.equal(result.accepted, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].origin, "TELEGRAM");
  assert.equal(seen[0].provenance.transportId, "telegram.primary");
  assert.equal(seen[0].provenance.origin, "TELEGRAM");
  assert.deepEqual(seen[0].provenance.claimedIdentity, { owner: true, role: "system" });
  assert.deepEqual(seen[0].provenance.claimedMetadata, { source: "console" });
});

test("envelope: claimed identity is inert data and grants no capability", () => {
  const bus = setupBus();
  registerEcho(bus);
  const result = bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_claim",
    kind: "EVENT",
    claimedIdentity: { owner: true, superadmin: true },
    payload: { eventType: "tick" }
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "CAPABILITY_VIOLATION");
});

test("envelope: envelope object is deeply frozen", () => {
  const bus = setupBus();
  const seen = registerCapture(bus);
  submitMessage(bus);
  const env = seen[0];
  assert.throws(() => {
    "use strict";
    env.kind = "COMMAND";
  });
  assert.throws(() => {
    "use strict";
    env.payload.text = "mutated";
  });
  assert.equal(Object.isFrozen(env), true);
  assert.equal(Object.isFrozen(env.payload), true);
  assert.equal(Object.isFrozen(env.provenance), true);
});

test("envelope: digest is stable for identical content and sensitive to payload change", () => {
  const bounds = ib.resolveBounds();
  const build = (payloadText, receivedAt) =>
    ib.buildEnvelope(
      {
        interactionId: "ix_1",
        sessionId: "ses_1",
        origin: "TEST",
        kind: "MESSAGE",
        receivedAt,
        payload: { text: payloadText },
        provenance: { transportId: "tpt.test", origin: "TEST" }
      },
      bounds
    );
  const a = ib.interactionDigest(build("same", 1000));
  const b = ib.interactionDigest(build("same", 999999));
  const c = ib.interactionDigest(build("different", 1000));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("envelope: deadline ISO strings parse with real time semantics", () => {
  const bounds = ib.resolveBounds();
  const early = ib.buildEnvelope(
    {
      interactionId: "ix_d1",
      sessionId: "ses_d",
      origin: "TEST",
      kind: "MESSAGE",
      receivedAt: Date.parse("2026-01-01T00:00:00Z"),
      payload: { text: "x" },
      deadline: "2030-01-01T00:00:00.000Z",
      provenance: { transportId: "tpt.test", origin: "TEST" }
    },
    bounds
  );
  assert.equal(early.deadline.at, Date.parse("2030-01-01T00:00:00.000Z"));
  assert.equal(early.deadline.expiredAtReceipt, false);
  const late = ib.buildEnvelope(
    {
      interactionId: "ix_d2",
      sessionId: "ses_d",
      origin: "TEST",
      kind: "MESSAGE",
      receivedAt: Date.parse("2040-01-01T00:00:00Z"),
      payload: { text: "x" },
      deadline: "2030-01-01T00:00:00.000Z",
      provenance: { transportId: "tpt.test", origin: "TEST" }
    },
    bounds
  );
  assert.equal(late.deadline.expiredAtReceipt, true);
});

test("envelope: invalid deadlines reject explicitly", () => {
  const bounds = ib.resolveBounds();
  for (const bad of ["not-a-date", -5, 0, Number.NaN, {}, []]) {
    assert.throws(
      () =>
        ib.buildEnvelope(
          {
            interactionId: "ix_x",
            sessionId: "ses_x",
            origin: "TEST",
            kind: "MESSAGE",
            receivedAt: 1000,
            payload: { text: "x" },
            deadline: bad,
            provenance: { transportId: "tpt.test", origin: "TEST" }
          },
          bounds
        ),
      /INVALID_DEADLINE/,
      `deadline ${String(bad)} should reject`
    );
  }
});

test("envelope: contextRefs enforce bounds and reject path-like types", () => {
  const bounds = ib.resolveBounds({ maxContextRefs: 2 });
  const base = {
    interactionId: "ix_r",
    sessionId: "ses_r",
    origin: "TEST",
    kind: "MESSAGE",
    receivedAt: 1000,
    payload: { text: "x" },
    provenance: { transportId: "tpt.test", origin: "TEST" }
  };
  assert.throws(
    () =>
      ib.buildEnvelope(
        {
          ...base,
          contextRefs: [
            { type: "doc", ref: "ref-1" },
            { type: "doc", ref: "ref-2" },
            { type: "doc", ref: "ref-3" }
          ]
        },
        bounds
      ),
    /BOUNDS_EXCEEDED/
  );
  assert.throws(
    () => ib.buildEnvelope({ ...base, contextRefs: [{ type: "../escape", ref: "ref-1" }] }, bounds),
    /PAYLOAD_FIELD_INVALID/
  );
});

test("envelope: authEvidenceRefs are strictly schema'd opaque references", () => {
  const bounds = ib.resolveBounds();
  const base = {
    interactionId: "ix_e",
    sessionId: "ses_e",
    origin: "TEST",
    kind: "MESSAGE",
    receivedAt: 1000,
    payload: { text: "x" },
    provenance: { transportId: "tpt.test", origin: "TEST" }
  };
  assert.throws(
    () =>
      ib.buildEnvelope(
        {
          ...base,
          authEvidenceRefs: [
            { provider: "totp_provider", evidenceId: "evd_1", issuedAt: 500, expiresAt: 900, token: "123456" }
          ]
        },
        bounds
      ),
    /PAYLOAD_FIELD_FORBIDDEN/
  );
  assert.throws(
    () =>
      ib.buildEnvelope(
        {
          ...base,
          authEvidenceRefs: [{ provider: "TOTP", evidenceId: "evd_1", issuedAt: 500, expiresAt: 900 }]
        },
        bounds
      ),
    /PAYLOAD_FIELD_INVALID/
  );
  assert.throws(
    () =>
      ib.buildEnvelope(
        {
          ...base,
          authEvidenceRefs: [{ provider: "totp_provider", evidenceId: "evd_1", issuedAt: 900, expiresAt: 500 }]
        },
        bounds
      ),
    /PAYLOAD_FIELD_INVALID/
  );
  const ok = ib.buildEnvelope(
    {
      ...base,
      authEvidenceRefs: [{ provider: "totp_provider", evidenceId: "evd_1", issuedAt: 500, expiresAt: 900 }]
    },
    bounds
  );
  assert.deepEqual(ok.authEvidenceRefs[0], {
    provider: "totp_provider",
    evidenceId: "evd_1",
    issuedAt: 500,
    expiresAt: 900
  });
});

test("envelope: generation must match runtimeGenerationId grammar", () => {
  const bounds = ib.resolveBounds();
  const base = {
    interactionId: "ix_g",
    sessionId: "ses_g",
    origin: "TEST",
    kind: "MESSAGE",
    receivedAt: 1000,
    payload: { text: "x" },
    provenance: { transportId: "tpt.test", origin: "TEST" }
  };
  assert.throws(() => ib.buildEnvelope({ ...base, generation: "../../etc" }, bounds), /INVALID_ID/);
  const ok = ib.buildEnvelope({ ...base, generation: "gen_boot7" }, bounds);
  assert.equal(ok.generation, "gen_boot7");
});

test("envelope: metadata is bounded and prototype-dangerous keys are rejected", () => {
  const bus = setupBus({ bounds: { maxMetadataKeys: 3 } });
  registerEcho(bus);
  const okResult = submitMessage(bus, {
    sessionId: "ses_meta_ok",
    metadata: { language: "id", thread: 3, pinned: true }
  });
  assert.equal(okResult.accepted, true);
  const tooMany = submitMessage(bus, {
    sessionId: "ses_meta_many",
    metadata: { a: 1, b: 2, c: 3, d: 4 }
  });
  assert.equal(tooMany.accepted, false);
  assert.equal(tooMany.reason, "BOUNDS_EXCEEDED");
  const poisoned = bus.submit({
    transportId: "telegram.primary",
    sessionId: "ses_meta_proto",
    kind: "MESSAGE",
    payload: { text: "y" },
    metadata: JSON.parse('{"__proto__": {"x": 1}}')
  });
  assert.equal(poisoned.accepted, false);
});
