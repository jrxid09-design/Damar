const test = require("node:test");
const assert = require("node:assert");

const acc = require("./evolution-harness");

/**
 * RED-TEAM BLOCKER 1: ratifikasi harus mengikat EXACT authority.
 * RED-TEAM BLOCKER 5: terminal capability tidak boleh resurrect.
 *
 * Hukum:
 *   Proposal/request != authority. Cognition mengusulkan, owner
 *   meratifikasi. Grant lahir EKSKLUSIF dari ratification.approvedAuthority;
 *   requestedAuthority pada issuance hanyalah equality assertion.
 *   Satu APPROVED = paling banyak SATU root grant (one-shot).
 */

const BASE_AUTHORITY = Object.freeze({
    capabilityId: "infra.deploy",
    subject: "damar-core",
    actions: ["use", "patch.production"]
});

async function seedApproved(registry, {
    proposalId = "prop-bind", ratificationId = "rat-bind",
    requestedAuthority = BASE_AUTHORITY } = {}) {
    await registry.proposeEvolution({
        proposalId, createdBy: "acc",
        kind: "authority_expansion",
        problem: "butuh authority deployment untuk evolusi",
        proposedChange: "terbitkan ROOT grant baru via ratifikasi",
        requestedAuthority
    }, "acc");
    const rat = await registry.ratify({
        ratificationId, proposalId,
        ownerIdentity: "owner-human", decision: "APPROVED" });
    assert.equal(rat.applied, true);
    return { proposal: await registry.store.getProposal(proposalId),
             ratification: rat.ratification };
}

test("B1: ratifikasi mengikat proposalId + revisi + digest + " +
     "approvedAuthority canonical digest", async () => {
    const { registry } = acc.makeRegistry();
    const { ratification } =
        await seedApproved(registry);

    assert.equal(ratification.proposalId, "prop-bind");
    assert.equal(ratification.proposalRevision, 1);
    assert.ok(typeof ratification.proposalDigest === "string" &&
              ratification.proposalDigest.length === 64);
    assert.deepEqual(ratification.approvedAuthority, {
        capabilityId: "infra.deploy",
        subject: "damar-core",
        actions: ["use", "patch.production"] });

    const { sha256, canonicalJson } = acc;
    assert.equal(ratification.approvedAuthorityDigest,
        sha256(canonicalJson(ratification.approvedAuthority)));
});

test("B1: issuance read-only membangun grant PERSIS dari " +
     "approvedAuthority (godmode DENY)", async () => {
    const { registry } = acc.makeRegistry();
    await seedApproved(registry);

    // Cognition mencoba menyelundupkan godmode saat issuance:
    const godmode = await registry.issueRatifiedRootGrant({
        proposalId: "prop-bind", ratificationId: "rat-bind",
        requestedAuthority: {
            capabilityId: "infra.deploy",
            subject: "damar-core",
            actions: ["use", "patch.production", "administer"],
            maxExecutions: null
        } });

    assert.equal(godmode.allowed, false);
    assert.equal(godmode.reasonCode, "CAP_MALFORMED");

    // Tidak ada grant yang lahir dari percobaan ilegal:
    assert.equal(await registry.store.getCapability("infra.deploy"), null);
});

test("B1: altered actions/scope/budget/depth pada requestedAuthority DENY",
     async () => {
    for (const [label, tweak] of Object.entries({
        actions: a => ({ ...a, actions: ["use"] }),
        scope: a => ({ ...a, scope: ["scope=prod"] }),
        budget: a => ({ ...a, maxExecutions: 5 }),
        depth: a => ({ ...a, remainingDelegationDepth: 9 }),
        subject: a => ({ ...a, subject: "other-subject" })
    })) {
        const { registry } = acc.makeRegistry();
        await seedApproved(registry);
        void label;

        // approvedAuthority punya actions penuh & tanpa field tambahan;
        // assertion kesetaraan wajib gagal untuk perubahan apa pun.
        const d = await registry.issueRatifiedRootGrant({
            proposalId: "prop-bind", ratificationId: "rat-bind",
            requestedAuthority: tweak(BASE_AUTHORITY) });
        assert.equal(d.allowed, false);
        assert.equal(d.reasonCode, "CAP_MALFORMED");
        assert.equal(await registry.store.getCapability("infra.deploy"),
            null);
    }
});

test("B1: exact ratified authority berhasil — tepat SATU kali; " +
     "replay DENY dengan reason eksplisit", async () => {
    const { registry } = acc.makeRegistry();
    await seedApproved(registry);

    const first = await registry.issueRatifiedRootGrant({
        proposalId: "prop-bind", ratificationId: "rat-bind",
        requestedAuthority: {
            capabilityId: "infra.deploy",
            subject: "damar-core",
            actions: ["use", "patch.production"]
        } });
    assert.equal(first.allowed, true);
    assert.deepEqual([...first.grant.actions].sort(),
        ["patch.production", "use"]);
    assert.equal(first.grant.ratificationId, "rat-bind");

    // REPLAY ratifikasi yang sama:
    const replay = await registry.issueRatifiedRootGrant({
        proposalId: "prop-bind", ratificationId: "rat-bind" });
    assert.equal(replay.allowed, false);
    assert.equal(replay.reasonCode, "CAP_RATIFICATION_CONSUMED");

    const rat = await registry.store.getRatification("rat-bind");
    assert.ok(rat.consumedAt, "ratifikasi tercatat consumed");
    assert.equal(rat.consumedByCapabilityId, "infra.deploy");

    // Hanya SATU event CAPABILITY_GRANTED:
    const events = await registry.store.listEvents("infra.deploy");
    assert.equal(
        events.filter(e => e.type === "CAPABILITY_GRANTED").length, 1);
});

