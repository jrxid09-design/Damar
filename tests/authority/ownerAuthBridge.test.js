"use strict";

/**
 * CANONICAL AUTHENTICATED-PRINCIPAL BRIDGE (Stage 4).
 *
 * Proves the sealed Owner/Admin proof → authenticated-principal bridge through
 * the canonical action facade (lane2.authenticate), with raw claimed fields
 * never authenticating and the fail-closed default preserved.
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

async function makeComposed() {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    return comp;
}

function issueProof(comp, { purpose, credentialId, privateKey }) {
    const ch = comp.proofVerifier.issueChallenge({ purpose, credentialId });
    const signature = crypto.sign(null, canonicalChallenge({
        purpose, credentialId, nonce: ch.nonce, context: ch.context
    }), privateKey);
    return { nonce: ch.nonce, signature: signature.toString("base64url") };
}

test("bridge: valid owner proof authenticates the canonical principal", async () => {
    const comp = await makeComposed();
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }) }
    });
    const proof = issueProof(comp, { purpose: "owner-proof", credentialId: "cred-live", privateKey: kp.privateKey });
    const result = comp.authVerifier({
        kind: "owner-proof", credentialId: "cred-live", nonce: proof.nonce, signature: proof.signature
    });
    assert.deepEqual(result, { principal: "owner-ardi" });
});

test("bridge: raw claimed fields NEVER authenticate (principal/owner/admin/telegramUserId/jid/deviceId)", async () => {
    const comp = await makeComposed();
    for (const evidence of [
        { principal: "owner-ardi" },
        { owner: true },
        { admin: true },
        { claimedPrincipal: "owner-ardi" },
        { telegramUserId: "12345" },
        { jid: "12345@s.whatsapp.net" },
        { deviceId: "dev-1" },
        { kind: "owner-proof" },           // missing proof fields
        null,
        "owner-ardi"
    ]) {
        assert.equal(comp.authVerifier(evidence), null,
            `must not authenticate: ${JSON.stringify(evidence)}`);
    }
});

test("bridge: wrong purpose / bad signature / replay / revoked credential rejected", async () => {
    const comp = await makeComposed();
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }) }
    });
    const proof = issueProof(comp, { purpose: "owner-proof", credentialId: "cred-live", privateKey: kp.privateKey });

    // wrong purpose (proof issued for owner-proof but presented as admin-proof)
    assert.equal(comp.authVerifier({
        kind: "admin-proof", credentialId: "cred-live", nonce: proof.nonce, signature: proof.signature
    }), null);
    // bad signature
    assert.equal(comp.authVerifier({
        kind: "owner-proof", credentialId: "cred-live", nonce: proof.nonce, signature: "AAAA"
    }), null);
    // valid once
    assert.ok(comp.authVerifier({
        kind: "owner-proof", credentialId: "cred-live", nonce: proof.nonce, signature: proof.signature
    }));
    // replay rejected
    assert.equal(comp.authVerifier({
        kind: "owner-proof", credentialId: "cred-live", nonce: proof.nonce, signature: proof.signature
    }), null);

    // revoked credential
    await comp.registry.revokeCredential({ credentialId: "cred-live" });
    const proof2 = issueProof(comp, { purpose: "owner-proof", credentialId: "cred-live", privateKey: kp.privateKey });
    assert.equal(comp.authVerifier({
        kind: "owner-proof", credentialId: "cred-live", nonce: proof2.nonce, signature: proof2.signature
    }), null);
});

test("bridge: admin proof authenticates admin principal (owner-delegated)", async () => {
    const comp = await makeComposed();
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.addAdmin({
        principalId: "admin-1",
        delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }) }
    });
    const proof = issueProof(comp, { purpose: "admin-proof", credentialId: "cred-admin", privateKey: kp.privateKey });
    const result = comp.authVerifier({
        kind: "admin-proof", credentialId: "cred-admin", nonce: proof.nonce, signature: proof.signature
    });
    assert.deepEqual(result, { principal: "admin-1" });
    // admin proof presented as owner-proof fails (purpose binding)
    const proof2 = issueProof(comp, { purpose: "admin-proof", credentialId: "cred-admin", privateKey: kp.privateKey });
    assert.equal(comp.authVerifier({
        kind: "owner-proof", credentialId: "cred-admin", nonce: proof2.nonce, signature: proof2.signature
    }), null);
});

test("bridge: canonical action facade authenticates a valid proof and fail-closes raw input", async () => {
    // Compose the CANONICAL singleton (installs the verifier into lane2).
    process.env.DAMAR_OWNER_TRUST_STATE = "memory";
    const otc = require("../../src/authority/ownerTrustComposition");
    const comp = await otc.ensureCanonicalComposed();
    if (comp.registry.getState() !== "ACTIVE") {
        const kp0 = crypto.generateKeyPairSync("ed25519");
        const b = await comp.firstOwnerBootstrap.begin({
            principalId: "owner-ardi", mode: "external",
            publicKeyPem: kp0.publicKey.export({ type: "spki", format: "pem" })
        });
        const sig = crypto.sign(null, otc.canonicalChallenge({
            purpose: otc.BOOTSTRAP_PURPOSE, credentialId: b.challenge.credentialId,
            nonce: b.challenge.nonce, context: otc.BOOTSTRAP_CONTEXT
        }), kp0.privateKey);
        await comp.firstOwnerBootstrap.complete({
            ceremonyId: b.ceremonyId, signature: sig.toString("base64url")
        });
    }
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-lane2", publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }) }
    });

    const { createCanonicalActionFacade } = require("../../src/action/bootstrap");
    const lane2 = createCanonicalActionFacade();
    const ch = comp.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId: "cred-lane2" });
    const proofSig = crypto.sign(null, otc.canonicalChallenge({
        purpose: "owner-proof", credentialId: "cred-lane2", nonce: ch.nonce, context: ch.context
    }), kp.privateKey);
    const session = lane2.authenticate({
        kind: "owner-proof", credentialId: "cred-lane2", nonce: ch.nonce, signature: proofSig.toString("base64url")
    });
    assert.ok(session, "lane2 must mint a branded session for a valid owner proof");
    assert.equal(session.principal, "owner-ardi");
    // Raw input still fail-closed.
    assert.equal(lane2.authenticate({}), null);
    assert.equal(lane2.authenticate({ principal: "owner-ardi" }), null);
    delete process.env.DAMAR_OWNER_TRUST_STATE;
});
