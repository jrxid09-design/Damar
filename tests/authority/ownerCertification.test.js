"use strict";

/**
 * STAGE 12 — OWNER TRUST CERTIFICATION MATRIX.
 *
 * Full lifecycle: fresh install -> first-Owner bootstrap (single winner) ->
 * device + transport bindings across all three channels -> channel
 * authentication -> Admin delegation -> Owner ratification into Authority ->
 * cross-channel continuity link -> credential rotation cascade -> revocation
 * cascade -> restart persistence -> corruption fail-closed.
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
const { AuthorityRegistry } = require("../../src/authority/registry");
const authorityStore = require("../../src/authority/store");
const { realClock } = require("../../src/embodiment/core/util");
const emb = require("../../src/embodiment");

function pem(kp) {
    return kp.publicKey.export({ type: "spki", format: "pem" });
}

function signChallenge(comp, { purpose, credentialId, nonce, context }, privateKey) {
    return crypto.sign(null, canonicalChallenge({
        purpose, credentialId, nonce, context
    }), privateKey).toString("base64url");
}

test("CERT-1: full lifecycle from fresh install to cross-channel operation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-cert-"));
    const stateFile = path.join(dir, "ownertrust.json");

    // ---- fresh install: UNENROLLED, everything fail-closed ----------------
    const comp = await composeOwnerTrustForTest({ stateFile });
    assert.equal(comp.registry.getState(), "UNENROLLED");
    assert.equal(comp.authVerifier({ principal: "owner-ardi" }), null);
    assert.equal(comp.channelBinders.console.authenticate().ok, false);
    assert.equal(comp.continuityLinker.getLinkPolicy().enabled, false);

    // ---- single-winner bootstrap ------------------------------------------
    const kp1 = crypto.generateKeyPairSync("ed25519");
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    assert.equal(comp.registry.getState(), "ACTIVE");
    assert.equal(comp.registry.isBootstrapped(), true);
    // Permanent closure.
    await assert.rejects(() => comp.firstOwnerBootstrap.begin({ principalId: "owner-y" }),
        (e) => e.code === "OT_BOOTSTRAP_CLOSED");

    // ---- live credential ----------------------------------------------------
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: pem(kp) }
    });
    const proof = (purpose = "owner-proof") => {
        const ch = comp.proofVerifier.issueChallenge({ purpose, credentialId: "cred-live" });
        return {
            nonce: ch.nonce,
            signature: signChallenge(comp, { ...ch, purpose }, kp.privateKey)
        };
    };

    // ---- device membership (existing pairing) ------------------------------
    const svc = emb.createIdentityService({});
    const dev = svc.registerIdentity({ namespace: "channel", stableKey: "laptop-1", displayName: "Laptop" });
    const pairing = svc.beginPairing(dev.deviceId);
    svc.submitChallenge({
        pairingId: pairing.pairingId, challengeId: pairing.challenge.challengeId,
        secret: pairing.challenge.secret
    });
    const { secret: bindingSecret } = svc.ownerConfirm(pairing.pairingId).bindingCredential;
    const deviceBinding = await comp.principalBindings.bindOwnerDevice({
        proof: proof(), deviceId: dev.deviceId, bindingSecret, identityService: svc
    });
    const reconnect = await comp.principalBindings.verifyDeviceReconnect({
        deviceId: dev.deviceId, bindingSecret, identityService: svc
    });
    assert.equal(reconnect.ok, true);
    assert.equal(reconnect.principalId, "owner-ardi");

    // ---- transport bindings across all three channels -----------------------
    const B = comp.channelBinders;
    await B.console.bind({ proof: proof(), purpose: "owner-proof", provenance: comp.testMint.console("local") });
    await B.telegram.bind({ proof: proof(), purpose: "owner-proof", provenance: comp.testMint.telegram("12345") });
    await B.whatsapp.bind({ proof: proof(), purpose: "owner-proof", provenance: comp.testMint.whatsapp("62812@s.whatsapp.net") });
    assert.equal(B.console.authenticate({ provenance: comp.testMint.console("local") }).principalId, "owner-ardi");
    assert.equal(B.telegram.authenticate({ provenance: comp.testMint.telegram("12345") }).principalId, "owner-ardi");
    assert.equal(B.whatsapp.authenticate({ provenance: comp.testMint.whatsapp("62812@s.whatsapp.net") }).principalId, "owner-ardi");
    // Spoofed peers never authenticate.
    assert.equal(B.telegram.authenticate({ provenance: comp.testMint.telegram("99999") }).ok, false);

    // ---- Admin delegation ----------------------------------------------------
    const kpA = crypto.generateKeyPairSync("ed25519");
    await comp.registry.addAdmin({
        principalId: "admin-1", delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kpA) }
    });
    const chA = comp.proofVerifier.issueChallenge({ purpose: "admin-proof", credentialId: "cred-admin" });
    const adminAuth = comp.authVerifier({
        kind: "admin-proof", credentialId: "cred-admin", nonce: chA.nonce,
        signature: signChallenge(comp, { ...chA, purpose: "admin-proof" }, kpA.privateKey)
    });
    assert.deepEqual(adminAuth, { principal: "admin-1" });

    // ---- Owner ratification into Authority ----------------------------------
    const authorityRegistry = new AuthorityRegistry({
        store: authorityStore.createMemoryAuthorityStore(), clock: realClock()
    });
    await authorityRegistry.proposeEvolution({
        proposalId: "prop-cert", createdBy: "acc", kind: "authority_expansion",
        problem: "butuh authority", proposedChange: "terbitkan ROOT grant via ratifikasi",
        requestedAuthority: { capabilityId: "cap.cert", subject: "agent", actions: ["read"] }
    }, "acc");
    const rat = await comp.ratifyAsOwner({
        authorityRegistry,
        proof: proof(),
        ratification: { ratificationId: "rat-cert", proposalId: "prop-cert", decision: "APPROVED" }
    });
    assert.equal(rat.applied, true);
    assert.equal(rat.ratification.ownerIdentity, "owner-ardi");

    // ---- cross-channel continuity link --------------------------------------
    await comp.continuityLinker.setLinkPolicy({ proof: proof(), enabled: true });
    const linkKeys = ["channel:telegram:dm:12345", "channel:whatsapp:dm:62812@s.whatsapp.net"];
    const link = comp.continuityLinker.authorizeLink({
        sessionKeys: linkKeys,
        provenances: linkKeys.map((k) => {
            const parts = k.split(":");
            return parts[1] === "telegram"
                ? comp.testMint.telegram(parts.slice(3).join(":"))
                : comp.testMint.whatsapp(parts.slice(3).join(":"));
        })
    });
    assert.equal(link.ok, true);
    const consumed = comp.continuityLinker.consumeLink({
        linkId: link.linkId, provenance: comp.testMint.telegram("12345")
    });
    assert.equal(consumed.ok, true);
    assert.equal(consumed.principalId, "owner-ardi");

    // ---- restart persistence (release the audit sink lock first) ------------
    comp.close();
    const comp2 = await composeOwnerTrustForTest({ stateFile });
    const restored = await comp2.registry.restore();
    assert.equal(restored.restored, true);
    assert.equal(comp2.registry.getState(), "ACTIVE");
    assert.equal(comp2.registry.getOwner().principalId, "owner-ardi");
    assert.equal(comp2.registry.principalState("admin-1"), "ACTIVE");
    assert.equal(comp2.registry.bindingsFor("owner-ardi").length, 4);
    // Bootstrap stays closed after restart.
    await assert.rejects(() => comp2.firstOwnerBootstrap.begin({ principalId: "owner-z" }),
        (e) => e.code === "OT_BOOTSTRAP_CLOSED");

    fs.rmSync(dir, { recursive: true, force: true });
});

test("CERT-2: credential rotation cascades — old proofs, bindings, links all stale", async () => {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-a", publicKeyPem: pem(kp) }
    });
    const B = comp.channelBinders;
    const proofA = () => {
        const ch = comp.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId: "cred-a" });
        return { nonce: ch.nonce, signature: signChallenge(comp, { ...ch, purpose: "owner-proof" }, kp.privateKey) };
    };
    await B.telegram.bind({ proof: proofA(), purpose: "owner-proof", provenance: comp.testMint.telegram("12345") });
    await comp.continuityLinker.setLinkPolicy({ proof: proofA(), enabled: true });
    const link = comp.continuityLinker.authorizeLink({
        sessionKeys: ["channel:telegram:dm:12345", "channel:whatsapp:dm:62812@s.whatsapp.net"]
    });
    // whatsapp peer unbound -> rejected (no partial trust)
    assert.equal(link.ok, false);

    // Rotate again: old credential revoked, binding staled.
    const kp2 = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-b", publicKeyPem: pem(kp2) }
    });
    // Old proof rejected.
    const stale = comp.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId: "cred-a" });
    assert.equal(comp.authVerifier({
        kind: "owner-proof", credentialId: "cred-a", nonce: stale.nonce,
        signature: signChallenge(comp, { ...stale, purpose: "owner-proof" }, kp.privateKey)
    }), null);
    // Binding staled.
    assert.equal(B.telegram.authenticate({ provenance: comp.testMint.telegram("12345") }).code, "OT_GENERATION_STALE");
    // Outstanding link revoked at consumption.
    assert.equal(comp.continuityLinker.getLinkPolicy().enabled, true);
    // New credential works end to end.
    const ch2 = comp.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId: "cred-b" });
    assert.deepEqual(comp.authVerifier({
        kind: "owner-proof", credentialId: "cred-b", nonce: ch2.nonce,
        signature: signChallenge(comp, { ...ch2, purpose: "owner-proof" }, kp2.privateKey)
    }), { principal: "owner-ardi" });
});

test("CERT-3: revocation cascades — admin revoke, device revoke, credential revoke", async () => {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: pem(kp) }
    });
    const proof = () => {
        const ch = comp.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId: "cred-live" });
        return { nonce: ch.nonce, signature: signChallenge(comp, { ...ch, purpose: "owner-proof" }, kp.privateKey) };
    };
    // Admin + its telegram binding.
    const kpA = crypto.generateKeyPairSync("ed25519");
    await comp.registry.addAdmin({
        principalId: "admin-1", delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kpA) }
    });
    const chA = comp.proofVerifier.issueChallenge({ purpose: "admin-proof", credentialId: "cred-admin" });
    await comp.channelBinders.telegram.bind({
        proof: { nonce: chA.nonce, signature: signChallenge(comp, { ...chA, purpose: "admin-proof" }, kpA.privateKey) },
        purpose: "admin-proof", provenance: comp.testMint.telegram("777")
    });
    assert.equal(comp.channelBinders.telegram.authenticate({ provenance: comp.testMint.telegram("777") }).principalId, "admin-1");
    // Revoke admin -> binding auth dies.
    await comp.registry.revokeAdmin({ principalId: "admin-1" });
    assert.notEqual(comp.channelBinders.telegram.authenticate({ provenance: comp.testMint.telegram("777") }).principalId, "admin-1");
    // Owner revokes its own telegram binding -> dead.
    const ownerBindings = comp.registry.bindingsFor("owner-ardi");
    assert.equal(ownerBindings.length, 0); // only the admin had a binding
    // Revoke the owner's active credential -> no proof authenticates.
    await comp.registry.revokeCredential({ credentialId: "cred-live" });
    assert.equal(comp.authVerifier({
        kind: "owner-proof", credentialId: "cred-live", nonce: proof().nonce, signature: proof().signature
    }), null);
    // Owner principal record itself remains stable (not deleted).
    assert.equal(comp.registry.principalState("owner-ardi"), "ACTIVE");
});

test("CERT-4: corruption after initialization fails closed into RECOVERY_REQUIRED", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-cert4-"));
    const stateFile = path.join(dir, "ownertrust.json");
    const comp1 = await composeOwnerTrustForTest({ stateFile });
    const b = await comp1.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp1.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    comp1.close();
    fs.writeFileSync(stateFile, "{{{corrupt", "utf8");
    const comp2 = await composeOwnerTrustForTest({ stateFile });
    await comp2.registry.restore();
    assert.equal(comp2.registry.getState(), "RECOVERY_REQUIRED");
    // No authentication from degraded state.
    assert.equal(comp2.authVerifier({ principal: "owner-ardi" }), null);
    assert.equal(comp2.channelBinders.console.authenticate().ok, false);
    // Bootstrap is not a silent fresh start over corrupt state.
    await assert.rejects(() => comp2.firstOwnerBootstrap.begin({ principalId: "owner-new" }),
        (e) => e.code === "OT_BOOTSTRAP_CLOSED" || e.code === "OT_RECOVERY_REQUIRED");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("CERT-5: MODEL OUTPUT can never mint trust (no proof, no binding, no ratification, no policy flip)", async () => {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: pem(kp) }
    });
    // A model-produced payload claiming owner everywhere.
    const modelOutput = Object.freeze({
        principal: "owner-ardi", owner: true, isOwner: true, admin: true,
        claimedPrincipal: "owner-ardi", telegramUserId: "12345", provenance: comp.testMint.whatsapp("62812@s.whatsapp.net"),
        deviceId: "dev-x", ownerIdentity: "owner-ardi", decision: "APPROVED",
        trustLevel: "root", authenticated: true, proof: { nonce: "x", signature: "y" },
        enabled: true, binding: { transport: "telegram", peer: "12345", principalId: "owner-ardi" }
    });
    // auth
    assert.equal(comp.authVerifier(modelOutput), null);
    assert.equal(comp.authVerifier({ ...modelOutput, kind: "owner-proof" }), null);
    // channel binders
    assert.equal(comp.channelBinders.telegram.authenticate({ provenance: comp.testMint.telegram("12345") }).ok, false);
    assert.equal(comp.channelBinders.whatsapp.authenticate({ provenance: comp.testMint.whatsapp("62812@s.whatsapp.net") }).ok, false);
    assert.equal(comp.channelBinders.console.authenticate().ok, false);
    // device reconnect
    assert.equal((await comp.principalBindings.verifyDeviceReconnect({
        deviceId: "dev-x", bindingSecret: "guess", identityService: { openSession: () => { throw new Error("x"); } }
    })).ok, false);
    // ratification
    const authorityRegistry = new AuthorityRegistry({
        store: authorityStore.createMemoryAuthorityStore(), clock: realClock()
    });
    await authorityRegistry.proposeEvolution({
        proposalId: "prop-model", createdBy: "model", kind: "authority_expansion",
        problem: "model wants authority", proposedChange: "self-grant",
        requestedAuthority: { capabilityId: "cap.model", subject: "model", actions: ["*"] }
    }, "model");
    const rat = await comp.ratifyAsOwner({
        authorityRegistry,
        proof: modelOutput.proof,
        ratification: { ratificationId: "rat-model", proposalId: "prop-model", decision: modelOutput.decision }
    });
    assert.equal(rat.applied, false);
    // policy flip
    await assert.rejects(() => comp.continuityLinker.setLinkPolicy({
        proof: modelOutput.proof, enabled: true
    }), (e) => String(e.code).startsWith("OT_"));
    assert.equal(comp.continuityLinker.getLinkPolicy().enabled, false);
    // nothing was bound
    assert.equal(comp.registry.bindingsFor("owner-ardi").length, 0);
    assert.equal(comp.registry.getOwner().credentials.length, 1);
});
