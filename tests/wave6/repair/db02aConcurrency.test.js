"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDamarManager } = require("../../../src/manager/bootstrap");
const { createCanonicalActionFacade } = require("../../../src/action/bootstrap");
const productionComposition = require("../../../src/authority/productionComposition");
const { isCanonicalAuthorityBound } = require("../../../src/authority/canonicalComposition");
const { CHANNEL_TYPES, OUTCOME } = require("../../../src/manager");
const { enrollOwnerAndGrant, freshProof } = require("./db02aBootOrderHelpers");

const CAPABILITY_ID = "mata_dewa.mode.deactivate";

/**
 * DB02-A boot-order (Repair5 continued), CONCURRENCY (D):
 *
 * Racing createDamarManager() / createCanonicalActionFacade() /
 * ensureProductionAuthorityComposed() must converge to ONE canonical
 * authority store — never split, never silently fork. There is exactly one
 * module-private `_canonicalRegistry` (src/authority/canonicalComposition.js)
 * and Lane 2's store lens re-resolves it on every read, so no interleaving
 * of these three calls can leave Lane 2 permanently bound to a different
 * store than the one the canonical AuthorityRegistry actually writes into.
 */
test("DB02-A concurrency: racing Manager/facade/composition construction converges to one authority store", async () => {
    const [manager, facade, comp] = await Promise.all([
        Promise.resolve().then(() => createDamarManager()),
        Promise.resolve().then(() => createCanonicalActionFacade()),
        productionComposition.ensureProductionAuthorityComposed()
    ]);

    assert.ok(manager, "Manager must construct");
    assert.ok(facade, "canonical Lane 2 facade must construct");
    assert.ok(comp.ownerTrust, "production Authority composition must complete");
    assert.equal(isCanonicalAuthorityBound(), true,
        "exactly one canonical AuthorityRegistry must be bound after the race");

    // Prove convergence, not just non-crash: a grant minted on the canonical
    // production owner AFTER the race must be visible to the SAME raced
    // Manager singleton — if Lane 2 had split onto a second/ephemeral store,
    // this would fail closed (AUTHORITY_DENIED) instead.
    const { ot, kp, credentialId } = await enrollOwnerAndGrant({
        comp, capabilityId: CAPABILITY_ID, actions: ["deactivate"], suffix: "-d"
    });
    const allowed = await manager.handle({
        channelType: CHANNEL_TYPES.CONSOLE, channelId: "console", sessionId: "s-db02a-race",
        correlationId: "corr-db02a-race", receivedAtMs: Date.now(),
        authProof: freshProof(ot, credentialId, kp),
        requestedOperation: { capabilityId: CAPABILITY_ID, operation: "deactivate", arguments: {} }
    });
    assert.notEqual(allowed.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
        "genuine one-use Owner proof must authenticate (got " + allowed.outcome + ")");
    assert.notEqual(allowed.outcome, OUTCOME.AUTHORITY_DENIED,
        "the raced Manager must converge onto the SAME canonical store the grant landed in " +
        "(got " + allowed.outcome + " detail=" + String(allowed.detail || "").slice(0, 200) + ")");
});
