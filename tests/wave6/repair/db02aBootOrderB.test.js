"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDamarManager } = require("../../../src/manager/bootstrap");
const productionComposition = require("../../../src/authority/productionComposition");
const { CHANNEL_TYPES, OUTCOME } = require("../../../src/manager");
const { enrollOwnerAndGrant, freshProof } = require("./db02aBootOrderHelpers");

const CAPABILITY_ID = "mata_dewa.mode.deactivate";

/**
 * DB02-A boot-order (Repair5 continued), ORDER B — the mirror image of
 * db02aBootOrderA.test.js: production Authority composition completes
 * BEFORE createDamarManager() ever runs. Result must be identical (ALLOW,
 * then immediately-visible revocation DENY) — construction order must never
 * change authority semantics.
 */
test("DB02-A order B: production Authority composition before Manager construction — identical result to order A", async () => {
    // 1. Production Authority composition FIRST.
    const comp = await productionComposition.ensureProductionAuthorityComposed();
    assert.ok(comp.ownerTrust, "real owner-trust composition must be live");

    // 2. Owner enroll/ratify/provision, still before the Manager exists.
    const { ot, kp, credentialId } = await enrollOwnerAndGrant({
        comp, capabilityId: CAPABILITY_ID, actions: ["deactivate"], suffix: "-b"
    });

    // 3. Manager (and Lane 2's canonical facade) constructed LAST.
    const manager = createDamarManager();

    const allowed = await manager.handle({
        channelType: CHANNEL_TYPES.CONSOLE, channelId: "console", sessionId: "s-db02a-order-b",
        correlationId: "corr-db02a-order-b", receivedAtMs: Date.now(),
        authProof: freshProof(ot, credentialId, kp),
        requestedOperation: { capabilityId: CAPABILITY_ID, operation: "deactivate", arguments: {} }
    });
    assert.notEqual(allowed.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
        "genuine one-use Owner proof must authenticate (got " + allowed.outcome + ")");
    assert.notEqual(allowed.outcome, OUTCOME.AUTHORITY_DENIED,
        "a Manager built AFTER production composition must see the existing grant " +
        "(got " + allowed.outcome + " detail=" + String(allowed.detail || "").slice(0, 200) + ")");

    // DB02-C in this order too: revocation must be immediately visible.
    const revoked = await comp.canonicalOwner.revoke(CAPABILITY_ID);
    assert.equal(revoked.ok, true, "revoke must succeed: " + JSON.stringify(revoked));
    const deniedAfterRevoke = await manager.handle({
        channelType: CHANNEL_TYPES.CONSOLE, channelId: "console", sessionId: "s-db02a-order-b-2",
        correlationId: "corr-db02a-order-b-2", receivedAtMs: Date.now(),
        authProof: freshProof(ot, credentialId, kp),
        requestedOperation: { capabilityId: CAPABILITY_ID, operation: "deactivate", arguments: {} }
    });
    assert.equal(deniedAfterRevoke.outcome, OUTCOME.AUTHORITY_DENIED,
        "revocation must be immediately visible to Lane 2 (got " + deniedAfterRevoke.outcome + ")");
});
