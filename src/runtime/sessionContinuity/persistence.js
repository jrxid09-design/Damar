"use strict";

/**
 * DAMAR SESSION CONTINUITY — bounded inert persistence (Wave 5 Lane 4).
 *
 * Continuity state is a CLOSED, FROZEN, PLAIN-DATA record.  It never contains
 * (and never accepts): functions, class instances, proxies, accessors,
 * AbortControllers, tool handles, model clients, streams, capability
 * references, principals, secrets, or tokens.
 *
 *   PERSISTED STATE != LIVE AUTHORITY
 *
 * Durability follows the established atomic pattern (staging file + fsync +
 * rename + directory sync where supported), mirroring
 * src/runtime/mediaIngress/subsystem.js without depending on it.  A crash at
 * any point leaves either the previous complete snapshot or the new complete
 * snapshot — never a half-written one.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { types } = require("node:util");

const SNAPSHOT_VERSION = 1;

// Closed snapshot schema: every field must be known, correctly typed, bounded.
const SESSION_FIELDS = Object.freeze([
  "sessionId", "createdAt", "updatedAt", "incarnation",
  "resumeMetadata", "terminalAt", "channels"
]);
const BINDING_FIELDS = Object.freeze(["channel", "peer", "boundAt", "generation"]);
const TERMINAL_ENTRY_FIELDS = Object.freeze(["sessionId", "state", "generation", "at"]);
const SNAPSHOT_LIMITS = Object.freeze({
  maxSessions: 4096,
  maxBindingsPerSession: 16,
  maxTerminalInteractions: 2048,
  maxResumeMetadataBytes: 2048,
  maxSnapshotBytes: 512 * 1024
});

function fail(code, message, details) {
  const error = new Error(`[${code}] ${message || code}`);
  error.name = "SessionContinuityError";
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let proxy;
  try { proxy = types.isProxy(value); } catch { return false; }
  if (proxy) return false;
  let proto;
  try { proto = Object.getPrototypeOf(value); } catch { return false; }
  return proto === Object.prototype || proto === null;
}

function hasOnlyDataProperties(value) {
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return Object.getOwnPropertySymbols(value).length === 0;
}

function safeInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

const CHANNEL_RE = /^[a-z][a-z0-9_]{0,31}$/;
const DSC_RE = /^dsc_[a-z0-9][a-z0-9_-]{0,62}$/;
const IX_RE = /^ix_[a-z0-9][a-z0-9_-]{0,62}$/;
const META_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * In-memory continuity store (tests / inert default).  Injectable; the
 * production composition selects the durable file store (DSC-003).
 */
function createMemoryContinuityStore() {
  let snapshot = null;
  return Object.freeze({
    async load() { return snapshot; },
    async persist(next) { snapshot = next; },
    async clear() { snapshot = null; }
  });
}

// ---------------------------------------------------------------------------
// Durable file store (DSC-003 + persistence hygiene)
// ---------------------------------------------------------------------------

/** Directory sync where the platform supports it; a documented no-op where
 * it does not (Windows/EPERM etc. — same policy as mediaIngress). */
async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform === "win32" &&
        ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code)) {
      return false; // platform constraint, not an anomaly
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return true;
}

/** Reconcile abandoned staging files (crash leftovers) from previous runs.
 * Bounded; anomalies (non-staging names, symlinks) are ignored, not
 * executed.  Returns the number of reclaimed staging files. */
async function cleanupAbandonedStaging(directory, maxScan = 64) {
  let reclaimed = 0;
  let entries;
  try {
    entries = await fsp.readdir(directory);
  } catch {
    return 0;
  }
  const staging = entries.filter((name) => name.startsWith(".cont_") && name.endsWith(".tmp"));
  for (const name of staging.slice(0, maxScan)) {
    const target = path.join(directory, name);
    try {
      const stat = await fsp.lstat(target);
      // Fail closed on anomalies: only plain files are reclaimed.
      if (stat.isFile() && !stat.isSymbolicLink()) {
        await fsp.unlink(target);
        reclaimed += 1;
      }
    } catch {
      // already gone / race — acceptable
    }
  }
  return reclaimed;
}

