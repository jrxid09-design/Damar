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
 * Wave 5 Lane 4 (repair R3, DSC-R2-001/005/006): the TRUSTED COMPOSITION
 * supplies:
 *
 *   sessionContinuity        — the PUBLIC inert continuity facade
 *   trustedContinuity        — { mintPeerProvenance, trustedLinkContinuity }
 *                              held ONLY by the trusted composition closure
 *   transportIdentity        — a TransportIdentityRegistry that the trusted
 *                              composition itself populated from
 *                              TRANSPORT-OWNED identity derivation
 *
 * DSC-R2-001: peer provenance is minted EXCLUSIVELY from TRANSPORT-OWNED
 * identity registered at composition time.  The raw event object is NEVER
 * consulted for continuity trust evidence — no field (trustedPeerEvidence,
 * continuitySessionId, canonicalSessionId, userId, peerKey, dscId, or any
 * other) on a raw caller event can establish continuity identity.  The
 * registered transport identity is an internal branded object that no
 * caller can construct through host.channels.ingest().
 *
 * DSC-R2-005: the ORDINARY channel facade exposes ONLY channel interaction
 * operations.  Global continuity lifecycle (restore/flush/shutdown/status)
 * lives on a SEPARATE trusted-lifecycle facade returned to the trusted
 * composition root only.
 */
