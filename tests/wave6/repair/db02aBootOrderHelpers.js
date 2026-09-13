"use strict";

const crypto = require("node:crypto");

/**
 * DB02-A boot-order tests (Repair5 continued) — shared owner enrollment +
 * grant helper. Uses the REAL first-run ceremony and REAL owner-ratified
 * grant path (the same contract tests/wave6/repair/ownerTrustProvisioning
 * .test.js and db02PublicE2E.test.js already prove) — no test-only shortcut.
 */
async function enrollOwnerAndGrant({ comp, capabilityId, actions, suffix = "" }) {
    const ownerTrustComposition = require("../../../src/authority/ownerTrustComposition");
    const ot = comp.ownerTrust;
    const kp = crypto.generateKeyPairSync("ed25519");
    const begin = await ot.firstOwnerBootstrap.begin({
        principalId: `owner-db02a${suffix}`, mode: "external",
        publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" })
    });
    const bootstrapPayload = ownerTrustComposition.canonicalChallenge({
        purpose: ownerTrustComposition.BOOTSTRAP_PURPOSE,
        credentialId: begin.challenge.credentialId,
        nonce: begin.challenge.nonce,
        context: ownerTrustComposition.BOOTSTRAP_CONTEXT
    });
    const bootstrapSig = crypto.sign(null, bootstrapPayload, kp.privateKey).toString("base64url");
    const done = await ot.firstOwnerBootstrap.complete({ ceremonyId: begin.ceremonyId, signature: bootstrapSig });
    const credentialId = done.credentialId;
    const ownerPrincipalId = ot.registry.getOwner().principalId;

    const proposalId = `db02a-grant${suffix}`;
    await comp.canonicalOwner.proposeEvolution({
        proposalId, createdBy: "owner", kind: "authority_expansion",
        problem: "db02a boot-order test", proposedChange: "grant",
        requestedAuthority: { capabilityId, subject: ownerPrincipalId, actions, scope: [], maxExecutions: 5 }
    }, "owner");
    const ratifyChallenge = ot.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId });
    const ratifySig = crypto.sign(null, ownerTrustComposition.canonicalChallenge({
        purpose: "owner-proof", credentialId, nonce: ratifyChallenge.nonce, context: ratifyChallenge.context
    }), kp.privateKey).toString("base64url");
    const ratificationId = `db02a-rat${suffix}`;
    const ratified = await comp.ratifyAsOwner({
        proof: { credentialId, nonce: ratifyChallenge.nonce, signature: ratifySig },
        ratification: { ratificationId, proposalId, decision: "APPROVED" }
    });
    if (ratified.applied !== true) throw new Error("ratification failed: " + JSON.stringify(ratified));
    const issued = await comp.provisionAuthority({ proposalId, ratificationId });
    if (issued.allowed !== true) throw new Error("grant mint failed: " + JSON.stringify(issued));

    return { ot, kp, credentialId, ownerPrincipalId };
}

/** A FRESH one-use proof (a proof is consumed once by Lane 2's verifier). */
function freshProof(ot, credentialId, kp) {
    const ownerTrustComposition = require("../../../src/authority/ownerTrustComposition");
    const challenge = ot.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId });
    const signature = crypto.sign(null, ownerTrustComposition.canonicalChallenge({
        purpose: "owner-proof", credentialId, nonce: challenge.nonce, context: challenge.context
    }), kp.privateKey).toString("base64url");
    return { kind: "owner-proof", credentialId, nonce: challenge.nonce, signature };
}

module.exports = { enrollOwnerAndGrant, freshProof };
