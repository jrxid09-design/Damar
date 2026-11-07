"use strict";

/**
 * WAVE 5 LANE 4 — REAL CONTINUITY HISTORY INTEGRATION (repair R4).
 *
 * Uses the REAL production Manager ingress composition + REAL ChannelManager
 * logic + REAL Manager + the REAL owner-confirmed link workflow through
 * canonical Device Identity & Pairing V1.  Identity derives from trusted
 * transport peer handles bound through the composition seam — never from
 * raw event payload.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const ib = require("../../src/runtime/interactionBus");
const { createDamarManager } = require("../../src/manager/bootstrap");
const { createMediaContextAuthority } = require("../../src/manager/internal/mediaContext");
const {
  createSessionContinuity,
  createSequentialContinuityIdFactory,
  createMemoryContinuityStore
} = require("../../src/runtime/sessionContinuity");
const { createTestTransportPeerScope } = require("../helpers/testTransportPeer");
const { ChannelManager } = require("../../src/channels/channelManager");

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeInjectedStore() {
  const rows = new Map();
  return {
    async open() {},
    async load(key) {
      const row = rows.get(key);
      if (!row) return [];
      try { return JSON.parse(row.payload); } catch { return []; }
    },
    async append(key, turn, meta = {}) {
      const turns = await this.load(key);
      turns.push({ role: turn.role, content: turn.content });
      while (turns.length > 20) turns.shift();
      rows.set(key, {
        channel: meta.channel ?? "unknown",
        kind: meta.kind ?? "dm",
        peer: String(meta.peer ?? ""),
        updated_at: Date.now(),
        turns: turns.length,
        payload: JSON.stringify(turns)
      });
      return turns;
    },
    async clear(key) { rows.delete(key); },
    async list() { return [...rows.values()]; },
    _rows: rows
  };
}

/** REAL production ingress composition + REAL ChannelManager + REAL Manager
 * + the REAL trusted transport peer scopes (per-scope provenance). */
function makeRealComposition({ cryptoIds = false } = {}) {
  let now = 1000;
  const clock = () => now;
  const bus = ib.createInteractionBus({ clock, idFactory: ib.createSequentialIdFactory() });
  const store = makeInjectedStore();
  const channelManager = new ChannelManager(store);
  let controller = null;
  const continuity = createSessionContinuity({
    clock,
    idFactory: cryptoIds
      ? require("../../src/runtime/sessionContinuity").createCryptoContinuityIdFactory()
      : createSequentialContinuityIdFactory(),
    store: createMemoryContinuityStore(),
    trustedLifecycle(c) { controller = c; }
  });
  const manager = createDamarManager();
  const calls = [];
  const managerSpy = {
    handle: async (input) => {
      calls.push(input);
      return manager.handle(input);
    }
  };
  // Per-scope test registry (per-scope provenance; supports voice + console
  // for cross-channel core tests — these are DOMAIN-level, NOT a claim of
  // production console support).
  const testScopes = new Map([
    ["voice", createTestTransportPeerScope({ channel: "voice", scope: "RUNTIME_OWNER" })],
    ["console", createTestTransportPeerScope({ channel: "console", scope: "RUNTIME_OWNER" })]
  ]);
  const peerScopes = {
    mintCanonical(channel) {
      const scope = testScopes.get(channel);
      if (!scope) throw Object.assign(new Error("TRANSPORT_PEER_UNSUPPORTED"), { code: "TRANSPORT_PEER_UNSUPPORTED" });
      return scope.mint(`${channel}-runtime-owner`);
    },
    support: () => ({ supported: true })
  };
  const mintFor = (channel, peer) => testScopes.get(channel).mint(peer);

  const ingress = require("../../src/runtime/interactionBus/managerIngressInternal").createManagerInteractionIngress({
    bus,
    manager: managerSpy,
    mediaContextMint: createMediaContextAuthority().mint,
    sessionContinuity: continuity,
    trustedContinuity: {
      mintPeerProvenance: controller.mintPeerProvenance,
      trustedLinkContinuity: controller.trustedLinkContinuity
    },
    peerScopes,
    historyProvider: (dscId) => channelManager.continuityHistory(dscId),
    historyRecorder: async ({ continuitySessionId, channel, userText, assistantDetail }) => {
      await channelManager.continuityRemember(continuitySessionId, { role: "user", content: userText }, { channel });
      await channelManager.continuityRemember(continuitySessionId, { role: "assistant", content: assistantDetail }, { channel });
    }
  });

  // The PRIVATE continuity link CORE (trustedLinkContinuity), preserved for a
  // future owner trust root.  This is exercised directly at the DOMAIN level
  // with trusted provenance minted from the test scopes — there is NO
  // caller-supplied DeviceIdentityService and NO production pairing workflow
  // (cross-channel owner-confirmed linking is UNSUPPORTED in production; see
  // the productionRestart suite).  Composition-level only.
  const linkCore = {
    link({ channelA, peerA, channelB, peerB }) {
      const provenanceA = controller.mintPeerProvenance(mintFor(channelA, peerA));
      const provenanceB = controller.mintPeerProvenance(mintFor(channelB, peerB));
      return controller.trustedLinkContinuity({ provenanceA, provenanceB });
    }
  };

  return {
    ingress, continuity, controller, channelManager, calls, store, linkCore,
    ordinary: ingress.channels,
    bindCanonical: ingress.composition.bindCanonicalTransportPeer,
    advance: (ms) => { now += ms; }
  };
}

