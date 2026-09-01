"use strict";

/**
 * DAMAR SESSION CONTINUITY — canonical domain (Wave 5 Lane 4).
 *
 * A Damar session belongs to DAMAR, not to one transport.  This module owns
 * the CANONICAL session identity (`dsc_*`), the deterministic cross-channel
 * bindings, the bounded inert persistence that lets a session survive a
 * runtime/process restart, and the incarnation (generation) ownership that
 * makes stale pre-restart work harmless after resume.
 *
 * LAWS (load-bearing):
 *
 *   SESSION != AUTHORITY            — a session id is inert identity, never a
 *                                      token, capability, or principal.
 *   CHANNEL != IDENTITY             — transport ids are BINDINGS/EVIDENCE.
 *   TRANSPORT ID != DAMAR IDENTITY  — canonical ids are minted only here.
 *   SESSION BINDING != AUTHORITY    — binding a channel mints no privilege.
 *   CHANNEL SWITCH != PRIVILEGE ESCALATION.
 *   PERSISTED STATE != LIVE AUTHORITY — resume reconstructs inert continuity
 *                                      data only; capabilities/authorities are
 *                                      NEVER serialized or resurrected.
 *   RESTART != RESUME-ALL           — resuming a session is an explicit,
 *                                      generation-owned lifecycle act.
 *
 * This module contains NO model calls, NO tool calls, NO actuators, and no
 * second channel router: canonical flow remains
 *   channel → RuntimeHost → InteractionBus → Manager.
 */

const {
  assertCanonicalContinuitySessionId,
  isCanonicalContinuitySessionId
} = require("./ids");
const {
  SNAPSHOT_VERSION,
  createMemoryContinuityStore,
  validateSnapshot,
  buildSnapshot
} = require("./persistence");

const TERMINAL_INTERACTION_STATES = Object.freeze(new Set([
  "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"
]));

const DEFAULT_BOUNDS = Object.freeze({
  maxSessions: 256,
  maxBindingsPerSession: 16,
  maxTerminalInteractions: 1024,
  maxResumeMetadataBytes: 2048
});

function fail(code, message, details) {
  const error = new Error(`[${code}] ${message || code}`);
  error.name = "SessionContinuityError";
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function isPlainData(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let proxy;
  try { proxy = require("node:util").types.isProxy(value); } catch { return false; }
  if (proxy) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) return false;
    if (name === "__proto__" || name === "constructor" || name === "prototype") return false;
  }
  return true;
}

function validResumeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return Object.freeze({});
  if (!isPlainData(metadata)) return null;
  const out = {};
  for (const key of Object.getOwnPropertyNames(metadata)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return null;
    const value = metadata[key];
    if (!(value === null || typeof value === "string" || typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)))) {
      return null;
    }
    out[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > DEFAULT_BOUNDS.maxResumeMetadataBytes) {
    return null;
  }
  return Object.freeze(out);
}

/**
 * Derive the channel-scoped peer key used for deterministic bindings.
 * The peer key is runtime-controlled evidence (derived from the trusted
 * normalize seam), never a trust root: two channels that derive the same
 * peer key MAY share a session, but nothing about that binding authorizes
 * anything.
 */
function peerKeyFor(channel, claimedIdentity) {
  if (typeof channel !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(channel)) {
    fail("BINDING_CHANNEL_INVALID", "channel must be a canonical channel name");
  }
  const raw = claimedIdentity === null || claimedIdentity === undefined
    ? "anon"
    : String(claimedIdentity).toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return `${channel}:${slug || "anon"}`;
}

/**
 * createSessionContinuity({ clock, idFactory, store, now })
 *
 * All dependencies are injected; the domain owns no globals, no timers, and
 * no authority.  `store` is the inert persistence contract from
 * persistence.js (memory store by default, file store for durability).
 */
