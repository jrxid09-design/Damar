"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDamarManager } = require("../../../src/manager/bootstrap");
const productionComposition = require("../../../src/authority/productionComposition");
const { CHANNEL_TYPES, OUTCOME } = require("../../../src/manager");
const { enrollOwnerAndGrant, freshProof } = require("./db02aBootOrderHelpers");

const CAPABILITY_ID = "mata_dewa.mode.deactivate";

/**
 * DB02-A boot-order (Repair5 continued), ORDER A:
 *
 *   createDamarManager() [-> createCanonicalActionFacade()]
 *   BEFORE
 *   ensureProductionAuthorityComposed()
 *
 * Before this repair, `resolveLane2AuthorityStore()` resolved the canonical
 * production store ONCE, eagerly, at facade-construction time, and the
 * facade memoizes forever. Building the Manager in this order captured the
 * ephemeral fallback store permanently: a genuine, later, Owner-ratified
 * grant could NEVER become visible to Lane 2, no matter how it was
 * provisioned. This test proves that gap is closed: the SAME, ALREADY-BUILT
 * Manager singleton must see a grant minted by production Authority
 * composition that only started AFTER the Manager existed.
 */
test("DB02-A order A: Manager built before production Authority composition still sees a later Owner grant", async () => {
    // 1. Manager (and therefore Lane 2's canonical facade) constructed FIRST
    //    — no production Authority composition has run in this process yet.
    const manager = createDamarManager();

    // 2. Production Authority composition happens AFTER.
    const comp = await productionComposition.ensureProductionAuthorityComposed();
    assert.ok(comp.ownerTrust, "real owner-trust composition must be live");

    // 3. Owner enroll/ratify/provision AFTER the Manager already exists.
    const { ot, kp, credentialId } = await enrollOwnerAndGrant({
        comp, capabilityId: CAPABILITY_ID, actions: ["deactivate"], suffix: "-a"
    });

    // 4. The Manager built in step 1 must see the grant minted in step 3 —
    //    proof that its store lens re-resolves the current canonical store
    //    live rather than replaying a snapshot captured at construction.
    const allowed = await manager.handle({
        channelType: CHANNEL_TYPES.CONSOLE, channelId: "console", sessionId: "s-db02a-order-a",
        correlationId: "corr-db02a-order-a", receivedAtMs: Date.now(),
        authProof: freshProof(ot, credentialId, kp),
        requestedOperation: { capabilityId: CAPABILITY_ID, operation: "deactivate", arguments: {} }
    });
    assert.notEqual(allowed.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
        "genuine one-use Owner proof must authenticate (got " + allowed.outcome + ")");
    assert.notEqual(allowed.outcome, OUTCOME.AUTHORITY_DENIED,
        "a Manager built BEFORE production composition must still see a grant minted AFTER it existed " +
        "(got " + allowed.outcome + " detail=" + String(allowed.detail || "").slice(0, 200) + ")");

    // 5 (DB02-C): post-boot revocation must be IMMEDIATELY visible on this
    //    SAME facade — a live read, not a cached ALLOW.
    const revoked = await comp.canonicalOwner.revoke(CAPABILITY_ID);
    assert.equal(revoked.ok, true, "revoke must succeed: " + JSON.stringify(revoked));
    const deniedAfterRevoke = await manager.handle({
        channelType: CHANNEL_TYPES.CONSOLE, channelId: "console", sessionId: "s-db02a-order-a-2",
        correlationId: "corr-db02a-order-a-2", receivedAtMs: Date.now(),
        authProof: freshProof(ot, credentialId, kp),
        requestedOperation: { capabilityId: CAPABILITY_ID, operation: "deactivate", arguments: {} }
    });
    assert.equal(deniedAfterRevoke.outcome, OUTCOME.AUTHORITY_DENIED,
        "revocation must be immediately visible to Lane 2 (got " + deniedAfterRevoke.outcome + ")");
});