test("B1: revisi proposal setelah ratifikasi -> stale (tidak usable)",
     async () => {
    const { registry } = acc.makeRegistry();
    await seedApproved(registry);

    await registry.reviseEvolution("prop-bind",
        { proposedChange: "ubah material setelah ratifikasi" }, "acc");

    const d = await registry.issueRatifiedRootGrant({
        proposalId: "prop-bind", ratificationId: "rat-bind" });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_RATIFICATION_REQUIRED");

    // Ratifikasi BARU untuk revisi baru sah kembali:
    await registry.ratify({ ratificationId: "rat-bind-v2",
        proposalId: "prop-bind", ownerIdentity: "o",
        decision: "APPROVED" });
    const ok = await registry.issueRatifiedRootGrant({
        proposalId: "prop-bind", ratificationId: "rat-bind-v2" });
    assert.equal(ok.allowed, true);
});

test("B1: tamper approvedAuthority di store -> digest mismatch DENY",
     async () => {
    const { registry } = acc.makeRegistry();
    await seedApproved(registry);

    const rat = JSON.parse(JSON.stringify(
        await registry.store.getRatification("rat-bind")));
    rat.approvedAuthority.actions.push("administer");
    await registry.store.upsertRatification(rat);

    const d = await registry.issueRatifiedRootGrant({
        proposalId: "prop-bind", ratificationId: "rat-bind" });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_MALFORMED");
});

test("B5: REVOKED capability_id tidak bisa dihidupkan ulang via reissue; " +
     "wajib capabilityId + ratifikasi baru", async () => {
    const { registry } = acc.makeRegistry();
    await seedApproved(registry);
    const issued = await registry.issueRatifiedRootGrant({
        proposalId: "prop-bind", ratificationId: "rat-bind" });
    assert.equal(issued.allowed, true);

    await registry.revoke("infra.deploy");

    // Reissue id SAMA bahkan dengan ratifikasi owner yang BENAR-BENAR BARU:
    await registry.proposeEvolution({
        proposalId: "prop-reissue", createdBy: "owner",
        kind: "authority_expansion",
        problem: "p", proposedChange: "c",
        requestedAuthority: {
            capabilityId: "infra.deploy", subject: "damar-core",
            actions: ["use"] }
    }, "owner");
    await registry.ratify({ ratificationId: "rat-reissue",
        proposalId: "prop-reissue", ownerIdentity: "o",
        decision: "APPROVED" });

    const reissue = await registry.issueRatifiedRootGrant({
        proposalId: "prop-reissue", ratificationId: "rat-reissue" });
    assert.equal(reissue.allowed, false);
    assert.equal(reissue.reasonCode, "CAP_REVOKED");

    const d = await registry.authorize({
        capabilityId: "infra.deploy", action: "use" });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_REVOKED");
});

test("B5: EXHAUSTED capability_id tidak bisa di-upsert ACTIVE lagi",
     async () => {
    const { registry } = acc.makeRegistry();
    await registry.proposeEvolution({
        proposalId: "prop-exh", createdBy: "owner",
        kind: "authority_expansion",
        problem: "p", proposedChange: "c",
        requestedAuthority: { capabilityId: "tool.heavy",
            subject: "damar-core", actions: ["use"], maxExecutions: 1 }
    }, "owner");
    await registry.ratify({ ratificationId: "r-exh",
        proposalId: "prop-exh", ownerIdentity: "o",
        decision: "APPROVED" });
    const g = await registry.issueRatifiedRootGrant({
        proposalId: "prop-exh", ratificationId: "r-exh" });
    assert.equal(g.allowed, true);
    assert.equal((await registry.consumeExecution("tool.heavy")).allowed,
        true);

    await registry.proposeEvolution({
        proposalId: "prop-exh2", createdBy: "owner",
        kind: "authority_expansion",
        problem: "p", proposedChange: "c",
        requestedAuthority: { capabilityId: "tool.heavy",
            subject: "damar-core", actions: ["use"] }
    }, "owner");
    await registry.ratify({ ratificationId: "r-exh2",
        proposalId: "prop-exh2", ownerIdentity: "o",
        decision: "APPROVED" });

    const reissue = await registry.issueRatifiedRootGrant({
        proposalId: "prop-exh2", ratificationId: "r-exh2" });
    assert.equal(reissue.allowed, false);
    assert.equal(reissue.reasonCode, "CAP_EXHAUSTED");
});
