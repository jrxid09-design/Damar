const test = require("node:test");
const assert = require("node:assert");
const acc = require("./evolution-harness");

/** Lifecycle Â§F/Â§G + restart persistence (Â§30). */

async function seeded() {
    const { registry, store, clock } = acc.makeRegistry();
    const g1 = await registry.issueRatifiedRootGrant({
        proposalId: "p-lc",
        ratificationId: "r-lc",
        actor: "test"
    }).catch(e => ({ allowed:false, error:e }));
    void g1;
    return { registry, store, clock };
}

// Seed helper: proposal + ratifikasi APPROVED lalu root grant.
async function seedGrant(registry, {
    capabilityId="cap.use", subject="damar-core",
    actions=["use"], maxExecutions=3,
    expiresAt="2030-01-01T00:00:00.000Z", extraProposal={}
} = {}) {

    const requested = { capabilityId, subject, actions,
        maxExecutions, expiresAt, ...extraProposal };

    await registry.proposeEvolution({
        proposalId: "prop-" + capabilityId,
        createdBy: "owner",
        kind: "authority_expansion",
        problem: "butuh kapabilitas",
        proposedChange: "terbitkan root grant",
        requestedAuthority: requested
    }, "owner");

    const rat = await registry.ratify({
        ratificationId: "rat-" + capabilityId,
        proposalId: "prop-" + capabilityId,
        ownerIdentity: "operator",
        decision: "APPROVED"
    });
    assert.equal(rat.applied, true);

    const issued = await registry.issueRatifiedRootGrant({
        proposalId: "prop-" + capabilityId,
        ratificationId: "rat-" + capabilityId
    });
    assert.equal(issued.allowed, true,
        "seed root grant wajib sukses: " +
        JSON.stringify(issued.reasonCode ?? ""));

    return issued.grant;
}

test("#19 SUSPENDED tidak bisa authorize; RESUME hidup lagi", async () => {
    const { registry } = acc.makeRegistry();
    const grant = await seedGrant(registry);

    let d = await registry.authorize({ capabilityId: grant.capabilityId,
        action: "use" });
    assert.equal(d.allowed, true);
    void d;

    await registry.suspend(grant.capabilityId);
    d = await registry.authorize({ capabilityId: grant.capabilityId,
        action: "use" });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_INACTIVE");

    await registry.resume(grant.capabilityId);
    d = await registry.authorize({ capabilityId: grant.capabilityId,
        action: "use" });
    assert.equal(d.allowed, true);
});

test("#20 REVOKED tidak bisa authorize & tidak bisa di-resurrect (Â§F)", async () => {
    const { registry } = acc.makeRegistry();
    const grant = await seedGrant(registry);

    await registry.revoke(grant.capabilityId);
    const d = await registry.authorize({ capabilityId: grant.capabilityId,
        action: "use" });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_REVOKED");

    // Terminal -> ACTIVE dilarang:
    const back = await registry.resume(grant.capabilityId);
    assert.equal(back.ok, false);
    const again = await registry.authorize(
        { capabilityId: grant.capabilityId, action: "use" });
    assert.equal(again.allowed, false);
});

test("#21 EXPIRED ditolak lazily saat authorize (Â§104-style)", async () => {
    const { registry, clock } = acc.makeRegistry();
    const grant = await seedGrant(registry,
        { expiresAt: new Date(clock.value + 1000).toISOString() });

    clock.advance(2000);

    const d = await registry.authorize({ capabilityId: grant.capabilityId,
        action: "use" });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_EXPIRED");
});

