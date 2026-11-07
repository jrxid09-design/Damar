const test = require("node:test");
const assert = require("node:assert");

const acc = require("./evolution-harness");

/**
 * RED-TEAM BLOCKER 2: registry.delegate positive path end-to-end.
 * RED-TEAM BLOCKER 3: delegasi tidak melebar scope/purpose/identity
 *                     (omitted = inherit parent).
 * RED-TEAM BLOCKER 9: expiry attenuation memakai waktu absolut.
 */

async function seedScopedParent(registry, {
    capabilityId = "team.ops",
    actions = ["use", "delegate"],
    scope = ["scope=home-lan"],
    allowedPurposes = ["ops.maintenance"],
    identityBinding = { channels: ["cli"] },
    restrictions = ["tool:fs.read"],
    maxExecutions = 10,
    expiresAt = "2030-12-31T00:00:00.000Z"
} = {}) {
    await registry.proposeEvolution({
        proposalId: "prop-" + capabilityId, createdBy: "owner",
        kind: "authority_expansion",
        problem: "p", proposedChange: "c",
        requestedAuthority: { capabilityId, subject: "damar-core",
            actions, scope, allowedPurposes, identityBinding,
            restrictions, maxExecutions, expiresAt,
            remainingDelegationDepth: 3 }
    }, "owner");
    await registry.ratify({ ratificationId: "rat-" + capabilityId,
        proposalId: "prop-" + capabilityId, ownerIdentity: "o",
        decision: "APPROVED" });
    const g = await registry.issueRatifiedRootGrant({
        proposalId: "prop-" + capabilityId,
        ratificationId: "rat-" + capabilityId });
    assert.equal(g.allowed, true);
    return g.grant;
}

/* ------------------------- BLOCKER 2 ---------------------------------- */

test("B2 POSITIVE e2e: root ACTIVE -> delegate narrower child -> " +
     "child persisted -> child authorize succeeds", async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedScopedParent(registry);

    // restrictions dikirim sebagai canonical object hasil internal —
    // jalur internal WAJIB rehydrate via restoreCanonicalRestrictionSet.
    const canonicalRestrictions =
        acc.canonicalRestrictionSet(["tool:fs.read", "tool:net.get"]);

    const d = await registry.delegate(parent.capabilityId, {
        capabilityId: "team.ops.child",
        subject: "damar-core",
        actions: ["use"],
        scope: ["scope=home-lan"],
        allowedPurposes: ["ops.maintenance"],
        identityBinding: { channels: ["cli"] },
        restrictions: canonicalRestrictions,
        maxExecutions: 2,
        expiresAt: "2030-06-30T00:00:00.000Z"
    }, "delegator");

    assert.equal(d.allowed, true,
        "delegate sukses wajib: " + JSON.stringify(d.reasonCode ?? ""));
    assert.equal(d.grant.kind, "delegated");
    assert.equal(d.grant.parentCapabilityId, "team.ops");
    assert.deepEqual([...d.grant.restrictions.items].sort(),
        ["tool:fs.read", "tool:net.get"]);

    // Child PERSISTED di store:
    const stored = await registry.store.getCapability("team.ops.child");
    assert.ok(stored, "child grant terpersist");
    assert.equal(stored.status, "ACTIVE");
    assert.equal(stored.payload.parentCapabilityId, "team.ops");

    // Child bisa authorize nyata:
    const auth = await registry.authorize({
        capabilityId: "team.ops.child", action: "use",
        scope: ["scope=home-lan"],
        purpose: "ops.maintenance",
        identity: { channel: "CLI" } });
    assert.equal(auth.allowed, true);

    // Dan budget child berfungsi (2 eksekusi lalu habis):
    assert.equal((await registry.consumeExecution("team.ops.child")).allowed,
        true);
    assert.equal((await registry.consumeExecution("team.ops.child")).allowed,
        true);
    const third = await registry.consumeExecution("team.ops.child");
    assert.equal(third.allowed, false);
});

test("B2/L-D1: plain object restriction dari caller EKSTERNAL tetap " +
     "fail-closed Decision (bukan throw)", async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedScopedParent(registry);

    let decision;
    try {
        decision = await registry.delegate(parent.capabilityId, {
            capabilityId: "team.ops.evil",
            subject: "damar-core",
            actions: ["use"],
            maxExecutions: 1,
            restrictions: { sneaky: "plain-object" }   // L-D1 violation
        });
    } catch (error) {
        decision = { allowed: false, reasonCode:
            error.reasonCode ?? "CAP_MALFORMED" };
    }

    assert.equal(decision.allowed, false);
    assert.match(decision.reasonCode ?? "", /CAP_MALFORMED|CAP_RESTRICTION/);
    assert.equal(await registry.store.getCapability("team.ops.evil"), null);
});

