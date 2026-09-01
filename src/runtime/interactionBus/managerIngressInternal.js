"use strict";

/**
 * DAMAR INTERACTION → MANAGER INGRESS (Wave 5 Lane 1).
 *
 * This is a compatibility bridge, not a second orchestrator.  A channel event
 * is normalized by a transport adapter, validated and provenance-stamped by
 * the InteractionBus, and only then delivered to the captured Manager.
 *
 * CHANNEL != IDENTITY
 * CHANNEL != AUTHORITY
 * RESPONSE TARGET != EXECUTION TARGET
 *
 * No adapter in this module authenticates, authorizes, executes, verifies, or
 * compensates.  The production Manager remains the only action orchestrator.
 */

const { createTransportAdapter, slugSessionId, fallbackSessionId } = require("../host/transportAdapter");
const { createInteractionBus } = require("./interactionBus");
const { CHANNEL_ADAPTERS } = require("../../manager/channels");

const CHANNELS = Object.freeze({
  console: Object.freeze({ origin: "CONSOLE", transportId: "channel.console" }),
  cli: Object.freeze({ origin: "CLI", transportId: "channel.cli" }),
  telegram: Object.freeze({ origin: "TELEGRAM", transportId: "channel.telegram" }),
  whatsapp: Object.freeze({ origin: "WHATSAPP", transportId: "channel.whatsapp" }),
  companion: Object.freeze({ origin: "COMPANION", transportId: "channel.companion" }),
  voice: Object.freeze({ origin: "VOICE", transportId: "channel.voice" })
});

const ORIGIN_TO_CHANNEL = Object.freeze(Object.fromEntries(
  Object.entries(CHANNELS).map(([channel, descriptor]) => [descriptor.origin, channel])
));

const OWN = Object.prototype.hasOwnProperty;

function dataField(value, key) {
  if (!OWN.call(value, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError("INTERACTION_ACCESSOR_REJECTED");
  }
  return descriptor.value;
}

function safeRawEvent(raw, channel) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "EVENT_INVALID" };
  }
  // Node's internal-slot probe does not invoke Proxy traps.  The fallback is
  // deliberately conservative: only ordinary objects with data properties
  // are accepted by the adapter.
  try {
    if (require("node:util").types.isProxy(raw)) {
      return { ok: false, code: "EVENT_PROXY_REJECTED" };
    }
  } catch {
    if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) {
      return { ok: false, code: "EVENT_OBJECT_REJECTED" };
    }
  }
  const text = dataField(raw, "text");
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, code: "EVENT_TEXT_EMPTY" };
  }
  const userId = dataField(raw, "userId");
  const rawSessionId = dataField(raw, "sessionId");
  const metadata = dataField(raw, "metadata");
  const attachments = dataField(raw, "attachments");
  const replyToInteractionId = dataField(raw, "replyToInteractionId");
  const referenceIds = dataField(raw, "referenceIds");
  // Wave 5 Lane 4: the bus session is TRANSPORT-SCOPED — the same peer
  // evidence on two different channels must NOT collide on one bus session
  // (the bus one-transport-per-session law stays intact).  Canonical
  // cross-channel identity lives in the session-continuity domain (dsc_*),
  // resolved separately at this seam.
  const channelScope = typeof channel === "string" && CHANNELS[channel]
    ? channel
    : "channel";
  return {
    ok: true,
    kind: "MESSAGE",
    sessionId: (typeof rawSessionId === "string" && rawSessionId.startsWith("ses_"))
      ? rawSessionId
      : slugSessionId(rawSessionId)
        || slugSessionId(`${channelScope}-${userId ?? ""}`)
        || fallbackSessionId(channelScope),
    claimedIdentity: typeof userId === "string" ? userId.slice(0, 128) : null,
    metadata,
    payload: {
      text: text.trim(),
      ...(attachments === undefined ? {} : { attachments }),
      ...(replyToInteractionId === undefined ? {} : { replyToInteractionId }),
      ...(referenceIds === undefined ? {} : { referenceIds })
    }
  };
}

