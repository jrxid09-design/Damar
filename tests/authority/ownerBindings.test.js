"use strict";

/**
 * STAGES 6-7 — device membership (existing pairing + principal bindings) and
 * transport principal bindings.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const emb = require("../../src/embodiment");
const {
    composeOwnerTrustForTest,
    canonicalChallenge,
    BOOTSTRAP_PURPOSE,
    BOOTSTRAP_CONTEXT
} = require("../../src/authority/ownerTrustComposition");

function pem(kp) {
    return kp.publicKey.export({ type: "spki", format: "pem" });
}

async function makeComposed() {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    // live credential we control
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: pem(kp) }
    });
    return { comp, ownerKey: kp, testMint: comp.testMint };
}

function ownerProof({ comp, ownerKey }, purpose = "owner-proof") {
    const ch = comp.proofVerifier.issueChallenge({ purpose, credentialId: "cred-live" });
    const signature = crypto.sign(null, canonicalChallenge({
        purpose, credentialId: "cred-live", nonce: ch.nonce, context: ch.context
    }), ownerKey.privateKey);
    return { nonce: ch.nonce, signature: signature.toString("base64url") };
}

async function pairedDevice() {
    const svc = emb.createIdentityService({});
    const dev = svc.registerIdentity({ namespace: "channel", stableKey: "laptop-1", displayName: "Laptop" });
    const pairing = svc.beginPairing(dev.deviceId);
    svc.submitChallenge({
        pairingId: pairing.pairingId,
        challengeId: pairing.challenge.challengeId,
        secret: pairing.challenge.secret
    });
    const confirmed = svc.ownerConfirm(pairing.pairingId);
    return { svc, deviceId: dev.deviceId, bindingSecret: confirmed.bindingCredential.secret };
}

test("paired device is NOT Owner: trust requires owner proof + explicit binding", async () => {
    const ctx = await makeComposed();
    const { svc, deviceId, bindingSecret } = await pairedDevice();
    // A paired device with NO owner binding can never authenticate as the principal.
    assert.equal((await ctx.comp.principalBindings.verifyDeviceReconnect({
        deviceId, bindingSecret, identityService: svc
    })).code, "OT_DEVICE_NOT_BOUND");
    // Owner binds the device (proof + persistent device proof).
    const binding = await ctx.comp.principalBindings.bindOwnerDevice({
        proof: ownerProof(ctx), deviceId, bindingSecret, identityService: svc
    });
    assert.equal(binding.principalId, "owner-ardi");
    // Reconnect with the persistent proof works.
    const rec = await ctx.comp.principalBindings.verifyDeviceReconnect({
        deviceId, bindingSecret, identityService: svc
    });
    assert.equal(rec.ok, true);
    assert.equal(rec.principalId, "owner-ardi");
});

test("stolen device (wrong binding secret) is rejected", async () => {
    const ctx = await makeComposed();
    const { svc, deviceId, bindingSecret } = await pairedDevice();
    await ctx.comp.principalBindings.bindOwnerDevice({
        proof: ownerProof(ctx), deviceId, bindingSecret, identityService: svc
    });
    const stolen = await ctx.comp.principalBindings.verifyDeviceReconnect({
        deviceId, bindingSecret: "attacker-guess", identityService: svc
    });
    assert.equal(stolen.ok, false);
    assert.equal(stolen.code, "OT_DEVICE_PROOF_FAILED");
});

test("device revoke: device auth stops, Owner principal remains stable", async () => {
    const ctx = await makeComposed();
    const { svc, deviceId, bindingSecret } = await pairedDevice();
    const binding = await ctx.comp.principalBindings.bindOwnerDevice({
        proof: ownerProof(ctx), deviceId, bindingSecret, identityService: svc
    });
    await ctx.comp.registry.revokeBinding({ bindingId: binding.bindingId });
    const rec = await ctx.comp.principalBindings.verifyDeviceReconnect({
        deviceId, bindingSecret, identityService: svc
    });
    assert.equal(rec.ok, false);
    assert.equal(ctx.comp.registry.principalState("owner-ardi"), "ACTIVE");
    // Identity service itself is untouched by the trust-layer revoke.
    assert.ok(svc.getIdentity(deviceId));
});

test("device rotation: rebinding after credential rotation requires a fresh proof", async () => {
    const ctx = await makeComposed();
    const { svc, deviceId, bindingSecret } = await pairedDevice();
    await ctx.comp.principalBindings.bindOwnerDevice({
        proof: ownerProof(ctx), deviceId, bindingSecret, identityService: svc
    });
    // Rotation invalidates the old credential -> old proof fails.
    const kp2 = crypto.generateKeyPairSync("ed25519");
    await ctx.comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live2", publicKeyPem: pem(kp2) }
    });
    await assert.rejects(() => ctx.comp.principalBindings.bindOwnerDevice({
        proof: ownerProof({ comp: ctx.comp, ownerKey: ctx.ownerKey }),
        deviceId, bindingSecret, identityService: svc
    }), (e) => e.code === "OT_PROOF_INVALID" || e.code === "OT_CREDENTIAL_REVOKED");
});

test("transport binding: transport-owned peer authenticates the bound principal", async () => {
    const ctx = await makeComposed();
    await ctx.comp.principalBindings.bindTransportPeer({
        proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.telegram("12345")
    });
    const auth = ctx.comp.principalBindings.authenticateTransportPeer({
        provenance: ctx.testMint.telegram("12345")
    });
    assert.equal(auth.ok, true);
    assert.equal(auth.principalId, "owner-ardi");
});

test("raw Telegram ID cannot bind itself; raw WhatsApp JID cannot bind itself", async () => {
    const ctx = await makeComposed();
    for (const attempt of [
        { provenance: ctx.testMint.telegram("99999") },
        { provenance: ctx.testMint.whatsapp("62899@s.whatsapp.net") }
    ]) {
        await assert.rejects(() => ctx.comp.principalBindings.bindTransportPeer({
            proof: null, purpose: "owner-proof", ...attempt
        }), (e) => e.code === "OT_PROOF_NONCE_INVALID" || e.code === "OT_PROOF_INVALID");
        assert.equal(ctx.comp.principalBindings.authenticateTransportPeer(attempt).code,
            "OT_PEER_NOT_BOUND");
    }
});

test("conflicting rebind of an active peer to another principal is rejected", async () => {
    const ctx = await makeComposed();
    const kp = crypto.generateKeyPairSync("ed25519");
    await ctx.comp.registry.addAdmin({
        principalId: "admin-1", delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kp) }
    });
    await ctx.comp.principalBindings.bindTransportPeer({
        proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.telegram("12345")
    });
    // admin tries to claim the SAME active peer -> rejected (no silent transfer)
    const ch = ctx.comp.proofVerifier.issueChallenge({ purpose: "admin-proof", credentialId: "cred-admin" });
    const adminSig = crypto.sign(null, canonicalChallenge({
        purpose: "admin-proof", credentialId: "cred-admin", nonce: ch.nonce, context: ch.context
    }), kp.privateKey);
    await assert.rejects(() => ctx.comp.principalBindings.bindTransportPeer({
        proof: { nonce: ch.nonce, signature: adminSig.toString("base64url") },
        purpose: "admin-proof", provenance: ctx.testMint.telegram("12345")
    }), (e) => e.code === "OT_BINDING_CONFLICT");
});

test("revoked binding: transport still works as transport but principal authentication fails", async () => {
    const ctx = await makeComposed();
    const binding = await ctx.comp.principalBindings.bindTransportPeer({
        proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.telegram("12345")
    });
    await ctx.comp.registry.revokeBinding({ bindingId: binding.bindingId });
    const auth = ctx.comp.principalBindings.authenticateTransportPeer({
        provenance: ctx.testMint.telegram("12345")
    });
    assert.equal(auth.ok, false);
    assert.equal(auth.code, "OT_PEER_NOT_BOUND");
    // The transport itself is untouched (it never depended on the binding to run).
    assert.equal(ctx.comp.registry.principalState("owner-ardi"), "ACTIVE");
});

test("channel account reassignment: revoked binding does not transfer trust to a new binding without a fresh ceremony", async () => {
    const ctx = await makeComposed();
    const kp = crypto.generateKeyPairSync("ed25519");
    await ctx.comp.registry.addAdmin({
        principalId: "admin-1", delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kp) }
    });
    const old = await ctx.comp.principalBindings.bindTransportPeer({
        proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.telegram("12345")
    });
    await ctx.comp.registry.revokeBinding({ bindingId: old.bindingId });
    // A fresh authenticated ceremony CAN rebind the now-free peer.
    const fresh = await ctx.comp.principalBindings.bindTransportPeer({
        proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.telegram("12345")
    });
    assert.equal(fresh.principalId, "owner-ardi");
    assert.ok(fresh.bindingId !== old.bindingId);
});

test("binding restart persistence: bindings survive restore over the same store", async () => {
    const { createOwnerTrustStore } = require("../../src/authority/ownerTrust");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-bind-"));
    const store = createOwnerTrustStore(path.join(dir, "ot.json"));
    const c1 = await composeOwnerTrustForTest({ stateFile: path.join(dir, "ot.json") });
    // enroll + bind
    const b = await c1.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await c1.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    const kp = crypto.generateKeyPairSync("ed25519");
    await c1.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: pem(kp) }
    });
    const ch = c1.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId: "cred-live" });
    const s = crypto.sign(null, canonicalChallenge({
        purpose: "owner-proof", credentialId: "cred-live", nonce: ch.nonce, context: ch.context
    }), kp.privateKey);
    await c1.principalBindings.bindTransportPeer({
        proof: { nonce: ch.nonce, signature: s.toString("base64url") },
        purpose: "owner-proof", provenance: c1.testMint.telegram("12345")
    });
    await c1.registry.persist();
    // restart (release the audit sink lock first — graceful shutdown)
    c1.close();
    const c2 = await composeOwnerTrustForTest({ stateFile: path.join(dir, "ot.json") });
    const restored = await c2.registry.restore();
    assert.equal(restored.restored, true);
    assert.equal(c2.registry.getState(), "ACTIVE");
    assert.equal(c2.registry.bindingsFor("owner-ardi").length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
});
