const test = require("node:test");
const assert = require("node:assert");
const acc = require("./evolution-harness");

/**
 * OWNER RATIFICATION (§E/§T3): satu-satunya jalur authority > previous.
 * Termasuk: digest binding (mutasi proposal = stale), ACC-origin flow.
 */

async function expansionFlow(registry, {
    capabilityId = "infra.deploy", subject = "damar-core",
    actions = ["use","patch.production"], maxExecutions = null,
    proposalId = "prop-expand"
} = {}) {
    const requested = { capabilityId, subject, actions, maxExecutions };

    await registry.proposeEvolution({
        proposalId,
        createdBy: "acc",
        kind: "authority_expansion",
        problem: "butuh authority deployment untuk evolusi",
        proposedChange: "terbitkan ROOT grant baru via ratifikasi",
        requestedAuthority: requested
    }, "acc");

    return { requested, proposalId };
}

test("#17 request TANPA ratifikasi tidak menghasilkan grant", async () => {
    const { registry } = acc.makeRegistry();
    const { proposalId } = await expansionFlow(registry);

    const attempt = await registry.issueRatifiedRootGrant({
        proposalId, ratificationId: "rat-tidak-ada"
    });

    assert.equal(attempt.allowed, false);
    assert.equal(attempt.reasonCode, "CAP_RATIFICATION_REQUIRED");

    // Dan memang tidak ada grant yang lahir:
    assert.equal(await registry.store.getCapability("infra.deploy"), null);
});

test("#16/#35 ratifikasi APPROVED menciptakan ROOT GRANT baru yang LEBIH LUAS", async () => {

    // Parent terbatas dulu:
    const { registry } = acc.makeRegistry();
    await expansionFlow(registry);

    await registry.ratify({
        ratificationId: "rat-1",
        proposalId: "prop-expand",
        ownerIdentity: "operator",
        decision: "APPROVED"
    });

    const issued = await registry.issueRatifiedRootGrant({
        proposalId: "prop-expand",
        ratificationId: "rat-1"
    });

    assert.equal(issued.allowed, true);
    assert.equal(issued.grant.kind, "root");
    assert.deepEqual([...issued.grant.actions].sort(),
        ["patch.production","use"]);
    assert.equal(issued.grant.maxExecutions, null,
        "root boleh unlimited — ini authority BARU dari owner");
    assert.equal(issued.grant.ratificationId, "rat-1");

    // Authorize nyata dengan action yang sebelumnya di luar jangkauan:
    const use = await registry.authorize({
        capabilityId: "infra.deploy", action: "patch.production" });
    assert.equal(use.allowed, true);
});

test("#18 mutasi proposal setelah ratifikasi -> ratifikasi STALE", async () => {

    const { registry } = acc.makeRegistry();
    const { proposalId } = await expansionFlow(registry);

    await registry.ratify({ ratificationId: "r-ok",
        proposalId, ownerIdentity: "operator", decision: "APPROVED" });

    // Mutasi MATERIAL (revisi):
    await registry.reviseEvolution(proposalId,
        { proposedChange: "terbitkan root grant + aksi tambahan" },
        "acc");

    const issued = await registry.issueRatifiedRootGrant({
        proposalId, ratificationId: "r-ok"
    });

    assert.equal(issued.allowed, false);
    assert.match(issued.detail || "", /stale|berubah/i);
});

test("#34 proposal/proposal-objek ACC BUKAN otoritas (tanpa ratifikasi)", async () => {
    const { registry } = acc.makeRegistry();

    const proposal = await registry.proposeEvolution({
        proposalId: "prop-acc-only",
        createdBy: "acc",
        problem: "x", proposedChange: "y"
    }, "acc");

    assert.equal(proposal.status, "DRAFT");

    // Mencoba authorize MEMAKAI id proposal sebagai capability:
    const d = await registry.authorize({
        capabilityId: proposal.proposalId, action: "use" });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_NOT_FOUND");

    // Dan tanpa ratifikasi, expansion flow juga menolak:
    const attempt = await registry.issueRatifiedRootGrant({
        proposalId: proposal.proposalId,
        ratificationId: "nope"
    });
    assert.equal(attempt.allowed, false);
});
