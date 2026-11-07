const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Â§N/Â§O â€” ACC INTEGRATION + DamarSelf evolution loop.
 * ACC/model BOLEH mengusulkan; hasil usulan TIDAK memberi otoritas.
 * Owner ratification mengubah request menjadi authority sah.
 */

const acc = require("./evolution-harness");
const { createDamarSelfService } =
    require("../../src/services/damarSelfService");

async function accInitiatedExpansion(registry) {
    // Simulasi keluaran ACC (MODEL_HYPOTHESIS) â†’ EvolutionIntent:
    const intent = {
        proposalId: "prop-acc-evolve",
        createdBy: "acc",
        kind: "authority_expansion",
        problem: "Damar butuh kemampuan deploy untuk evolusi material",
        hypothesis: "dengan akses deploy, perbaikan mandiri bisa tervalidasi",
        proposedChange: "minta ROOT grant infra.deploy",
        requiredCapabilities: ["self.patch.production"],
        requestedAuthority: {
            capabilityId: "infra.deploy",
            subject: "damar-core",
            actions: ["use","patch.production"]
        },
        evidenceRefs: ["experience-1","prediction-2"]
    };
    const proposal = await registry.proposeEvolution(intent, "acc");
    return { intent, proposal };
}

test("#7/#8 REQUEST dan PROPOSAL bukan otoritas", async () => {
    const { registry } = await acc.makeRegistry();
    const { proposal } = await accInitiatedExpansion(registry);

    // 1) Proposal DRAFT tidak muncul sebagai capability:
    assert.equal(await registry.store.getCapability(proposal.proposalId), null);

    // 2) authorize memakai id proposal -> CAP_NOT_FOUND:
    const d = await registry.authorize({
        capabilityId: proposal.proposalId, action: "use" });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_NOT_FOUND");
});

test("#34 ACC proposal tanpa ratifikasi -> tidak ada grant", async () => {
    const { registry } = await acc.makeRegistry();
    const { proposal } = await accInitiatedExpansion(registry);

    const attempt = await registry.issueRatifiedRootGrant({
        proposalId: proposal.proposalId, ratificationId: "tidak-ada" });

    assert.equal(attempt.allowed, false);
    assert.equal(attempt.reasonCode, "CAP_RATIFICATION_REQUIRED");
    assert.equal(await registry.store.getCapability("infra.deploy"), null);
});

test("#35 owner-ratified escalation -> root grant sah & bisa dipakai", async () => {
    const { registry } = await acc.makeRegistry();
    await accInitiatedExpansion(registry);

    const rat = await registry.ratify({
        ratificationId: "rat-owner-1",
        proposalId: "prop-acc-evolve",
        ownerIdentity: "owner-human",
        decision: "APPROVED"
    });
    assert.equal(rat.applied, true);

    const issued = await registry.issueRatifiedRootGrant({
        proposalId: "prop-acc-evolve",
        ratificationId: "rat-owner-1"
    });
    assert.equal(issued.allowed, true);
    assert.equal(issued.grant.kind, "root");
    assert.deepEqual([...issued.grant.actions].sort(),
        ["patch.production","use"]);

    const d = await registry.authorize({
        capabilityId: "infra.deploy", action: "patch.production" });
    assert.equal(d.allowed, true);
});

test("Â§O: EvolutionProposal terdokumentasi ke DamarSelf/proposals", () => {

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aself-doc-"));
    const svc = createDamarSelfService({ canonicalDir: dir });
    svc.ensureStructure();

    const proposal = {
        proposalId: "prop-doc-1",
        createdBy: "acc",
        kind: "architectural_change",
        revision: 1,
        digest: "deadbeef",
        status: "DRAFT",
        problem: "p", proposedChange: "c",
        risk: "r", rollbackPlan: "rb",
        requiredCapabilities: ["self.research"]
    };

    const file = svc.writeEvolutionProposalDoc(proposal);
    assert.ok(fs.existsSync(file));
    assert.match(fs.readFileSync(file, "utf8"),
        /EvolutionProposal prop-doc-1/);

    fs.rmSync(dir, { recursive: true, force: true });
});