test("B2: malformed delegate input -> fail-closed Decision, bukan throw",
     async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedScopedParent(registry);

    for (const bad of [
        { capabilityId: "..bad..", actions: ["use"], maxExecutions: 1 },
        { capabilityId: "ok.child", actions: "use-not-array" },
        null, undefined
    ]) {
        const d = await registry.delegate(parent.capabilityId, bad);
        assert.equal(d.allowed, false);
        assert.ok(d.reasonCode, "decision punya reasonCode");
    }
    assert.equal(await registry.store.getCapability("ok.child"), null);
});

/* ------------------------- BLOCKER 3 ---------------------------------- */

test("B3: scoped parent + child TANPA scope -> child tetap scoped", async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedScopedParent(registry);

    const d = await registry.delegate(parent.capabilityId, {
        capabilityId: "team.ops.inherit",
        subject: "damar-core",
        actions: ["use"],
        maxExecutions: 1
        // scope / purposes / identity TIDAK disebutkan => inherit
    });
    assert.equal(d.allowed, true);
    assert.deepEqual([...d.grant.scope], ["scope=home-lan"]);
    assert.deepEqual([...d.grant.allowedPurposes], ["ops.maintenance"]);
    assert.deepEqual([...d.grant.identityBinding.channels], ["cli"]);

    // Token di luar scope parent DITOLAK pada child:
    const out = await registry.authorize({
        capabilityId: "team.ops.inherit", action: "use",
        scope: ["scope=cloud"] });
    assert.equal(out.allowed, false);
    assert.equal(out.reasonCode, "CAP_SCOPE_MISMATCH");

    const inScope = await registry.authorize({
        capabilityId: "team.ops.inherit", action: "use",
        scope: ["scope=home-lan"],
        purpose: "ops.maintenance",
        identity: { channel: "cli" } });
    assert.equal(inScope.allowed, true);
});

test("B3: purpose-restricted parent + omitted purpose -> tetap restricted",
     async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedScopedParent(registry, {
        capabilityId: "mail.send",
        actions: ["send"],
        scope: [],
        allowedPurposes: ["reply_to_user_request"] });

    const d = await registry.delegate(parent.capabilityId, {
        capabilityId: "mail.send.child",
        subject: "damar-core", actions: ["send"], maxExecutions: 1 });
    assert.equal(d.allowed, true);
    assert.deepEqual([...d.grant.allowedPurposes],
        ["reply_to_user_request"]);

    const wrongPurpose = await registry.authorize({
        capabilityId: "mail.send.child", action: "send",
        purpose: "marketing_broadcast" });
    assert.equal(wrongPurpose.reasonCode, "CAP_PURPOSE_MISMATCH");
});

test("B3: explicit wider scope DENY; explicit empty scope pada scoped " +
     "parent DENY ([] = unrestricted)", async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedScopedParent(registry);

    const wider = await registry.delegate(parent.capabilityId, {
        capabilityId: "team.ops.wider",
        subject: "damar-core", actions: ["use"], maxExecutions: 1,
        scope: ["scope=home-lan", "scope=cloud"] });
    assert.equal(wider.allowed, false);
    assert.equal(wider.reasonCode, "CAP_SCOPE_MISMATCH");

    const emptied = await registry.delegate(parent.capabilityId, {
        capabilityId: "team.ops.emptied",
        subject: "damar-core", actions: ["use"], maxExecutions: 1,
        scope: [] });
    assert.equal(emptied.allowed, false);
    assert.equal(emptied.reasonCode, "CAP_SCOPE_MISMATCH");
});

test("B3: wider purpose DENY; empty purposes pada restricted parent DENY",
     async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedScopedParent(registry);

    const widerP = await registry.delegate(parent.capabilityId, {
        capabilityId: "team.ops.pwider",
        subject: "damar-core", actions: ["use"], maxExecutions: 1,
        allowedPurposes: ["ops.maintenance", "marketing.broadcast"] });
    assert.equal(widerP.allowed, false);
    assert.equal(widerP.reasonCode, "CAP_PURPOSE_MISMATCH");

    const emptied = await registry.delegate(parent.capabilityId, {
        capabilityId: "team.ops.pempty",
        subject: "damar-core", actions: ["use"], maxExecutions: 1,
        allowedPurposes: [] });
    assert.equal(emptied.allowed, false);
});

