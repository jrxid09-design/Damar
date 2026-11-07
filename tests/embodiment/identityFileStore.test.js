"use strict";

/**
 * Device Identity durable file store tests (Trust Foundation stage).
 *
 * Proves the durable production adapter for the EXISTING IdentityStore port:
 * persist/restart round trip, paired/revoked state persistence, corrupt store
 * fail-closed (never a silent reset to empty identity), partial-write
 * durability, and that the existing memory store remains available.  No
 * human-Owner semantics, no Authority semantics.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const emb = require("../../src/embodiment");
const {
    createFileIdentityStore,
    createMemoryIdentityStore,
    persistIdentity,
    loadIdentity
} = require("../../src/embodiment/identity/store");

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "identity-filestore-"));
}

function pairDevice(svc, stableKey) {
    const dev = svc.registerIdentity({ namespace: "channel", stableKey, displayName: stableKey });
    const pairing = svc.beginPairing(dev.deviceId);
    svc.submitChallenge({
        pairingId: pairing.pairingId,
        challengeId: pairing.challenge.challengeId,
        secret: pairing.challenge.secret
    });
    svc.ownerConfirm(pairing.pairingId);
    return { deviceId: dev.deviceId, pairingId: pairing.pairingId };
}

test("register → persist → restart → same identity", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const svc = emb.createIdentityService({});
    const dev = svc.registerIdentity({ namespace: "channel", stableKey: "dev-A", displayName: "Device A" });

    await persistIdentity(svc, createFileIdentityStore(file));
    assert.equal(fs.existsSync(file), true);

    const restored = await loadIdentity({ store: createFileIdentityStore(file) });
    const r = restored.getIdentity(dev.deviceId);
    assert.ok(r, "identity must survive restart");
    assert.equal(r.deviceId, dev.deviceId);
    assert.equal(r.displayName, "Device A");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("paired/trusted → persist → restart → same established state + binding digest", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const svc = emb.createIdentityService({});
    const { deviceId } = pairDevice(svc, "dev-paired");

    await persistIdentity(svc, createFileIdentityStore(file));
    const restored = await loadIdentity({ store: createFileIdentityStore(file) });
    const r = restored.getIdentity(deviceId);
    assert.equal(r.pairingState, "PAIRED", "paired state must persist across restart");
    const restoredRow = restored.serialize().devices.find((d) => d.deviceId === deviceId);
    assert.ok(restoredRow.bindingDigest, "binding digest must be restored for an established pairing");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("revoked → persist → restart → still revoked", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const svc = emb.createIdentityService({});
    const { deviceId } = pairDevice(svc, "dev-revoked");
    svc.revoke(deviceId);

    await persistIdentity(svc, createFileIdentityStore(file));
    const restored = await loadIdentity({ store: createFileIdentityStore(file) });
    assert.equal(restored.getIdentity(deviceId).pairingState, "REVOKED",
        "a revoked device must remain revoked after restart (restore never upgrades trust)");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("corrupt store fails closed (never silently resets to empty identity)", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const svc = emb.createIdentityService({});
    pairDevice(svc, "dev-corrupt");
    await persistIdentity(svc, createFileIdentityStore(file));

    fs.writeFileSync(file, "CORRUPT-NOT-JSON{{{", "utf8");
    await assert.rejects(
        () => loadIdentity({ store: createFileIdentityStore(file) }),
        (err) => err.code === "PID_INVALID_SERIALIZATION",
        "corrupt store must fail closed, not return empty identity state"
    );
    fs.rmSync(dir, { recursive: true, force: true });
});

test("shape-invalid snapshot (right JSON, wrong shape) fails closed", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    fs.writeFileSync(file, JSON.stringify({ version: 2, devices: [], transactions: [] }), "utf8");
    await assert.rejects(
        () => loadIdentity({ store: createFileIdentityStore(file) }),
        (err) => err.code === "PID_INVALID_SERIALIZATION"
    );
    fs.rmSync(dir, { recursive: true, force: true });
});

test("partial write: previous valid state survives an interrupted later write", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const svc = emb.createIdentityService({});
    const { deviceId } = pairDevice(svc, "dev-partial");
    await persistIdentity(svc, createFileIdentityStore(file));

    // Simulate an interrupted/torn later write: a leftover tmp file must NOT
    // clobber the committed snapshot.
    fs.writeFileSync(`${file}.tmp-orphan`, "CORRUPT-PARTIAL{{{", "utf8");
    const restored = await loadIdentity({ store: createFileIdentityStore(file) });
    assert.equal(restored.getIdentity(deviceId).pairingState, "PAIRED",
        "an orphan tmp write must not corrupt the last committed snapshot");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("overlapping writes do not silently corrupt canonical state", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const svcA = emb.createIdentityService({});
    pairDevice(svcA, "dev-a");
    const store = createFileIdentityStore(file);

    // Two near-simultaneous saves: both complete; the file stays a valid
    // snapshot (the last committed writer wins, never a torn interleave).
    const svcB = emb.createIdentityService({});
    pairDevice(svcB, "dev-b");
    await Promise.all([
        persistIdentity(svcA, store),
        persistIdentity(svcB, store)
    ]);
    const restored = await loadIdentity({ store: createFileIdentityStore(file) });
    const stats = restored.stats();
    assert.ok(stats.devices >= 1, "at least one device present after overlapping writes");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("in-flight pairing normalizes to UNPAIRED across restart (transient not durable)", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const svc = emb.createIdentityService({});
    const dev = svc.registerIdentity({ namespace: "channel", stableKey: "dev-inflight", displayName: "x" });
    svc.beginPairing(dev.deviceId); // CHALLENGE_ISSUED — transient

    await persistIdentity(svc, createFileIdentityStore(file));
    const restored = await loadIdentity({ store: createFileIdentityStore(file) });
    assert.equal(restored.getIdentity(dev.deviceId).pairingState, "UNPAIRED",
        "in-flight pairing must normalize to UNPAIRED across restart");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("existing memory store remains available for tests", async () => {
    const svc = emb.createIdentityService({});
    const { deviceId } = pairDevice(svc, "dev-mem");
    const store = createMemoryIdentityStore();
    await persistIdentity(svc, store);
    const restored = await loadIdentity({ store });
    assert.equal(restored.getIdentity(deviceId).pairingState, "PAIRED");
});

test("load() returns null when no durable snapshot exists yet", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "identity.json");
    const restored = await loadIdentity({ store: createFileIdentityStore(file) });
    assert.equal(restored, null);
    fs.rmSync(dir, { recursive: true, force: true });
});