test("#22 EXHAUSTED setelah budget habis; authorize ikut menolak", async () => {
    const { registry } = acc.makeRegistry();
    const grant = await seedGrant(registry, { maxExecutions: 2 });

    for (let i = 0; i < 2; i++) {
        const c = await registry.consumeExecution(grant.capabilityId);
        assert.equal(c.allowed, true);
    }

    const third = await registry.consumeExecution(grant.capabilityId);
    assert.equal(third.allowed, false);
    assert.equal(third.reasonCode, "CAP_EXHAUSTED");

    const auth = await registry.authorize(
        { capabilityId: grant.capabilityId, action: "use" });
    assert.equal(auth.allowed, false);
    assert.equal(auth.reasonCode, "CAP_BUDGET_EXHAUSTED");
});

test("#23 terminal TIDAK boleh resurrect dalam bentuk apa pun", async () => {
    const { registry } = acc.makeRegistry();
    const grant = await seedGrant(registry, { maxExecutions: 1 });

    await registry.consumeExecution(grant.capabilityId);   // EXHAUSTED

    const res = await registry.resume(grant.capabilityId);
    assert.equal(res.ok, false);
    const susp = await registry.suspend(grant.capabilityId);
    assert.equal(susp.ok, false);

    // Re-issue dengan capability id SAMA juga ditolak bila mencoba
    // lewat jalur delegasi dari parent EXHAUSTED:
    const del = await registry.delegate(grant.capabilityId,
        { capabilityId: "cap.use.child", subject: "damar-core",
          actions: ["use"] });
    assert.equal(del.allowed, false);
});


test("#36 parent SUSPENDED -> delegate DENY CAP_INACTIVE", async () => {
    const { registry } = acc.makeRegistry();
    const grant = await seedGrant(registry);

    await registry.suspend(grant.capabilityId);

    const d = await registry.delegate(grant.capabilityId, {
        capabilityId: "cap.child.suspended",
        subject: "damar-core",
        actions: ["use"],
        maxExecutions: 1
    });

    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_INACTIVE");
});

test("#37 parent REVOKED -> delegate DENY CAP_REVOKED", async () => {
    const { registry } = acc.makeRegistry();
    const grant = await seedGrant(registry);

    await registry.revoke(grant.capabilityId);

    const d = await registry.delegate(grant.capabilityId, {
        capabilityId: "cap.child.revoked",
        subject: "damar-core",
        actions: ["use"],
        maxExecutions: 1
    });

    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_REVOKED");
});

test("#38 generation stale parent -> delegate DENY CAP_GENERATION_STALE", async () => {
    const { registry } = acc.makeRegistry();
    const grant = await seedGrant(registry);

    await registry.revokeSubjectGeneration("damar-core");

    const d = await registry.delegate(grant.capabilityId, {
        capabilityId: "cap.child.stale",
        subject: "damar-core",
        actions: ["use"],
        maxExecutions: 1
    });

    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_GENERATION_STALE");
});

test("#39 expired parent -> delegate DENY CAP_EXPIRED", async () => {
    const { registry, clock } = acc.makeRegistry();

    const grant = await seedGrant(registry, {
        expiresAt: new Date(clock.value + 1000).toISOString()
    });

    clock.advance(2000);

    const d = await registry.delegate(grant.capabilityId, {
        capabilityId: "cap.child.expired",
        subject: "damar-core",
        actions: ["use"],
        maxExecutions: 1
    });

    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_EXPIRED");
});

test("#40 malformed persisted parent -> delegate fail-closed CAP_MALFORMED", async () => {
    const { registry, store } = acc.makeRegistry();

    await store.upsertCapability(
        "cap.bad.parent",
        "ACTIVE",
        0,
        {
            capabilityId: "cap.bad.parent",
            kind: "root",
            subject: "damar-core",
            issuer: "test",
            actions: [],
            scope: [],
            allowedPurposes: [],
            restrictions: { kind: "unrestricted", items: [] },
            maxExecutions: 3,
            expiresAt: null,
            generation: 0
        }
    );

    const d = await registry.delegate("cap.bad.parent", {
        capabilityId: "cap.child.bad",
        subject: "damar-core",
        actions: ["use"],
        maxExecutions: 1
    });

    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_MALFORMED");
});