// ---------------------------------------------------------------------------
// Same-process durable-store OWNERSHIP (DSC-R2-002).
//
// Multiple createRuntimeHost() compositions in ONE process can accidentally
// target the same durable snapshot path.  Cross-process/Mesh locking is
// explicitly OUT OF SCOPE; this is a narrow process-local registry: exactly
// one active durable owner per normalized absolute path.
//
// DSC-R2-002: ownership is held UNTIL FINAL FLUSH COMPLETES.  The owning
// store releases the registry entry only inside the settled completion of
// its shutdown (after the final write attempt has conclusively ended),
// never synchronously at shutdown-call time.  A second composition
// attempting the same path while the first is still flushing fails closed
// with CONTINUITY_STORE_OWNED.
// ---------------------------------------------------------------------------
const ACTIVE_FILE_STORE_OWNERS = new Map(); // normalized path → store handle

/** DSC-R2-002/#6: normalize an absolute path for ownership comparison.
 * Absolute form + separator normalization always; on win32 the path is
 * ALSO lowercased because NTFS path comparison is case-insensitive. */
function normalizeStorePath(file) {
  let normalized = path.resolve(file);
  // Separator normalization: forward slashes to platform separators.
  normalized = normalized.split("/").join(path.sep);
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function acquireFileStoreOwnership(normalizedPath, storeHandle) {
  if (ACTIVE_FILE_STORE_OWNERS.has(normalizedPath)) {
    const error = new Error(
      `[CONTINUITY_STORE_OWNED] durable continuity store is already owned by another active composition in this process: ${normalizedPath}`
    );
    error.name = "SessionContinuityError";
    error.code = "CONTINUITY_STORE_OWNED";
    error.details = { path: normalizedPath };
    throw error;
  }
  ACTIVE_FILE_STORE_OWNERS.set(normalizedPath, storeHandle);
}

function releaseFileStoreOwnership(normalizedPath, storeHandle) {
  if (ACTIVE_FILE_STORE_OWNERS.get(normalizedPath) === storeHandle) {
    ACTIVE_FILE_STORE_OWNERS.delete(normalizedPath);
    return true;
  }
  return false;
}

function isFileStoreOwned(normalizedPath) {
  return ACTIVE_FILE_STORE_OWNERS.has(normalizedPath);
}

/**
 * Durable file store: one bounded JSON snapshot per continuity domain,
 * written atomically.  Malformed/oversized snapshots on disk fail CLOSED
 * (load returns { corrupt: true } and the caller degrades to a fresh
 * continuity domain — never resurrect unvalidated state).
 *
 * Same-process ownership (DSC-R2-002): constructing a second file store
 * over the SAME normalized path while the first is still active (including
 * while its shutdown flush is in flight) fails closed with
 * CONTINUITY_STORE_OWNED.  Ownership is released ONLY when the final
 * shutdown flush settles (success OR deterministic failure) — by
 * `store.finalizeShutdown()`, called by the trusted lifecycle owner.
 */
function createFileContinuityStore(file) {
  if (typeof file !== "string" || file.length === 0 || !path.isAbsolute(file)) {
    throw new TypeError("CONTINUITY_STORE_FILE_INVALID");
  }
  const normalizedPath = normalizeStorePath(file);
  const directory = path.dirname(path.resolve(file));
  // Same-process ownership: exactly one active durable owner per path.
  acquireFileStoreOwnership(normalizedPath, null);
  const storeHandle = Object.freeze({
    path: normalizedPath,
    kind: "SessionContinuityStoreHandle"
  });
  ACTIVE_FILE_STORE_OWNERS.set(normalizedPath, storeHandle);
  let finalized = false;
  return Object.freeze({
    async load() {
      // Hygiene: reclaim abandoned staging from a crashed previous run
      // BEFORE reading (bounded, fail-closed on anomalies).
      await cleanupAbandonedStaging(directory);
      let raw;
      try {
        raw = await fsp.readFile(path.resolve(file), "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") return null;
        return { corrupt: true, reason: "READ_FAILED" };
      }
      if (Buffer.byteLength(raw, "utf8") > SNAPSHOT_LIMITS.maxSnapshotBytes) {
        return { corrupt: true, reason: "SNAPSHOT_TOO_LARGE" };
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { corrupt: true, reason: "SNAPSHOT_MALFORMED_JSON" };
      }
      return parsed;
    },
    async persist(next) {
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized, "utf8") > SNAPSHOT_LIMITS.maxSnapshotBytes) {
        fail("SNAPSHOT_TOO_LARGE", "continuity snapshot exceeds the persistence bound");
      }
      await fsp.mkdir(directory, { recursive: true });
      const staging = path.join(
        directory,
        `.cont_${process.pid}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.tmp`
      );
      const handle = await fsp.open(staging, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
      try {
        fs.renameSync(staging, path.resolve(file));
        // Hygiene: make the rename itself durable where the platform allows.
        await syncDirectory(directory);
      } catch (error) {
        await fsp.unlink(staging).catch(() => {});
        throw error;
      }
      return Object.freeze({ persisted: true });
    },
    async clear() {
      await fsp.unlink(path.resolve(file)).catch((error) => {
        if (!error || error.code !== "ENOENT") throw error;
      });
    },
    /**
     * DSC-R2-002: release same-process ownership.  Called ONLY by the
     * trusted lifecycle owner AFTER the final flush has conclusively ended
     * (success or deterministic failure).  Idempotent, non-destructive.
     */
    async finalizeShutdown() {
      if (finalized) return Object.freeze({ released: false, alreadyFinalized: true });
      finalized = true;
      const released = releaseFileStoreOwnership(normalizedPath, storeHandle);
      return Object.freeze({ released });
    }
  });
}

