"use strict";

/**
 * STAGE 5 — Owner-delegated Admin + Owner ratification bridge into Authority.
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
const { AuthorityRegistry } = require("../../src/authority/registry");
const authorityStore = require("../../src/authority/store");
const { realClock } = require("../../src/embodiment/core/util");

async function makeComposed() {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    return comp;
}

function pem(kp) {
    return kp.publicKey.export({ type: "spki", format: "pem" });
}

function issueProof(comp, { purpose, credentialId, privateKey }) {
    const ch = comp.proofVerifier.issueChallenge({ purpose, credentialId });
    const signature = crypto.sign(null, canonicalChallenge({
        purpose, credentialId, nonce: ch.nonce, context: ch.context
    }), privateKey);
    return { credentialId, nonce: ch.nonce, signature: signature.toString("base64url") };
}

async function makeAuthorityRegistry() {
    const registry = new AuthorityRegistry({
        store: authorityStore.createMemoryAuthorityStore(),
        clock: realClock()
    });
    await registry.proposeEvolution({
        proposalId: "prop-1",
        createdBy: "acc",
        kind: "authority_expansion",
        problem: "butuh authority untuk evolusi",
        proposedChange: "terbitkan ROOT grant via ratifikasi",
        requestedAuthority: { capabilityId: "cap.test", subject: "agent", actions: ["read"] }
    }, "acc");
    return registry;
}

test("Owner creates Admin; Admin proof authenticates the admin principal", async () => {
    const comp = await makeComposed();
    const kp = crypto.generateKeyPairSync("ed25519");
    const res = await comp.registry.addAdmin({
        principalId: "admin-1",
        delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kp) }
    });
    assert.equal(res.principalId, "admin-1");
    const proof = issueProof(comp, { purpose: "admin-proof", credentialId: "cred-admin", privateKey: kp.privateKey });
    assert.deepEqual(comp.authVerifier({
        kind: "admin-proof", credentialId: proof.credentialId, nonce: proof.nonce, signature: proof.signature
    }), { principal: "admin-1" });
});

test("non-Owner cannot delegate Admin; admin cannot create equivalent Owner", async () => {
    const comp = await makeComposed();
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.addAdmin({
        principalId: "admin-1",
        delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kp) }
    });
    // admin delegating another admin -> rejected (only the Owner delegates)
    const kp2 = crypto.generateKeyPairSync("ed25519");
    await assert.rejects(() => comp.registry.addAdmin({
        principalId: "admin-2",
        delegatedBy: "admin-1",
        credential: { credentialId: "cred-admin2", publicKeyPem: pem(kp2) }
    }), (e) => e.code === "OT_NOT_OWNER");
    // admin cannot complete a first-Owner bootstrap (no second root)
    await assert.rejects(() => comp.registry.completeFirstBootstrap({
        principalId: "admin-1", credential: { credentialId: "zz", publicKeyPem: "k" }
    }), (e) => e.code === "OT_BOOTSTRAP_CLOSED");
    // admin cannot become the Owner via completeFirstBootstrap with its own principal
    await assert.rejects(() => comp.registry.completeFirstBootstrap({
        principalId: "admin-1", credential: { credentialId: "zz2", publicKeyPem: pem(kp) }
    }), (e) => e.code === "OT_BOOTSTRAP_CLOSED");
});

test("revoke Admin invalidates its authentication; Owner unaffected", async () => {
    const comp = await makeComposed();
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.addAdmin({
        principalId: "admin-1",
        delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kp) }
    });
    const proof = issueProof(comp, { purpose: "admin-proof", credentialId: "cred-admin", privateKey: kp.privateKey });
    assert.deepEqual(comp.authVerifier({
        kind: "admin-proof", credentialId: proof.credentialId, nonce: proof.nonce, signature: proof.signature
    }), { principal: "admin-1" });
    await comp.registry.revokeAdmin({ principalId: "admin-1" });
    const proof2 = issueProof(comp, { purpose: "admin-proof", credentialId: "cred-admin", privateKey: kp.privateKey });
    assert.equal(comp.authVerifier({
        kind: "admin-proof", credentialId: proof2.credentialId, nonce: proof2.nonce, signature: proof2.signature
    }), null, "revoked admin must fail authentication");
    // Owner unaffected
    const kpO = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-owner-live", publicKeyPem: pem(kpO) }
    });
    const ownerProof = issueProof(comp, { purpose: "owner-proof", credentialId: "cred-owner-live", privateKey: kpO.privateKey });
    assert.deepEqual(comp.authVerifier({
        kind: "owner-proof", credentialId: ownerProof.credentialId, nonce: ownerProof.nonce, signature: ownerProof.signature
    }), { principal: "owner-ardi" });
});

test("Owner ratification bridge: valid owner proof ratifies into AuthorityRegistry", async () => {
    const comp = await makeComposed();
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: pem(kp) }
    });
    const registry = await makeAuthorityRegistry();
    const result = await comp.ratifyAsOwner({
        authorityRegistry: registry,
        proof: issueProof(comp, { purpose: "owner-proof", credentialId: "cred-live", privateKey: kp.privateKey }),
        ratification: { ratificationId: "rat-1", proposalId: "prop-1", decision: "APPROVED" }
    });
    assert.equal(result.applied, true);
    assert.equal(result.ratification.ownerIdentity, "owner-ardi");
});

test("Owner ratification bridge: raw ownerIdentity string is NOT proof of Owner", async () => {
    const comp = await makeComposed();
    const registry = await makeAuthorityRegistry();
    // Caller-supplied ownerIdentity masquerading as proof -> rejected.
    const result = await comp.ratifyAsOwner({
        authorityRegistry: registry,
        proof: { ownerIdentity: "owner-ardi" },
        ratification: { ratificationId: "rat-2", proposalId: "prop-1", decision: "APPROVED" }
    });
    assert.equal(result.applied, false);
    assert.ok(result.reasonCode);
});

test("Owner ratification bridge: fake proof / admin-as-owner rejected", async () => {
    const comp = await makeComposed();
    const registry = await makeAuthorityRegistry();
    const fake = await comp.ratifyAsOwner({
        authorityRegistry: registry,
        proof: { credentialId: "cred-live", nonce: "x", signature: "AAAA" },
        ratification: { ratificationId: "rat-3", proposalId: "prop-1", decision: "APPROVED" }
    });
    assert.equal(fake.applied, false);
    const kpA = crypto.generateKeyPairSync("ed25519");
    await comp.registry.addAdmin({
        principalId: "admin-1",
        delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kpA) }
    });
    const adminResult = await comp.ratifyAsOwner({
        authorityRegistry: registry,
        proof: issueProof(comp, { purpose: "admin-proof", credentialId: "cred-admin", privateKey: kpA.privateKey }),
        ratification: { ratificationId: "rat-4", proposalId: "prop-1", decision: "APPROVED" }
    });
    assert.equal(adminResult.applied, false);
    assert.equal(adminResult.reasonCode, "OT_PROOF_PURPOSE_MISMATCH");
});

test("Authority core semantics unchanged: direct registry.ratify still works for existing tests", async () => {
    const registry = await makeAuthorityRegistry();
    const r = await registry.ratify({
        ratificationId: "rat-direct",
        proposalId: "prop-1",
        ownerIdentity: "acc-test-actor",
        decision: "APPROVED"
    });
    assert.equal(r.applied, true);
});

test("model cannot mint a grant: proof-less ratifyAsOwner fails closed", async () => {
    const comp = await makeComposed();
    const registry = await makeAuthorityRegistry();
    // A model-produced "ownerIdentity" text alone can never ratify.
    for (const proof of [null, undefined, {}, "owner-ardi", 42]) {
        const result = await comp.ratifyAsOwner({
            authorityRegistry: registry,
            proof,
            ratification: { ratificationId: "rat-m", proposalId: "prop-1", decision: "APPROVED" }
        });
        assert.equal(result.applied, false, `proof ${JSON.stringify(proof)} must not ratify`);
    }
});
