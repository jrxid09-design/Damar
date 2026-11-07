const test = require("node:test");
const assert = require("node:assert");

/** Delegation law (§Delegation): child TIDAK boleh melebar (T1). */
const acc = require("./evolution-harness");

function parentGrant() {
    return acc.model.buildGrant({
        capabilityId: "team.ops",
        kind: "root",
        subject: "damar-core",
        issuer: "owner",
        actions: ["use", "delegate"],
        scope: ["scope=home-lan"],
        allowedPurposes: ["ops.maintenance"],
        restrictions: ["tool:fs.read"],
        maxExecutions: 10,
        issuedAt: "2026-08-25T00:00:00.000Z",
        expiresAt: "2026-12-31T00:00:00.000Z",
        delegationDepth: 0,
        remainingDelegationDepth: 2
    });
}

const CHILD_BASE = {
    capabilityId: "team.ops.child",
    actions: ["use"],
    scope: ["scope=home-lan"],
    allowedPurposes: ["ops.maintenance"],
    maxExecutions: 5,
    expiresAt: "2026-11-30T00:00:00.000Z"
};

test("#9 child tidak bisa MENAMBAH action", () => {
    const r = acc.delegation.attenuateGrant(parentGrant(),
        { ...CHILD_BASE, actions: ["use","administer"] });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some(v =>
        v.field==="actions" && v.reasonCode==="CAP_ACTION_DENIED"));
});

test("#10 child tidak bisa MELEBARKAN scope", () => {
    const r = acc.delegation.attenuateGrant(parentGrant(),
        { ...CHILD_BASE, scope: ["scope=home-lan","scope=cloud"] });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some(v =>
        v.field==="scope" && v.reasonCode==="CAP_SCOPE_MISMATCH"));
});

test("#11 child tidak bisa MELEBARKAN purpose", () => {
    const r = acc.delegation.attenuateGrant(parentGrant(),
        { ...CHILD_BASE,
          allowedPurposes:["ops.maintenance","marketing.broadcast"] });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some(v =>
        v.field==="purpose" && v.reasonCode==="CAP_PURPOSE_MISMATCH"));
});

test("#12 child tidak bisa MEMPERPANJANG expiry", () => {
    const r = acc.delegation.attenuateGrant(parentGrant(),
        { ...CHILD_BASE, expiresAt: "2027-06-01T00:00:00.000Z" });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some(v => v.field === "expiry"));
});

test("#13 child tidak bisa MENAMBAH budget", () => {
    const r = acc.delegation.attenuateGrant(parentGrant(),
        { ...CHILD_BASE, maxExecutions: 999 });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some(v => v.field === "maxExecutions"));
});

test("#14 depth berkurang & nol ditolak", () => {
    const okR = acc.delegation.attenuateGrant(parentGrant(), CHILD_BASE);
    assert.equal(okR.grant.remainingDelegationDepth, 1);
    assert.equal(okR.grant.delegationDepth, 1);

    const exhaustedParent = { ...parentGrant(),
        remainingDelegationDepth: 0 };
    const denied = acc.delegation.attenuateGrant(exhaustedParent, CHILD_BASE);
    assert.equal(denied.ok, false);
    assert.ok(denied.violations.some(v =>
        v.field==="remainingDelegationDepth"));
});

test("#15 restriction lebih ketat BERHASIL; lebih longgar gagal", () => {
    const strict = acc.delegation.attenuateGrant(parentGrant(),
        { ...CHILD_BASE, restrictions: ["tool:fs.read","tool:net.get"] });
    assert.equal(strict.ok, true);
    assert.deepEqual([...strict.grant.restrictions.items].sort(),
        ["tool:fs.read","tool:net.get"]);

    const loose = acc.delegation.attenuateGrant(parentGrant(),
        { ...CHILD_BASE, restrictions: null });   // unrestricted = longgar
    assert.equal(loose.ok, false);
});
