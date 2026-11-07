"use strict";

/**
 * WAVE 5 LANE 4 — SESSION CONTINUITY TEST SUITE (repair R3, part 1).
 *
 * Continuity-domain contracts: trusted controller captured ONLY through the
 * trustedLifecycle closure hook; epoch-based bounded persistence; shared
 * shutdown completion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createSessionContinuity,
  createSequentialContinuityIdFactory,
  createMemoryContinuityStore,
  createFileContinuityStore,
  validateSnapshot
} = require("../../src/runtime/sessionContinuity");
const {
  createTestTransportPeerScope
} = require("../helpers/testTransportPeer");

/** Trusted scope helper (isolated component-test scope; per-scope provenance
 * — never accepted by the canonical composition). */
function peerScope(channel) {
  return createTestTransportPeerScope({ channel, scope: "RUNTIME_OWNER" });
}

/** Mint a trusted provenance via the composition-style controller. */
function provOf(controller, channel, peer) {
  return controller.mintPeerProvenance(peerScope(channel).mint(peer));
}

function makeDomain(options = {}) {
  let now = options.now === undefined ? 1000 : options.now;
  const clock = () => now;
  let controller = null;
  const domain = createSessionContinuity({
    clock,
    idFactory: options.idFactory || createSequentialContinuityIdFactory(),
    store: options.store || createMemoryContinuityStore(),
    persistOnMutation: options.persistOnMutation === true,
    trustedLifecycle(captured) {
      if (controller !== null) throw new Error("double capture");
      controller = captured;
    }
  });
  return {
    domain,
    controller,
    provOf: (c, channel, peer) => c.mintPeerProvenance(peerScope(channel).mint(peer)),
    advance: (ms) => { now += ms; },
    setNow: (value) => { now = value; }
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "damar-continuity-"));
}

// ---------------------------------------------------------------------------
// Public-surface hardening (retained from R2)
// ---------------------------------------------------------------------------

test("DSC-R1-001 (retained): no public mint/controller/resolver anywhere", () => {
  const mod = require("../../src/runtime/sessionContinuity/continuity");
  const t = makeDomain();
  for (const key of Object.keys(mod)) {
    assert.match(key, /^(createSessionContinuity|TERMINAL_INTERACTION_STATES|DEFAULT_BOUNDS)$/);
  }
  assert.equal("__trusted" in t.domain, false);
  assert.equal("resetDurableState" in t.domain, false);
  assert.equal("trustedTransferBinding" in t.domain, false);
  assert.equal("trustedLinkContinuity" in t.domain, false);
});

test("DSC-R1-001 (retained): provenance unforgable; facade method list inert", () => {
  const t = makeDomain();
  const created = t.domain.createSession({});
  for (const forged of [
    Object.freeze({ kind: "PeerProvenance", channel: "telegram", peer: "u1", key: "telegram\u0000u1" }),
    null, undefined, "telegram:u1", {}
  ]) {
    assert.throws(
      () => t.domain.bindChannel({ sessionId: created.sessionId, provenance: forged }),
      (error) => error.code === "PROVENANCE_UNTRUSTED"
    );
  }
  assert.deepEqual(Object.keys(t.domain).sort(), [
    "acceptAsyncOutcome", "bindChannel", "captureAdmissionOwnership", "checkIncarnation",
    "closeSession", "commitTerminalOutcome", "createSession", "currentIncarnation",
    "getPersistenceStatus", "getSession", "getTerminalInteraction", "persist",
    "resolveChannel", "restore", "resumeSession", "shutdown", "snapshotDiagnostics",
    "unbindChannel", "updateResumeMetadata", "whenPersisted"
  ].sort());
});

test("DSC-R1-003 (retained): destructive reset private; shutdown preserves state", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "continuity.json");
  const store = createFileContinuityStore(file);
  const t = makeDomain({ store, persistOnMutation: true });
  const created = t.domain.createSession({});
  t.domain.bindChannel({ sessionId: created.sessionId, provenance: t.provOf(t.controller, "telegram", "u1") });
  await t.domain.whenPersisted();
  assert.equal("resetDurableState" in t.domain, false);
  const shutdown = await t.domain.shutdown();
  assert.equal(shutdown.shutdown, true);
  assert.equal(fs.existsSync(file), true, "shutdown must not delete the durable snapshot");
  await store.finalizeShutdown();
  await t.controller.resetDurableState();
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DSC-R2-003 — persistence failure settles waiters deterministically
// ---------------------------------------------------------------------------

