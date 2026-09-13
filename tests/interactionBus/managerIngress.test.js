"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");
const { createManagerInteractionIngress } = require("../../src/runtime/interactionBus/managerIngressInternal");
const { createMediaContextAuthority } = require("../../src/manager/internal/mediaContext");

function makeIngress() {
  const bus = ib.createInteractionBus({
    clock: () => 1000,
    idFactory: ib.createSequentialIdFactory()
  });
  const calls = [];
  const manager = {
    async handle(input) {
      calls.push(input);
      return Object.freeze({
        managerRequestId: "req-1",
        outcome: "COMPLETED",
        lifecycleState: "COMPLETED",
        detail: "cognition"
      });
    }
  };
  const mediaContextAuthority = createMediaContextAuthority();
  return { bus, calls, manager, ingress: createManagerInteractionIngress({ bus, manager, mediaContextMint: mediaContextAuthority.mint }) };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("manager ingress supports the five existing channels plus voice through one canonical bus boundary", async () => {
  const { ingress, calls } = makeIngress();
  assert.deepEqual(ingress.channels.channels, ["console", "cli", "telegram", "whatsapp", "companion", "voice"]);
  for (const channel of ingress.channels.channels) {
    const accepted = ingress.channels.ingest(channel, { text: `hello-${channel}`, userId: `${channel}-user` });
    assert.equal(accepted.accepted, true, channel);
  }
  await tick();
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((call) => call.channelType), ingress.channels.channels);
  assert.ok(calls.every((call) => call.sessionId.startsWith("ses_")));
  assert.ok(calls.every((call) => Object.isFrozen(call.payload)));
});

test("request facade awaits the same bus-routed Manager result", async () => {
  const { ingress, calls } = makeIngress();
  const result = await ingress.channels.request("voice", { text: "canonical", userId: "claimed", sessionId: "ses_voice_request" });
  assert.equal(result.detail, "cognition");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channelType, "voice");
  assert.equal(calls[0].channelId, "channel.voice");
});

test("manager ingress rejects raw attachments that bypass MediaIngress", async () => {
  const { ingress, calls } = makeIngress();
  const raw = {
    text: "before", userId: "user-1",
    attachments: [{ attachmentId: "att_1", mediaType: "text/plain", sizeBytes: 1, contentRef: "ref-1", name: "note.txt" }],
    metadata: { authority: "inert-claim" }
  };
  const result = ingress.channels.ingest("console", raw);
  assert.equal(result.accepted, false);
  assert.equal(result.code, "FOREIGN_MEDIA_REFERENCE");
  await tick();
  assert.equal(calls.length, 0);
});
test("invalid and hostile channel input fails closed without invoking Manager", async () => {
  const { ingress, calls } = makeIngress();
  assert.deepEqual(ingress.channels.ingest("unknown", { text: "x" }), {
    accepted: false,
    code: "CHANNEL_NOT_SUPPORTED"
  });
  assert.equal(ingress.channels.ingest("console", { text: "" }).accepted, false);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "text", {
    enumerable: true,
    get() { getterCalls += 1; return "trap"; }
  });
  assert.equal(ingress.channels.ingest("console", accessor).accepted, false);
  assert.equal(getterCalls, 0);

  const hostile = new Proxy({ text: "trap" }, {
    get() { throw new Error("proxy trap"); }
  });
  assert.equal(ingress.channels.ingest("console", hostile).accepted, false);
  await tick();
  assert.equal(calls.length, 0);
});

test("canonical envelope recognition is bus-local and copies are foreign", () => {
  const { bus } = makeIngress();
  let seen = null;
  // A separate handler is intentionally not installed: this proof observes
  // the public predicate on a bus-created envelope through a tiny second bus
  // composition with the same canonical transport contract.
  const captureBus = ib.createInteractionBus({
    clock: () => 1000,
    idFactory: ib.createSequentialIdFactory(10)
  });
  captureBus.registerTransport({ transportId: "capture.console", origin: "CONSOLE", capabilities: { acceptsText: true } });
  captureBus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: (envelope, context) => {
      seen = envelope;
      context.stream.emit("START");
      context.stream.emit("COMPLETE");
    }
  });
  captureBus.submit({
    transportId: "capture.console",
    sessionId: "ses_capture",
    kind: "MESSAGE",
    payload: { text: "x" }
  });
  assert.equal(captureBus.isCanonicalEnvelope(seen), true);
  assert.equal(bus.isCanonicalEnvelope(seen), false);
  assert.equal(captureBus.isCanonicalEnvelope({ ...seen }), false);
  assert.equal(captureBus.isCanonicalEnvelope(Object.create(seen)), false);
});

test("routing projection cannot become execution authority", () => {
  const { ingress } = makeIngress();
  const projection = ingress.channels.render("telegram", {
    managerRequestId: "req-1",
    outcome: "AUTHORITY_DENIED",
    lifecycleState: "FAILED",
    detail: "denied"
  });
  assert.equal(projection.outcome, "AUTHORITY_DENIED");
  assert.equal("authority" in projection, false);
  assert.equal("execute" in projection, false);
  assert.equal("grant" in projection, false);
  assert.equal(Object.isFrozen(projection), true);
});

test("production ingress cannot create a second media ownership domain", () => {
  assert.throws(
    () => require("../../src/runtime/interactionBus/managerIngressInternal").createProductionManagerInteractionIngress(),
    /owned by createRuntimeHost/
  );
});

test("production bootstrap contains only one Manager composition site", () => {
  const fs = require("node:fs");
  // DB-02 (Repair5): the canonical Manager composition moved from
  // src/manager/bootstrap.js into src/manager/internal/managerBootstrap.js
  // itself, so the privileged wave6Adapter dependency stays lexically
  // captured inside the SAME closure that owns it and never crosses an
  // exported function boundary. src/manager/bootstrap.js is now a thin
  // re-export with no composition call of its own.
  const bootstrapSource = fs.readFileSync(require.resolve("../../src/manager/bootstrap"), "utf8");
  assert.equal((bootstrapSource.match(/composeManagerInternal\s*\(/g) || []).length, 0,
    "src/manager/bootstrap.js must contain no composition call of its own");
  const internalSource = fs.readFileSync(require.resolve("../../src/manager/internal/managerBootstrap"), "utf8");
  assert.equal((internalSource.match(/canonicalManager\s*=\s*composeManagerInternal\s*\(/g) || []).length, 1,
    "exactly one site assigns the canonical Manager singleton");
  const { createDamarManager } = require("../../src/manager/bootstrap");
  assert.equal(createDamarManager(), createDamarManager());
});
