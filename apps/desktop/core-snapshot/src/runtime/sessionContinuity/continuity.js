"use strict";

/**
 * DAMAR SESSION CONTINUITY — canonical domain (Wave 5 Lane 4, repair R2).
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
 *   TRUSTED PROVENANCE IS COMPOSITION-OWNED (DSC-R1-001/006):
 *                                      peer provenance can be minted ONLY
 *                                      by the trusted composition closure
 *                                      (trustedLifecycle hook).  There is NO
 *                                      public mint, NO public trusted
 *                                      controller, NO resolver escape hatch.
 *   PEER PROVENANCE IS EXACT        — no case folding, no punctuation
 *                                      destruction, no shared "anon";
 *                                      bounded by UTF-8 BYTES.
 *   SESSION BINDING != AUTHORITY    — binding a channel mints no privilege.
 *   CHANNEL SWITCH != PRIVILEGE ESCALATION.
 *   PERSISTED STATE != LIVE AUTHORITY — resume reconstructs inert continuity
 *                                      data only; capabilities/authorities are
 *                                      NEVER serialized or resurrected.
 *   NO MUTABLE STATE ESCAPES        — all public views are frozen inert
 *                                      projections; all mutations are closed
 *                                      operations that validate BEFORE they
 *                                      mutate.
 *   OLD WORK MUST NOT MUTATE NEW INCARNATION — terminal commits must carry
 *                                      the incarnation captured at ADMISSION,
 *                                      never re-read at completion (DSC-R1-002).
 *   RESTORED != RESUMED             — restore yields CLOSED sessions; resume
 *                                      is an explicit generation-advancing act.
 *   RESUMED != AUTHORIZED           — resume mints no privilege of any kind.
 *   BUS SESSION != DAMAR CONTINUITY SESSION.
 *
 * TRUST ARCHITECTURE (repair R2): createSessionContinuity accepts an OPTIONAL
 * `trustedLifecycle` hook supplied by the trusted composition root.  That hook
 * receives the private controller (restore/persist/shutdown/transfer/reset)
 * and the provenance mint.  NOTHING trusted is reachable from the returned
 * facade, from module exports, or via any token/resolver.
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
// DSC-R4-001: there is deliberately NO global isTransportPeerHandle brand
// check.  Provenance is PER-SCOPE: a handle is recognized only by the
// private per-runtime scope that minted it, and that membership is verified
// at the trusted composition boundary (peerScopes.mintCanonical) BEFORE the
// handle reaches this domain.  Here we validate the handle's inert shape;
// the unforgeable provenance guarantee is enforced one layer up.
function isCanonicalTransportPeerHandleShape(value) {
  return value !== null && typeof value === "object" &&
    value.kind === "TransportPeerHandle" &&
    typeof value.channel === "string" &&
    typeof value.peer === "string" &&
    typeof value.scope === "string";
}

const TERMINAL_INTERACTION_STATES = Object.freeze(new Set([
  "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"
]));

const DEFAULT_BOUNDS = Object.freeze({
  maxSessions: 256,
  maxBindingsPerSession: 16,
  maxTerminalInteractions: 1024,
  maxResumeMetadataBytes: 2048,
  maxPeerBytes: 128
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

/** Validate and FREEZE resume metadata (same closed-data rules on every
 * mutation).  Returns a frozen inert copy or null. */
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
// TRUSTED PEER PROVENANCE (DSC-R1-001 / DSC-R1-006)
//
// PeerProvenance is minted ONLY inside createSessionContinuity's closure and
// handed ONLY to the trustedLifecycle hook supplied by the composition root.
// The mint derives from RUNTIME-OWNED transport evidence — the exact peer
// string the canonical transport adapter produced (authenticated Telegram
// sender/chat id, WhatsApp JID, runtime console identity, voice session
// identity).  It is NEVER derived from raw caller event fields.
//
// Branding is closure-private (WeakSet), so no module consumer can forge a
// provenance record, and no public mint exists at all.
// ---------------------------------------------------------------------------