test("DSC-R2-003: write failure REJECTS whenPersisted — no stranded waiter", async () => {
  let failing = true;
  let writes = 0;
  const store = {
    snapshot: null,
    async load() { return this.snapshot; },
    async persist(next) {
      writes += 1;
      if (failing) {
        const error = new Error("disk full");
        error.code = "DISK_FULL";
        throw error;
      }
      this.snapshot = next;
    },
    async clear() { this.snapshot = null; }
  };
  const t = makeDomain({ store, persistOnMutation: true });
  const s = t.domain.createSession({});
  const waiter = t.domain.whenPersisted();
  await assert.rejects(waiter, (error) => error.code === "DISK_FULL",
    "whenPersisted must settle with the deterministic failure");
  const status = t.domain.getPersistenceStatus();
  assert.ok(status.lastError !== null);
  assert.equal(status.lastError.code, "DISK_FULL");
  assert.equal(status.writerActive, false, "writer returned to a coherent idle/error state");
});

test("DSC-R2-003: shutdown terminates with deterministic failure after disk error", async () => {
  const store = {
    snapshot: null,
    async load() { return this.snapshot; },
    async persist() {
      const error = new Error("io error");
      error.code = "IO_ERROR";
      throw error;
    },
    async clear() { this.snapshot = null; }
  };
  const t = makeDomain({ store, persistOnMutation: true });
  t.domain.createSession({});
  const settled = await t.domain.shutdown();
  assert.equal(settled.shutdown, true);
  assert.equal(settled.flushed.failed, true, "deterministic failure result — never a hang");
  assert.equal(settled.flushed.code, "IO_ERROR");
});

test("DSC-R2-003: later mutation opens a NEW epoch; failed waiter never retro-succeeds", async () => {
  let failing = true;
  const store = {
    snapshot: null,
    async load() { return this.snapshot; },
    async persist(next) {
      if (failing) {
        const error = new Error("disk full");
        error.code = "DISK_FULL";
        throw error;
      }
      this.snapshot = next;
    },
    async clear() { this.snapshot = null; }
  };
  const t = makeDomain({ store, persistOnMutation: true });
  const s = t.domain.createSession({});
  const failedWaiter = t.domain.whenPersisted();
  await assert.rejects(failedWaiter, (error) => error.code === "DISK_FULL");

  // Recovery: a later mutation starts a NEW persistence epoch.
  failing = false;
  t.domain.updateResumeMetadata({ sessionId: s.sessionId, generation: 1, resumeMetadata: { ok: true } });
  const laterWaiter = t.domain.whenPersisted();
  const result = await laterWaiter;
  assert.equal(result.persisted, true, "the NEW epoch succeeds");
  // The already-failed waiter stayed failed (already settled).
  await assert.rejects(failedWaiter, (error) => error.code === "DISK_FULL",
    "already-failed waiter is never retroactively turned into success");
  assert.deepEqual(store.snapshot.sessions[0].resumeMetadata, { ok: true });
});

test("DSC-R2-003: no stale waiter survives a success epoch", async () => {
  const store = {
    snapshot: null,
    async load() { return this.snapshot; },
    async persist(next) { this.snapshot = next; },
    async clear() { this.snapshot = null; }
  };
  const t = makeDomain({ store, persistOnMutation: true });
  const s = t.domain.createSession({});
  const w1 = t.domain.whenPersisted();
  await w1;
  t.domain.updateResumeMetadata({ sessionId: s.sessionId, generation: 1, resumeMetadata: { b: 2 } });
  const w2 = t.domain.whenPersisted();
  await w2;
  assert.deepEqual(store.snapshot.sessions[0].resumeMetadata, { b: 2 });
});