function createManagerInteractionIngress({ bus, manager, mediaSubsystem = null, mediaContextMint = null, sessionContinuity = null, trustedContinuity = null, transportIdentity = null, historyRecorder = undefined, historyProvider = undefined, continuityStoreHandle = null } = {}) {
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
        typeof sessionContinuity.bindChannel !== "function" ||
        typeof sessionContinuity.captureAdmissionOwnership !== "function") {
      throw new TypeError("MANAGER_INGRESS_SESSION_CONTINUITY_INVALID");
    }
  }
  if (continuityStoreHandle !== null && continuityStoreHandle !== undefined) {
    if (typeof continuityStoreHandle.shutdown !== "function" &&
        typeof continuityStoreHandle.finalizeShutdown !== "function") {
      throw new TypeError("MANAGER_INGRESS_CONTINUITY_STORE_HANDLE_INVALID");
    }
  }
  // DSC-R1-001/006 + DSC-R2-001: continuity REQUIRES the trusted provenance
  // mint AND a trusted transport-identity registry.  Without both, no
  // binding can ever form (fail closed).
  if (sessionContinuity) {
    if (trustedContinuity === null || trustedContinuity === undefined ||
        typeof trustedContinuity.mintPeerProvenance !== "function") {
      throw new TypeError("MANAGER_INGRESS_TRUSTED_CONTINUITY_REQUIRED");
    }
    if (transportIdentity === null || transportIdentity === undefined ||
        typeof transportIdentity.resolve !== "function") {
      throw new TypeError("MANAGER_INGRESS_TRANSPORT_IDENTITY_REQUIRED");
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
      // submit() dispatches synchronously; yield once so ingest() can attach
      // the admission ownership tuple by interaction id BEFORE the Manager
      // input is formed (request() likewise attaches its waiter here).
      await Promise.resolve();
      // DSC-R1-002: the ADMISSION ownership tuple captured at ingest.  It
      // carries the incarnation at admission — the ONLY incarnation any
      // completion-side operation may use.  There is deliberately NO
      // completion-side re-derivation or refresh path.
      const admission = continuityByInteraction.get(envelope.interactionId) ?? null;
      const continuitySessionId = admission ? admission.sessionId : null;
      const incarnationAtAdmission = admission ? admission.incarnationAtAdmission : null;
      // DSC-R1-004: logical conversation context.  When trusted continuity
      // identity exists, prior logical-conversation turns are read through
      // the EXISTING ChannelManager/SessionStore seam (dsc:* key) and passed
      // to the Manager as inert context provenance.  Unbound/legacy events
      // get exactly the previous behavior.
      let continuityContext = null;
      if (continuitySessionId !== null && typeof readContinuityHistory === "function") {
        try {
          const priorTurns = await readContinuityHistory(continuitySessionId);
          if (Array.isArray(priorTurns) && priorTurns.length > 0) {
            continuityContext = Object.freeze(
              priorTurns.slice(-20).map((t) => Object.freeze({
                role: t.role === "assistant" ? "assistant" : "user",
                content: typeof t.content === "string" ? t.content.slice(0, 4096) : ""
              }))
            );
          }
        } catch {
          continuityContext = null; // fail-soft: history never blocks flow
        }
      }
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
        // DSC-005: transport session (ses_*) stays the bus transport-session
        // identity; the canonical continuity identity (dsc_*) is passed as
        // TRUSTED provenance minted by the continuity resolver at this seam
        // — never from caller-provided metadata.  Manager can distinguish
        // the two; neither is authority.
        sessionId: envelope.sessionId,
        ...(continuitySessionId === null ? {} : { continuitySessionId }),
        ...(continuityContext === null ? {} : { continuityContext }),
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
      const waiter = pending.get(envelope.interactionId);
      try {
        const result = await manager.handle(managerInput, Object.freeze({ mediaContext, signal: waiter?.controller.signal }));
        const rendered = Object.freeze(adapter.renderOutbound(result));
        context.stream.emit("FINAL", rendered);
        context.stream.emit("COMPLETE", { interactionId: envelope.interactionId });
        waiter?.resolve(rendered);
        // DSC-R1-002 + DSC-004: atomic terminal commit using the ADMISSION
        // incarnation — NEVER re-read currentIncarnation() at completion.
        // If the session resumed while this interaction was in flight, the
        // admission incarnation is now stale and the commit fails
        // STALE_GENERATION, leaving the new incarnation's ledger untouched.
        // Failures are contained (they must not break the bus handler that
        // has already completed its canonical stream).
        if (sessionContinuity && continuitySessionId !== null && incarnationAtAdmission !== null) {
          try {
            sessionContinuity.commitTerminalOutcome({
              sessionId: continuitySessionId,
              interactionId: envelope.interactionId,
              generation: incarnationAtAdmission,
              state: "COMPLETED"
            });
          } catch {
            // Stale-admission or idempotent outcomes are decided inside the
            // domain; old work can never mutate the new incarnation.
          }
          // DSC-R1-004: logical-conversation continuity WRITE.  Record the
          // exchange under the trusted dsc_* logical key through the EXISTING
          // channel/history seam (ChannelManager) — never a parallel history
          // system, never auto-merging legacy per-channel records.  Fail-soft:
          // history storage problems must never break canonical flow.
          if (typeof recordContinuityTurn === "function") {
            try {
              await recordContinuityTurn({
                continuitySessionId,
                channel: channelType,
                userText: typeof envelope.payload.text === "string" ? envelope.payload.text : "",
                assistantDetail: typeof rendered.detail === "string" ? rendered.detail : ""
              });
            } catch {
              // fail-soft: continuity history is best-effort
            }
          }
        }
      } catch (error) {
        // DSC-R1-002: errors use the SAME captured admission tuple.
        if (sessionContinuity && continuitySessionId !== null && incarnationAtAdmission !== null) {
          try {
            sessionContinuity.commitTerminalOutcome({
              sessionId: continuitySessionId,
              interactionId: envelope.interactionId,
              generation: incarnationAtAdmission,
              state: "FAILED"
            });
          } catch {
            // contained: stale/idempotent decisions stay in the domain
          }
        }
        waiter?.reject(error);
        throw error;
      } finally {
        pending.delete(envelope.interactionId);
        continuityByInteraction.delete(envelope.interactionId);
        if (typeof context.releaseMediaAccess === "function") for (const handle of access) releaseHandleSafe(context, handle);
        if (typeof context.releaseMediaBinding === "function") context.releaseMediaBinding();
      }
    }
  });

  function releaseHandleSafe(context, handle) {
    try { context.releaseMediaAccess(handle); } catch { /* idempotent */ }
  }

  // ------------------------------------------------------------------
  // DSC-R1-004 — logical-conversation history READ + WRITE through the
  // EXISTING ChannelManager/SessionStore seam.
  //
  // The trusted composition may inject a history reader/recorder bound to
  // the canonical ChannelManager (src/channels).  Default: the canonical
  // channelManager instance, keyed by the trusted dsc_* logical key.
  // Unbound/legacy channels continue unchanged; nothing is auto-merged.
  // The continuitySessionId used for BOTH read and write comes only from
  // the trusted continuity resolver — caller-supplied dsc_* never selects
  // history.
  // ------------------------------------------------------------------
  let recordContinuityTurn = null;
  if (historyRecorder !== undefined) {
    if (historyRecorder !== null && typeof historyRecorder !== "function") {
      throw new TypeError("MANAGER_INGRESS_HISTORY_RECORDER_INVALID");
    }
    recordContinuityTurn = historyRecorder;
  } else {
    recordContinuityTurn = async ({ continuitySessionId, channel, userText, assistantDetail }) => {
      const { channelManager } = require("../../channels");
      await channelManager.continuityRemember(continuitySessionId, {
        role: "user", content: String(userText).slice(0, 4096)
      }, { channel });
      await channelManager.continuityRemember(continuitySessionId, {
        role: "assistant", content: String(assistantDetail).slice(0, 4096)
      }, { channel });
    };
  }

  let readContinuityHistory = null;
  if (historyProvider !== undefined) {
    if (historyProvider !== null && typeof historyProvider !== "function") {
      throw new TypeError("MANAGER_INGRESS_HISTORY_PROVIDER_INVALID");
    }
    readContinuityHistory = historyProvider;
  } else {
    readContinuityHistory = async (continuitySessionId) => {
      const { channelManager } = require("../../channels");
      return channelManager.continuityHistory(continuitySessionId);
    };
  }

  // ------------------------------------------------------------------
  // Wave 5 Lane 4 (repair R3) — canonical session continuity resolution.
  //
  // TRANSPORT ID != DAMAR IDENTITY: the canonical Damar session (dsc_*) is
  // resolved at this TRUSTED seam, so one conversation continues coherently
  // across channels and across runtime restarts while every submission still
  // goes through the SAME InteractionBus and the SAME Manager.  The bus
  // session remains transport-scoped (its one-transport-per-session
  // anti-hijack law is untouched).
  //
  // DSC-R2-001: peer provenance is minted EXCLUSIVELY from TRANSPORT-OWNED
  // identity REGISTERED in the trusted composition's TransportIdentity
  // registry at composition time.  The RAW EVENT OBJECT IS NEVER CONSULTED:
  // no raw payload field (trustedPeerEvidence, continuitySessionId,
  // canonicalSessionId, userId, peerKey, dscId, or any other) can establish
  // continuity identity.  The registry entry is a closure-branded object
  // that no caller can construct through the public ingest surface.
  //
  // Trust boundary (conceptual):
  //   transport-specific adapter
  //   → runtime-owned canonical peer identity (registered)
  //   → private continuity provenance mint
  //   → Manager ingress
  //
  // If a transport has no registered trusted identity, continuity binding
  // for that transport FAILS CLOSED — the ordinary ses_* interaction path
  // continues unchanged.
  //
  // DSC-R1-002: admission ownership (sessionId + incarnationAtAdmission) is
  // captured at ADMISSION and carried through execution; terminal commits
  // use the CAPTURED incarnation, never a re-read.
  //
  // DSC-003: a resolved-but-not-resumed (RESTORED) session is resumed
  // EXPLICITLY here — a safe, generation-advancing act.
  //
  // Nothing here authenticates or authorizes: channel claims remain
  // provenance evidence, and resolution is by BINDING POLICY only.
  // ------------------------------------------------------------------
  const continuityByInteraction = new Map(); // ix_* → admission ownership tuple
  const mintPeerProvenance = trustedContinuity
    ? trustedContinuity.mintPeerProvenance
    : null;

  function resolveContinuitySession(channel, rawEvent) {
    if (!sessionContinuity || !mintPeerProvenance) return null;
    // TRANSPORT-OWNED evidence ONLY: look up the identity the trusted
    // composition registered for this channel.  The raw event is passed
    // solely so the registry MAY correlate by bus-session identity derived
    // from runtime state — never by reading raw payload fields.
    const evidence = transportIdentity.resolve(channel, rawEvent);
    if (typeof evidence !== "string" || evidence.length === 0) {
      // No trustworthy transport-owned identity → NO continuity binding.
      // The ordinary ses_* interaction path continues unchanged.
      return { resolved: false, reason: "PEER_EVIDENCE_UNTRUSTED" };
    }
    const provenance = mintPeerProvenance(channel, evidence);
    let resolution = sessionContinuity.resolveChannel({ provenance });
    if (resolution.resolved && !resolution.resumed) {
      // RESTORED != RESUMED: the canonical ingress owns the explicit resume
      // act — a NEW incarnation is minted here (safe + generation-advancing),
      // so stale pre-restart work stays stale.
      sessionContinuity.resumeSession({ sessionId: resolution.sessionId });
      resolution = sessionContinuity.resolveChannel({ provenance });
    }
    if (resolution.resolved) {
      return { resolution, provenance };
    }
    // No binding yet: create the canonical session and bind this trusted
    // peer.  This is identity continuity, not privilege: the new binding
    // mints no authority and cannot steal an existing binding (fail-closed).
    const created = sessionContinuity.createSession({});
    sessionContinuity.bindChannel({ sessionId: created.sessionId, provenance });
    return {
      resolution: sessionContinuity.resolveChannel({ provenance }),
      provenance
    };
  }

  function ingest(channel, rawEvent) {
    const adapter = adapters.get(channel);
    if (!adapter) return Object.freeze({ accepted: false, code: "CHANNEL_NOT_SUPPORTED" });
    let canonicalSessionId = null;
    if (sessionContinuity) {
      const continuity = resolveContinuitySession(channel, rawEvent);
      if (continuity && continuity.resolution && continuity.resolution.resolved) {
        canonicalSessionId = continuity.resolution.sessionId;
      }
    }
    const outcome = adapter.ingestExternalEvent(rawEvent);
    if (outcome.accepted && canonicalSessionId !== null) {
      // DSC-R1-002: capture the immutable admission ownership tuple BEFORE
      // the interaction begins executing, and carry it by interaction id.
      const admission = sessionContinuity.captureAdmissionOwnership({
        sessionId: canonicalSessionId
      });
      continuityByInteraction.set(outcome.interactionId, Object.freeze({
        sessionId: admission.sessionId,
        incarnationAtAdmission: admission.incarnationAtAdmission
      }));
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

  // ------------------------------------------------------------------
  // DSC-R2-005 — TRUSTED LIFECYCLE FACADE (separate from the ordinary
  // channel facade).  Global continuity lifecycle operations (boot restore,
  // global flush, shutdown, privileged status) live HERE and are returned to
  // the TRUSTED COMPOSITION ROOT ONLY — never on the ordinary channel
  // facade that channel code receives.  RuntimeHost RECOVER/shutdown invoke
  // these private hooks directly.
  //
  // DSC-R2-002: the durable store's same-process ownership is released
  // ONLY after the final flush settles (store.finalizeShutdown), so a
  // second composition cannot acquire the same path while this one is
  // still writing.
  // ------------------------------------------------------------------
  let continuityShutdownStarted = false;
  const trustedLifecycleFacade = Object.freeze({
    async restoreContinuity() {
      if (!sessionContinuity || typeof sessionContinuity.restore !== "function") {
        return Object.freeze({ restored: false, degraded: false, reason: "CONTINUITY_UNBOUND" });
      }
      return sessionContinuity.restore();
    },
    async flushContinuity() {
      if (!sessionContinuity || typeof sessionContinuity.persist !== "function") {
        return Object.freeze({ persisted: false, reason: "CONTINUITY_UNBOUND" });
      }
      return sessionContinuity.persist();
    },
    /**
     * DSC-R1-005 + DSC-R2-002/004: graceful continuity shutdown — AWAITED
     * with SHARED completion.  Flushes all currently-known dirty state
     * through the bounded epoch scheduler (deterministic failure on disk
     * error — never a hang), releases the durable store's same-process
     * ownership ONLY after the final flush settles, and NEVER deletes
     * persisted state.
     */
    async shutdownContinuity() {
      if (!sessionContinuity || typeof sessionContinuity.shutdown !== "function") {
        return Object.freeze({ shutdown: false, reason: "CONTINUITY_UNBOUND" });
      }
      continuityShutdownStarted = true;
      let result;
      try {
        result = await sessionContinuity.shutdown();
      } catch (error) {
        result = Object.freeze({ shutdown: true, flushed: { failed: true, code: error?.code ?? "PERSIST_FAILURE" } });
      }
      // DSC-R2-002: ownership release AFTER the final flush conclusively
      // ended — success OR deterministic failure.
      if (continuityStoreHandle && typeof continuityStoreHandle.finalizeShutdown === "function") {
        try { await continuityStoreHandle.finalizeShutdown(); } catch { /* idempotent */ }
      }
      return result;
    },
    continuityStatus() {
      if (!sessionContinuity || typeof sessionContinuity.snapshotDiagnostics !== "function") {
        return Object.freeze({ bound: false });
      }
      return Object.freeze({ bound: true, ...sessionContinuity.snapshotDiagnostics() });
    }
  });

  // ---- ORDINARY CHANNEL FACADE (DSC-R2-005: interaction only) -------------
  // Channel code receives ONLY what it needs to interact.  NO restore, NO
  // global flush, NO global shutdown, NO privileged lifecycle status, and
  // NO arbitrary-event continuity resolution escape hatch.
  const ordinaryChannelFacade = Object.freeze({
    ingest,
    request,
    ingestAttachments,
    render,
    channels: Object.freeze(Object.keys(CHANNELS)),
    transportSnapshot: () => Object.freeze([...adapters.values()].map((a) => a.snapshot()))
  });

  return Object.freeze({
    // The ordinary facade handed to channel code (host.channels).
    channels: ordinaryChannelFacade,
    // The trusted lifecycle facade, returned ONLY to the trusted
    // composition root (never exposed on host.channels).
    lifecycle: trustedLifecycleFacade,
    // Internal composition surface for trusted tests (not channel-facing).
    composition: Object.freeze({
      resolveContinuityId(channel, rawEvent) {
        const continuity = resolveContinuitySession(channel, rawEvent);
        return continuity && continuity.resolution && continuity.resolution.resolved
          ? continuity.resolution.sessionId : null;
      }
    })
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