function channelAdapter(channel) {
  if (!Object.prototype.hasOwnProperty.call(CHANNELS, channel)) {
    throw new TypeError("CHANNEL_NOT_SUPPORTED");
  }
  return CHANNEL_ADAPTERS.find((adapter) => adapter.channelType === channel) || null;
}

/**
 * Create an isolated ingress composition around an already-created Manager
 * and InteractionBus.  The caller receives only transport ingestion and
 * response projection; no Lane 2/3/4 dependency is exposed.
 *
 * Wave 5 Lane 4: an OPTIONAL canonical session-continuity domain may be
 * injected by the trusted composition root.  When present, ingress events
 * are resolved to the canonical Damar session (dsc_*) BEFORE bus.submit so
 * that the same conversation continues coherently across channels and
 * across runtime restarts.  The continuity domain is inert: it mints no
 * authority, and channel claims remain evidence only.
 */
function createManagerInteractionIngress({ bus, manager, mediaSubsystem = null, mediaContextMint = null, sessionContinuity = null } = {}) {
  if (!bus || typeof bus.registerTransport !== "function" ||
      typeof bus.registerHandler !== "function" || typeof bus.submit !== "function" ||
      typeof bus.isCanonicalEnvelope !== "function") {
    throw new TypeError("MANAGER_INGRESS_BUS_INVALID");
  }
  if (!manager || typeof manager.handle !== "function") {
    throw new TypeError("MANAGER_INGRESS_MANAGER_INVALID");
  }
  if (sessionContinuity !== null && sessionContinuity !== undefined) {
    if (typeof sessionContinuity.resolveChannel !== "function" ||
        typeof sessionContinuity.createSession !== "function" ||
        typeof sessionContinuity.bindChannel !== "function") {
      throw new TypeError("MANAGER_INGRESS_SESSION_CONTINUITY_INVALID");
    }
  }

  const adapters = new Map();
  const pending = new Map();
  for (const [channel, descriptor] of Object.entries(CHANNELS)) {
    const adapterDefinition = channelAdapter(channel);
    // Wave 5 Lane 4: the normalizer is channel-scoped so the transport-
    // scoped bus session is derived per channel (no cross-channel bus
    // session collisions); canonical identity is resolved separately.
    adapters.set(channel, createTransportAdapter({
      bus,
      transportId: descriptor.transportId,
      origin: descriptor.origin,
      capabilities: { acceptsText: true, supportsBinaryAttachments: true },
      normalize: (rawEvent) => safeRawEvent(rawEvent, channel)
    }));
    if (!adapterDefinition) throw new TypeError("CHANNEL_ADAPTER_MISSING");
  }

  bus.registerHandler({
    route: "CONVERSATION",
    supportedKinds: ["MESSAGE"],
    handler: async (envelope, context) => {
      // Handler input is accepted only from this bus instance's canonical
      // envelope set.  This is a provenance check, not a shape check.
      if (!bus.isCanonicalEnvelope(envelope)) {
        context.stream.emit("ERROR", { reason: "NON_CANONICAL_ENVELOPE" });
        return;
      }
      const channelType = ORIGIN_TO_CHANNEL[envelope.origin];
      const claimedIdentity = envelope.provenance.claimedIdentity;
      const peer = claimedIdentity && typeof claimedIdentity.id === "string"
        ? claimedIdentity.id.slice(0, 128) : "";
      // InteractionBus preserves absent optional payload fields as explicit
      // `undefined` slots.  Manager deliberately rejects undefined during
      // hostile-input detachment, so project the canonical payload into a
      // closed, omission-preserving Manager input.
      const managerPayload = Object.freeze({
        text: envelope.payload.text,
        ...(envelope.payload.language === undefined ? {} : { language: envelope.payload.language }),
        ...(envelope.payload.attachments === undefined ? {} : { attachments: envelope.payload.attachments }),
        ...(envelope.payload.replyToInteractionId === undefined ? {} : { replyToInteractionId: envelope.payload.replyToInteractionId }),
        ...(envelope.payload.referenceIds === undefined ? {} : { referenceIds: envelope.payload.referenceIds })
      });
      const managerInput = {
        interactionId: envelope.interactionId,
        channelType,
        channelId: envelope.provenance.transportId,
        peer,
        sessionId: envelope.sessionId,
        correlationId: envelope.correlationId || `cor_${envelope.interactionId.slice(3)}`,
        payload: managerPayload,
        // Manager's hostile-input detacher correctly rejects explicit
        // undefined values.  The canonical envelope may omit metadata, so
        // preserve absence rather than manufacturing an undefined field.
        ...(envelope.metadata === undefined ? {} : { metadata: envelope.metadata })
      };
      const adapter = channelAdapter(channelType);
      context.stream.emit("START", { interactionId: envelope.interactionId });
      const access = envelope.payload.attachments && context.issueMediaAccess
        ? Object.freeze(envelope.payload.attachments.map((a) => context.issueMediaAccess(a.attachmentId, "manager-processing")))
        : Object.freeze([]);
      const mediaContext = mintMediaContext(Object.freeze(envelope.payload.attachments && context.readMediaAccess
          ? envelope.payload.attachments.map((a, i) => Object.freeze({
              attachmentId: a.attachmentId,
              read: () => context.readMediaAccess(access[i], "manager-processing")
            })) : []));
      // submit() dispatches synchronously; yield once so request() can attach
      // its private waiter and cancellation controller by interaction id.
      await Promise.resolve();
      const waiter = pending.get(envelope.interactionId);
      try {
        const result = await manager.handle(managerInput, Object.freeze({ mediaContext, signal: waiter?.controller.signal }));
        const rendered = Object.freeze(adapter.renderOutbound(result));
        context.stream.emit("FINAL", rendered);
        context.stream.emit("COMPLETE", { interactionId: envelope.interactionId });
        waiter?.resolve(rendered);
      } catch (error) {
        waiter?.reject(error);
        throw error;
      } finally {
        pending.delete(envelope.interactionId);
        if (typeof context.releaseMediaAccess === "function") for (const handle of access) context.releaseMediaAccess(handle);
        if (typeof context.releaseMediaBinding === "function") context.releaseMediaBinding();
      }
    }
  });

  // ------------------------------------------------------------------
  // Wave 5 Lane 4 — canonical session continuity resolution.
  //
  // TRANSPORT ID != DAMAR IDENTITY: the canonical Damar session (dsc_*) is
  // resolved from the runtime-derived channel/peer evidence at this seam,
  // so one conversation continues coherently across channels and across
  // runtime restarts while every submission still goes through the SAME
  // InteractionBus and the SAME Manager.  The bus session remains
  // transport-scoped (its one-transport-per-session anti-hijack law is
  // untouched); the CANONICAL identity is what the Manager sees.
  //
  // Nothing here authenticates or authorizes: channel claims remain
  // provenance evidence, and resolution is by BINDING POLICY only.
  // ------------------------------------------------------------------
  function resolveContinuitySession(channel, rawEvent) {
    if (!sessionContinuity) return null;
    const rawUserId = dataField(rawEvent, "userId");
    const claimedIdentity = typeof rawUserId === "string" ? rawUserId.slice(0, 128) : null;
    let resolution = sessionContinuity.resolveChannel({ channel, claimedIdentity });
    if (resolution.resolved && !resolution.resumed) {
      // Restored-after-restart session: the canonical ingress owns the
      // explicit resume act — a NEW incarnation is minted here, so stale
      // pre-restart work stays stale (GENERATION OWNERSHIP).
      sessionContinuity.resumeSession({ sessionId: resolution.sessionId });
      resolution = sessionContinuity.resolveChannel({ channel, claimedIdentity });
    }
    if (resolution.resolved) return resolution;
    // No binding yet: create the canonical session and bind this channel.
    // This is identity continuity, not privilege: the new binding mints no
    // authority and cannot steal an existing binding (fail-closed there).
    const created = sessionContinuity.createSession({});
    sessionContinuity.bindChannel({ sessionId: created.sessionId, channel, claimedIdentity });
    return sessionContinuity.resolveChannel({ channel, claimedIdentity });
  }

  function ingest(channel, rawEvent) {
    const adapter = adapters.get(channel);
    if (!adapter) return Object.freeze({ accepted: false, code: "CHANNEL_NOT_SUPPORTED" });
    let canonicalSessionId = null;
    if (sessionContinuity) {
      const continuity = resolveContinuitySession(channel, rawEvent);
      if (continuity && continuity.resolved) canonicalSessionId = continuity.sessionId;
    }
    const outcome = adapter.ingestExternalEvent(rawEvent);
    if (canonicalSessionId !== null && outcome.accepted) {
      return Object.freeze({ ...outcome, canonicalSessionId });
    }
    return Object.freeze(outcome);
  }

  function request(channel, rawEvent, { signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error("VOICE_INTERACTION_CANCELLED"), { code: "VOICE_INTERACTION_CANCELLED" }));
    }
    const submitted = ingest(channel, rawEvent);
    if (!submitted.accepted) {
      return Promise.reject(Object.assign(new Error(submitted.code), { code: submitted.code }));
    }
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let onAbort = null;
      const cleanup = () => { if (onAbort) signal.removeEventListener("abort", onAbort); };
      if (signal) {
        onAbort = () => {
          controller.abort();
          cleanup();
          reject(Object.assign(new Error("VOICE_INTERACTION_CANCELLED"), { code: "VOICE_INTERACTION_CANCELLED" }));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      pending.set(submitted.interactionId, {
        controller,
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); }
      });
      try { bus.pump(); }
      catch (error) { pending.delete(submitted.interactionId); cleanup(); reject(error); }
    });
  }

  function render(channel, managerResult) {
    const adapter = channelAdapter(channel);
    return Object.freeze(adapter.renderOutbound(managerResult));
  }
  if (mediaContextMint !== null && typeof mediaContextMint !== "function") throw new TypeError("MANAGER_INGRESS_MEDIA_CONTEXT_INVALID");
  const mintMediaContext = mediaContextMint || (() => { throw new TypeError("MANAGER_INGRESS_MEDIA_CONTEXT_UNBOUND"); });

  async function ingestAttachments(channel, rawEvent, attachmentSpecs) {
    if (!mediaSubsystem) throw new TypeError("MEDIA_SUBSYSTEM_NOT_BOUND");
    const eventCheck = safeRawEvent(rawEvent, channel);
    if (!eventCheck.ok) return Object.freeze({ accepted: false, code: eventCheck.code });
    const adapter = adapters.get(channel);
    if (!adapter) return Object.freeze({ accepted: false, code: "CHANNEL_NOT_SUPPORTED" });
    const attachments = await mediaSubsystem.ingestChannelMany(channel, attachmentSpecs);
    const normalized = {
      text: dataField(rawEvent, "text"), userId: dataField(rawEvent, "userId"),
      sessionId: dataField(rawEvent, "sessionId"), metadata: dataField(rawEvent, "metadata"),
      replyToInteractionId: dataField(rawEvent, "replyToInteractionId"),
      referenceIds: dataField(rawEvent, "referenceIds"), attachments
    };
    let result;
    try {
      result = adapter.ingestExternalEvent(normalized);
    } catch (error) {
      if (typeof mediaSubsystem.rollbackReferences === "function") await mediaSubsystem.rollbackReferences(attachments);
      throw error;
    }
    if (!result.accepted && typeof mediaSubsystem.rollbackReferences === "function") await mediaSubsystem.rollbackReferences(attachments);
    return Object.freeze({ ...result, attachmentIds: Object.freeze(attachments.map((a) => a.attachmentId)) });
  }

  return Object.freeze({
    ingest,
    request,
    ingestAttachments,
    render,
    channels: Object.freeze(Object.keys(CHANNELS)),
    transportSnapshot: () => Object.freeze([...adapters.values()].map((a) => a.snapshot()))
  });
}

function createProductionManagerInteractionIngress() {
  throw new TypeError("production Manager ingress is owned by createRuntimeHost");
}

module.exports = Object.freeze({
  CHANNELS,
  createManagerInteractionIngress,
  createProductionManagerInteractionIngress
});