// ---------------------------------------------------------------------------
// DSC-R2-007 — bounded/coalesced waiters (epoch-shared promise)
// ---------------------------------------------------------------------------

test("DSC-R2-007 STRESS: 100k whenPersisted callers join ONE slow write; O(1) internal state", async () => {
  let writes = 0;
  let resolveWrite = null;
  const store = {
    snapshot: null,
    async load() { return this.snapshot; },
    async persist(next) {
      writes += 1;
      await new Promise((resolve) => { resolveWrite = resolve; });
      this.snapshot = next;
    },
    async clear() { this.snapshot = null; }
  };
  const t = makeDomain({ store, persistOnMutation: true });
  const s = t.domain.createSession({});
  // Ensure a write is in flight.
  const inFlight = t.domain.whenPersisted();
  assert.equal(t.domain.getPersistenceStatus().writerActive, true);

  // 100,000 callers join the outstanding durability epoch.
  const CALLERS = 100_000;
  const joined = [];
  for (let i = 0; i < CALLERS; i += 1) {
    joined.push(t.domain.whenPersisted());
  }
  assert.equal(writes, 1, "exactly one write in flight — waiters do NOT trigger extra writes");

  // Release the slow write.
  resolveWrite();
  const results = await Promise.all(joined);
  assert.equal(results.length, CALLERS);
  assert.ok(results.every((r) => r && r.persisted === true),
    "all callers observe the same epoch result");

  // Internal retention is O(1): the status reports at most one pending
  // write and the domain exposes no waiter-array growth.
  const status = t.domain.getPersistenceStatus();
  assert.equal(status.writerActive, false);
  assert.equal(status.pendingWrites, 0);
  assert.ok(status.pendingWrites <= 1, "internal pending-write state is bounded");
  await inFlight;
});

test("DSC-R2-007: failure settles the epoch; later success epoch is separate", async () => {
  let failing = true;
  const store = {
    snapshot: null,
    async load() { return this.snapshot; },
    async persist(next) {
      if (failing) {
        const error = new Error("io");
        error.code = "IO";
        throw error;
      }
      this.snapshot = next;
    },
    async clear() { this.snapshot = null; }
  };
  const t = makeDomain({ store, persistOnMutation: true });
  t.domain.createSession({});
  const a = t.domain.whenPersisted();
  const b = t.domain.whenPersisted();
  await assert.rejects(a, (e) => e.code === "IO");
  await assert.rejects(b, (e) => e.code === "IO", "both joiners observe the same failure");
  failing = false;
  const s2 = t.domain.createSession({});
  const c = t.domain.whenPersisted();
  const ok = await c;
  assert.equal(ok.persisted, true, "the later epoch succeeds separately");
});

// ---------------------------------------------------------------------------
// DSC-R2-004 — shared shutdown completion (domain level)
// ---------------------------------------------------------------------------

test("DSC-R2-004: repeated shutdown calls join the SAME completion", async () => {
  let writes = 0;
  let releaseWrites = [];
  const store = {
    snapshot: null,
    async load() { return this.snapshot; },
    async persist(next) {
      writes += 1;
      await new Promise((resolve) => { releaseWrites.push(resolve); });
      this.snapshot = next;
    },
    async clear() { this.snapshot = null; }
  };
  const t = makeDomain({ store, persistOnMutation: true });
  t.domain.createSession({});
  const first = t.domain.shutdown();
  // 100 concurrent joiners.
  const joiners = [];
  for (let i = 0; i < 100; i += 1) joiners.push(t.domain.shutdown());
  let settled = false;
  first.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(settled, false, "no caller completes while the final flush is active");
  // Release every in-flight write (coalescing may perform a bounded number).
  for (let guard = 0; guard < 50 && !settled; guard += 1) {
    for (const release of releaseWrites.splice(0)) release();
    await new Promise((r) => setTimeout(r, 10));
  }
  const results = await Promise.all([first, ...joiners]);
  assert.ok(results.every((r) => r.shutdown === true));
  assert.ok(results.every((r) => !r.flushed || r.flushed.failed !== true || r.flushed.idempotent === true));
  assert.ok(writes < 100, "write count remains bounded");
});

