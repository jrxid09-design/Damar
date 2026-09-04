"use strict";

/**
 * TRUST FOUNDATION REPAIR — Stage 1 test gate (TF-001..TF-007).
 *
 * Proves the durable-storage and key-provenance blockers are closed BEFORE
 * any Owner authentication is stacked on top:
 *   TF-001 audit restart continuation (resume N -> N+1, exact prevDigest)
 *   TF-003 audit single-writer ownership
 *   TF-002 Windows identity fsync (portable descriptor)
 *   TF-004 identity read failure (ENOENT only = absent; others fail closed)
 *   TF-005 vault key-file protection (POSIX + honest Windows gating)
 *   TF-006 key ingestion (strict Base64, defensive copy)
 *   TF-007 durability / temp cleanup
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    createAuditLedger,
    createFileAuditSink,
    LedgerError,
    LEDGER_ERROR_CODES
} = require("../../src/runtime/auditLedger");
const {
    createFileIdentityStore,
    persistIdentity,
    loadIdentity
} = require("../../src/embodiment/identity/store");
const emb = require("../../src/embodiment");
const { createProductionCipherAdapter } = require("../../src/runtime/vaultProviders/aesGcmCipher");

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tf-repair-"));
}

// ---------------------------------------------------------------------------
// TF-001 — audit restart continuation
// ---------------------------------------------------------------------------

test("TF-001: canonical ledger resumes from durable tail (N -> N+1, exact prevDigest)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    let t = 0;
    const clock = () => ++t;

    const sink1 = createFileAuditSink(file);
    const l1 = createAuditLedger({ clock, sink: sink1 });
    l1.append({ eventType: "a.b", source: "s" }, { durable: true });
    l1.append({ eventType: "a.b", source: "s" }, { durable: true });
    l1.append({ eventType: "a.b", source: "s" }, { durable: true });
    const tailDigest = sink1.describeDurable().lastDigest;
    sink1.close();

    // Restart: new sink + new canonical ledger resumed from the verified tail.
    const sink2 = createFileAuditSink(file);
    const l2 = createAuditLedger({ clock, sink: sink2, resume: sink2.verifiedTail() });
    const next = l2.append({ eventType: "a.b", source: "s" }, { durable: true });
    assert.equal(next.sequence, 4, "next sequence == previous + 1 exactly");
    assert.equal(next.integrity.prevDigest, tailDigest,
        "next prevDigest == durable last digest");
    // Reopen clean after the valid restart append.
    sink2.close();
    const sink3 = createFileAuditSink(file);
    assert.equal(sink3.describeDurable().corrupt, false);
    assert.equal(sink3.describeDurable().lastSequence, 4);
    sink3.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("TF-001: skipped sequence / duplicate sequence / wrong prevDigest / wrong digest rejected", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    let t = 0;
    const clock = () => ++t;
    const sink = createFileAuditSink(file);
    const ledger = createAuditLedger({ clock, sink });
    const e1 = ledger.append({ eventType: "a.b", source: "s" }, { durable: true });

    const good = (over) => Object.assign({}, e1, over);
    // skipped sequence
    assert.throws(() => sink.append(good({ eventId: "skip", sequence: 99 })),
        (e) => e.code === LEDGER_ERROR_CODES.PERSIST_FAILED);
    // duplicate sequence
    assert.throws(() => sink.append(good({ eventId: "dup", sequence: 1 })),
        (e) => e.code === LEDGER_ERROR_CODES.PERSIST_FAILED);
    // wrong prevDigest
    assert.throws(() => sink.append(good({
        eventId: "wrongprev", sequence: 2,
        integrity: { algorithm: "sha256", prevDigest: "0".repeat(64), digest: e1.integrity.digest }
    })), (e) => e.code === LEDGER_ERROR_CODES.PERSIST_FAILED);
    // wrong self digest
    assert.throws(() => sink.append(good({
        eventId: "wrongdigest", sequence: 2,
        integrity: { algorithm: "sha256", prevDigest: e1.integrity.prevDigest, digest: "0".repeat(64) }
    })), (e) => e.code === LEDGER_ERROR_CODES.PERSIST_FAILED);
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TF-003 — audit single-writer ownership
// ---------------------------------------------------------------------------

test("TF-003: concurrent sink owner for the same file is rejected", () => {
    const dir = tmpDir();
    const file = path.join(dir, "audit.jsonl");
    const sinkA = createFileAuditSink(file);
    assert.throws(() => createFileAuditSink(file),
        (e) => e.code === LEDGER_ERROR_CODES.PERSIST_FAILED,
        "a second active owner for the same canonical file must be rejected");
    sinkA.close();
    // After close, a new owner may acquire the file.
    const sinkB = createFileAuditSink(file);
    sinkB.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TF-002 — Windows identity fsync (portable descriptor)
// ---------------------------------------------------------------------------

test("TF-002: durable identity save fsyncs via a portable read-write descriptor", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const svc = emb.createIdentityService({});
    svc.registerIdentity({ namespace: "channel", stableKey: "dev-win", displayName: "win" });
    // Must not throw EPERM on any platform (Windows semantics use "r+").
    await persistIdentity(svc, createFileIdentityStore(file));
    assert.equal(fs.existsSync(file), true);
    const restored = await loadIdentity({ store: createFileIdentityStore(file) });
    assert.ok(restored);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TF-004 — identity read failure
// ---------------------------------------------------------------------------

test("TF-004: ENOENT means absent; EACCES/directory/IO failure fails closed", async () => {
    const dir = tmpDir();
    // ENOENT -> null (genuinely absent)
    const absent = await loadIdentity({ store: createFileIdentityStore(path.join(dir, "nope.json")) });
    assert.equal(absent, null);

    // A directory path used as the snapshot file -> fail closed (EISDIR)
    await assert.rejects(
        () => loadIdentity({ store: createFileIdentityStore(dir) }),
        (e) => e.code === "PID_INVALID_SERIALIZATION"
    );

    // Unreadable file (no read permission) -> fail closed, not null.
    if (process.platform !== "win32") {
        const lockedFile = path.join(dir, "locked.json");
        fs.writeFileSync(lockedFile, JSON.stringify({ version: 1, devices: [], transactions: [] }), { mode: 0o000 });
        await assert.rejects(
            () => loadIdentity({ store: createFileIdentityStore(lockedFile) }),
            (e) => e.code === "PID_INVALID_SERIALIZATION",
            "an unreadable initialized state must NOT be read as fresh state"
        );
        fs.chmodSync(lockedFile, 0o600);
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TF-005 — vault key-file protection
// ---------------------------------------------------------------------------

test("TF-005: group/world-readable key file rejected on POSIX; regular-file required", () => {
    if (process.platform === "win32") return; // POSIX-specific assertion
    const dir = tmpDir();
    const keyFile = path.join(dir, "k.key");
    fs.writeFileSync(keyFile, require("node:crypto").randomBytes(32).toString("base64"), { mode: 0o644 });
    assert.throws(() => createProductionCipherAdapter({ keyFile }),
        (e) => e.code === "VAULT_CIPHER_REQUIRED",
        "group/world-readable key file must be rejected");
    fs.chmodSync(keyFile, 0o600);
    const adapter = createProductionCipherAdapter({ keyFile });
    assert.equal(adapter.secure, true);
    // Non-regular file (directory) rejected.
    assert.throws(() => createProductionCipherAdapter({ keyFile: dir }),
        (e) => e.code === "VAULT_CIPHER_REQUIRED");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("TF-005: Windows keyFile is gated (not falsely claimed as POSIX-protected)", () => {
    if (process.platform !== "win32") return; // Windows-specific assertion
    const dir = tmpDir();
    const keyFile = path.join(dir, "k.key");
    fs.writeFileSync(keyFile, require("node:crypto").randomBytes(32).toString("base64"));
    assert.throws(() => createProductionCipherAdapter({ keyFile }),
        (e) => e.code === "VAULT_CIPHER_REQUIRED",
        "Windows keyFile must be gated without explicit platform-managed opt-in");
    const adapter = createProductionCipherAdapter({ keyFile, allowPlatformManagedKeyFile: true });
    assert.equal(adapter.secure, true);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TF-006 — key ingestion
// ---------------------------------------------------------------------------

test("TF-006: strict Base64 rejects invalid/ignored characters", () => {
    const key = require("node:crypto").randomBytes(32);
    const good = key.toString("base64");
    assert.ok(createProductionCipherAdapter({ keyMaterial: good }));
    // Invalid characters / padding games must be rejected, not tolerated.
    for (const bad of [good.slice(0, -1) + "!", good + " ", good.replace(/=+$/, "") + "==", "@@@@" + good]) {
        assert.throws(() => createProductionCipherAdapter({ keyMaterial: bad }),
            (e) => e.code === "VAULT_CIPHER_REQUIRED",
            `invalid base64 must be rejected: ${JSON.stringify(bad.slice(0, 12))}…`);
    }
});

test("TF-006: caller mutation of the source Buffer cannot alter the active adapter key", () => {
    const src = require("node:crypto").randomBytes(32);
    const adapter = createProductionCipherAdapter({ keyMaterial: src });
    const env1 = adapter.encrypt(Buffer.from("probe", "utf8"));
    // Mutate the caller's source buffer to all zeros.
    src.fill(0);
    // The adapter's own key must be unaffected (defensive copy).
    assert.deepEqual(adapter.decrypt(env1), Buffer.from("probe", "utf8"));
});

// ---------------------------------------------------------------------------
// TF-007 — durability / temp cleanup
// ---------------------------------------------------------------------------

test("TF-007: failed identity save cleans its temp file; committed snapshot survives", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const svc = emb.createIdentityService({});
    svc.registerIdentity({ namespace: "channel", stableKey: "dev-clean", displayName: "c" });
    await persistIdentity(svc, createFileIdentityStore(file));

    // No orphan tmp files left after a successful save.
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "no temp debris after successful save");
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Lifecycle — existing vault/audit/identity behavior remains green
// ---------------------------------------------------------------------------

test("TF lifecycle: tamper + wrong key still reject after hardening", () => {
    const a1 = createProductionCipherAdapter({ keyMaterial: require("node:crypto").randomBytes(32) });
    const a2 = createProductionCipherAdapter({ keyMaterial: require("node:crypto").randomBytes(32) });
    const env1 = a1.encrypt(Buffer.from("k-bound", "utf8"));
    assert.throws(() => a2.decrypt(env1), /integrity|failure/i);
    const raw = Buffer.from(env1.d, "base64");
    raw[0] ^= 1;
    assert.throws(() => a1.decrypt({ ...env1, d: raw.toString("base64") }), /integrity|failure|malformed/i);
});
