"use strict";

/**
 * STAGES 8-10 — Console / Telegram / WhatsApp channel authentication binders.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

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

test("STAGE 8 console: local context is transport-only; Owner proof required to bind", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    // LOCAL != OWNER: no proof -> no binding, no authentication.
    await assert.rejects(() => B.console.bind({ proof: null, purpose: "owner-proof", provenance: ctx.testMint.console("local") }),
        (e) => e.code === "OT_PROOF_NONCE_INVALID" || e.code === "OT_PROOF_INVALID");
    assert.equal(B.console.authenticate({ provenance: ctx.testMint.console("local") }).ok, false);
    // With proof, the console context binds and authenticates.
    await B.console.bind({ proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.console("local") });
    const auth = B.console.authenticate({ provenance: ctx.testMint.console("local") });
    assert.equal(auth.ok, true);
    assert.equal(auth.principalId, "owner-ardi");
});

test("STAGE 8 console: no environment variable or shortcut grants owner", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    process.env.DAMAR_OWNER = "1";
    process.env.OWNER = "true";
    process.env.DAMAR_OWNER_TRUSTED = "yes";
    // A fresh registry never authenticates, regardless of environment flags.
    assert.equal(B.console.authenticate({ provenance: ctx.testMint.console("local") }).ok, false);
    for (const k of ["DAMAR_OWNER", "OWNER", "DAMAR_OWNER_TRUSTED"]) delete process.env[k];
});

test("STAGE 8 console: authentication is temporary and revocation-checked on every call", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    const binding = await B.console.bind({ proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.console("local") });
    assert.equal(B.console.authenticate({ provenance: ctx.testMint.console("local") }).ok, true);
    await ctx.comp.registry.revokeBinding({ bindingId: binding.bindingId });
    assert.equal(B.console.authenticate({ provenance: ctx.testMint.console("local") }).ok, false, "revocation must apply immediately");
});

test("STAGE 9 telegram: transport-owned sender peer authenticates; spoofed IDs fail closed", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    await B.telegram.bind({ proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.telegram("12345") });
    assert.equal(B.telegram.authenticate({ provenance: ctx.testMint.telegram("12345") }).principalId, "owner-ardi");
    assert.equal(B.telegram.authenticate({ provenance: ctx.testMint.telegram("99999") }).code, "OT_PEER_NOT_BOUND");
    // raw ID in a payload was never evidence: a malformed peer key cannot
    // even be minted by a canonical adapter (fail closed at the mint).
    assert.throws(() => ctx.testMint.telegram("12345 "),
        (e) => e.code === "OT_PROVENANCE_CONTEXT_INVALID");
});

test("STAGE 9 telegram: TOTP absent — telegram ID / phone is never an Owner root", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    // No TOTP factor exists anywhere in the binder surface.
    const surface = Object.keys(B.telegram);
    assert.ok(!surface.some((k) => k.toLowerCase().includes("totp")));
    // Telegram ID alone can never authenticate.
    assert.equal(B.telegram.authenticate({ provenance: ctx.testMint.telegram("12345") }).code, "OT_PEER_NOT_BOUND");
});

test("STAGE 10 whatsapp: transport-owned JID authenticates; spoofed JIDs fail closed", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    await B.whatsapp.bind({ proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.whatsapp("62812@s.whatsapp.net") });
    assert.equal(B.whatsapp.authenticate({ provenance: ctx.testMint.whatsapp("62812@s.whatsapp.net") }).principalId, "owner-ardi");
    assert.equal(B.whatsapp.authenticate({ provenance: ctx.testMint.whatsapp("62899@s.whatsapp.net") }).code, "OT_PEER_NOT_BOUND");
});

test("STAGE 10 whatsapp: JID alone is never Owner; phone-number claims cannot bind", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    await assert.rejects(() => B.whatsapp.bind({ proof: null, purpose: "owner-proof", provenance: ctx.testMint.whatsapp("62812@s.whatsapp.net") }),
        (e) => e.code === "OT_PROOF_NONCE_INVALID" || e.code === "OT_PROOF_INVALID");
    assert.equal(B.whatsapp.authenticate({ provenance: ctx.testMint.whatsapp("62812@s.whatsapp.net") }).ok, false);
});

test("all binders: credential rotation stales existing bindings (PERSISTED TRUST != LIVE AUTH)", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    await B.console.bind({ proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.console("local") });
    await B.telegram.bind({ proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.telegram("12345") });
    await B.whatsapp.bind({ proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.whatsapp("62812@s.whatsapp.net") });
    assert.equal(B.console.authenticate({ provenance: ctx.testMint.console("local") }).ok, true);
    assert.equal(B.telegram.authenticate({ provenance: ctx.testMint.telegram("12345") }).ok, true);
    assert.equal(B.whatsapp.authenticate({ provenance: ctx.testMint.whatsapp("62812@s.whatsapp.net") }).ok, true);
    // Rotate the Owner credential: every prior binding becomes stale.
    const kp2 = crypto.generateKeyPairSync("ed25519");
    await ctx.comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live2", publicKeyPem: pem(kp2) }
    });
    assert.equal(B.console.authenticate({ provenance: ctx.testMint.console("local") }).code, "OT_GENERATION_STALE");
    assert.equal(B.telegram.authenticate({ provenance: ctx.testMint.telegram("12345") }).code, "OT_GENERATION_STALE");
    assert.equal(B.whatsapp.authenticate({ provenance: ctx.testMint.whatsapp("62812@s.whatsapp.net") }).code, "OT_GENERATION_STALE");
    // Rebinding requires a fresh ceremony with the NEW credential.
    ctx.ownerKey.privateKey = kp2.privateKey;
    ctx.comp.proofVerifier; // verifier is bound to the registry, which now knows cred-live2
    const ch = ctx.comp.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId: "cred-live2" });
    const sig = crypto.sign(null, canonicalChallenge({
        purpose: "owner-proof", credentialId: "cred-live2", nonce: ch.nonce, context: ch.context
    }), kp2.privateKey);
    await B.telegram.bind({
        proof: { nonce: ch.nonce, signature: sig.toString("base64url") },
        purpose: "owner-proof", provenance: ctx.testMint.telegram("12345")
    });
    assert.equal(B.telegram.authenticate({ provenance: ctx.testMint.telegram("12345") }).ok, true);
});

test("all binders: ADMIN proof can bind a peer to the admin principal (delegated trust)", async () => {
    const ctx = await makeComposed();
    const kpA = crypto.generateKeyPairSync("ed25519");
    await ctx.comp.registry.addAdmin({
        principalId: "admin-1", delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kpA) }
    });
    const B = ctx.comp.channelBinders;
    const ch = ctx.comp.proofVerifier.issueChallenge({ purpose: "admin-proof", credentialId: "cred-admin" });
    const sig = crypto.sign(null, canonicalChallenge({
        purpose: "admin-proof", credentialId: "cred-admin", nonce: ch.nonce, context: ch.context
    }), kpA.privateKey);
    await B.telegram.bind({
        proof: { nonce: ch.nonce, signature: sig.toString("base64url") },
        purpose: "admin-proof", provenance: ctx.testMint.telegram("777")
    });
    const auth = B.telegram.authenticate({ provenance: ctx.testMint.telegram("777") });
    assert.equal(auth.ok, true);
    assert.equal(auth.principalId, "admin-1");
});
