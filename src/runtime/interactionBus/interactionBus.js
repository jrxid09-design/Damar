"use strict";

const { BusError } = require("./errors");
const { resolveBounds } = require("./config");
const { assertCanonicalId } = require("./ids");
const { TERMINAL_STATES } = require("./enums");
const { buildEnvelope, interactionDigest } = require("./envelope");
const { InteractionStream } = require("./streams");
const { createSessionRegistry } = require("./sessions");
const { createHandlerRegistry, routeForKind } = require("./routing");
const { createTransportRegistry } = require("./transports");

const HISTORY_LIMIT = 16;

function createInteractionBus(options) {
  const opts = options || {};
  const clock = opts.clock;
  const idFactory = opts.idFactory;
  if (typeof clock !== "function") {
    throw new BusError("CLOCK_REQUIRED", "an injected clock function is required");
  }
  if (!idFactory || typeof idFactory.next !== "function") {
    throw new BusError("ID_FACTORY_REQUIRED", "an injected id factory is required");
  }
  const bounds = resolveBounds(opts.bounds);
  const ambiguityPolicy = opts.handlerAmbiguityPolicy;

  const transports = createTransportRegistry();
  const handlers = createHandlerRegistry(ambiguityPolicy);
  const sessions = createSessionRegistry(bounds);

  const interactions = new Map();
  const ledger = new Map();
  const diagnostics = [];
  let pendingCount = 0;

  const counters = {
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    conflicts: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    dispatched: 0,
    handlerFaults: 0,
    streamEventsEmitted: 0,
    bufferOverflows: 0,
    negativeCounterGuards: 0,
    doubleTerminalGuards: 0,
    staleGenerationResponses: 0,
    byOrigin: {},
    rejectionReasons: {}
  };

  function bump(name) {
    counters[name] += 1;
  }

  function bumpOrigin(origin) {
    counters.byOrigin[origin] = (counters.byOrigin[origin] || 0) + 1;
  }

  function bumpRejection(reason) {
    counters.rejected += 1;
    counters.rejectionReasons[reason] = (counters.rejectionReasons[reason] || 0) + 1;
  }

  function recordDiagnostic(reason, interactionId, detail) {
    diagnostics.push({
      at: clock(),
      reason,
      interactionId: interactionId === undefined ? null : interactionId,
      detail: detail === undefined ? null : detail
    });
    while (diagnostics.length > bounds.maxDiagnostics) {
      diagnostics.shift();
    }
  }

  function decrement(valueHolder, key) {
    if (valueHolder[key] <= 0) {
      counters.negativeCounterGuards += 1;
      valueHolder[key] = 0;
      return;
    }
    valueHolder[key] -= 1;
  }

  function rejection(reason, extra) {
    bumpRejection(reason);
    return Object.freeze(Object.assign({ accepted: false, reason }, extra || {}));
  }

  function registerTransport(descriptor) {
    return transports.register(descriptor);
  }

  function registerHandler(registration) {
    return handlers.register(registration);
  }

  function ledgerInsert(interactionId, digest, sessionId) {
    ledger.set(interactionId, { digest, sessionId, finalState: null, terminalAt: null });
    while (ledger.size > bounds.maxDedupeLedger) {
      const oldest = ledger.keys().next().value;
      ledger.delete(oldest);
      recordDiagnostic("DEDUPE_LEDGER_EVICTED", oldest);
    }
  }

  function pushHistory(record, state, at) {
    record.history.push({ state, at });
    while (record.history.length > HISTORY_LIMIT) {
      record.history.shift();
    }
  }

  function submit(request) {
    if (!request || typeof request !== "object") {
      return rejection("SUBMIT_INVALID");
    }
    let transport;
    try {
      transport = transports.requireRegistered(request.transportId);
    } catch (error) {
      if (error instanceof BusError) {
        return rejection(error.code, { field: "transportId" });
      }
      throw error;
    }

    try {
      transports.checkKindAllowed(request.transportId, request.kind);
    } catch (error) {
      if (error instanceof BusError) {
        return rejection(error.code, error.details);
      }
      throw error;
    }

    let interactionId;
    try {
      if (request.interactionId === undefined) {
        interactionId = idFactory.next("interactionId");
        assertCanonicalId("interactionId", interactionId);
      } else {
        interactionId = assertCanonicalId("interactionId", request.interactionId);
      }
    } catch (error) {
      if (error instanceof BusError) {
        return rejection(error.code, { field: "interactionId" });
      }
      throw error;
    }

    let envelope;
    try {
      envelope = buildEnvelope(
        {
          interactionId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          correlationId: request.correlationId,
          generation: request.generation,
          origin: transport.origin,
          kind: request.kind,
          receivedAt: clock(),
          payload: request.payload,
          contextRefs: request.contextRefs,
          authEvidenceRefs: request.authEvidenceRefs,
          metadata: request.metadata,
          deadline: request.deadline,
          provenance: {
            transportId: transport.transportId,
            origin: transport.origin,
            claimedIdentity: request.claimedIdentity,
            claimedMetadata: request.claimedMetadata
          }
        },
        bounds
      );
    } catch (error) {
      if (error instanceof BusError) {
        return rejection(error.code, error.details);
      }
      throw error;
    }

    const digest = interactionDigest(envelope);

    let session;
    try {
      session = sessions.ensure(envelope.sessionId, envelope.origin, transport.transportId, envelope.receivedAt);
    } catch (error) {
      if (error instanceof BusError) {
        return rejection(error.code, error.details);
      }
      throw error;
    }

    const existing = ledger.get(interactionId);
    if (existing) {
      if (existing.digest !== digest) {
        bump("conflicts");
        recordDiagnostic("CONFLICTING_INTERACTION", interactionId);
        return rejection("CONFLICTING_INTERACTION", { interactionId });
      }
      bump("duplicates");
      recordDiagnostic("DUPLICATE", interactionId);
      return rejection("DUPLICATE", {
        interactionId,
        originalState: existing.finalState || "ACTIVE"
      });
    }

    if (pendingCount >= bounds.maxPendingInteractions) {
      return rejection("QUEUE_FULL", { maxPendingInteractions: bounds.maxPendingInteractions });
    }
    if (session.queue.length >= bounds.maxPendingPerSession) {
      return rejection("SESSION_QUEUE_FULL", { maxPendingPerSession: bounds.maxPendingPerSession });
    }

    const now = envelope.receivedAt;
    ledgerInsert(interactionId, digest, envelope.sessionId);

    const record = {
      interactionId,
      sessionId: envelope.sessionId,
      kind: envelope.kind,
      route: routeForKind(envelope.kind),
      envelope,
      digest,
      state: "RECEIVED",
      history: [],
      enqueuedAt: now,
      terminalAt: null,
      cancelRequested: false,
      expired: false,
      failureReason: null,
      stream: null
    };
    pushHistory(record, "RECEIVED", now);
    pushHistory(record, "VALIDATED", now);

    interactions.set(interactionId, record);
    bump("accepted");
    bumpOrigin(envelope.origin);

    if (envelope.deadline && envelope.deadline.expiredAtReceipt) {
      expireRecord(record, "EXPIRED_ON_ARRIVAL");
      record.state = "EXPIRED";
      pushHistory(record, "EXPIRED", clock());
      finalizeTerminal(record, "EXPIRED");
      return Object.freeze({
        accepted: true,
        interactionId,
        state: "EXPIRED"
      });
    }

    pushHistory(record, "QUEUED", now);
    record.state = "QUEUED";
    session.queue.push(record);
    pendingCount += 1;
    sessions.rememberInteraction(record.sessionId, interactionId);

    pump();

    return Object.freeze({
      accepted: true,
      interactionId,
      state: record.state,
      stream: record.stream
    });
  }

  function pump(budgetOverride) {
    const budget = budgetOverride === undefined ? bounds.maxPendingInteractions : budgetOverride;
    if (!Number.isSafeInteger(budget) || budget < 0) {
      throw new BusError("INVALID_BUDGET", "pump budget must be a non-negative integer");
    }
    let dispatchedTotal = 0;
    let progress = true;
    while (progress && pendingCount > 0 && dispatchedTotal < budget) {
      progress = false;
      for (const sessionId of sessions.orderSnapshot()) {
        if (dispatchedTotal >= budget) break;
        const session = sessions.get(sessionId);
        if (!session || session.queue.length === 0) continue;
        const record = session.queue.shift();
        if (!record) continue;
        progress = true;
        dispatchOne(session, record);
        dispatchedTotal += 1;
      }
    }
    return dispatchedTotal;
  }

  function dispatchOne(session, record) {
    pendingCount -= 1;
    if (pendingCount < 0) {
      counters.negativeCounterGuards += 1;
      pendingCount = 0;
    }

    if (record.cancelRequested) {
      pushHistory(record, "CANCELLED", clock());
      record.state = "CANCELLED";
      finalizeTerminal(record, "CANCELLED");
      return;
    }

    const now = clock();
    if (
      now - record.envelope.receivedAt > bounds.interactionTTLms ||
      (record.envelope.deadline && now > record.envelope.deadline.at)
    ) {
      pushHistory(record, "EXPIRED", now);
      record.state = "EXPIRED";
      finalizeTerminal(record, "EXPIRED");
      return;
    }

    if (session.inflightCount >= bounds.maxInFlightPerSession) {
      session.queue.unshift(record);
      pendingCount += 1;
      recordDiagnostic("INFLIGHT_LIMIT_DEFERRED", record.interactionId);
      return;
    }

    const resolved = handlers.resolve(record.kind);
    if (!resolved) {
      record.failureReason = "NO_HANDLER";
      pushHistory(record, "FAILED", now);
      record.state = "FAILED";
      recordDiagnostic("NO_HANDLER", record.interactionId, { kind: record.kind, route: record.route });
      finalizeTerminal(record, "FAILED");
      return;
    }

    pushHistory(record, "DISPATCHED", now);
    record.state = "DISPATCHED";
    bump("dispatched");
    session.inflightCount += 1;

    const stream = new InteractionStream({
      interactionId: record.interactionId,
      bounds,
      clock,
      expectedGeneration: record.envelope.generation,
      onTransition: (type, nextState) => {
        if (type === "START" && record.state !== "CANCEL_REQUESTED") {
          pushHistory(record, "STREAMING", clock());
          record.state = "STREAMING";
        }
        if (type === "COMPLETE") {
          pushHistory(record, "COMPLETED", clock());
          record.state = "COMPLETED";
          finalizeTerminal(record, "COMPLETED");
        }
        if (type === "ERROR") {
          pushHistory(record, "FAILED", clock());
          record.state = "FAILED";
          record.failureReason = "STREAM_ERROR";
          finalizeTerminal(record, "FAILED");
        }
      }
    });
    record.stream = stream;

    const handlerContext = Object.freeze({
      envelope: record.envelope,
      stream,
      acknowledgeCancellation: () => acknowledgeCancellation(record.interactionId)
    });

    try {
      const outcome = resolved.handler(record.envelope, handlerContext);
      if (outcome && typeof outcome.then === "function") {
        Promise.resolve(outcome).then(
          () => {},
          (error) => {
            failInteraction(record, "HANDLER_REJECTED", error);
          }
        );
      }
    } catch (error) {
      failInteraction(record, "HANDLER_THROWN", error);
    }
  }

  function failInteraction(record, reason, error) {
    bump("handlerFaults");
    if (error && error.code === "STALE_GENERATION") {
      bump("staleGenerationResponses");
    }
    recordDiagnostic(reason, record.interactionId, {
      code: error && error.code ? String(error.code) : null
    });
    if (record.stream && !record.stream.terminal) {
      try {
        record.stream.emit("ERROR", { reason });
      } catch (streamError) {
        void streamError;
      }
    }
    if (!isTerminalRecord(record)) {
      record.failureReason = reason;
      pushHistory(record, "FAILED", clock());
      record.state = "FAILED";
      finalizeTerminal(record, "FAILED");
    }
  }

  function isTerminalRecord(record) {
    return TERMINAL_STATES.has(record.state);
  }

  function expireRecord(record, label) {
    recordDiagnostic(label, record.interactionId);
  }

  function finalizeTerminal(record, finalState) {
    if (isTerminalRecord(record) && record.terminalAt !== null) {
      counters.doubleTerminalGuards += 1;
      return;
    }
    record.terminalAt = clock();
    const entry = ledger.get(record.interactionId);
    if (entry) {
      entry.finalState = finalState;
      entry.terminalAt = record.terminalAt;
    }
    const session = sessions.get(record.sessionId);
    if (session && session.inflightCount > 0 && record.stream) {
      decrement(session, "inflightCount");
    }
    if (finalState === "COMPLETED") bump("completed");
    else if (finalState === "FAILED") bump("failed");
    else if (finalState === "CANCELLED") bump("cancelled");
    else if (finalState === "EXPIRED") bump("expired");
    interactions.delete(record.interactionId);
    if (record.stream) {
      record.stream.closeForTerminal();
    }
  }

  function requestCancellation(request) {
    if (!request || typeof request !== "object") {
      return Object.freeze({ accepted: false, reason: "CANCEL_INVALID" });
    }
    let sessionId;
    let targetInteractionId;
    try {
      sessionId = assertCanonicalId("sessionId", request.sessionId);
      targetInteractionId = assertCanonicalId("interactionId", request.targetInteractionId);
    } catch (error) {
      if (error instanceof BusError) {
        return Object.freeze({ accepted: false, reason: "CANCEL_INVALID" });
      }
      throw error;
    }
    if (typeof request.transportId !== "string") {
      return Object.freeze({ accepted: false, reason: "CANCEL_INVALID" });
    }
    const session = sessions.requireOwned(sessionId, request.transportId);
    let target = interactions.get(targetInteractionId);
    if (!target && session) {
      const ledgerEntry = ledger.get(targetInteractionId);
      if (ledgerEntry && ledgerEntry.sessionId === sessionId && ledgerEntry.finalState) {
        return Object.freeze({
          accepted: true,
          targetInteractionId,
          targetState: ledgerEntry.finalState,
          idempotent: true
        });
      }
    }
    if (!session || !target || target.sessionId !== sessionId) {
      recordDiagnostic("CANCEL_TARGET_NOT_FOUND", targetInteractionId);
      return Object.freeze({ accepted: false, reason: "TARGET_NOT_FOUND" });
    }
    if (isTerminalRecord(target)) {
      return Object.freeze({
        accepted: true,
        targetInteractionId,
        targetState: target.state,
        idempotent: true
      });
    }
    if (target.cancelRequested) {
      return Object.freeze({
        accepted: true,
        targetInteractionId,
        targetState: target.state,
        idempotent: true
      });
    }
    target.cancelRequested = true;
    pushHistory(target, "CANCEL_REQUESTED", clock());
    target.state = "CANCEL_REQUESTED";
    recordDiagnostic("CANCEL_REQUESTED", targetInteractionId, {
      reason: typeof request.reason === "string" ? request.reason.slice(0, 64) : null
    });
    if (target.stream) {
      target.stream.notifyCancellationRequested();
    }
    return Object.freeze({
      accepted: true,
      targetInteractionId,
      targetState: target.state,
      idempotent: false
    });
  }

  function acknowledgeCancellation(interactionId) {
    const target = interactions.get(interactionId);
    if (!target) {
      throw new BusError("TARGET_NOT_FOUND", "interaction is not active", { interactionId });
    }
    if (target.state !== "CANCEL_REQUESTED") {
      throw new BusError("NOT_CANCEL_REQUESTED", "interaction has no outstanding cancellation", {
        interactionId,
        state: target.state
      });
    }
    pushHistory(target, "CANCELLED", clock());
    target.state = "CANCELLED";
    finalizeTerminal(target, "CANCELLED");
    return Object.freeze({ interactionId, state: "CANCELLED" });
  }

  function sweep(now) {
    if (!Number.isSafeInteger(now)) {
      throw new BusError("INVALID_TIME", "sweep timestamp must be epoch-ms integer");
    }
    for (const record of [...interactions.values()]) {
      const expiredByTTL = now - record.envelope.receivedAt > bounds.interactionTTLms;
      const expiredByDeadline =
        record.envelope.deadline && record.envelope.deadline.at <= now && !isTerminalRecord(record);
      if (!expiredByTTL && !expiredByDeadline) continue;
      if (record.state === "QUEUED") {
        const session = sessions.get(record.sessionId);
        if (session) {
          const idx = session.queue.indexOf(record);
          if (idx >= 0) {
            session.queue.splice(idx, 1);
            pendingCount -= 1;
            if (pendingCount < 0) {
              counters.negativeCounterGuards += 1;
              pendingCount = 0;
            }
          }
        }
      }
      if (record.stream && !record.stream.terminal && record.state !== "QUEUED") {
        record.stream.closeForTerminal();
      }
      if (!isTerminalRecord(record)) {
        pushHistory(record, "EXPIRED", now);
        record.state = "EXPIRED";
        expireRecord(record, "EXPIRED_BY_SWEEP");
        finalizeTerminal(record, "EXPIRED");
      }
    }
    sessions.sweepIdle(now);
    return Object.freeze({ sweptAt: now });
  }

  function transportDisconnect(transportId) {
    transports.requireRegistered(transportId);
    const detached = sessions.detachTransport(transportId, clock());
    recordDiagnostic("TRANSPORT_DISCONNECTED", undefined, { transportId });
    return Object.freeze({
      transportId,
      detachedSessions: Object.freeze(detached),
      pendingPolicy: "keep-until-ttl"
    });
  }

  function getStatus() {
    const activeStates = {};
    for (const record of interactions.values()) {
      activeStates[record.state] = (activeStates[record.state] || 0) + 1;
    }
    let inflight = 0;
    for (const record of interactions.values()) {
      if (record.state === "DISPATCHED" || record.state === "STREAMING") inflight += 1;
    }
    let streamsActive = 0;
    for (const record of interactions.values()) {
      if (record.stream && !record.stream.terminal) streamsActive += 1;
    }
    return Object.freeze({
      now: clock(),
      bounds,
      activeSessions: sessions.size(),
      pendingInteractions: pendingCount,
      inflight,
      streamsActive,
      activeStates: Object.freeze({ ...activeStates }),
      ledgerSize: ledger.size,
      diagnosticsUsed: diagnostics.length,
      transportsRegistered: transports.size(),
      handlersRegistered: handlers.snapshot().length,
      counters: Object.freeze({
        ...counters,
        byOrigin: Object.freeze({ ...counters.byOrigin }),
        rejectionReasons: Object.freeze({ ...counters.rejectionReasons })
      }),
      diagnostics: Object.freeze(diagnostics.map((d) => Object.freeze({ ...d })))
    });
  }

  function getInteractionTrace(interactionId) {
    const record = interactions.get(interactionId);
    if (!record) return null;
    return Object.freeze({
      interactionId: record.interactionId,
      sessionId: record.sessionId,
      kind: record.kind,
      route: record.route,
      state: record.state,
      cancelRequested: record.cancelRequested,
      failureReason: record.failureReason,
      history: Object.freeze(record.history.map((h) => Object.freeze({ ...h }))),
      streamSnapshot: record.stream ? record.stream.snapshot() : null
    });
  }

  function getSessionSnapshot() {
    return sessions.snapshot();
  }

  return Object.freeze({
    bounds,
    registerTransport,
    registerHandler,
    submit,
    pump,
    sweep,
    requestCancellation,
    acknowledgeCancellation,
    transportDisconnect,
    getStatus,
    getInteractionTrace,
    getSessionSnapshot,
    routeForKind
  });
}

module.exports = { createInteractionBus };