// ---------------------------------------------------------------------------
// DSC-R2-002 — store ownership through final flush
// ---------------------------------------------------------------------------

test("DSC-R2-002: ownership held through slow final flush; released after settle", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "continuity.json");
  let releaseWrites = [];
  const realStore = createFileContinuityStore(file);
  const store = {
    snapshot: null,
    load: realStore.load.bind(realStore),
    async persist(next) {
      await new Promise((resolve) => { releaseWrites.push(resolve); });
      await realStore.persist(next);
      this.snapshot = next;
    },
    clear: realStore.clear.bind(realStore),
    finalizeShutdown: realStore.finalizeShutdown.bind(realStore)
  };
  const t = makeDomain({ store, persistOnMutation: true });
  t.domain.createSession({});

  // Start shutdown; the final flush is now IN FLIGHT.
  const shutdownPromise = t.domain.shutdown();
  await new Promise((r) => setTimeout(r, 10));
  if (releaseWrites.length > 0) {
    for (const release of releaseWrites.splice(0)) release();
    await new Promise((r) => setTimeout(r, 5));
  }

  // Host B cannot acquire the same path while Host A is still flushing.
  assert.throws(
    () => createFileContinuityStore(file),
    (error) => error.code === "CONTINUITY_STORE_OWNED",
    "ownership must be held until final flush completes"
  );

  // Allow the flush to finish and settle (bounded release loop).
  for (let guard = 0; guard < 50; guard += 1) {
    const pending = releaseWrites.splice(0);
    for (const release of pending) release();
    const settled = await Promise.race([
      shutdownPromise.then(() => true, () => true),
      new Promise((r) => setTimeout(() => r(false), 10))
    ]);
    if (settled) break;
  }
  await shutdownPromise;
  await store.finalizeShutdown();

  // Host B may now acquire.
  const storeB = createFileContinuityStore(file);
  await storeB.finalizeShutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DSC-R2-002: ownership releases after a FAILED final flush too (deterministic)", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "continuity.json");
  const realStore = createFileContinuityStore(file);
  const store = {
    snapshot: null,
    load: realStore.load.bind(realStore),
    async persist() {
      const error = new Error("io error");
      error.code = "IO_ERROR";
      throw error;
    },
    clear: realStore.clear.bind(realStore),
    finalizeShutdown: realStore.finalizeShutdown.bind(realStore)
  };
  const t = makeDomain({ store, persistOnMutation: true });
  t.domain.createSession({});
  const settled = await t.domain.shutdown();
  assert.equal(settled.flushed.failed, true);
  await store.finalizeShutdown();
  const storeB = createFileContinuityStore(file);
  await storeB.finalizeShutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DSC-R2-002: Windows-style path normalization is consistent", () => {
  const { _normalizeStorePath } = require("../../src/runtime/sessionContinuity/persistence");
  const a = _normalizeStorePath("/tmp/x/continuity.json");
  const b = _normalizeStorePath("/tmp//x/continuity.json");
  assert.equal(a, b, "separator/double-slash forms normalize identically");
  const c = _normalizeStorePath("/tmp/./x/continuity.json");
  assert.equal(a, c, "dot segments normalize identically");
  // On win32 the registry also lowercases; assert the documented behavior.
  if (process.platform === "win32") {
    assert.equal(_normalizeStorePath("C:\\Data\\C.json"), _normalizeStorePath("c:\\data\\c.json"));
  }
});

// ---------------------------------------------------------------------------
// DSC-R2-006 — trusted link (domain level)
// ---------------------------------------------------------------------------

