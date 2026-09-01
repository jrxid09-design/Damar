"use strict";

/**
 * DAMAR SESSION CONTINUITY — canonical domain (Wave 5 Lane 4, repair R1).
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
 *   CHANNEL != IDENTITY            — transport ids are BINDINGS/EVIDENCE.
 *   TRANSPORT ID != DAMAR IDENTITY  — canonical ids are minted only here.
 *   PEER PROVENANCE IS TRUSTED-INPUT-ONLY (DSC-001):
 *                                      binding keys derive ONLY from a
 *                                      peer-provenance value minted at the
 *                                      trusted transport normalization
 *                                      boundary.  Raw event fields (userId,
 *                                      claimed ids) are NEVER treated as
 *                                      identity for binding.
 *   PEER PROVENANCE IS EXACT        — no case folding, no punctuation
 *                                      destruction, no shared "anon".
 *   SESSION BINDING != AUTHORITY    — binding a channel mints no privilege.
 *   CHANNEL SWITCH != PRIVILEGE ESCALATION.
 *   PERSISTED STATE != LIVE AUTHORITY — resume reconstructs inert continuity
 *                                      data only; capabilities/authorities are
 *                                      NEVER serialized or resurrected.
 *   NO MUTABLE STATE ESCAPES (DSC-002) — no public method returns or accepts
 *                                      a mutable canonical record or callback
 *                                      into one; all views are frozen inert
 *                                      projections; all mutations are closed
 *                                      operations that validate BEFORE they
 *                                      mutate.
 *   ATOMIC TERMINAL OWNERSHIP (DSC-004) — a terminal outcome is committed in
 *                                      ONE internal transition that verifies
 *                                      session, incarnation, and interaction
 *                                      identity together.
 *   OLD WORK MUST NOT MUTATE NEW INCARNATION STATE.
 *   RESTORED != RESUMED             — restore yields CLOSED sessions; resume
 *                                      is an explicit generation-advancing act.
 *   RESUMED != AUTHORIZED           — resume mints no privilege of any kind.
 *
 * This module contains NO model calls, NO tool calls, NO actuators, and no
 * second channel router: canonical flow remains
 *   channel → RuntimeHost → InteractionBus → Manager.
 */

const crypto = require("node:crypto");

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
  maxResumeMetadataBytes: 2048,
  maxPeerKeyBytes: 128
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

/**
 * Validate and FREEZE resume metadata.  Identical closed-data rules on every
 * mutation (creation, resume, update) — not only at persistence time.
 * Returns a frozen inert copy or null.
 */
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

// ---------------------------------------------------------------------------
// DSC-001 — TRUSTED PEER PROVENANCE
//
// A PeerProvenance is minted ONLY at the trusted transport normalization
// boundary (managerIngressInternal safeRawEvent seam → this module's mint
// entrypoint).  It carries an EXACT peer string (case/punctuation preserved)
// that the transport itself supplied through its trusted normalization path.
// Raw caller fields never reach binding derivation directly.
//
// The mint is deliberately one-way: the provenance token is an opaque
// branded record recognized by identity in a closure-private WeakSet, so a
// forged lookalike object cannot become trusted provenance.
// ---------------------------------------------------------------------------

const MINTED_PROVENANCE = new WeakSet();

/** Mint trusted peer provenance at the trusted normalization boundary.
 * EXACT peer string required — no normalization, no case folding. */
function mintPeerProvenance(channel, peer) {
  if (typeof channel !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(channel)) {
    fail("PROVENANCE_CHANNEL_INVALID", "channel must be a canonical channel name");
  }
  // DSC-001.4: missing/untrusted peer identity must NOT collapse into a
  // shared identity.  Peer must be an exact non-empty bounded non-blank
  // string (whitespace-only ids are "missing" for continuity purposes).
  if (typeof peer !== "string" || peer.length === 0 || peer.length > 128 || peer.trim().length === 0) {
    fail("PROVENANCE_PEER_INVALID", "peer provenance requires an exact non-empty bounded peer string");
  }
  const provenance = Object.freeze({
    kind: "PeerProvenance",
    channel,
    peer,
    key: `${channel}\u0000${peer}`
  });
  MINTED_PROVENANCE.add(provenance);
  return provenance;
}

