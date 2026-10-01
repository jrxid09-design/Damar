const test = require("node:test");
const assert = require("node:assert");

test("internal grant registration cannot promote a caller-owned object", () => {
    const grants = require("../../src/ai/tools/internalGrant");
    const forged = Object.freeze({
        role: "system",
        source: "forged",
        sessionId: "attacker"
    });

    assert.equal(grants.registerGrant(forged, ["terminal_run"]), false);
    assert.equal(grants.isCanonicalInternalGrant(forged), false);
    assert.equal(grants.isToolAuthorizedByGrant(forged, "terminal_run"), false);
});

test("cross-domain registration adopts only an actually minted grant and its original scope", () => {
    const grants = require("../../src/ai/tools/internalGrant");
    const domain = grants.createInternalGrantDomain();
    const minted = domain.mintCanonicalInternalGrant({
        authorizedTools: ["memory_recall"],
        provenance: "boundary-test"
    });

    assert.equal(grants.registerGrant(minted, ["terminal_run"]), true);
    assert.equal(grants.isCanonicalInternalGrant(minted), true);
    assert.equal(grants.isToolAuthorizedByGrant(minted, "memory_recall"), true);
    assert.equal(grants.isToolAuthorizedByGrant(minted, "terminal_run"), false);
});
