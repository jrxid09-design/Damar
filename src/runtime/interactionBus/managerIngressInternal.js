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
  companion: Object.freeze({ origin: "COMPANION", transportId: "channel.companion" })
});

const ORIGIN_TO_CHANNEL = Object.freeze(Object.fromEntries(
  Object.entries(CHANNELS).map(([channel, descriptor]) => [descriptor.origin, channel])
));

const OWN = Object.prototype.hasOwnProperty;
const MEDIA_CONTEXT_BRAND = new WeakSet();

function createMediaContext(entries) {
  const context = Object.freeze({ attachments: Object.freeze(entries) });
  MEDIA_CONTEXT_BRAND.add(context);
  return context;
}

function dataField(value, key) {
  if (!OWN.call(value, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError("INTERACTION_ACCESSOR_REJECTED");
  }
  return descriptor.value;
}

function safeRawEvent(raw) {
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
  return {
    ok: true,
    kind: "MESSAGE",
    sessionId: (typeof rawSessionId === "string" && rawSessionId.startsWith("ses_"))
      ? rawSessionId
      : slugSessionId(rawSessionId) || slugSessionId(userId) || fallbackSessionId("channel"),
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
 */
function createManagerInteractionIngress({ bus, manager, mediaSubsystem = null } = {}) {
  if (!bus || typeof bus.registerTransport !== "function" ||
      typeof bus.registerHandler !== "function" || typeof bus.submit !== "function" ||
      typeof bus.isCanonicalEnvelope !== "function") {
    throw new TypeError("MANAGER_INGRESS_BUS_INVALID");
  }
  if (!manager || typeof manager.handle !== "function") {
    throw new TypeError("MANAGER_INGRESS_MANAGER_INVALID");
  }

  const adapters = new Map();
  for (const [channel, descriptor] of Object.entries(CHANNELS)) {
    const adapterDefinition = channelAdapter(channel);
    adapters.set(channel, createTransportAdapter({
      bus,
      transportId: descriptor.transportId,
      origin: descriptor.origin,
      capabilities: { acceptsText: true, supportsBinaryAttachments: true },
      normalize: safeRawEvent
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
      const managerInput = {
        interactionId: envelope.interactionId,
        channelType,
        channelId: envelope.provenance.transportId,
        peer,
        sessionId: envelope.sessionId,
        correlationId: envelope.correlationId || `cor_${envelope.interactionId.slice(3)}`,
        payload: envelope.payload,
        metadata: envelope.metadata
      };
      const adapter = channelAdapter(channelType);
      context.stream.emit("START", { interactionId: envelope.interactionId });
      const access = envelope.payload.attachments && context.issueMediaAccess
        ? Object.freeze(envelope.payload.attachments.map((a) => context.issueMediaAccess(a.attachmentId, "manager-processing")))
        : Object.freeze([]);
      const mediaContext = createMediaContext(envelope.payload.attachments && context.readMediaAccess
          ? envelope.payload.attachments.map((a, i) => Object.freeze({
              attachmentId: a.attachmentId,
              read: () => context.readMediaAccess(access[i], "manager-processing")
            })) : []);
      try {
        const result = await manager.handle(managerInput, Object.freeze({ mediaContext }));
        context.stream.emit("FINAL", adapter.renderOutbound(result));
        context.stream.emit("COMPLETE", { interactionId: envelope.interactionId });
      } finally {
        if (mediaSubsystem && typeof mediaSubsystem.releaseAccess === "function") for (const handle of access) mediaSubsystem.releaseAccess(handle);
      }
    }
  });

  function ingest(channel, rawEvent) {
    const adapter = adapters.get(channel);
    if (!adapter) return Object.freeze({ accepted: false, code: "CHANNEL_NOT_SUPPORTED" });
    return Object.freeze(adapter.ingestExternalEvent(rawEvent));
  }

  function render(channel, managerResult) {
    const adapter = channelAdapter(channel);
    return Object.freeze(adapter.renderOutbound(managerResult));
  }

  async function ingestAttachments(channel, rawEvent, attachmentSpecs) {
    if (!mediaSubsystem) throw new TypeError("MEDIA_SUBSYSTEM_NOT_BOUND");
    const eventCheck = safeRawEvent(rawEvent);
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
