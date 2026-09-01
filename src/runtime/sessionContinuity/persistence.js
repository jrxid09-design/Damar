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
 * rename), mirroring src/runtime/mediaIngress/subsystem.js without depending
 * on it.  A crash at any point leaves either the previous complete snapshot
 * or the new complete snapshot — never a half-written one.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { types } = require("node:util");

const SNAPSHOT_VERSION = 1;

// Closed snapshot schema: every field must be known, correctly typed, bounded.
const SESSION_FIELDS = Object.freeze([
  "sessionId", "createdAt", "updatedAt", "incarnation",
  "resumeMetadata", "terminalAt", "channels"
]);
const BINDING_FIELDS = Object.freeze(["channel", "peerKey", "boundAt", "generation"]);
const SNAPSHOT_LIMITS = Object.freeze({
  maxSessions: 4096,
  maxBindingsPerSession: 16,
  maxTerminalInteractions: 2048,
  maxResumeMetadataBytes: 2048,
  maxSnapshotBytes: 512 * 1024,
  maxTerminalCount: 4096
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

/**
 * In-memory continuity store (default).  Injectable for tests and for a
 * future durable backend; the contract is synchronous snapshots +
 * asynchronous durable flush.
 */
function createMemoryContinuityStore() {
  let snapshot = null;
  return Object.freeze({
    async load() { return snapshot; },
    async persist(next) { snapshot = next; },
    async clear() { snapshot = null; }
  });
}

/**
 * Durable file store: one bounded JSON snapshot per continuity domain,
 * written atomically.  Malformed/oversized snapshots on disk fail CLOSED
 * (load returns { corrupt: true } and the caller must degrade to a fresh
 * continuity domain — never resurrect unvalidated state).
 */
function createFileContinuityStore(file) {
  if (typeof file !== "string" || file.length === 0 || !path.isAbsolute(file)) {
    throw new TypeError("CONTINUITY_STORE_FILE_INVALID");
  }
  const directory = path.dirname(file);
  return Object.freeze({
    async load() {
      let raw;
      try {
        raw = await fsp.readFile(file, "utf8");
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
      const staging = path.join(directory, `.cont_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
      const handle = await fsp.open(staging, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
      try {
        fs.renameSync(staging, file);
      } catch (error) {
        await fsp.unlink(staging).catch(() => {});
        throw error;
      }
      return Object.freeze({ persisted: true });
    },
    async clear() {
      await fsp.unlink(file).catch((error) => {
        if (!error || error.code !== "ENOENT") throw error;
      });
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
  if (fields.length !== 3 || !fields.every((k) => ["schemaVersion", "savedAt", "sessions", "terminal"].includes(k))) {
    if (fields.length !== 4 || !fields.every((k) => ["schemaVersion", "savedAt", "sessions", "terminal"].includes(k))) {
      return { corrupt: true, reason: "SNAPSHOT_FIELDS_INVALID" };
    }
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
    if (typeof entry.sessionId !== "string" || !/^dsc_[a-z0-9][a-z0-9_-]{0,62}$/.test(entry.sessionId)) {
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
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
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
      if (typeof binding.channel !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(binding.channel)) {
        return { corrupt: true, reason: "BINDING_ENTRY_CHANNEL_INVALID" };
      }
      if (typeof binding.peerKey !== "string" || binding.peerKey.length === 0 || binding.peerKey.length > 128) {
        return { corrupt: true, reason: "BINDING_ENTRY_PEER_INVALID" };
      }
      if (!safeInteger(binding.boundAt, 0, Number.MAX_SAFE_INTEGER) ||
          !safeInteger(binding.generation, 1, 1_000_000_000)) {
        return { corrupt: true, reason: "BINDING_ENTRY_GENERATION_INVALID" };
      }
      const composite = `${binding.channel} ${binding.peerKey}`;
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
  let terminal = Object.freeze([]);
  if (raw.terminal !== undefined) {
    if (!plain(raw.terminal) || !hasOnlyDataProperties(raw.terminal)) {
      return { corrupt: true, reason: "TERMINAL_LEDGER_NOT_PLAIN" };
    }
    const entries = Object.getOwnPropertyNames(raw.terminal);
    if (entries.length > SNAPSHOT_LIMITS.maxTerminalInteractions) {
      return { corrupt: true, reason: "TERMINAL_LEDGER_OVERFLOW" };
    }
    const out = {};
    for (const interactionId of entries) {
      if (!/^ix_[a-z0-9][a-z0-9_-]{0,62}$/.test(interactionId)) {
        return { corrupt: true, reason: "TERMINAL_LEDGER_KEY_INVALID" };
      }
      const record = raw.terminal[interactionId];
      if (!plain(record) || !hasOnlyDataProperties(record)) {
        return { corrupt: true, reason: "TERMINAL_LEDGER_ENTRY_NOT_PLAIN" };
      }
      const recordNames = Object.getOwnPropertyNames(record);
      if (recordNames.length !== 3 || !recordNames.every((k) => ["state", "generation", "at"].includes(k))) {
        return { corrupt: true, reason: "TERMINAL_LEDGER_ENTRY_FIELDS_INVALID" };
      }
      if (!["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(record.state)) {
        return { corrupt: true, reason: "TERMINAL_LEDGER_ENTRY_STATE_INVALID" };
      }
      if (!safeInteger(record.generation, 1, 1_000_000_000) ||
          !safeInteger(record.at, 0, Number.MAX_SAFE_INTEGER)) {
        return { corrupt: true, reason: "TERMINAL_LEDGER_ENTRY_INVALID" };
      }
      out[interactionId] = Object.freeze({ ...record });
    }
    terminal = Object.freeze(out);
  }
  return Object.freeze({
    schemaVersion: SNAPSHOT_VERSION,
    savedAt: raw.savedAt,
    sessions: Object.freeze(sessions),
    terminal
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
        peerKey: binding.peerKey,
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
  createMemoryContinuityStore,
  createFileContinuityStore,
  validateSnapshot,
  buildSnapshot,
  // Internal fail helper shared with the domain module.
  _fail: fail,
  _plain: plain,
  _hasOnlyDataProperties: hasOnlyDataProperties
});