/**
 * createSessionContinuity({ clock, idFactory, store, persistOnMutation,
 *                            trustedLifecycle })
 *
 * All dependencies are injected; the domain owns no globals, no timers, and
 * no authority.  `store` is the inert persistence contract from
 * persistence.js.  `trustedLifecycle` is the OPTIONAL trusted hook: a
 * function ({ controller, mintPeerProvenance }) => void called ONCE at
 * construction by the trusted composition root to capture the private
 * controller.  If omitted, the domain simply has no trusted consumer —
 * provenance can never be minted and no binding can ever form (fail closed).
 *
 * DSC-R1-005: persistence uses a bounded COALESCING scheduler — at most one
 * active write; mutations only mark state dirty; the writer re-checks and
 * re-writes while dirty.  O(1) scheduling state regardless of mutation count.
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
  const trustedLifecycle = options.trustedLifecycle;
  if (trustedLifecycle !== undefined && typeof trustedLifecycle !== "function") {
    throw new TypeError("SESSION_CONTINUITY_TRUSTED_LIFECYCLE_INVALID");
  }

  // ---- live inert state (NEVER escapes this closure) ---------------------
  const sessions = new Map();          // dsc_* → session record
  const bindingIndex = new Map();      // "channel\0peer" → sessionId
  const terminal = new Map();          // ix_* → { sessionId, state, generation, at }
  let persistedGeneration = 0;
  let restored = false;
  let degradedReason = null;
  let shutDown = false;

  // ---- trusted peer provenance (closure-private brand) -------------------
  const MINTED_PROVENANCE = new WeakSet();

  /**
   * TRUSTED-ONLY: mint peer provenance from a RUNTIME-OWNED
   * TransportPeerHandle (see transportPeer.js).  DSC-R3-001: the ONLY
   * accepted evidence input is a handle minted inside a trusted transport
   * peer scope — never a raw string, never a raw event field, never a
   * ses_* transport-session id.
   */
  function mintPeerProvenance(peerHandle) {
    if (!isCanonicalTransportPeerHandleShape(peerHandle)) {
      fail("PROVENANCE_UNTRUSTED", "peer provenance requires a canonical TransportPeerHandle minted by the trusted per-runtime transport scope");
    }
    const provenance = Object.freeze({
      kind: "PeerProvenance",
      channel: peerHandle.channel,
      peer: peerHandle.peer,
      scope: peerHandle.scope,
      key: `${peerHandle.channel}\u0000${peerHandle.peer}`
    });
    MINTED_PROVENANCE.add(provenance);
    return provenance;
  }

  function requirePeerProvenance(value, what) {
    if (value === null || typeof value !== "object" || !MINTED_PROVENANCE.has(value)) {
      fail("PROVENANCE_UNTRUSTED", `${what || "operation"} requires trusted peer provenance`);
    }
    return value;
  }

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

  // ---------------------------------------------------------------------------
  // DSC-R2-003 + DSC-R2-007 — bounded COALESCING persistence scheduler with
  // EPOCH-BASED SHARED DURABILITY PROMISES.
  //
  //   mutation → markDirty() → (re)open a durability epoch
  //   at most ONE writer is ever active
  //   writer: snapshot latest state → write → re-check dirty → maybe rewrite
  //
  // Waiter semantics (DSC-R2-007): every whenPersisted() caller JOINS the
  // single shared promise of the CURRENT epoch — internal retention is O(1)
  // (one promise object per epoch), no matter how many callers join.  When
  // the epoch settles, ALL joined callers observe the same result.
  //
  // Failure semantics (DSC-R2-003): a write failure REJECTS the epoch's
  // shared promise — every waiter of that epoch settles with a deterministic
  // failure.  A later mutation opens a NEW epoch with a NEW shared promise;
  // already-failed waiters are never retroactively turned into successes.
  //
  // Durability contract:
  //   create/update/bind/... success   → in-memory mutation accepted (NOT a
  //                                      guaranteed disk commit)
  //   whenPersisted()                  → durability of the state known at
  //                                      call time (success or deterministic
  //                                      failure)
  //   shutdown()                       → final durability or deterministic
  //                                      failure result
  // ---------------------------------------------------------------------------
  const scheduler = {
    dirty: false,
    writing: false,
    epoch: 0,
    epochShared: null,      // shared promise for the current epoch (O(1))
    epochSettled: true,
    lastError: null
  };

  // Settler for the CURRENT epoch (closure-private, single slot — O(1)).
  let settleEpoch = null;

  /** Open (or keep) the current durability epoch and return its SHARED
   * promise.  All joiners observe the same settlement. */
  function openEpoch() {
    if (scheduler.epochShared === null || scheduler.epochSettled) {
      scheduler.epoch += 1;
      scheduler.epochSettled = false;
      scheduler.epochShared = new Promise((resolve, reject) => {
        settleEpoch = (ok, value) => {
          if (scheduler.epochSettled) return;
          scheduler.epochSettled = true;
          if (ok) resolve(value);
          else reject(value);
        };
      });
      // The shared promise is joined by internal callers too; attach a
      // contained catch so an unobserved epoch failure can never surface as
      // an unhandled rejection.
      scheduler.epochShared.catch(() => {});
    }
    return scheduler.epochShared;
  }

  function settleEpochSuccess() {
    if (settleEpoch) settleEpoch(true, Object.freeze({ persisted: true, epoch: scheduler.epoch, savedAt: persistedGeneration }));
  }

  function settleEpochFailure(error) {
    if (settleEpoch) settleEpoch(false, error);
  }

  function markDirty() {
    if (!persistOnMutation) return;
    scheduler.dirty = true;
    // DSC-R3-002 CASE B: a NEW mutation opens a NEW durability epoch; the
    // previous failure's error state belongs to the failed epoch only.
    // Clearing it here lets the new epoch attempt recovery on its own
    // merits (whenPersisted of the failed epoch stays settled as failure).
    scheduler.lastError = null;
    openEpoch();
    ensureWriter();
  }

  function ensureWriter() {
    if (scheduler.writing || !scheduler.dirty || shutDown) return;
    scheduler.writing = true;
    // The writer runs detached but fully contained: no unhandled rejection.
    (async () => {
      try {
        while (scheduler.dirty && !shutDown) {
          scheduler.dirty = false;
          const snapshot = buildSnapshot(clock(), sessions, terminal);
          try {
            await store.persist(snapshot);
            persistedGeneration = snapshot.savedAt;
            scheduler.lastError = null;
          } catch (error) {
            // DSC-R2-003: surface the failure, settle EVERY waiter of this
            // epoch with a deterministic failure, and return to a coherent
            // idle/error state.  The next mutation opens a NEW epoch.
            scheduler.lastError = {
              code: error && error.code ? String(error.code) : "PERSIST_FAILURE",
              at: clock()
            };
            scheduler.dirty = true;
            const failure = new Error(`[PERSIST_FAILURE] ${scheduler.lastError.code}`);
            failure.name = "SessionContinuityError";
            failure.code = scheduler.lastError.code;
            settleEpochFailure(failure);
            break;
          }
        }
        // Durable quiescence: settle the epoch as success when nothing is
        // left dirty (either never dirty, or all writes completed).
        if (!scheduler.dirty) {
          settleEpochSuccess();
        }
      } finally {
        scheduler.writing = false;
        // If dirty state remains (failure case), it is re-armed ONLY by the
        // next mutation or an explicit flush — never by a self-retriggering
        // loop.
      }
    })();
  }

  /**
   * DSC-R2-003/#2: resolve or reject when the durability of the state known
   * at call time is settled.  Joins the CURRENT epoch's shared promise —
   * internal retention stays O(1) regardless of caller count.
   */
  function whenPersisted() {
    if (!persistOnMutation) return Promise.resolve();
    // DSC-R3-002 CASE A: a durability failure has been recorded and NO new
    // mutation has occurred since (dirty is the failure remnant, the writer
    // is idle, the epoch settled).  The recorded failure IS the durability
    // result for all state known at call time: settle DETERMINISTICALLY.
    // Never open a fresh inert epoch with no writer.
    if (scheduler.lastError !== null && !scheduler.writing &&
        scheduler.epochSettled && scheduler.dirty) {
      const failure = new Error(`[PERSIST_FAILURE] ${scheduler.lastError.code}`);
      failure.name = "SessionContinuityError";
      failure.code = scheduler.lastError.code;
      return Promise.reject(failure);
    }
    if (scheduler.epochSettled && !scheduler.dirty && !scheduler.writing) {
      return Promise.resolve(Object.freeze({ persisted: true, epoch: scheduler.epoch, savedAt: persistedGeneration }));
    }
    if (shutDown && !scheduler.writing) {
      // Shutdown latched with no writer: perform the final write directly
      // so the caller never parks forever.
      return (async () => {
        const snapshot = buildSnapshot(clock(), sessions, terminal);
        await store.persist(snapshot);
        persistedGeneration = snapshot.savedAt;
        scheduler.dirty = false;
        scheduler.lastError = null;
        return Object.freeze({ persisted: true, epoch: scheduler.epoch, savedAt: persistedGeneration });
      })();
    }
    // Normal path: join the CURRENT epoch's shared promise (the epoch's
    // writer is armed by markDirty/flushOnce; there is always a live or
    // pending writer on this path because epochSettled-with-idle-writer is
    // handled above).
    return openEpoch();
  }

  /** Await the write of the CURRENT state (shutdown seam). */
  async function flushOnce() {
    if (!persistOnMutation) {
      const snapshot = buildSnapshot(clock(), sessions, terminal);
      await store.persist(snapshot);
      persistedGeneration = snapshot.savedAt;
      return Object.freeze({ persisted: true, savedAt: snapshot.savedAt });
    }
    scheduler.dirty = true;
    openEpoch();
    ensureWriter();
    await openEpoch();
    if (scheduler.lastError !== null && scheduler.dirty) {
      const error = new Error(`[PERSIST_FAILURE] ${scheduler.lastError.code}`);
      error.name = "SessionContinuityError";
      error.code = scheduler.lastError.code;
      throw error;
    }
    return Object.freeze({ persisted: true, savedAt: persistedGeneration });
  }

  function getPersistenceStatus() {
    return Object.freeze({
      persistOnMutation,
      dirty: persistOnMutation && scheduler.dirty,
      writerActive: scheduler.writing,
      // Truthful: at most ONE shared epoch promise exists at any time.
      pendingWrites: scheduler.writing || scheduler.dirty ? 1 : 0,
      epoch: scheduler.epoch,
      lastError: scheduler.lastError === null ? null : Object.freeze({ ...scheduler.lastError })
    });
  }

  /** Explicit snapshot commit (trusted lifecycle / tests). */
  async function persist() {
    return flushOnce();
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
        restored: false, degraded: true, reason: degradedReason, sessions: 0
      });
    }
    const verdict = validateSnapshot(raw);
    if (verdict && verdict.corrupt === true) {
      restored = false;
      degradedReason = verdict.reason;
      return Object.freeze({
        restored: false, degraded: true, reason: verdict.reason, sessions: 0
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
    return Object.freeze({ restored: true, degraded: false, sessions: sessions.size });
  }

  // ---- inert views (frozen projections only) ------------------------------
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

  // ---- canonical identity -------------------------------------------------
  function createSession({ resumeMetadata } = {}) {
    if (shutDown) fail("DOMAIN_SHUTDOWN", "continuity domain is shut down");
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
    markDirty();
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

  // ---- cross-channel bindings (trusted-provenance gated) ------------------
  /**
   * Bind a trusted channel peer to a canonical session.  Deterministic for
   * the same trusted provenance.  A binding CANNOT be stolen: binding a
   * channel+peer already bound to a DIFFERENT session fails closed.
   * Binding TRANSFER exists only on the private trusted controller.
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
    markDirty();
    return Object.freeze({
      sessionId,
      channel: provenance.channel,
      peer: provenance.peer,
      generation: session.incarnation
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
    markDirty();
    return Object.freeze({ sessionId, channel: provenance.channel, peer: provenance.peer });
  }

  /**
   * Resolve a trusted channel event to its canonical session WITHOUT minting
   * authority: resolution is scoped to this domain, keyed by trusted peer
   * provenance ONLY.
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

  // ---- restart / resume ----------------------------------------------------
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
    for (const binding of session.channels) {
      binding.generation = session.incarnation;
    }
    touchSession(session, now);
    markDirty();
    return Object.freeze({
      sessionId: session.sessionId,
      incarnation: session.incarnation,
      previousIncarnation: session.incarnation - 1,
      resumed: true,
      resumeMetadata: session.resumeMetadata
    });
  }

  /** Closed metadata update: validated inert input, internal mutation,
   * frozen inert result.  Requires the CURRENT incarnation. */
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
    markDirty();
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
    markDirty();
    return Object.freeze({ sessionId, terminalAt: now, reason: String(reason).slice(0, 64) });
  }

  // ---- generation / stale-work safety --------------------------------------
  function currentIncarnation(sessionId) {
    if (!isCanonicalContinuitySessionId(sessionId)) return null;
    const session = sessions.get(sessionId);
    return session ? session.incarnation : null;
  }

  /** Pure frozen verdict — no mutable state access. */
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

  // ---- DSC-R1-002 + DSC-004: ADMISSION-CAPTURED OWNERSHIP -----------------
  /**
   * Capture the immutable ownership tuple for an interaction AT ADMISSION.
   * The returned incarnation is the incarnation CURRENT at admission; the
   * ingress must carry it through execution and use it at completion —
   * NEVER re-read currentIncarnation() later.
   */
  function captureAdmissionOwnership({ sessionId } = {}) {
    assertCanonicalContinuitySessionId(sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      fail("SESSION_NOT_FOUND", "cannot capture admission ownership for an unknown session");
    }
    if (session.terminalAt !== null) {
      fail("SESSION_TERMINAL", "terminal sessions cannot admit work");
    }
    return Object.freeze({
      sessionId: session.sessionId,
      incarnationAtAdmission: session.incarnation
    });
  }

  /**
   * The ONE terminal commit transition.  `generation` MUST be the ADMISSION
   * incarnation carried by the in-flight interaction — completing old work
   * after a resume yields STALE_GENERATION and never mutates the new
   * incarnation's terminal state.  In one internal transition: verify
   * session existence, session state, current incarnation == admission
   * incarnation, interaction non-duplication; then record + persist.
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
    if (session.terminalAt !== null) {
      fail("SESSION_TERMINAL", "terminal sessions cannot receive terminal outcomes");
    }
    const existing = terminal.get(interactionId);
    if (existing) {
      return Object.freeze({
        interactionId,
        sessionId: existing.sessionId,
        state: existing.state,
        recorded: false,
        idempotent: true
      });
    }
    if (generation !== session.incarnation) {
      fail("STALE_GENERATION", "terminal outcome carries a stale admission incarnation", {
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
    markDirty();
    return Object.freeze({ interactionId, sessionId, state, recorded: true, idempotent: false });
  }

  function getTerminalInteraction(interactionId) {
    const record = terminal.get(interactionId);
    if (!record) return null;
    return Object.freeze({ interactionId, ...record });
  }

  /**
   * Containment check for a stale async resolve/reject: accepted only if the
   * session is live, the presented (admission) incarnation is current, and
   * the interaction is not already terminal.
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

  // ---- diagnostics -----------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Graceful shutdown (DSC-R2-003 + DSC-R2-004).
  //
  // SHARED COMPLETION: the first invocation creates ONE canonical shutdown
  // completion promise; every subsequent call JOINS that same completion
  // until it settles.  No caller observes "shutdown complete" while the
  // final flush is still active.
  //
  // DETERMINISTIC FAILURE: a final-write disk error resolves the completion
  // with a flushed:{failed:true, code} result — never a hang.
  //
  // Never deletes persisted state.  The durable store's same-process
  // ownership is released by the TRUSTED LIFECYCLE OWNER through
  // store.finalizeShutdown() only after this completion settles.
  // ---------------------------------------------------------------------------
  let shutdownCompletion = null;

  function domainShutdown() {
    if (shutdownCompletion === null) {
      shutdownCompletion = (async () => {
        // Flush ALL currently-known dirty state BEFORE latching the shutdown
        // flag (the flag legitimately stops future mutation scheduling).
        let flushed = null;
        try {
          if (persistOnMutation) {
            scheduler.dirty = true;
            openEpoch();
            ensureWriter();
            await openEpoch();
          }
          if (scheduler.dirty || !persistOnMutation) {
            // Writer stopped on failure (or non-durable mode): perform one
            // direct final write so the outcome is conclusive.
            const snapshot = buildSnapshot(clock(), sessions, terminal);
            await store.persist(snapshot);
            persistedGeneration = snapshot.savedAt;
            scheduler.dirty = false;
          }
          flushed = Object.freeze({ persisted: true, savedAt: persistedGeneration });
        } catch (error) {
          flushed = Object.freeze({ failed: true, code: error?.code ?? "PERSIST_FAILURE" });
          // DSC-R2-003: settle any still-open epoch deterministically.
          const failure = new Error(`[PERSIST_FAILURE] ${error?.code ?? "PERSIST_FAILURE"}`);
          failure.name = "SessionContinuityError";
          failure.code = error?.code ?? "PERSIST_FAILURE";
          settleEpochFailure(failure);
        }
        shutDown = true;
        sessions.clear();
        bindingIndex.clear();
        terminal.clear();
        // Settle any epoch still open (e.g. parked before shutdown began).
        settleEpochSuccess();
        return Object.freeze({ shutdown: true, flushed });
      })();
      // Contain: the canonical completion itself never rejects; failure is
      // carried in the resolved result (deterministic failure return).
      shutdownCompletion.catch(() => {});
    }
    return shutdownCompletion;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE TRUSTED CONTROLLER — handed ONLY to the trustedLifecycle hook.
  // Never returned from the facade, never exported from the module, and
  // reachable by no token/resolver mechanism whatsoever.
  // ---------------------------------------------------------------------------
  const trustedController = Object.freeze({
    restore,
    persist,
    shutdown: domainShutdown,
    mintPeerProvenance,
    /**
     * DSC-R2-006: TRUSTED-ONLY explicit continuity LINK.  Binds BOTH
     * trusted peer provenances to the SAME canonical session (endpoint B
     * joins endpoint A's session).  Composition-only; never reachable from
     * raw events, the ordinary facade, or Manager payload.  Links
     * continuity identity ONLY — never authority.
     */
    trustedLinkContinuity({ provenanceA, provenanceB } = {}) {
      requirePeerProvenance(provenanceA, "trustedLinkContinuity");
      requirePeerProvenance(provenanceB, "trustedLinkContinuity");
      const keyA = provenanceA.key;
      const keyB = provenanceB.key;
      if (keyA === keyB) {
        fail("LINK_ENDPOINTS_IDENTICAL", "continuity link endpoints must differ");
      }
      const ownerA = bindingIndex.get(keyA);
      const ownerB = bindingIndex.get(keyB);
      // DSC-R3-005: FAIL-CLOSED conflict semantics.  If either endpoint is
      // already bound to a LIVE dsc session (other than one the OTHER
      // endpoint already owns — i.e. an already-linked pair re-linking
      // idempotently), the link is REJECTED with a typed conflict.  NO
      // SILENT TRANSFER: an existing binding is never detached by a link.
      // (Explicit transfer, if ever needed, must be a distinct owner-
      // confirmed operation; this repair deliberately provides none.)
      const liveOwnerA = ownerA && sessions.has(ownerA) ? ownerA : null;
      const liveOwnerB = ownerB && sessions.has(ownerB) ? ownerB : null;
      if (liveOwnerA && liveOwnerB && liveOwnerA !== liveOwnerB) {
        fail("LINK_CONFLICT", "both endpoints are already bound to different live continuity sessions", {
          endpointA: { channel: provenanceA.channel, peer: provenanceA.peer, boundSessionId: liveOwnerA },
          endpointB: { channel: provenanceB.channel, peer: provenanceB.peer, boundSessionId: liveOwnerB }
        });
      }
      if (liveOwnerA && liveOwnerB && liveOwnerA === liveOwnerB) {
        // Idempotent: already linked to each other's session.
        const existing = sessions.get(liveOwnerA);
        return Object.freeze({
          sessionId: liveOwnerA,
          linked: Object.freeze([]),
          idempotent: true
        });
      }
      // Resolve/choose the target canonical session: the bound endpoint's
      // session if exactly one is bound, else mint a new one.
      let target = liveOwnerA ? sessions.get(liveOwnerA) : null;
      if (!target && liveOwnerB) target = sessions.get(liveOwnerB);
      if (!target) {
        target = {
          sessionId: idFactory.next(),
          createdAt: clock(),
          updatedAt: clock(),
          incarnation: 1,
          resumeMetadata: Object.freeze({}),
          terminalAt: null,
          channels: [],
          state: "ACTIVE"
        };
        assertCanonicalContinuitySessionId(target.sessionId);
        sessions.set(target.sessionId, target);
      }
      if (target.terminalAt !== null) {
        fail("SESSION_TERMINAL", "cannot link onto a terminal session");
      }
      const now = clock();
      const attached = [];
      for (const [provenance, key] of [[provenanceA, keyA], [provenanceB, keyB]]) {
        // Only UNBOUND endpoints are attached here — conflict semantics above
        // guarantee no live binding is ever detached or reassigned.
        const alreadyBound = target.channels.some((b) => compositeBindingKey(b) === key);
        if (!alreadyBound && !bindingIndex.has(key)) {
          if (target.channels.length >= DEFAULT_BOUNDS.maxBindingsPerSession) {
            fail("BINDING_LIMIT_EXCEEDED", "session binding bound reached");
          }
          target.channels.push({
            channel: provenance.channel,
            peer: provenance.peer,
            boundAt: now,
            generation: target.incarnation
          });
          bindingIndex.set(key, target.sessionId);
          attached.push(Object.freeze({ channel: provenance.channel, peer: provenance.peer }));
        }
      }
      target.state = "ACTIVE";
      touchSession(target, now);
      markDirty();
      return Object.freeze({
        sessionId: target.sessionId,
        linked: Object.freeze(attached)
      });
    },
    // TRUSTED-ONLY binding transfer (explicit cross-session unification).
    trustedTransferBinding({ provenance, toSessionId } = {}) {
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
      markDirty();
      return Object.freeze({
        channel: provenance.channel,
        peer: provenance.peer,
        fromSessionId: previous && previous !== toSessionId ? previous : null,
        toSessionId
      });
    },
    // EXPLICIT destructive administrative reset — private, composition-only.
    async resetDurableState() {
      if (typeof store.clear === "function") {
        await store.clear();
      }
      sessions.clear();
      bindingIndex.clear();
      terminal.clear();
      return Object.freeze({ reset: true });
    }
  });

  if (trustedLifecycle !== undefined) {
    try {
      trustedLifecycle(trustedController);
    } catch (error) {
      // A broken trusted hook must not leave a half-constructed domain.
      throw new TypeError("SESSION_CONTINUITY_TRUSTED_LIFECYCLE_FAULT");
    }
  }

  // ---- PUBLIC INERT FACADE ---------------------------------------------------
  // DSC-R1-001/003: NO __trusted, NO provenance mint, NO resetDurableState,
  // NO trusted transfer, NO resolver.  Bounded continuity operations only.
  return Object.freeze({
    // canonical identity
    createSession,
    getSession,
    // cross-channel bindings (trusted-provenance gated; provenance can only
    // be minted by the trusted composition closure via trustedLifecycle)
    bindChannel,
    unbindChannel,
    resolveChannel,
    // restart / resume
    resumeSession,
    closeSession,
    persist,
    restore,
    // generation ownership (pure checks; admission capture)
    currentIncarnation,
    checkIncarnation,
    captureAdmissionOwnership,
    // terminal lifecycle (atomic, admission-incarnation-owned)
    commitTerminalOutcome,
    getTerminalInteraction,
    acceptAsyncOutcome,
    // metadata (closed validated mutation)
    updateResumeMetadata,
    // diagnostics
    snapshotDiagnostics,
    getPersistenceStatus,
    whenPersisted,
    // graceful shutdown (non-destructive; flushes)
    shutdown: domainShutdown
  });
}

module.exports = Object.freeze({
  createSessionContinuity,
  // Inert vocabulary ONLY — deliberately NO mintPeerProvenance, NO
  // isPeerProvenance, NO _resolveTrustedController, NO trusted tokens.
  TERMINAL_INTERACTION_STATES,
  DEFAULT_BOUNDS
});
