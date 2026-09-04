"use strict";

/**
 * WAVE 5 LANE 4 REPAIR — canonical composition sealing (OT-001..OT-007).
 *
 * Proves the composition-root guarantees: ceremony-bound bootstrap, vault
 * sealing, mandatory durable audit, provenance-only peer evidence, stale
 * lock recovery, and restart continuation.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    composeOwnerTrustForTest,
    canonicalChallenge,
    BOOTSTRAP_PURPOSE,
    BOOTSTRAP_CONTEXT
} = require("../../src/authority/ownerTrustComposition");

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ot-comp-"));
}

test("OT-004 vault-mode ceremony: no key material ever escapes the boundary", async () => {
    const dir = tmpDir();
    const comp = await composeOwnerTrustForTest({ stateFile: path.join(dir, "ot.json") });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    assert.ok(b.ceremonyId, "ceremonyId returned");
    assert.ok(b.challenge?.nonce, "challenge returned");
    assert.equal(b.mode, "damar-vault");
    assert.equal(b.privateKeyPem, undefined, "no private key on begin result");
    assert.equal(b.publicKeyPem, undefined, "no public key on begin result");
    // complete takes ceremonyId ONLY; a caller signature is rejected.
    await assert.rejects(() => comp.firstOwnerBootstrap.complete({
        ceremonyId: b.ceremonyId, signature: "AAAA"
    }), (e) => e.code === "OT_PROOF_UNEXPECTED");
    const done = await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    assert.equal(done.principalId, "owner-ardi");
    assert.ok(done.vaultRef, "vault ref recorded");
    assert.equal(done.privateKeyPem, undefined, "no key material on complete result");
    // Registry snapshot stores only the ref, never the key.
    const raw = fs.readFileSync(path.join(dir, "ot.json"), "utf8");
    assert.ok(!raw.includes("PRIVATE KEY"));
    assert.ok(raw.includes(done.vaultRef));
    // Vault alone resolves the secret.
    const got = comp.vault.resolve(`secretref:v1:${done.vaultRef}:system`);
    assert.ok(got.value && String(got.value.reveal()).includes("PRIVATE KEY"));
    // One-use: ceremony cannot complete twice.
    await assert.rejects(() => comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId }),
        (e) => e.code === "OT_CEREMONY_UNKNOWN");
    comp.close();
});

test("OT-004 external mode: Damar never possesses the private key", async () => {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const kp = crypto.generateKeyPairSync("ed25519");
    const b = await comp.firstOwnerBootstrap.begin({
        principalId: "owner-ext", mode: "external",
        publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" })
    });
    // Vault mode completion rejected in external mode.
    await assert.rejects(() => comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId }),
        (e) => e.code === "OT_PROOF_REQUIRED");
    const payload = canonicalChallenge({
        purpose: BOOTSTRAP_PURPOSE, credentialId: b.challenge.credentialId,
        nonce: b.challenge.nonce, context: BOOTSTRAP_CONTEXT
    });
    const sig = crypto.sign(null, payload, kp.privateKey).toString("base64url");
    const done = await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId, signature: sig });
    assert.equal(done.mode, "external");
    assert.equal(done.vaultRef, null, "no fabricated vault ref");
});

test("OT-002/003 anchor + reservation: crash-safe single-winner provisioning", async () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, "ot.json");
    const comp = await composeOwnerTrustForTest({ stateFile });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    // Anchor exists and is valid.
    const anchor = require("../../src/authority/ownerTrust/initAnchor");
    assert.equal(anchor.describeAnchor(stateFile).valid, true);
    // Reservation released after commit.
    assert.ok(!fs.existsSync(path.join(dir, "ownertrust-bootstrap.lock")));
    // Bootstrap permanently closed.
    await assert.rejects(() => comp.firstOwnerBootstrap.begin({ principalId: "x" }),
        (e) => e.code === "OT_BOOTSTRAP_CLOSED");
    comp.close();

    // Corrupt the snapshot: recovery required, never fresh install.
    fs.writeFileSync(stateFile, "{{{corrupt", "utf8");
    const comp2 = await composeOwnerTrustForTest({ stateFile });
    await comp2.registry.restore();
    assert.equal(comp2.registry.getState(), "RECOVERY_REQUIRED");
    await assert.rejects(() => comp2.firstOwnerBootstrap.begin({ principalId: "fresh" }),
        (e) => e.code === "OT_BOOTSTRAP_CLOSED" || e.code === "OT_RECOVERY_REQUIRED");
    comp2.close();
});

test("OT-005 vault: master key provisioned once, sealed at rest, stable across restart", async () => {
    const dir = tmpDir();
    const keyPath = path.join(dir, "vault-master.key");
    const comp = await composeOwnerTrustForTest({ stateFile: path.join(dir, "ot.json") });
    assert.ok(fs.existsSync(keyPath), "master key provisioned");
    const key1 = fs.readFileSync(keyPath, "utf8");
    comp.close();
    const comp2 = await composeOwnerTrustForTest({ stateFile: path.join(dir, "ot.json") });
    const key2 = fs.readFileSync(keyPath, "utf8");
    assert.equal(key1, key2, "same key reused (never regenerated)");
    // Key file is 0600 on POSIX.
    if (process.platform !== "win32") {
        const mode = fs.statSync(keyPath).mode & 0o777;
        assert.equal(mode & 0o077, 0, "no group/world access on key file");
    }
    comp2.close();
});

test("OT-007 mandatory durable audit: every trust mutation reaches the ledger", async () => {
    const dir = tmpDir();
    const comp = await composeOwnerTrustForTest({ stateFile: path.join(dir, "ot.json") });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    const stats = comp.ledger.stats();
    assert.equal(stats.acceptedCount, 1, "trust.owner.activated durably audited");
    assert.equal(stats.hasPersistenceSink, true, "durable sink attached");
    assert.equal(comp.auditGate.health().ok, true);
    // Ledger file exists and contains the event.
    const ledgerFile = path.join(dir, "audit-ledger.jsonl");
    assert.ok(fs.existsSync(ledgerFile));
    const lines = fs.readFileSync(ledgerFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("trust.owner.activated"));
    comp.close();
});

test("TF-001 restart continuation: ledger resumes sequence/digest across restarts", async () => {
    const dir = tmpDir();
    const comp = await composeOwnerTrustForTest({ stateFile: path.join(dir, "ot.json") });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    const seq1 = comp.ledger.stats().logicalSequence;
    assert.equal(seq1, 1);
    comp.close();
    const comp2 = await composeOwnerTrustForTest({ stateFile: path.join(dir, "ot.json") });
    // A second trust mutation continues the chain (no sequence reset).
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp2.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }) }
    });
    const stats = comp2.ledger.stats();
    assert.equal(stats.logicalSequence, seq1 + 1, "sequence continues after restart");
    assert.equal(stats.chainHead !== null, true);
    comp2.close();
});

test("TF-007 stale lock: a dead writer's lock is reclaimed; a live writer never stolen", async () => {
    const dir = tmpDir();
    const sinkPath = path.join(dir, "ledger.jsonl");
    const lockPath = `${sinkPath}.lock`;
    const { createFileAuditSink } = require("../../src/runtime/auditLedger");
    // Live writer holds the lock.
    const sink1 = createFileAuditSink(sinkPath);
    assert.throws(() => createFileAuditSink(sinkPath),
        (e) => e.code === "E_PERSIST_FAILED", "live writer is never stolen");
    // Simulate a crashed writer: stale pid + dead process.
    fs.writeFileSync(lockPath, JSON.stringify({ v: 1, pid: 999999999, acquiredAtMs: Date.now() }), "utf8");
    const sink2 = createFileAuditSink(sinkPath);
    assert.ok(sink2, "stale lock reclaimed by a live acquirer");
    const after = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(after.pid, process.pid, "reclaim is ownership-validated");
    // Corrupt lock: fail closed for manual inspection.
    sink2.close();
    fs.writeFileSync(lockPath, "not json", "utf8");
    assert.throws(() => createFileAuditSink(sinkPath),
        (e) => e.code === "E_PERSIST_FAILED");
    fs.rmSync(lockPath, { force: true });
});

test("OT-006 provenance: raw strings, plain objects, and clones are never evidence", async () => {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }) }
    });
    const prov = comp.testMint.console("local");
    const ch = comp.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId: "cred-live" });
    const sig = crypto.sign(null, canonicalChallenge({
        purpose: "owner-proof", credentialId: "cred-live", nonce: ch.nonce, context: ch.context
    }), kp.privateKey).toString("base64url");
    await comp.channelBinders.console.bind({
        proof: { nonce: ch.nonce, signature: sig }, purpose: "owner-proof", provenance: prov
    });
    // The genuine minted object authenticates.
    assert.equal(comp.channelBinders.console.authenticate({ provenance: prov }).ok, true);
    // Shape-identical look-alike: rejected.
    const fake = Object.freeze({
        transport: "console", peerKey: "local", incarnation: null,
        instanceId: "canonical-console", mintedAtMs: prov.mintedAtMs
    });
    assert.equal(comp.channelBinders.console.authenticate({ provenance: fake }).code, "OT_PROVENANCE_INVALID");
    // Raw string: rejected.
    assert.equal(comp.channelBinders.console.authenticate({ provenance: "console:local" }).code, "OT_PROVENANCE_INVALID");
    // Clone via structuredClone / JSON round-trip: rejected.
    assert.equal(comp.channelBinders.console.authenticate({
        provenance: JSON.parse(JSON.stringify({
            transport: prov.transport, peerKey: prov.peerKey, incarnation: null,
            instanceId: prov.instanceId, mintedAtMs: prov.mintedAtMs
        }))
    }).code, "OT_PROVENANCE_INVALID");
    // Cross-transport confusion: telegram provenance cannot bind on console.
    const tg = comp.testMint.telegram("12345");
    await assert.rejects(() => comp.channelBinders.console.bind({
        proof: { nonce: comp.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId: "cred-live" }).nonce,
                 signature: sig }, purpose: "owner-proof", provenance: tg
    }), (e) => e.code === "OT_PROVENANCE_TRANSPORT_MISMATCH");
});

test("OT-006 ingress adapters: provenance minted from REAL service objects at handle()", async () => {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const { currentPeerProvenance } = require("../../src/authority/ownerTrust/transportAdapters");
    // A minimal REAL-contract telegram service object (handle() present).
    const calls = [];
    const fakeTelegram = {
        running: true,
        async handle(msg) {
            calls.push({ provenance: currentPeerProvenance(), chatId: msg?.chat?.id ?? null });
        }
    };
    const wrapped = comp.ingress.attachTelegramIngress({ service: fakeTelegram });
    assert.notEqual(wrapped, fakeTelegram, "wrapper is a distinct object");
    assert.equal(wrapped.running, true, "contract passthrough");
    await wrapped.handle({ chat: { id: 12345 }, id: "upd-1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provenance.transport, "telegram");
    assert.equal(calls[0].provenance.peerKey, "12345");
    assert.equal(calls[0].provenance.incarnation, "upd-1");
    // No peer evidence -> delegation WITHOUT provenance (trust stays closed).
    await wrapped.handle({ chat: null });
    assert.equal(calls[1].provenance, null);
    // Malformed peer key -> no provenance, transport still works.
    await wrapped.handle({ chat: { id: " ".repeat(5) } });
    assert.equal(calls[2].provenance, null);
    // WhatsApp group message: participant JID is the peer.
    const fakeWa = {
        async handle(msg) { this.seen = currentPeerProvenance(); }
    };
    const wa = comp.ingress.attachWhatsappIngress({ service: fakeWa });
    await wa.handle({ key: { remoteJid: "12036@g.us", participant: "62812@s.whatsapp.net" } });
    assert.equal(fakeWa.seen.transport, "whatsapp");
    assert.equal(fakeWa.seen.peerKey, "62812@s.whatsapp.net");
    // Group message without participant: no peer evidence.
    const fakeWa2 = { async handle(msg) { this.seen = currentPeerProvenance(); } };
    const wa2 = comp.ingress.attachWhatsappIngress({ service: fakeWa2 });
    await wa2.handle({ key: { remoteJid: "12036@g.us" } });
    assert.equal(fakeWa2.seen, null);
});

test("Gate 1 sealing: canonical singleton exposes no mint capability and no key material", async () => {
    process.env.DAMAR_OWNER_TRUST_STATE = "memory";
    const otc = require("../../src/authority/ownerTrustComposition");
    const comp = await otc.ensureCanonicalComposed();
    // No testMint on the canonical singleton (null = production mode).
    assert.ok(!comp.testMint, "canonical composition never exposes minting");
    // The public module surface exposes no provenance issuer factory.
    for (const key of Object.keys(otc)) {
        assert.ok(!key.toLowerCase().includes("mint"), `no mint on public surface: ${key}`);
    }
});

test("OT-007 degraded audit is visible, never silent", async () => {
    const dir = tmpDir();
    const comp = await composeOwnerTrustForTest({ stateFile: path.join(dir, "ot.json") });
    // A malformed event through the gate records a rejection.
    assert.throws(() => comp.auditGate.audit({ eventType: "trust.x.y", source: "!!bad!!" }));
    const health = comp.auditGate.health();
    assert.equal(health.ok, false);
    assert.equal(health.rejected, 1);
    assert.ok(health.lastError, "rejection is surfaced with code");
    comp.close();
});
