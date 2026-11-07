const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const acc = require("./evolution-harness");

/**
 * RED-TEAM BLOCKER 4: delegated budget tidak boleh terlipatgandakan
 * via sibling. Model yang dipilih: RESERVATION — setiap delegasi
 * mereservasi kapasitas ATOMIK dari sisa budget delegable parent.
 * Total budget anak-anak <= maxExecutions parent; restart-safe.
 */

async function seedParent(registry, { capabilityId = "team.ops",
                                      maxExecutions = 2 } = {}) {
    await registry.proposeEvolution({
        proposalId: "prop-" + capabilityId, createdBy: "owner",
        kind: "authority_expansion",
        problem: "p", proposedChange: "c",
        requestedAuthority: {
            capabilityId, subject: "damar-core",
            actions: ["use", "delegate"], scope: ["scope=home-lan"],
            allowedPurposes: ["ops.maintenance"],
            restrictions: ["tool:fs.read"], maxExecutions,
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

function childRequest(capabilityId, actions, maxExecutions) {
    return {
        capabilityId,
        subject: "damar-core",
        actions: actions ?? ["use"],
        scope: ["scope=home-lan"],
        allowedPurposes: ["ops.maintenance"],
        restrictions: ["tool:fs.read"],
        maxExecutions
    };
}

test("B4 memory: parent budget 2 tidak bisa menghasilkan total anak 6",
     async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedParent(registry, { maxExecutions: 2 });

    // Skenario amplifikasi lama: 3 anak x budget 2 => total 6.
    const a = await registry.delegate(parent.capabilityId,
        childRequest("team.a", undefined, 2));
    assert.equal(a.allowed, true);

    const b = await registry.delegate(parent.capabilityId,
        childRequest("team.b", undefined, 2));
    assert.equal(b.allowed, false);
    assert.equal(b.reasonCode, "CAP_DELEGATION_BUDGET_EXHAUSTED");
    assert.equal(await registry.store.getCapability("team.b"), null);

    // Bahkan 1 pun tidak muat lagi:
    const c = await registry.delegate(parent.capabilityId,
        childRequest("team.c", undefined, 1));
    assert.equal(c.allowed, false);
    assert.equal(c.reasonCode, "CAP_DELEGATION_BUDGET_EXHAUSTED");

    // Total delegated == 2 == parent budget:
    const reservations = await registry.store
        .getDelegationReservations("team.ops");
    const total = reservations.reduce((s, r) => s + r.amount, 0);
    assert.equal(total, 2);
});

test("B4 memory: dua anak 1+1 muat; ketiga ditolak", async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedParent(registry, { maxExecutions: 2 });

    assert.equal((await registry.delegate(parent.capabilityId,
        childRequest("team.x", undefined, 1))).allowed, true);
    assert.equal((await registry.delegate(parent.capabilityId,
        childRequest("team.y", undefined, 1))).allowed, true);
    const z = await registry.delegate(parent.capabilityId,
        childRequest("team.z", undefined, 1));
    assert.equal(z.allowed, false);
    assert.equal(z.reasonCode, "CAP_DELEGATION_BUDGET_EXHAUSTED");
});

test("B4 memory: rantai nested ikut di-reserve per level (grandchild " +
     "tidak bisa melebihi child budget)", async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedParent(registry, { maxExecutions: 2 });

    const child = await registry.delegate(parent.capabilityId,
        childRequest("lvl1", ["use", "delegate"], 1));
    assert.equal(child.allowed, true);

    const grandTooBig = await registry.delegate(child.grant.capabilityId,
        childRequest("lvl2-big", ["use"], 2));
    assert.equal(grandTooBig.allowed, false);

    const grand = await registry.delegate(child.grant.capabilityId,
        childRequest("lvl2", ["use"], 1));
    assert.equal(grand.allowed, true);

    // lvl2 budget-1 sudah penuh ter-reserve ke lvl2:
    const greatGrand = await registry.delegate(grand.grant.capabilityId,
        childRequest("lvl3", ["use"], 1));
    assert.equal(greatGrand.allowed, true);

    // Sibling berikutnya tidak mendapat kapasitas baru dari lvl1:
    const sibling = await registry.delegate(grand.grant.capabilityId,
        childRequest("lvl3-sibling", ["use"], 1));
    assert.equal(sibling.allowed, false);
    assert.equal(sibling.reasonCode, "CAP_DELEGATION_BUDGET_EXHAUSTED");
});

test("B4 memory: delegasi konkuren (Promise.all) tidak over-allocate",
     async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedParent(registry, { maxExecutions: 2 });

    const results = await Promise.all([
        registry.delegate(parent.capabilityId,
            childRequest("race.a", undefined, 1)),
        registry.delegate(parent.capabilityId,
            childRequest("race.b", undefined, 1)),
        registry.delegate(parent.capabilityId,
            childRequest("race.c", undefined, 1))
    ]);

    const allowedCount =
        results.filter(r => r.allowed === true).length;
    assert.equal(allowedCount, 2,
        "hanya dua delegasi budget-1 yang muat di parent budget-2");

    const reservations = await registry.store
        .getDelegationReservations("team.ops");
    assert.equal(reservations.length, allowedCount);
});