test("DSC-R2-006: trustedLinkContinuity joins both endpoints onto one session", () => {
  const t = makeDomain();
  const provA = t.provOf(t.controller, "telegram", "ses_tg-771");
  const provB = t.provOf(t.controller, "console", "ses_console-owner");
  const a = t.domain.createSession({});
  t.domain.bindChannel({ sessionId: a.sessionId, provenance: provA });

  const link = t.controller.trustedLinkContinuity({ provenanceA: provA, provenanceB: provB });
  assert.equal(link.sessionId, a.sessionId, "B joins A's canonical session");
  const resolutionA = t.domain.resolveChannel({ provenance: provA });
  const resolutionB = t.domain.resolveChannel({ provenance: provB });
  assert.equal(resolutionA.sessionId, link.sessionId);
  assert.equal(resolutionB.sessionId, link.sessionId);

  // Both endpoints distinct (Telegram X != Console X) BEFORE any link.
  const provTg2 = t.provOf(t.controller, "telegram", "ses_other");
  const provWa2 = t.provOf(t.controller, "whatsapp", "ses_other");
  assert.equal(t.domain.resolveChannel({ provenance: provTg2 }).resolved, false);
  assert.equal(t.domain.resolveChannel({ provenance: provWa2 }).resolved, false);
  const link2 = t.controller.trustedLinkContinuity({ provenanceA: provTg2, provenanceB: provWa2 });
  assert.equal(
    t.domain.resolveChannel({ provenance: provTg2 }).sessionId,
    t.domain.resolveChannel({ provenance: provWa2 }).sessionId
  );
  assert.notEqual(link2.sessionId, link.sessionId, "different link pairs stay isolated");
});

test("DSC-R2-006: link requires TRUSTED provenance for BOTH endpoints", () => {
  const t = makeDomain();
  const provA = t.provOf(t.controller, "telegram", "ses_a");
  assert.throws(
    () => t.controller.trustedLinkContinuity({ provenanceA: provA, provenanceB: { kind: "PeerProvenance" } }),
    (error) => error.code === "PROVENANCE_UNTRUSTED"
  );
  assert.throws(
    () => t.controller.trustedLinkContinuity({ provenanceA: null, provenanceB: provA }),
    (error) => error.code === "PROVENANCE_UNTRUSTED"
  );
  assert.throws(
    () => t.controller.trustedLinkContinuity({ provenanceA: provA, provenanceB: provA }),
    (error) => error.code === "LINK_ENDPOINTS_IDENTICAL"
  );
});

// ---------------------------------------------------------------------------
// Retained domain contracts (R2 regression suite)
// ---------------------------------------------------------------------------

test("retained: admission capture + stale completion rejection", () => {
  const t = makeDomain();
  const created = t.domain.createSession({});
  const admission = t.domain.captureAdmissionOwnership({ sessionId: created.sessionId });
  assert.equal(admission.incarnationAtAdmission, 1);
  t.domain.resumeSession({ sessionId: created.sessionId });
  assert.throws(
    () => t.domain.commitTerminalOutcome({
      sessionId: admission.sessionId, interactionId: "ix_old",
      generation: admission.incarnationAtAdmission, state: "COMPLETED"
    }),
    (error) => error.code === "STALE_GENERATION"
  );
  assert.equal(t.domain.getTerminalInteraction("ix_old"), null);
});

test("retained: peer byte bound enforced as UTF-8 bytes (scope mint)", () => {
  const t = makeDomain();
  const scope = peerScope("telegram");
  // The transport peer scope enforces the byte bound at handle mint time.
  scope.mint("a".repeat(128));
  scope.mint("é".repeat(64));
  scope.mint("𝕏".repeat(32));
  for (const over of ["a".repeat(129), "é".repeat(65), "𝕏".repeat(33)]) {
    assert.throws(
      () => scope.mint(over),
      (error) => error.code === "TRANSPORT_PEER_INVALID"
    );
  }
  // And the persisted-snapshot validator still rejects oversized peers.
  const bad = validateSnapshot({
    schemaVersion: 1, savedAt: 1, sessions: [{
      sessionId: "dsc_x", createdAt: 1, updatedAt: 1, incarnation: 1,
      resumeMetadata: null, terminalAt: null,
      channels: [{ channel: "telegram", peer: "é".repeat(65), boundAt: 1, generation: 1 }]
    }], terminal: {}
  });
  assert.equal(bad.corrupt, true);
});

