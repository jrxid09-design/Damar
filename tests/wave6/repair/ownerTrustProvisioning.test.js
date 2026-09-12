"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const productionComposition = require("../../../src/authority/productionComposition");
const { isCanonicalAuthorityBound } = require("../../../src/authority/canonicalComposition");
const { isCanonicalAuthorityRegistry } = require("../../../src/authority/canonicalOwnership");
const { parseActionIntent } = require("../../../src/action/intent");
const { createDistributedNodeRuntime } = require("../../../src/integration/wave6Production");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * W6-R5-03 — REAL PRODUCTION OWNER-TRUST PROVISIONING.
 *
 * Before R5-03 the production daemon never bound the canonical
 * AuthorityRegistry, so `dexec/router` fail-closed forever ("not yet bound")
 * and Owner trust was never connected to canonical authority. These tests
 * drive the REAL production composition (NOT the test-only seam) and prove:
 *   - the canonical AuthorityRegistry is bound by the production entry;
 *   - the sealed canonical Owner/Admin composition is used;
 *   - ratification + provisioning mint ONLY from a genuine owner proof bound
 *     to a stored proposal;
 *   - a caller-shaped / forged ratification or raw identity mints NOTHING;
 *   - a real end-to-end route resolves live authority.
 */

let compPromise = null;
function composed() {
    if (!compPromise) compPromise = productionComposition.ensureProductionAuthorityComposed();
    return compPromise;
}

test("R5-03: production composition binds THE canonical AuthorityRegistry (no test seam)", async () => {
    const comp = await composed();
    assert.equal(comp.marker, "production-owner-trust-composition");
    assert.equal(comp.status().authorityBound, true, "canonical authority must be bound at production boot");
    assert.equal(isCanonicalAuthorityBound(), true);
    // The owner is the canonical instance produced by the deep-internal
    // composition root — never a caller `new AuthorityRegistry(...)`.
    assert.equal(isCanonicalAuthorityRegistry(comp.canonicalOwner), true);
    // The canonical Owner/Admin trust composition is the REAL one.
    assert.ok(comp.ownerTrust, "canonical owner-trust composition must be composed");
    assert.equal(comp.status().ownerTrustComposed, true);
});

test("R5-03: production surface exports NO privileged authority mutator", () => {
    for (const forbidden of [
        "installCanonicalAuthorityRegistry", "markCanonicalAuthorityRegistry",
        "buildCanonicalAuthorityRoot", "createCanonicalAuthorityRegistry",
        "composeCanonicalAuthorityRoot"
    ]) {
        assert.equal(productionComposition[forbidden], undefined,
            `production composition must NOT export ${forbidden}`);
    }
    // Only the sanctioned entries exist.
    assert.deepEqual(Object.keys(productionComposition).sort(),
        ["ensureProductionAuthorityComposed", "getProductionAuthorityComposition", "resolveProductionAuthorityStore"]);
});