function createSessionContinuity(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const idFactory = options.idFactory;
  if (!idFactory || typeof idFactory.next !== "function") {
    throw new TypeError("SESSION_CONTINUITY_ID_FACTORY_REQUIRED");
  }
  const store = options.store || createMemoryContinuityStore();
  if (!store || typeof store.load !== "function" || typeof store.persist !== "function") {
    throw new TypeError("SESSION_CONTINUITY_STORE_INVALID");
  }

  // ---- live inert state -------------------------------------------------
  const sessions = new Map();          // dsc_* → session record
  const bindingIndex = new Map();      // "channel:peerKey" → sessionId
  const terminal = new Map();          // ix_* → { state, generation, at }
  let persistedGeneration = 0;
  let restored = false;

  function touchSession(session, now) {
    session.updatedAt = now;
  }

  function indexBindings(session) {
    for (const binding of session.channels) {
      bindingIndex.set(compositeBindingKey(binding), session.sessionId);
    }
  }

  // ---- persistence ------------------------------------------------------
  async function persist() {
    const snapshot = buildSnapshot(clock(), sessions, terminal);
    persistedGeneration = snapshot.savedAt;
    await store.persist(snapshot);
    return Object.freeze({ persisted: true, savedAt: snapshot.savedAt });
  }

  /**
   * Restore from the injected store.  Fail-closed: a corrupt/oversized/
   * malformed snapshot is DISCARDED (reported), never partially applied.
   * Restored sessions own their lifecycle EXPLICITLY: they come back in a
   * CLOSED state with incarnation advanced, and only resumeSession() can
   * re-open them under a NEW incarnation.
   */
  async function restore() {
    const raw = await store.load();
    if (raw === null || raw === undefined) {
      restored = true;
      return Object.freeze({ restored: true, sessions: 0, degraded: false });
    }
    if (raw && raw.corrupt === true) {
      restored = true;
      return Object.freeze({
        restored: false,
        degraded: true,
        reason: raw.reason || "SNAPSHOT_CORRUPT",
        sessions: 0
      });
    }
    const verdict = validateSnapshot(raw);
    if (verdict && verdict.corrupt === true) {
      restored = true;
      return Object.freeze({
        restored: false,
        degraded: true,
        reason: verdict.reason,
        sessions: 0
      });
    }
    sessions.clear();
    bindingIndex.clear();
    terminal.clear();
    for (const entry of Object.values(verdict.sessions)) {
      const session = {
        sessionId: entry.sessionId,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        incarnation: entry.incarnation,
        resumeMetadata: entry.resumeMetadata,
        terminalAt: entry.terminalAt,
        channels: entry.channels.map((binding) => ({ ...binding })),
        state: "CLOSED" // restored sessions resume explicitly
      };
      sessions.set(session.sessionId, session);
      indexBindings(session);
    }
    for (const [interactionId, record] of Object.entries(verdict.terminal)) {
      terminal.set(interactionId, { ...record });
    }
    restored = true;
    return Object.freeze({
      restored: true,
      degraded: false,
      sessions: sessions.size
    });
  }

  // ---- canonical identity ----------------------------------------------
  /** Mint a NEW canonical session.  Canonical ids never collide with
   * transport ids because they are minted here, deterministically bounded. */
  function createSession({ resumeMetadata } = {}) {
    const metadata = validResumeMetadata(resumeMetadata);
    if (metadata === null) {
      fail("RESUME_METADATA_INVALID", "resume metadata must be bounded inert data");
    }
    if (sessions.size >= DEFAULT_BOUNDS.maxSessions) {
      fail("SESSION_LIMIT_EXCEEDED", "continuity session bound reached");
    }
    const now = clock();
    const sessionId = idFactory.next();
    assertCanonicalContinuitySessionId(sessionId);
    const session = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      incarnation: 1,
      resumeMetadata: metadata,
      terminalAt: null,
      channels: [],
      state: "ACTIVE"
    };
    sessions.set(sessionId, session);
    return Object.freeze({
      sessionId,
      incarnation: session.incarnation,
      state: session.state,
      createdAt: session.createdAt
    });
  }

  function getSession(sessionId) {
    if (!isCanonicalContinuitySessionId(sessionId)) return null;
    const session = sessions.get(sessionId);
    if (!session) return null;
    return Object.freeze({
      sessionId: session.sessionId,
      incarnation: session.incarnation,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      terminalAt: session.terminalAt,
      resumeMetadata: session.resumeMetadata,
      channels: Object.freeze(session.channels.map((binding) => Object.freeze({ ...binding })))
    });
  }

  // ---- cross-channel bindings ------------------------------------------
  /** Composite lookup key: `channel:peerKey` (peerKey is stored WITHOUT the
   * channel prefix; the composite is reconstructed deterministically). */
  function compositeBindingKey(binding) {
    return `${binding.channel}:${binding.peerKey}`;
  }

  /**
   * Bind a channel to a canonical session.  Deterministic: the same
   * (channel, claimedIdentity) resolves to the same binding.
   *
   * A binding CANNOT be stolen: binding a channel+peer that is already
   * bound to a DIFFERENT session is rejected unless the caller explicitly
   * rebinds through the policy entrypoint (`rebind`) — and even then it
   * mints no authority.  Forged channel metadata therefore cannot hijack
   * another session: it fails closed at this seam.
   */
  function bindChannel({ sessionId, channel, claimedIdentity, rebind = false } = {}) {
    assertCanonicalContinuitySessionId(sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      fail("SESSION_NOT_FOUND", "cannot bind an unknown canonical session");
    }
    if (session.terminalAt !== null) {
      fail("SESSION_TERMINAL", "cannot bind a terminal session");
    }
    if (session.state !== "ACTIVE") {
      fail("SESSION_NOT_ACTIVE", "binding requires an active (resumed) session");
    }
    const peerKey = peerKeyFor(channel, claimedIdentity);
    const compositeKey = peerKey;
    const existing = bindingIndex.get(compositeKey);
    if (existing && existing !== sessionId) {
      if (!rebind) {
        fail("BINDING_CONFLICT", "channel is already bound to another canonical session", {
          channel,
          boundSessionId: existing
        });
      }
      const previous = sessions.get(existing);
      if (previous) {
        previous.channels = previous.channels.filter((binding) => compositeBindingKey(binding) !== compositeKey);
        touchSession(previous, clock());
      }
    }
    const alreadyBound = session.channels.some(
      (binding) => compositeBindingKey(binding) === compositeKey
    );
    const now = clock();
    if (!alreadyBound) {
      if (session.channels.length >= DEFAULT_BOUNDS.maxBindingsPerSession) {
        fail("BINDING_LIMIT_EXCEEDED", "session binding bound reached");
      }
      session.channels.push({
        channel,
        peerKey: peerKey.split(":").slice(1).join(":"),
        boundAt: now,
        generation: session.incarnation
      });
    }
    bindingIndex.set(compositeKey, sessionId);
    touchSession(session, now);
    return Object.freeze({
      sessionId,
      channel,
      peerKey: peerKey.split(":").slice(1).join(":"),
      generation: session.incarnation,
      rebound: Boolean(existing && existing !== sessionId)
    });
  }

  /**
   * Resolve a channel event to its canonical session WITHOUT minting
   * authority: the resolution is scoped to this domain, keyed by the
   * runtime-derived peer key.  An attacker-supplied claimed sessionId is
   * EVIDENCE ONLY — it can select a session only when the binding policy
   * already binds this channel+peer to that session.
   */
  function resolveChannel({ channel, claimedIdentity, claimedSessionId = null } = {}) {
    const peerKey = peerKeyFor(channel, claimedIdentity);
    const boundSessionId = bindingIndex.get(peerKey);
    if (boundSessionId) {
      const session = sessions.get(boundSessionId);
      if (session && session.terminalAt === null) {
        return Object.freeze({
          resolved: true,
          sessionId: session.sessionId,
          incarnation: session.incarnation,
          resumed: session.state === "ACTIVE",
          channel,
          peerKey
        });
      }
    }
    // Claimed session id may only be honored when the claim matches a
    // session that the binding policy ALREADY associates with this channel.
    if (claimedSessionId !== null && isCanonicalContinuitySessionId(claimedSessionId)) {
      const claimed = sessions.get(claimedSessionId);
      if (claimed && claimed.terminalAt === null) {
        const claimAllowed = claimed.channels.some(
          (binding) => `${binding.channel}:${binding.peerKey}` === peerKey
        );
        if (claimAllowed) {
          return Object.freeze({
            resolved: true,
            sessionId: claimed.sessionId,
            incarnation: claimed.incarnation,
            resumed: claimed.state === "ACTIVE",
            channel,
            peerKey
          });
        }
      }
    }
    return Object.freeze({ resolved: false, channel, peerKey });
  }

  // ---- restart / resume -------------------------------------------------
  /**
   * Resume a session after restart (or from a restored CLOSED state).
   * Resume is an EXPLICIT lifecycle act that enters a NEW incarnation:
   * stale pre-restart work stamped with an older incarnation can no longer
   * write session state, and the resumed session owns its new lifecycle.
   */
  function resumeSession({ sessionId, resumeMetadata } = {}) {
    assertCanonicalContinuitySessionId(sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      fail("SESSION_NOT_FOUND", "cannot resume an unknown canonical session");
    }
    if (session.terminalAt !== null) {
      fail("SESSION_TERMINAL", "cannot resume a terminal session");
    }
    let metadata = session.resumeMetadata;
    if (resumeMetadata !== undefined) {
      const candidate = validResumeMetadata(resumeMetadata);
      if (candidate === null) {
        fail("RESUME_METADATA_INVALID", "resume metadata must be bounded inert data");
      }
      metadata = candidate;
    }
    const now = clock();
    session.incarnation += 1;
    session.state = "ACTIVE";
    session.resumeMetadata = metadata;
    // Stale bindings from the previous incarnation stay as evidence but are
    // re-stamped to the new incarnation so stale binding writes cannot
    // replace the newer generation's ownership.
    for (const binding of session.channels) {
      binding.generation = session.incarnation;
    }
    touchSession(session, now);
    return Object.freeze({
      sessionId: session.sessionId,
      incarnation: session.incarnation,
      previousIncarnation: session.incarnation - 1,
      resumed: true,
      resumeMetadata: Object.freeze({ ...metadata })
    });
  }

  /** Explicit terminal close (abandoned sessions, user reset). */
  function closeSession({ sessionId, reason = "CLOSED" } = {}) {
    assertCanonicalContinuitySessionId(sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      fail("SESSION_NOT_FOUND", "cannot close an unknown canonical session");
    }
    if (session.terminalAt !== null) {
      return Object.freeze({ sessionId, terminalAt: session.terminalAt, idempotent: true });
    }
    const now = clock();
    session.terminalAt = now;
    session.state = "CLOSED";
    touchSession(session, now);
    return Object.freeze({ sessionId, terminalAt: now, reason: String(reason).slice(0, 64) });
  }

  // ---- generation / stale-work safety -----------------------------------
  function currentIncarnation(sessionId) {
    if (!isCanonicalContinuitySessionId(sessionId)) return null;
    const session = sessions.get(sessionId);
    return session ? session.incarnation : null;
  }

  /**
   * Apply a write stamped with an incarnation.  Stale generations are
   * rejected: pre-restart work can never overwrite resumed state.
   */
  function applyWithIncarnation(sessionId, generation, mutator) {
    assertCanonicalContinuitySessionId(sessionId);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      fail("GENERATION_INVALID", "generation must be a positive integer");
    }
    if (typeof mutator !== "function") {
      throw new TypeError("SESSION_CONTINUITY_MUTATOR_INVALID");
    }
    const session = sessions.get(sessionId);
    if (!session) {
      fail("SESSION_NOT_FOUND", "cannot apply work for an unknown session");
    }
    if (session.terminalAt !== null) {
      fail("SESSION_TERMINAL", "terminal sessions cannot receive work");
    }
    if (generation !== session.incarnation) {
      fail("STALE_GENERATION", "work is stamped with a stale session incarnation", {
        sessionId,
        currentGeneration: session.incarnation,
        presentedGeneration: generation
      });
    }
    return mutator(session);
  }

  // ---- terminal interaction ledger (idempotent terminal state) ----------
  /**
   * Record a terminal interaction state.  An already-terminal interaction
   * is NEVER emitted/recorded twice: subsequent writes are ignored
   * (idempotent containment) — a resumed session cannot duplicate a
   * completed interaction, and stale async completion cannot revive it.
   */
  function recordTerminalInteraction({ interactionId, state, generation } = {}) {
    if (typeof interactionId !== "string" || !/^ix_[a-z0-9][a-z0-9_-]{0,62}$/.test(interactionId)) {
      fail("INTERACTION_ID_INVALID", "interaction id must be canonical ix_*");
    }
    if (!TERMINAL_INTERACTION_STATES.has(state)) {
      fail("TERMINAL_STATE_INVALID", "state must be a terminal interaction state");
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      fail("GENERATION_INVALID", "generation must be a positive integer");
    }
    const existing = terminal.get(interactionId);
    if (existing) {
      return Object.freeze({
        interactionId,
        state: existing.state,
        recorded: false,
        idempotent: true
      });
    }
    if (terminal.size >= DEFAULT_BOUNDS.maxTerminalInteractions) {
      const oldest = terminal.keys().next().value;
      terminal.delete(oldest);
    }
    terminal.set(interactionId, { state, generation, at: clock() });
    return Object.freeze({ interactionId, state, recorded: true, idempotent: false });
  }

  function getTerminalInteraction(interactionId) {
    const record = terminal.get(interactionId);
    if (!record) return null;
    return Object.freeze({ interactionId, ...record });
  }

  /**
   * Contain a stale async resolve/reject arriving after restart: the result
   * is dropped unless it carries the session's CURRENT incarnation AND the
   * interaction is not already terminal.
   */
  function acceptAsyncOutcome({ interactionId, sessionId, generation, state } = {}) {
    const session = sessions.get(sessionId);
    if (!session || session.terminalAt !== null) {
      return Object.freeze({ accepted: false, reason: "SESSION_NOT_ACTIVE" });
    }
    if (generation !== session.incarnation) {
      return Object.freeze({ accepted: false, reason: "STALE_GENERATION" });
    }
    const already = terminal.get(interactionId);
    if (already) {
      return Object.freeze({ accepted: false, reason: "ALREADY_TERMINAL", state: already.state });
    }
    return Object.freeze({ accepted: true });
  }

  // ---- diagnostics ------------------------------------------------------
  function snapshotDiagnostics() {
    return Object.freeze({
      schemaVersion: SNAPSHOT_VERSION,
      sessions: sessions.size,
      bindings: bindingIndex.size,
      terminalInteractions: terminal.size,
      restored,
      persistedGeneration
    });
  }

  async function shutdown() {
    if (typeof store.clear === "function") {
      await store.clear();
    }
    sessions.clear();
    bindingIndex.clear();
    terminal.clear();
    return Object.freeze({ shutdown: true });
  }

  return Object.freeze({
    // canonical identity
    createSession,
    getSession,
    // cross-channel bindings
    bindChannel,
    resolveChannel,
    // restart / resume
    restore,
    resumeSession,
    closeSession,
    persist,
    // generation ownership
    currentIncarnation,
    applyWithIncarnation,
    // terminal lifecycle
    recordTerminalInteraction,
    getTerminalInteraction,
    acceptAsyncOutcome,
    // diagnostics
    snapshotDiagnostics,
    shutdown
  });
}

module.exports = Object.freeze({
  createSessionContinuity,
  peerKeyFor,
  TERMINAL_INTERACTION_STATES,
  DEFAULT_BOUNDS
});