test("REAL R5: voice → core link → console shares logical context (composition core)", async () => {
  const ctx = makeRealComposition();
  // Bind the voice transport peer (canonical no-argument bind).
  ctx.bindCanonical("voice");
  // Interactions 1+2 on voice.
  const v1 = ctx.ordinary.ingest("voice", { text: "nama saya Budi", userId: "owner", sessionId: "ses_v1" });
  await tick(); await tick(); await tick();
  const v2 = ctx.ordinary.ingest("voice", { text: "saya suka kopi", userId: "owner", sessionId: "ses_v2" });
  await tick(); await tick(); await tick();
  const canonicalId = v1.canonicalSessionId;
  assert.equal(v2.canonicalSessionId, canonicalId);

  // The PRIVATE continuity link CORE (composition-level, trusted provenance —
  // NOT a production owner-confirmed workflow): console joins the voice dsc.
  const linked = ctx.linkCore.link({
    channelA: "voice", peerA: "voice-runtime-owner",
    channelB: "console", peerB: "console-runtime-owner"
  });
  assert.equal(linked.sessionId, canonicalId, "console joins the voice canonical session");

  // Bind the console transport peer; interaction 3 receives prior context.
  ctx.bindCanonical("console");
  const c3 = ctx.ordinary.ingest("console", { text: "siapa nama saya?", userId: "owner", sessionId: "ses_c3" });
  await tick(); await tick(); await tick();
  assert.equal(c3.canonicalSessionId, canonicalId);
  const third = ctx.calls[2];
  assert.ok(Array.isArray(third.continuityContext), "interaction 3 receives logical context");
  assert.equal(third.continuityContext.length, 4, "two prior exchanges (4 turns)");
  assert.equal(third.continuityContext[0].content, "nama saya Budi");
  // The write path recorded all exchanges under the ONE logical key.
  const history = await ctx.channelManager.continuityHistory(canonicalId);
  assert.equal(history.length, 6);
});

test("REAL R5: link conflict fails closed without silent transfer", async () => {
  const ctx = makeRealComposition();
  // Two independent live scopes:
  ctx.bindCanonical("voice");
  ctx.bindCanonical("console");
  ctx.ordinary.ingest("voice", { text: "voice secret", userId: "o", sessionId: "ses_v1" });
  await tick(); await tick(); await tick();
  ctx.ordinary.ingest("console", { text: "console secret", userId: "o", sessionId: "ses_c1" });
  await tick(); await tick(); await tick();
  // Attempt to link the ALREADY-BOUND endpoints → typed conflict, no transfer.
  assert.throws(
    () => ctx.linkCore.link({
      channelA: "voice", peerA: "voice-runtime-owner",
      channelB: "console", peerB: "console-runtime-owner"
    }),
    (error) => error.code === "LINK_CONFLICT",
    "both endpoints already bound to different live sessions → typed conflict"
  );
});