test("R5-03: owner-proof ratification mints authority; raw identity / forged proof does NOT", async () => {
    const comp = await composed();
    const ot = comp.ownerTrust;

    // Enroll the canonical Owner (external mode: the test holds the key).
    const kp = crypto.generateKeyPairSync("ed25519");
    let credentialId;
    if (ot.registry.getState() !== "ACTIVE") {
        const begin = await ot.firstOwnerBootstrap.begin({
            principalId: "owner-ardi", mode: "external",
            publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" })
        });
        credentialId = begin.challenge.credentialId;
        const payload = require("../../../src/authority/ownerTrustComposition").canonicalChallenge({
            purpose: require("../../../src/authority/ownerTrustComposition").BOOTSTRAP_PURPOSE,
            credentialId,
            nonce: begin.challenge.nonce,
            context: require("../../../src/authority/ownerTrustComposition").BOOTSTRAP_CONTEXT
        });
        const sig = crypto.sign(null, payload, kp.privateKey).toString("base64url");
        const done = await ot.firstOwnerBootstrap.complete({ ceremonyId: begin.ceremonyId, signature: sig });
        credentialId = done.credentialId;
    } else {
        await ot.registry.rotateCredential({
            principalId: "owner-ardi",
            newCredential: { credentialId: "cred-r503", publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }) }
        });
        credentialId = "cred-r503";
    }

    // A stored proposal in the CANONICAL registry.
    const proposalId = "r503-proposal";
    await comp.canonicalOwner.proposeEvolution({
        proposalId, createdBy: "owner", kind: "authority_expansion",
        problem: "grant governed execution", proposedChange: "grant",
        requestedAuthority: {
            capabilityId: "code.test", subject: "damar",
            actions: ["test"], scope: ["."], maxExecutions: 1000
        }
    }, "owner");

    // Raw ownerIdentity string is NEVER proof.
    const raw = await comp.ratifyAsOwner({
        proof: { ownerIdentity: "owner-ardi" },
        ratification: { ratificationId: "r503-raw", proposalId, decision: "APPROVED" }
    });
    assert.equal(raw.applied, false, "raw identity must not ratify");

    // Genuine owner proof ratifies into the canonical registry.
    const ch = ot.proofVerifier.issueChallenge({ purpose: "owner-proof", credentialId });
    const proofSig = crypto.sign(null, require("../../../src/authority/ownerTrustComposition").canonicalChallenge({
        purpose: "owner-proof", credentialId, nonce: ch.nonce, context: ch.context
    }), kp.privateKey).toString("base64url");
    const ratified = await comp.ratifyAsOwner({
        proof: { credentialId, nonce: ch.nonce, signature: proofSig },
        ratification: { ratificationId: "r503-approved", proposalId, decision: "APPROVED" }
    });
    assert.equal(ratified.applied, true, "genuine owner proof must ratify");

    // Provision (mint) — binds the STORED APPROVED ratification.
    const issued = await comp.provisionAuthority({ proposalId, ratificationId: "r503-approved" });
    assert.equal(issued.allowed, true, "owner-ratified proposal must mint a root grant");
    assert.ok(issued.grant, "a concrete grant is issued");

    // Forged / unknown ratification mints NOTHING.
    const forged = await comp.provisionAuthority({ proposalId, ratificationId: "ghost-rat" });
    assert.equal(forged.allowed, false, "a non-existent ratification must not mint");
    assert.equal(forged.grant, null);
});

test("R5-03: end-to-end governed route resolves LIVE canonical authority (no test seam)", async () => {
    const comp = await composed();
    assert.equal(comp.status().authorityBound, true);

    // Build a real node; its dexecRouter resolves the canonical bridge at route
    // time. This is the production path (no makeCanonicalAuthorityRoot harness).
    const A = createDistributedNodeRuntime({
        logicalDamarId: ids.mint.logicalDamarId(),
        profile: "DESKTOP_PRIMARY",
        capabilityIds: ["code.test"]
    });
    const B = createDistributedNodeRuntime({
        logicalDamarId: A.identity.logicalDamarId,
        profile: "SERVER_PRIVATE",
        capabilityIds: ["code.test"]
    });
    A.registry.register({ identity: A.identity });
    A.registry.register({ identity: B.identity });
    B.registry.register({ identity: B.identity });
    B.registry.register({ identity: A.identity });
    A.trust.pair({ nodeId: B.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"], ttlMs: 3_600_000 });
    A.trust.pair({ nodeId: A.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"], ttlMs: 3_600_000 });
    A.dexecRouter.advertise({
        nodeId: B.identity.nodeId, profile: "SERVER_PRIVATE",
        capabilities: [{ capabilityId: "code.test", toolId: "tool.code.test", latencyScore: 40 }],
        resources: { headroomScore: 35 }
    });

    const intent = parseActionIntent(JSON.stringify({
        schemaVersion: 1, capabilityId: "code.test", operation: "test",
        arguments: { scope: "." }, correlationId: "r503"
    }), { nowMs: 1_000_000 });

    const out = await A.ingress.submitIntent({
        intent, toolId: "tool.code.test", privacyClass: "INTERNAL",
        preferredNodeId: B.identity.nodeId
    });
    assert.equal(out.targetNodeId, B.identity.nodeId,
        "route MUST resolve live canonical authority, not fail closed as unbound");
    assert.match(out.lease.leaseId, /^dlease-/);
});

test("R5-03: single-flight — repeated composition returns the SAME frozen owner", async () => {
    const comp = await composed();
    const again = await productionComposition.ensureProductionAuthorityComposed();
    assert.equal(again, comp, "composition runs once per process");
    assert.equal(productionComposition.getProductionAuthorityComposition(), comp);
    assert.ok(Object.isFrozen(comp));
});