test("B3: identity channel widening DENY (cli-only parent tidak bisa " +
     "diganti http/webhook); narrowed succeeds", async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedScopedParent(registry, {
        identityBinding: { channels: ["cli"] } });

    // Widening/replacement:
    for (const channels of [["http"], ["webhook"], ["cli", "http"]]) {
        const d = await registry.delegate(parent.capabilityId, {
            capabilityId: "team.ops.chan",
            subject: "damar-core", actions: ["use"], maxExecutions: 1,
            identityBinding: { channels } });
        assert.equal(d.allowed, false,
            "channel widening harus DENY: " + channels.join(","));
        assert.equal(d.reasonCode, "CAP_IDENTITY_MISMATCH");
    }

    // Narrowed: tanpa identityBinding sama sekali = inherit cli-only.
    const inherited = await registry.delegate(parent.capabilityId, {
        capabilityId: "team.ops.inh-id",
        subject: "damar-core", actions: ["use"], maxExecutions: 1 });
    assert.equal(inherited.allowed, true);
    const wrongChannel = await registry.authorize({
        capabilityId: "team.ops.inh-id", action: "use",
        scope: ["scope=home-lan"],
        purpose: "ops.maintenance",
        identity: { channel: "http" } });
    assert.equal(wrongChannel.reasonCode, "CAP_IDENTITY_MISMATCH");

    const rightChannel = await registry.authorize({
        capabilityId: "team.ops.inh-id", action: "use",
        scope: ["scope=home-lan"],
        purpose: "ops.maintenance",
        identity: { channel: "cli" } });
    assert.equal(rightChannel.allowed, true);

    // Parent multi-channel + child subset = sah:
    const multiParent = await seedScopedParent(registry, {
        capabilityId: "multi.ops",
        identityBinding: { channels: ["cli", "webhook"] } });
    const narrowed = await registry.delegate(multiParent.capabilityId, {
        capabilityId: "multi.ops.narrow",
        subject: "damar-core", actions: ["use"], maxExecutions: 1,
        identityBinding: { channels: ["webhook"] } });
    assert.equal(narrowed.allowed, true);
    assert.deepEqual([...narrowed.grant.identityBinding.channels],
        ["webhook"]);

    // Parent unbound + child menambah binding = pempersempit, sah:
    const unboundParent = await seedScopedParent(registry, {
        capabilityId: "free.ops", identityBinding: null });
    const boundChild = await registry.delegate(unboundParent.capabilityId, {
        capabilityId: "free.ops.bound",
        subject: "damar-core", actions: ["use"], maxExecutions: 1,
        identityBinding: { sessionIds: ["sess-1"] } });
    assert.equal(boundChild.allowed, true);
});

/* ------------------------- BLOCKER 9 ---------------------------------- */

test("B9: offset timestamps dibanding ABSOLUT — " +
     "'2026-06-01T00:00:00-11:00' > '2026-06-01T00:00:00Z' -> DENY",
     () => {
        const parent = acc.model.buildGrant({
            capabilityId: "abs.parent", kind: "root",
            subject: "s", issuer: "o", actions: ["use"],
            scope: [], allowedPurposes: [],
            restrictions: ["tool:x"], maxExecutions: 5,
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-06-01T00:00:00.000Z",
            remainingDelegationDepth: 2 });

        // Sama secara leksikografis ('-' < 'Z'), tapi 11 jam LEBIH LAMBAT:
        const offsetChild = acc.delegation.attenuateGrant(parent, {
            capabilityId: "abs.child",
            actions: ["use"], maxExecutions: 1,
            expiresAt: "2026-06-01T00:00:00-11:00" });
        assert.equal(offsetChild.ok, false,
            "child kedaluwarsa lebih lambat dalam waktu absolut wajib DENY");
        assert.ok(offsetChild.violations.some(
            v => v.field === "expiry"));

        // Child lebih awal secara absolut -> sah:
        const earlierChild = acc.delegation.attenuateGrant(parent, {
            capabilityId: "abs.child2",
            actions: ["use"], maxExecutions: 1,
            expiresAt: "2026-06-01T00:00:00+13:00" });
        assert.equal(earlierChild.ok, true);

        // Expiry tidak parseable -> fail closed:
        const garbage = acc.delegation.attenuateGrant(parent, {
            capabilityId: "abs.child3",
            actions: ["use"], maxExecutions: 1,
            expiresAt: "not-a-date" });
        assert.equal(garbage.ok, false);
        assert.ok(garbage.violations.some(v => v.reasonCode ===
            "CAP_MALFORMED"));
    });