test("retained: restart restore semantics (RESTORED != RESUMED)", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "continuity.json");
  const storeA = createFileContinuityStore(file);
  const t = makeDomain({ store: storeA, persistOnMutation: true });
  const created = t.domain.createSession({ resumeMetadata: { topic: "sore" } });
  t.domain.bindChannel({ sessionId: created.sessionId, provenance: t.provOf(t.controller, "console", "owner") });
  await t.domain.whenPersisted();
  await t.domain.shutdown();
  await storeA.finalizeShutdown();

  const storeB = createFileContinuityStore(file);
  const t2 = makeDomain({ store: storeB });
  const restored = await t2.domain.restore();
  assert.equal(restored.restored, true);
  assert.equal(t2.domain.getSession(created.sessionId).state, "CLOSED");
  const resumed = t2.domain.resumeSession({ sessionId: created.sessionId });
  assert.equal(resumed.incarnation, 2);
  await storeB.finalizeShutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("retained: malformed snapshots fail closed", () => {
  const bad = (snapshot) => {
    assert.equal(validateSnapshot(snapshot).corrupt, true, JSON.stringify(String(snapshot)).slice(0, 50));
  };
  bad(null); bad(undefined); bad("s"); bad(42); bad([]); bad({});
  bad({ schemaVersion: 2, savedAt: 1, sessions: [], terminal: {} });
  bad({ schemaVersion: 1, savedAt: -1, sessions: [], terminal: {} });
  bad({ schemaVersion: 1, savedAt: 1, sessions: {}, terminal: {} });
  bad({ schemaVersion: 1, savedAt: 1, sessions: [], terminal: {}, extra: 1 });
});

test("retained: stress — thousands of rapid mutations with slow persistence", async () => {
  let writeCount = 0;
  const slowStore = {
    snapshot: null,
    async load() { return this.snapshot; },
    async persist(next) {
      writeCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      this.snapshot = next;
    },
    async clear() { this.snapshot = null; }
  };
  const t = makeDomain({ store: slowStore, persistOnMutation: true });
  const session = t.domain.createSession({});
  const prov = t.provOf(t.controller, "telegram", "stress-u");
  const MUTATIONS = 3000;
  for (let i = 0; i < MUTATIONS; i += 1) {
    t.domain.updateResumeMetadata({
      sessionId: session.sessionId, generation: 1, resumeMetadata: { seq: i }
    });
    if (i === 100) t.domain.bindChannel({ sessionId: session.sessionId, provenance: prov });
  }
  const midStatus = t.domain.getPersistenceStatus();
  assert.equal(midStatus.writerActive, true);
  assert.ok(midStatus.pendingWrites <= 1);
  await t.domain.whenPersisted();
  assert.ok(writeCount < MUTATIONS / 10, `writes coalesced: ${writeCount} for ${MUTATIONS} mutations`);
  assert.deepEqual(slowStore.snapshot.sessions[0].resumeMetadata, { seq: MUTATIONS - 1 });
  const shutdown = await t.domain.shutdown();
  assert.equal(shutdown.shutdown, true);
});

test("retained: honest persistence contract — mutation success is in-memory only", async () => {
  // A SLOW store proves the contract: the mutation returns successfully
  // BEFORE any disk write completes.
  let writeFinished = false;
  let releaseWrite = null;
  const store = {
    snapshot: null,
    async load() { return this.snapshot; },
    async persist(next) {
      await new Promise((resolve) => { releaseWrite = resolve; });
      this.snapshot = next;
      writeFinished = true;
    },
    async clear() { this.snapshot = null; }
  };
  const t = makeDomain({ store, persistOnMutation: true });
  // Mutation API success = in-memory acceptance ONLY.
  const s = t.domain.createSession({});
  assert.ok(s.sessionId.startsWith("dsc_"), "mutation succeeded in memory");
  assert.equal(writeFinished, false,
    "the disk write has NOT completed — mutation success never implies transactional disk commit");
  const pending = t.domain.getPersistenceStatus();
  assert.ok(pending.writerActive === true || pending.dirty === true,
    "durability is pending until whenPersisted() settles");
  releaseWrite();
  await t.domain.whenPersisted();
  const settledStatus = t.domain.getPersistenceStatus();
  assert.equal(settledStatus.writerActive, false);
  assert.equal(settledStatus.dirty, false);
});