test("B4 sqlite: semantik identik dengan memory + restart-safe",
     async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-budget-"));
    const dbFile = path.join(dir, "authority.db");

    const Database = require("../../src/memory/db/Database");
    const migrate = require("../../src/memory/db/migrate");

    async function open() {
        const database = new Database(dbFile);
        await database.open();
        await migrate(database, {});
        return { database,
                 store: acc.createSqliteAuthorityStore(database) };
    }

    const first = await open();
    const reg1 = new acc.AuthorityRegistry({ store: first.store,
        clock: acc.manualClock(acc.T0) });
    const parent = await seedParent(reg1, { maxExecutions: 2 });

    assert.equal((await reg1.delegate(parent.capabilityId,
        childRequest("sq.a", undefined, 1))).allowed, true);
    const b = await reg1.delegate(parent.capabilityId,
        childRequest("sq.b", undefined, 2));
    assert.equal(b.allowed, false);
    assert.equal(b.reasonCode, "CAP_DELEGATION_BUDGET_EXHAUSTED");

    // RESTART: koneksi baru ke file yang sama — reservasi bertahan.
    await first.database.close?.();
    const second = await open();
    const reg2 = new acc.AuthorityRegistry({ store: second.store,
        clock: acc.manualClock(acc.T0 + 1000) });

    const c = await reg2.delegate(parent.capabilityId,
        childRequest("sq.c", undefined, 1));
    assert.equal(c.allowed, true,
        "slot terakhir masih ada setelah restart");

    const d = await reg2.delegate(parent.capabilityId,
        childRequest("sq.d", undefined, 1));
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_DELEGATION_BUDGET_EXHAUSTED",
        "setelah restart kuota tetap tidak bisa dilewati");

    // Child yang sah tetap berfungsi penuh setelah restart:
    const auth = await reg2.authorize({
        capabilityId: "sq.c", action: "use",
        scope: ["scope=home-lan"],
        purpose: "ops.maintenance" });
    assert.equal(auth.allowed, true);

    await second.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("B4: root unlimited (maxExecutions null) tetap dapat mendelegasikan " +
     "budget finite ke beberapa anak (semantik terdokumentasi)", async () => {
    const { registry } = acc.makeRegistry();
    const parent = await seedParent(registry, { capabilityId: "unl.ops",
                                                maxExecutions: null });
    void parent;

    assert.equal((await registry.delegate("unl.ops",
        childRequest("unl.a", undefined, 5))).allowed, true);
    assert.equal((await registry.delegate("unl.ops",
        childRequest("unl.b", undefined, 7))).allowed, true);
});