/**
 * Validate an inert snapshot record.  Returns a FROZEN detached copy or
 * { corrupt: true, reason }.  Unknown fields, wrong types, oversize or
 * non-plain input all fail closed.
 */
function validateSnapshot(raw) {
  if (!plain(raw) || !hasOnlyDataProperties(raw)) {
    return { corrupt: true, reason: "SNAPSHOT_NOT_PLAIN" };
  }
  const fields = Object.getOwnPropertyNames(raw);
  const allowedTop = ["schemaVersion", "savedAt", "sessions", "terminal"];
  if (fields.length !== allowedTop.length || !fields.every((k) => allowedTop.includes(k))) {
    return { corrupt: true, reason: "SNAPSHOT_FIELDS_INVALID" };
  }
  if (raw.schemaVersion !== SNAPSHOT_VERSION) {
    return { corrupt: true, reason: "SNAPSHOT_VERSION_UNSUPPORTED" };
  }
  if (!safeInteger(raw.savedAt, 0, Number.MAX_SAFE_INTEGER)) {
    return { corrupt: true, reason: "SNAPSHOT_SAVEDAT_INVALID" };
  }
  if (!Array.isArray(raw.sessions)) {
    return { corrupt: true, reason: "SNAPSHOT_SESSIONS_INVALID" };
  }
  if (raw.sessions.length > SNAPSHOT_LIMITS.maxSessions) {
    return { corrupt: true, reason: "SNAPSHOT_SESSIONS_OVERFLOW" };
  }
  const sessions = {};
  const seenSessionIds = new Set();
  for (const entry of raw.sessions) {
    if (!plain(entry) || !hasOnlyDataProperties(entry)) {
      return { corrupt: true, reason: "SESSION_ENTRY_NOT_PLAIN" };
    }
    const names = Object.getOwnPropertyNames(entry);
    if (names.length !== SESSION_FIELDS.length || !SESSION_FIELDS.every((k) => names.includes(k))) {
      return { corrupt: true, reason: "SESSION_ENTRY_FIELDS_INVALID" };
    }
    if (typeof entry.sessionId !== "string" || !DSC_RE.test(entry.sessionId)) {
      return { corrupt: true, reason: "SESSION_ENTRY_ID_INVALID" };
    }
    if (seenSessionIds.has(entry.sessionId)) {
      return { corrupt: true, reason: "SESSION_ENTRY_DUPLICATE" };
    }
    seenSessionIds.add(entry.sessionId);
    if (!safeInteger(entry.createdAt, 0, Number.MAX_SAFE_INTEGER) ||
        !safeInteger(entry.updatedAt, 0, Number.MAX_SAFE_INTEGER) ||
        entry.updatedAt < entry.createdAt) {
      return { corrupt: true, reason: "SESSION_ENTRY_TIME_INVALID" };
    }
    if (!safeInteger(entry.incarnation, 1, 1_000_000_000)) {
      return { corrupt: true, reason: "SESSION_ENTRY_INCARNATION_INVALID" };
    }
    if (entry.terminalAt !== null && !safeInteger(entry.terminalAt, 0, Number.MAX_SAFE_INTEGER)) {
      return { corrupt: true, reason: "SESSION_ENTRY_TERMINAL_INVALID" };
    }
    if (entry.resumeMetadata !== null) {
      if (!plain(entry.resumeMetadata) || !hasOnlyDataProperties(entry.resumeMetadata)) {
        return { corrupt: true, reason: "SESSION_ENTRY_METADATA_NOT_PLAIN" };
      }
      for (const key of Object.getOwnPropertyNames(entry.resumeMetadata)) {
        if (!META_KEY_RE.test(key)) {
          return { corrupt: true, reason: "SESSION_ENTRY_METADATA_KEY_INVALID" };
        }
        const value = entry.resumeMetadata[key];
        if (!(value === null || typeof value === "string" || typeof value === "boolean" ||
              (typeof value === "number" && Number.isFinite(value)))) {
          return { corrupt: true, reason: "SESSION_ENTRY_METADATA_VALUE_INVALID" };
        }
      }
      if (Buffer.byteLength(JSON.stringify(entry.resumeMetadata), "utf8") > SNAPSHOT_LIMITS.maxResumeMetadataBytes) {
        return { corrupt: true, reason: "SESSION_ENTRY_METADATA_TOO_LARGE" };
      }
    }
    if (!Array.isArray(entry.channels)) {
      return { corrupt: true, reason: "SESSION_ENTRY_CHANNELS_INVALID" };
    }
    if (entry.channels.length > SNAPSHOT_LIMITS.maxBindingsPerSession) {
      return { corrupt: true, reason: "SESSION_ENTRY_BINDINGS_OVERFLOW" };
    }
    const channels = [];
    const seenBindings = new Set();
    for (const binding of entry.channels) {
      if (!plain(binding) || !hasOnlyDataProperties(binding)) {
        return { corrupt: true, reason: "BINDING_ENTRY_NOT_PLAIN" };
      }
      const bindingNames = Object.getOwnPropertyNames(binding);
      if (bindingNames.length !== BINDING_FIELDS.length ||
          !BINDING_FIELDS.every((k) => bindingNames.includes(k))) {
        return { corrupt: true, reason: "BINDING_ENTRY_FIELDS_INVALID" };
      }
      if (typeof binding.channel !== "string" || !CHANNEL_RE.test(binding.channel)) {
        return { corrupt: true, reason: "BINDING_ENTRY_CHANNEL_INVALID" };
      }
      // EXACT peer string (DSC-001 + peer byte-bound): non-empty, bounded by
      // actual UTF-8 BYTES (not JS characters), no control chars, no NUL
      // (the composite-key separator).  Fail closed — never truncate.
      if (typeof binding.peer !== "string" || binding.peer.length === 0 ||
          Buffer.byteLength(binding.peer, "utf8") > 128 ||
          /[\u0000-\u001f\u007f]/.test(binding.peer)) {
        return { corrupt: true, reason: "BINDING_ENTRY_PEER_INVALID" };
      }
      if (!safeInteger(binding.boundAt, 0, Number.MAX_SAFE_INTEGER) ||
          !safeInteger(binding.generation, 1, 1_000_000_000)) {
        return { corrupt: true, reason: "BINDING_ENTRY_GENERATION_INVALID" };
      }
      const composite = `${binding.channel}\u0000${binding.peer}`;
      if (seenBindings.has(composite)) {
        return { corrupt: true, reason: "BINDING_ENTRY_DUPLICATE" };
      }
      seenBindings.add(composite);
      channels.push(Object.freeze({ ...binding }));
    }
    sessions[entry.sessionId] = Object.freeze({
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      incarnation: entry.incarnation,
      resumeMetadata: entry.resumeMetadata === null ? null : Object.freeze({ ...entry.resumeMetadata }),
      terminalAt: entry.terminalAt,
      channels: Object.freeze(channels)
    });
  }
  if (!plain(raw.terminal)) {
    return { corrupt: true, reason: "TERMINAL_LEDGER_NOT_PLAIN" };
  }
  const entries = Object.getOwnPropertyNames(raw.terminal);
  if (entries.length > SNAPSHOT_LIMITS.maxTerminalInteractions) {
    return { corrupt: true, reason: "TERMINAL_LEDGER_OVERFLOW" };
  }
  const out = {};
  for (const interactionId of entries) {
    if (!IX_RE.test(interactionId)) {
      return { corrupt: true, reason: "TERMINAL_LEDGER_KEY_INVALID" };
    }
    const record = raw.terminal[interactionId];
    if (!plain(record) || !hasOnlyDataProperties(record)) {
      return { corrupt: true, reason: "TERMINAL_LEDGER_ENTRY_NOT_PLAIN" };
    }
    const recordNames = Object.getOwnPropertyNames(record);
    if (recordNames.length !== TERMINAL_ENTRY_FIELDS.length ||
        !TERMINAL_ENTRY_FIELDS.every((k) => recordNames.includes(k))) {
      return { corrupt: true, reason: "TERMINAL_LEDGER_ENTRY_FIELDS_INVALID" };
    }
    if (!["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(record.state)) {
      return { corrupt: true, reason: "TERMINAL_LEDGER_ENTRY_STATE_INVALID" };
    }
    if (!DSC_RE.test(record.sessionId)) {
      return { corrupt: true, reason: "TERMINAL_LEDGER_ENTRY_SESSION_INVALID" };
    }
    if (!safeInteger(record.generation, 1, 1_000_000_000) ||
        !safeInteger(record.at, 0, Number.MAX_SAFE_INTEGER)) {
      return { corrupt: true, reason: "TERMINAL_LEDGER_ENTRY_INVALID" };
    }
    out[interactionId] = Object.freeze({ ...record });
  }
  return Object.freeze({
    schemaVersion: SNAPSHOT_VERSION,
    savedAt: raw.savedAt,
    sessions: Object.freeze(sessions),
    terminal: Object.freeze(out)
  });
}

/** Build a fresh inert snapshot from live domain state. */
function buildSnapshot(now, sessions, terminal) {
  const sessionList = [];
  for (const session of sessions.values()) {
    sessionList.push({
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      incarnation: session.incarnation,
      resumeMetadata: session.resumeMetadata,
      terminalAt: session.terminalAt,
      channels: session.channels.map((binding) => ({
        channel: binding.channel,
        peer: binding.peer,
        boundAt: binding.boundAt,
        generation: binding.generation
      }))
    });
  }
  const terminalOut = {};
  let terminalCount = 0;
  for (const [interactionId, record] of terminal.entries()) {
    if (terminalCount >= SNAPSHOT_LIMITS.maxTerminalInteractions) break;
    terminalOut[interactionId] = {
      sessionId: record.sessionId,
      state: record.state,
      generation: record.generation,
      at: record.at
    };
    terminalCount += 1;
  }
  return Object.freeze({
    schemaVersion: SNAPSHOT_VERSION,
    savedAt: now,
    sessions: Object.freeze(sessionList),
    terminal: Object.freeze(terminalOut)
  });
}

module.exports = Object.freeze({
  SNAPSHOT_VERSION,
  SNAPSHOT_LIMITS,
  SESSION_FIELDS,
  BINDING_FIELDS,
  TERMINAL_ENTRY_FIELDS,
  createMemoryContinuityStore,
  createFileContinuityStore,
  validateSnapshot,
  buildSnapshot,
  // hygiene helpers (internal/test-visible)
  _syncDirectory: syncDirectory,
  _cleanupAbandonedStaging: cleanupAbandonedStaging,
  _normalizeStorePath: normalizeStorePath,
  _isFileStoreOwned: isFileStoreOwned,
  _fail: fail,
  _plain: plain,
  _hasOnlyDataProperties: hasOnlyDataProperties
});