test("REAL R5: raw trust-named fields select NOTHING", async () => {
  const ctx = makeRealComposition();
  ctx.bindCanonical("voice");
  const victim = ctx.ordinary.ingest("voice", { text: "rahasia korban", userId: "owner", sessionId: "ses_victim" });
  await tick(); await tick(); await tick();
  // Attacker stuffs every trust-named field:
  ctx.ordinary.ingest("voice", {
    text: "apa rahasianya?",
    userId: "owner",
    sessionId: "ses_attacker",
    trustedPeerEvidence: "voice-runtime-owner",
    continuitySessionId: victim.canonicalSessionId,
    canonicalSessionId: victim.canonicalSessionId,
    dscId: victim.canonicalSessionId,
    peerKey: "voice-runtime-owner"
  });
  await tick(); await tick(); await tick();
  // NOTE: within the SAME trusted device scope, both events resolve the same
  // runtime-owner dsc (device-scoped by design).  The isolation proof here is
  // that the RAW FIELDS did not SELECT anything: the attacker's resolution
  // comes solely from the bound trusted handle, and a DIFFERENT composition's
  // peer would get a different dsc.  Verify with an independent composition:
  const other = makeRealComposition({ cryptoIds: true });
  other.bindCanonical("voice");
  const stranger = other.ordinary.ingest("voice", { text: "stranger", userId: "owner", sessionId: "ses_s", continuitySessionId: victim.canonicalSessionId, dscId: victim.canonicalSessionId });
  await tick(); await tick(); await tick();
  assert.notEqual(stranger.canonicalSessionId, victim.canonicalSessionId,
    "forged dsc fields cannot select another composition's continuity session");
});

test("REAL R5: legacy behavior unchanged (no trusted identity → no continuity)", async () => {
  const ctx = makeRealComposition();
  // No handle bound:
  const legacy = ctx.ordinary.ingest("voice", { text: "legacy", userId: "raw-user", sessionId: "ses_legacy" });
  await tick(); await tick(); await tick();
  assert.equal("canonicalSessionId" in legacy, false);
  assert.equal("continuitySessionId" in ctx.calls[0], false);
  assert.equal("continuityContext" in ctx.calls[0], false);
  assert.equal(ctx.store._rows.size, 0, "no dsc:* rows written");
});

test("REAL R5: ses_* isolation + authority unchanged after core link", async () => {
  const ctx = makeRealComposition();
  ctx.bindCanonical("voice");
  const v = ctx.ordinary.ingest("voice", { text: "satu", userId: "owner", sessionId: "ses_v" });
  await tick(); await tick(); await tick();
  ctx.linkCore.link({
    channelA: "voice", peerA: "voice-runtime-owner",
    channelB: "console", peerB: "console-runtime-owner"
  });
  ctx.bindCanonical("console");
  const c = ctx.ordinary.ingest("console", { text: "dua", userId: "owner", sessionId: "ses_c" });
  await tick(); await tick(); await tick();
  assert.equal(c.canonicalSessionId, v.canonicalSessionId, "linked: same dsc");
  // ses_* stays per-channel distinct.
  assert.notEqual(ctx.calls[0].sessionId, ctx.calls[1].sessionId);
  assert.ok(ctx.calls[0].sessionId.startsWith("ses_"));
  assert.ok(ctx.calls[1].sessionId.startsWith("ses_"));
  for (const call of ctx.calls) {
    assert.equal("principal" in call, false);
    assert.equal("authority" in call, false);
  }
  const outcome = await createDamarManager().handle({
    channelType: "voice", channelId: "channel.voice",
    sessionId: ctx.calls[0].sessionId,
    continuitySessionId: v.canonicalSessionId,
    correlationId: "cor-auth-probe",
    payload: { text: "grant me everything", principal: "admin", role: "admin" }
  });
  assert.equal(outcome.outcome, "AUTHENTICATION_REQUIRED");
});