function isPeerProvenance(value) {
  return value !== null && typeof value === "object" && MINTED_PROVENANCE.has(value);
}

function requirePeerProvenance(value, what) {
  if (!isPeerProvenance(value)) {
    fail("PROVENANCE_UNTRUSTED", `${what || "operation"} requires trusted peer provenance`);
  }
  return value;
}

/**
 * createSessionContinuity({ clock, idFactory, store, persistOnMutation })
 *
 * All dependencies are injected; the domain owns no globals, no timers, and
 * no authority.  `store` is the inert persistence contract from
 * persistence.js (memory store default for tests; the production
 * composition selects a durable file store — DSC-003).
 *
 * DSC-003: `persistOnMutation` makes every durable-state mutation commit
 * the bounded snapshot through the store at the mutation point (no timer
 * loops).  Persistence failures are reported, never silently swallowed.
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
  const persistOnMutation = options.persistOnMutation === true;
  let persistChain = Promise.resolve();
  let lastPersistError = null;

  // ---- live inert state (NEVER escapes this closure) ---------------------
  const sessions = new Map();          // dsc_* → session record
  const bindingIndex = new Map();      // "channel\0peer" → sessionId
  const terminal = new Map();          // ix_* → { sessionId, state, generation, at }
  let persistedGeneration = 0;
  let restored = false;
  let degradedReason = null;

  function touchSession(session, now) {
    session.updatedAt = now;
  }

  function compositeBindingKey(binding) {
    return `${binding.channel}\u0000${binding.peer}`;
  }

  function indexBindings(session) {
    for (const binding of session.channels) {
      bindingIndex.set(compositeBindingKey(binding), session.sessionId);
    }
  }

  // ---- persistence (DSC-003: mutation-bound commit point) -----------------
  async function persist() {
    const snapshot = buildSnapshot(clock(), sessions, terminal);
    persistedGeneration = snapshot.savedAt;
    await store.persist(snapshot);
    lastPersistError = null;
    return Object.freeze({ persisted: true, savedAt: snapshot.savedAt });
  }

  /** Serialize persistence of sequential mutations and record failures. */
  function persistAfterMutation(label) {
    if (!persistOnMutation) return;
    persistChain = persistChain.then(() => persist()).catch((error) => {
      lastPersistError = {
        label: String(label).slice(0, 64),
        code: error && error.code ? String(error.code) : "PERSIST_FAILURE",
        at: clock()
      };
    });
  }

  function getPersistenceStatus() {
    return Object.freeze({
      persistOnMutation,
      lastPersistError: lastPersistError === null ? null : Object.freeze({ ...lastPersistError }),
      pendingWrites: 0
    });
  }

  /** Await all queued mutation-bound persistence (tests / shutdown seam). */
  function whenPersisted() {
    return persistChain;
  }

  /**
   * Restore from the injected store.  Fail-closed: a corrupt/oversized/
   * malformed snapshot is DISCARDED (reported), never partially applied.
   * Restored sessions own their lifecycle EXPLICITLY (RESTORED != RESUMED):
   * they come back CLOSED; only resumeSession() re-opens them under a NEW
   * incarnation.
   */
  async function restore() {
    const raw = await store.load();
    if (raw === null || raw === undefined) {
      restored = true;
      degradedReason = null;
      return Object.freeze({ restored: true, sessions: 0, degraded: false });
    }
    if (raw && raw.corrupt === true) {
      restored = false;
      degradedReason = raw.reason || "SNAPSHOT_CORRUPT";
      return Object.freeze({
        restored: false,
        degraded: true,
        reason: degradedReason,
        sessions: 0
      });
    }
    const verdict = validateSnapshot(raw);
    if (verdict && verdict.corrupt === true) {
      restored = false;
      degradedReason = verdict.reason;
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
    degradedReason = null;
    return Object.freeze({
      restored: true,
      degraded: false,
      sessions: sessions.size
    });
  }

  // ---- inert views (DSC-002: frozen projections only) ---------------------
  function projectSession(session) {
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
    persistAfterMutation("createSession");
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
    return projectSession(session);
  }

  // ---- cross-channel bindings (DSC-001: provenance-gated) -----------------
  /**
   * Bind a trusted channel peer to a canonical session.  Deterministic for
   * the same trusted provenance.  A binding CANNOT be stolen: binding a
   * channel+peer already bound to a DIFFERENT session fails closed
   * (BINDING_CONFLICT) on the public path.  Trusted transfer is available
   * ONLY through the trusted internal seam (`trustedTransferBinding`), which
   * the composition root may call; arbitrary channel callers cannot reach it.
   */
  function bindChannel({ sessionId, provenance } = {}) {
    assertCanonicalContinuitySessionId(sessionId);
    requirePeerProvenance(provenance, "bindChannel");
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
    const key = provenance.key;
    const existing = bindingIndex.get(key);
    if (existing && existing !== sessionId) {
      fail("BINDING_CONFLICT", "channel peer is already bound to another canonical session", {
        channel: provenance.channel,
        boundSessionId: existing
      });
    }
    const now = clock();
    const alreadyBound = session.channels.some((b) => compositeBindingKey(b) === key);
    if (!alreadyBound) {
      if (session.channels.length >= DEFAULT_BOUNDS.maxBindingsPerSession) {
        fail("BINDING_LIMIT_EXCEEDED", "session binding bound reached");
      }
      session.channels.push({
        channel: provenance.channel,
        peer: provenance.peer,
        boundAt: now,
        generation: session.incarnation
      });
      bindingIndex.set(key, sessionId);
    }
    touchSession(session, now);
    persistAfterMutation("bindChannel");
    return Object.freeze({
      sessionId,
      channel: provenance.channel,
      peer: provenance.peer,
      generation: session.incarnation
    });
  }

  /**
   * TRUSTED-ONLY seam: transfer a binding between canonical sessions (e.g.
   * explicit cross-session unification by trusted runtime policy).  This is
   * NOT on the public inert facade; the composition root decides whether to
   * expose it.  Even here it mints no authority — it only moves identity
   * continuity.
   */
  function trustedTransferBinding({ provenance, toSessionId } = {}) {
    requirePeerProvenance(provenance, "trustedTransferBinding");
    assertCanonicalContinuitySessionId(toSessionId);
    const target = sessions.get(toSessionId);
    if (!target) {
      fail("SESSION_NOT_FOUND", "cannot transfer a binding to an unknown session");
    }
    if (target.terminalAt !== null) {
      fail("SESSION_TERMINAL", "cannot transfer a binding to a terminal session");
    }
    const key = provenance.key;
    const previous = bindingIndex.get(key);
    const now = clock();
    if (previous && previous !== toSessionId) {
      const previousSession = sessions.get(previous);
      if (previousSession) {
        previousSession.channels = previousSession.channels.filter(
          (b) => compositeBindingKey(b) !== key
        );
        touchSession(previousSession, now);
      }
    }
    const alreadyBound = target.channels.some((b) => compositeBindingKey(b) === key);
    if (!alreadyBound) {
      if (target.channels.length >= DEFAULT_BOUNDS.maxBindingsPerSession) {
        fail("BINDING_LIMIT_EXCEEDED", "session binding bound reached");
      }
      target.channels.push({
        channel: provenance.channel,
        peer: provenance.peer,
        boundAt: now,
        generation: target.incarnation
      });
    }
    bindingIndex.set(key, toSessionId);
    touchSession(target, now);
    persistAfterMutation("trustedTransferBinding");
    return Object.freeze({
      channel: provenance.channel,
      peer: provenance.peer,
      fromSessionId: previous && previous !== toSessionId ? previous : null,
      toSessionId
    });
  }

  /** Remove one trusted binding from a session (explicit unbind). */
  function unbindChannel({ sessionId, provenance } = {}) {
    assertCanonicalContinuitySessionId(sessionId);
    requirePeerProvenance(provenance, "unbindChannel");
    const session = sessions.get(sessionId);
    if (!session) {
      fail("SESSION_NOT_FOUND", "cannot unbind an unknown canonical session");
    }
    const key = provenance.key;
    const owned = bindingIndex.get(key);
    if (owned !== sessionId) {
      fail("BINDING_NOT_OWNED", "session does not own this binding");
    }
    const now = clock();
    session.channels = session.channels.filter((b) => compositeBindingKey(b) !== key);
    bindingIndex.delete(key);
    touchSession(session, now);
    persistAfterMutation("unbindChannel");
    return Object.freeze({ sessionId, channel: provenance.channel, peer: provenance.peer });
  }

  /**
   * Resolve a trusted channel event to its canonical session WITHOUT minting
   * authority: resolution is scoped to this domain, keyed by trusted peer
   * provenance ONLY.  Caller-supplied session id claims are inert evidence
   * and are IGNORED for selection (DSC-001: they can never select a session
   * the binding policy does not already own).
   */
  function resolveChannel({ provenance } = {}) {
    requirePeerProvenance(provenance, "resolveChannel");
    const key = provenance.key;
    const boundSessionId = bindingIndex.get(key);
    if (boundSessionId) {
      const session = sessions.get(boundSessionId);
      if (session && session.terminalAt === null) {
        return Object.freeze({
          resolved: true,
          sessionId: session.sessionId,
          incarnation: session.incarnation,
          resumed: session.state === "ACTIVE",
          channel: provenance.channel,
          peer: provenance.peer
        });
      }
    }
    return Object.freeze({
      resolved: false,
      channel: provenance.channel,
      peer: provenance.peer
    });
  }

  // ---- restart / resume -------------------------------------------------
  /**
   * Resume a session after restart (or from a restored CLOSED state).
   * Resume is an EXPLICIT lifecycle act that enters a NEW incarnation:
   * stale pre-restart work stamped with an older incarnation can no longer
   * write session state, and the resumed session owns its new lifecycle.
   * RESUMED != AUTHORIZED: resume mints nothing.
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
    // Bindings remain evidence but are re-stamped to the new incarnation so
    // stale binding writes cannot replace the newer generation's ownership.
    for (const binding of session.channels) {
      binding.generation = session.incarnation;
    }
    touchSession(session, now);
    persistAfterMutation("resumeSession");
    return Object.freeze({
      sessionId: session.sessionId,
      incarnation: session.incarnation,
      previousIncarnation: session.incarnation - 1,
      resumed: true,
      resumeMetadata: session.resumeMetadata
    });
  }

  /** Closed metadata update (DSC-002): validated inert input, internal
   * mutation, frozen inert result.  Requires the CURRENT incarnation — old
   * work can never mutate a new incarnation. */
  function updateResumeMetadata({ sessionId, generation, resumeMetadata } = {}) {
    assertCanonicalContinuitySessionId(sessionId);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      fail("GENERATION_INVALID", "generation must be a positive integer");
    }
    const session = sessions.get(sessionId);
    if (!session) {
      fail("SESSION_NOT_FOUND", "cannot update an unknown session");
    }
    if (session.terminalAt !== null) {
      fail("SESSION_TERMINAL", "terminal sessions cannot be updated");
    }
    if (generation !== session.incarnation) {
      fail("STALE_GENERATION", "work is stamped with a stale session incarnation", {
        sessionId,
        currentGeneration: session.incarnation,
        presentedGeneration: generation
      });
    }
    const candidate = validResumeMetadata(resumeMetadata);
    if (candidate === null) {
      fail("RESUME_METADATA_INVALID", "resume metadata must be bounded inert data");
    }
    session.resumeMetadata = candidate;
    touchSession(session, clock());
    persistAfterMutation("updateResumeMetadata");
    return Object.freeze({
      sessionId: session.sessionId,
      incarnation: session.incarnation,
      resumeMetadata: session.resumeMetadata
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
    persistAfterMutation("closeSession");
    return Object.freeze({ sessionId, terminalAt: now, reason: String(reason).slice(0, 64) });
  }

  // ---- generation / stale-work safety -----------------------------------
  function currentIncarnation(sessionId) {
    if (!isCanonicalContinuitySessionId(sessionId)) return null;
    const session = sessions.get(sessionId);
    return session ? session.incarnation : null;
  }

  /**
   * DSC-002: verify a stamped generation against the session's CURRENT
   * incarnation WITHOUT exposing mutable state.  Returns a frozen verdict.
   * (The old applyWithIncarnation(mutator) callback API is REMOVED — no
   * public path may mutate canonical records through a caller callback.)
   */
  function checkIncarnation({ sessionId, generation } = {}) {
    if (!isCanonicalContinuitySessionId(sessionId)) {
      return Object.freeze({ ok: false, reason: "SESSION_NOT_FOUND" });
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return Object.freeze({ ok: false, reason: "GENERATION_INVALID" });
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return Object.freeze({ ok: false, reason: "SESSION_NOT_FOUND" });
    }
    if (session.terminalAt !== null) {
      return Object.freeze({ ok: false, reason: "SESSION_TERMINAL" });
    }
    if (generation !== session.incarnation) {
      return Object.freeze({ ok: false, reason: "STALE_GENERATION", currentGeneration: session.incarnation });
    }
    return Object.freeze({ ok: true, sessionId, currentGeneration: session.incarnation });
  }

  // ---- DSC-004: ATOMIC TERMINAL TRANSITION -------------------------------
  /**
   * The ONE terminal commit transition.  In a single internal operation it
   * verifies: the session exists, the session state permits the transition,
   * the expected incarnation is current (OLD WORK MUST NOT MUTATE NEW
   * INCARNATION TERMINAL STATE), and the interaction has not already
   * terminally completed; then it records the terminal result and persists
   * when durable state changed.
   *
   * Duplicate terminal attempts are idempotent.  Stale incarnations fail
   * WITHOUT mutating terminal state.  There is no other public path that
   * records terminal state.
   */
  function commitTerminalOutcome({ sessionId, interactionId, generation, state } = {}) {
    assertCanonicalContinuitySessionId(sessionId);
    if (typeof interactionId !== "string" || !/^ix_[a-z0-9][a-z0-9_-]{0,62}$/.test(interactionId)) {
      fail("INTERACTION_ID_INVALID", "interaction id must be canonical ix_*");
    }
    if (!TERMINAL_INTERACTION_STATES.has(state)) {
      fail("TERMINAL_STATE_INVALID", "state must be a terminal interaction state");
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      fail("GENERATION_INVALID", "generation must be a positive integer");
    }
    const session = sessions.get(sessionId);
    if (!session) {
      fail("SESSION_NOT_FOUND", "cannot commit a terminal outcome for an unknown session");
    }
    // Session-state ownership: terminal sessions can never receive more work.
    if (session.terminalAt !== null) {
      fail("SESSION_TERMINAL", "terminal sessions cannot receive terminal outcomes");
    }
    const existing = terminal.get(interactionId);
    if (existing) {
      // Idempotent containment: the FIRST terminal state wins; later
      // attempts (including stale async resolve/reject) change nothing.
      return Object.freeze({
        interactionId,
        sessionId: existing.sessionId,
        state: existing.state,
        recorded: false,
        idempotent: true
      });
    }
    // Incarnation ownership: stale generations fail WITHOUT mutation.
    if (generation !== session.incarnation) {
      fail("STALE_GENERATION", "terminal outcome is stamped with a stale session incarnation", {
        sessionId,
        currentGeneration: session.incarnation,
        presentedGeneration: generation
      });
    }
    if (terminal.size >= DEFAULT_BOUNDS.maxTerminalInteractions) {
      const oldest = terminal.keys().next().value;
      terminal.delete(oldest);
    }
    terminal.set(interactionId, {
      sessionId,
      state,
      generation,
      at: clock()
    });
    persistAfterMutation("commitTerminalOutcome");
    return Object.freeze({ interactionId, sessionId, state, recorded: true, idempotent: false });
  }

  function getTerminalInteraction(interactionId) {
    const record = terminal.get(interactionId);
    if (!record) return null;
    return Object.freeze({ interactionId, ...record });
  }

  /**
   * Contain a stale async resolve/reject arriving after restart: the outcome
   * is accepted only if the session is live AND the presented incarnation is
   * current AND the interaction is not already terminal.  This is a pure
   * check — the terminal commit itself is `commitTerminalOutcome`.
   */
  function acceptAsyncOutcome({ interactionId, sessionId, generation } = {}) {
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
      degradedReason,
      persistedGeneration,
      persistence: getPersistenceStatus()
    });
  }

  /**
   * DSC-003: graceful shutdown FLUSHES the durable snapshot.  It NEVER
   * deletes persisted state (destructive reset is a separate explicit
   * administrative operation — `resetDurableState`).  In-memory state is
   * released.
   */
  async function shutdown() {
    await persistChain;
    let flushed = null;
    if (persistOnMutation) {
      try {
        flushed = await persist();
      } catch (error) {
        flushed = Object.freeze({ failed: true, code: error?.code ?? "PERSIST_FAILURE" });
      }
    } else {
      try {
        flushed = await persist();
      } catch (error) {
        flushed = Object.freeze({ failed: true, code: error?.code ?? "PERSIST_FAILURE" });
      }
    }
    sessions.clear();
    bindingIndex.clear();
    terminal.clear();
    return Object.freeze({ shutdown: true, flushed });
  }

  /** EXPLICIT destructive administrative reset (not normal shutdown). */
  async function resetDurableState() {
    if (typeof store.clear === "function") {
      await store.clear();
    }
    sessions.clear();
    bindingIndex.clear();
    terminal.clear();
    return Object.freeze({ reset: true });
  }

  // ---- trusted internal controller ---------------------------------------
  // The trusted composition root may capture this controller to perform
  // lifecycle integration (boot restore, shutdown flush, binding transfer).
  // It is NOT part of the public inert facade: the controller token is a
  // frozen opaque value resolvable only through the closure-private
  // resolver exported for the composition root.
  const trustedController = Object.freeze({
    restore,
    persist,
    shutdown,
    mintPeerProvenance,
    // Trusted-only binding transfer (explicit cross-session unification).
    // Never exposed on the public facade; never reachable by channel events.
    trustedTransferBinding,
    resetDurableState
  });

  const publicFacade = Object.freeze({
    // canonical identity
    createSession,
    getSession,
    // cross-channel bindings (trusted-provenance gated)
    bindChannel,
    unbindChannel,
    resolveChannel,
    // restart / resume
    resumeSession,
    closeSession,
    persist,
    restore,
    // generation ownership (pure checks; no mutable state access)
    currentIncarnation,
    checkIncarnation,
    // terminal lifecycle (atomic ownership)
    commitTerminalOutcome,
    getTerminalInteraction,
    acceptAsyncOutcome,
    // metadata (closed validated mutation)
    updateResumeMetadata,
    // diagnostics
    snapshotDiagnostics,
    getPersistenceStatus,
    whenPersisted,
    shutdown,
    // EXPLICIT destructive administrative reset (never normal shutdown)
    resetDurableState
  });

  return Object.freeze({
    ...publicFacade,
    // Trusted composition seam (composition root only).  A WeakSet brand
    // prevents arbitrary callers from forging the controller: only the
    // closure that created the domain can mint a controller token.
    __trusted: Object.freeze({
      controller: mintTrustedController(trustedController, publicFacade)
    })
  });
}

// Trusted-controller brand: closure-private per domain instance.
const CONTROLLER_TOKENS = new WeakMap();
function mintTrustedController(controller, facade) {
  const token = Object.freeze({ kind: "SessionContinuityTrustedController" });
  CONTROLLER_TOKENS.set(token, { controller, facade });
  return token;
}
function resolveTrustedController(token) {
  const entry = CONTROLLER_TOKENS.get(token);
  return entry ? entry.controller : null;
}

module.exports = Object.freeze({
  createSessionContinuity,
  // Trusted-boundary helpers (used by the trusted normalization seam)
  mintPeerProvenance,
  isPeerProvenance,
  // Inert vocabulary
  TERMINAL_INTERACTION_STATES,
  DEFAULT_BOUNDS,
  // Internal repair-time helper for the composition root
  _resolveTrustedController: resolveTrustedController,
  _fail: fail,
  _validResumeMetadata: validResumeMetadata
});
