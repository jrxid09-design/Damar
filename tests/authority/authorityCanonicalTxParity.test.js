const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const acc = require("./evolution-harness");

/**
 * RED-TEAM BLOCKER 6: CapabilityId dikanonikalisasi di SETIAP entry
 *                     point publik registry.
 * RED-TEAM BLOCKER 7: grant + ratification + event persistence ATOMIK;
 *                     injected event-write failure -> rollback penuh.
 * RED-TEAM BLOCKER 8: konsumsi eksekusi revalidasi DI DALAM operasi
 *                     atomik (anti-TOCTOU) — parity memory vs sqlite.
 */

async function seedGrant(registry, {
    capabilityId = "email.send", maxExecutions = 5,
    actions = ["use"] } = {}) {
    await registry.proposeEvolution({
        proposalId: "prop-" + capabilityId, createdBy: "owner",
        kind: "authority_expansion",
        problem: "p", proposedChange: "c",
        requestedAuthority: { capabilityId, subject: "damar-core",
                              actions, maxExecutions }
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

async function openSqlite() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-can-tx-"));
    const Database = require("../../src/memory/db/Database");
    const migrate = require("../../src/memory/db/migrate");
    const database = new Database(path.join(dir, "authority.db"));
    await database.open();
    await migrate(database, {});
    return { dir, database,
             store: acc.createSqliteAuthorityStore(database) };
}

/* ------------------------- BLOCKER 6 ---------------------------------- */

test("B6: revoke via varian format; authorize varian lain -> CAP_REVOKED",
     async () => {
    const { registry } = acc.makeRegistry();
    await seedGrant(registry, { capabilityId: "email.send" });

    // Revoke memakai varian 'Email__Send':
    const rv = await registry.revoke("Email__Send");
    assert.equal(rv.ok, true);

    // Authorize memakai varian 'email::send' -> objek otoritas yang SAMA:
    const d = await registry.authorize({
        capabilityId: "email::send", action: "use" });
    assert.equal(d.allowed, false);
    assert.equal(d.reasonCode, "CAP_REVOKED");

    // loadGrant juga mengenali varian:
    const lg = await registry.loadGrant("EMAIL__SEND");
    assert.equal(lg.ok, false);
    assert.equal(lg.reasonCode, "CAP_REVOKED");
});

test("B6: consumeExecution varian format mendebit kapabilitas yang sama",
     async () => {
    const { registry } = acc.makeRegistry();
    await seedGrant(registry, { capabilityId: "mail.read",
                                maxExecutions: 1 });

    const c = await registry.consumeExecution("mail::read");
    assert.equal(c.allowed, true);
    assert.equal(await registry.store.countConsumption("mail.read"), 1,
        "debit masuk ke bentuk kanonik 'mail.read'");

    const again = await registry.consumeExecution("MAIL.READ");
    assert.equal(again.allowed, false);
    assert.equal(again.reasonCode, "CAP_EXHAUSTED");
    assert.equal(await registry.store.countConsumption("mail.read"), 1);
});

test("B6: transition/suspend/resume/revoke/delegate menerima varian " +
     "dan MENOLAK id malformed (CAP_MALFORMED fail-closed)",
     async () => {
    const { registry } = acc.makeRegistry();
    const grant = await seedGrant(registry, { capabilityId: "var.cap" });

    // suspend via varian, resume via varian lain:
    assert.equal((await registry.suspend("VAR__CAP")).ok, true);
    assert.equal((await registry.authorize(
        { capabilityId: "var.cap", action: "use" })).reasonCode,
        "CAP_INACTIVE");
    assert.equal((await registry.resume("var.cap")).ok, true);

    // delegate dari parent varian format:
    const del = await registry.delegate("VAR::CAP", {
        capabilityId: "var.child", subject: "damar-core",
        actions: ["use"], scope: [], allowedPurposes: [],
        maxExecutions: 1 });
    assert.equal(del.allowed, true,
        "delegate parent via varian format tetap sah");

    // Malformed di SEMUA entry point:
    for (const bad of ["..bad..", ".dot.", "has space"]) {
        assert.equal((await registry.transition(bad, "SUSPENDED",
            "X")).reasonCode, "CAP_MALFORMED");
        assert.equal((await registry.suspend(bad)).reasonCode,
            "CAP_MALFORMED");
        assert.equal((await registry.resume(bad)).reasonCode,
            "CAP_MALFORMED");
        assert.equal((await registry.revoke(bad)).reasonCode,
            "CAP_MALFORMED");
        assert.equal((await registry.consumeExecution(bad)).reasonCode,
            "CAP_MALFORMED");
        assert.equal((await registry.loadGrant(bad)).reasonCode,
            "CAP_MALFORMED");
        assert.equal((await registry.authorize({
            capabilityId: bad, action: "use" })).reasonCode,
            "CAP_MALFORMED");
        const dd = await registry.delegate(bad, {
            capabilityId: "c.x", subject: "s",
            actions: ["use"], maxExecutions: 1 });
        assert.equal(dd.allowed, false);
        assert.equal(dd.reasonCode, "CAP_MALFORMED");
    }
    void grant;
});

/* ------------------------- BLOCKER 7 ---------------------------------- */

test("B7 sqlite: event-gagal saat ROOT issuance -> tidak ada capability, " +
     "ratifikasi tidak terkonsumsi, retry berhasil", async () => {
    const { dir, database, store } = await openSqlite();
    const reg = new acc.AuthorityRegistry({ store,
        clock: acc.manualClock(acc.T0) });

    await reg.proposeEvolution({
        proposalId: "prop-txroot", createdBy: "owner",
        kind: "authority_expansion",
        problem: "p", proposedChange: "c",
        requestedAuthority: { capabilityId: "tx.root",
            subject: "damar-core", actions: ["use"] }
    }, "owner");
    await reg.ratify({ ratificationId: "rat-txroot",
        proposalId: "prop-txroot", ownerIdentity: "o",
        decision: "APPROVED" });

    await database.exec(
        `CREATE TRIGGER fail_ev BEFORE INSERT ON capability_events
         BEGIN SELECT RAISE(ABORT, 'injected'); END;`);

    let threw = false;
    try {
        await reg.issueRatifiedRootGrant({
            proposalId: "prop-txroot", ratificationId: "rat-txroot" });
    } catch { threw = true; }

    assert.equal(threw, true);
    assert.equal(await store.getCapability("tx.root"), null,
        "tidak ada capability yang tercipta");
    const rat = await store.getRatification("rat-txroot");
    assert.equal(rat.consumedAt ?? null, null,
        "ratifikasi tidak terkonsumsi pada rollback");

    // Status proposal & ratifikasi tidak berubah:
    assert.equal((await store.getProposal("prop-txroot")).status, "DRAFT");

    await database.exec("DROP TRIGGER fail_ev");
    const retried = await reg.issueRatifiedRootGrant({
        proposalId: "prop-txroot", ratificationId: "rat-txroot" });
    assert.equal(retried.allowed, true);

    await database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("B7 sqlite: event-gagal saat DELEGATION -> tidak ada child, " +
     "tidak ada budget reserved, status parent tetap", async () => {
    const { dir, database, store } = await openSqlite();
    const reg = new acc.AuthorityRegistry({ store,
        clock: acc.manualClock(acc.T0) });

    await seedGrant(reg, { capabilityId: "deleg.parent", maxExecutions: 3 });

    await database.exec(
        `CREATE TRIGGER fail_ev BEFORE INSERT ON capability_events
         BEGIN SELECT RAISE(ABORT, 'injected'); END;`);

    let threw = false;
    try {
        await reg.delegate("deleg.parent", {
            capabilityId: "deleg.child", subject: "damar-core",
            actions: ["use"], maxExecutions: 2 });
    } catch { threw = true; }

    assert.equal(threw, true);
    assert.equal(await store.getCapability("deleg.child"), null,
        "child tidak boleh tercipta");
    assert.deepEqual(
        await store.getDelegationReservations("deleg.parent"), [],
        "tidak ada budget yang ter-reserve");
    const parent = await store.getCapability("deleg.parent");
    assert.equal(parent.status, "ACTIVE",
        "status parent tidak berubah");

    await database.exec("DROP TRIGGER fail_ev");
    const ok = await reg.delegate("deleg.parent", {
        capabilityId: "deleg.child", subject: "damar-core",
        actions: ["use"], maxExecutions: 2 });
    assert.equal(ok.allowed, true);
    assert.equal(
        (await store.getDelegationReservations("deleg.parent")).length, 1);

    await database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("B7 memory: appendEvent gagal -> rollback snapshot identik",
     async () => {
    const store = acc.createMemoryAuthorityStore();
    let injectFail = false;
    const originalAppend = store.appendEvent.bind(store);
    store.appendEvent = async (e) => {
        if (injectFail) throw new Error("injected memory event failure");
        return originalAppend(e);
    };
    const reg = new acc.AuthorityRegistry({ store,
        clock: acc.manualClock(acc.T0) });

    await reg.proposeEvolution({
        proposalId: "prop-memtx", createdBy: "owner",
        kind: "authority_expansion",
        problem: "p", proposedChange: "c",
        requestedAuthority: { capabilityId: "mem.tx",
            subject: "damar-core", actions: ["use"] }
    }, "owner");
    await reg.ratify({ ratificationId: "rat-memtx",
        proposalId: "prop-memtx", ownerIdentity: "o",
        decision: "APPROVED" });

    injectFail = true;
    let threw = false;
    try {
        await reg.issueRatifiedRootGrant({
            proposalId: "prop-memtx", ratificationId: "rat-memtx" });
    } catch { threw = true; }
    assert.equal(threw, true);
    assert.equal(await store.getCapability("mem.tx"), null);
    assert.equal((await store.getRatification("rat-memtx")).consumedAt ??
        null, null);

    injectFail = false;
    const retried = await reg.issueRatifiedRootGrant({
        proposalId: "prop-memtx", ratificationId: "rat-memtx" });
    assert.equal(retried.allowed, true);

    // Delegation rollback di memory:
    injectFail = true;
    let delThrew = false;
    try {
        await reg.delegate("mem.tx", {
            capabilityId: "mem.tx.child", subject: "damar-core",
            actions: ["use"], maxExecutions: 1 });
    } catch { delThrew = true; }
    assert.equal(delThrew, true);
    assert.equal(await store.getCapability("mem.tx.child"), null);
    assert.deepEqual(
        await store.getDelegationReservations("mem.tx"), []);
});

test("B7: TIDAK ADA lagi tautological/empty-helper di test rollback",
     async () => {
        // Audit statis: helper kosong & assertion tautologis dilarang.
        const src = fs.readFileSync(__filename, "utf8");
        void src;
        const budgetSrc = fs.readFileSync(
            path.join(__dirname, "authorityBudgetIdentityPersistence.test.js"),
            "utf8");
        assert.doesNotMatch(budgetSrc,
            /breakEventsThenConsume\s*\(\s*\)\s*\{\s*\}/,
            "empty helper terlarang");
        assert.doesNotMatch(budgetSrc, /equal\([^,]+,\s*true,\s*[^)]*\)\s*,\s*true/,
            "tautology terlarang");
    });

/* ------------------------- BLOCKER 8 ---------------------------------- */

async function runConsumptionMatrix(makeRegistry) {
    const outcomes = {};

    // authorize -> revoke -> consume => DENY CAP_REVOKED:
    {
        const { registry } = makeRegistry();
        await seedGrant(registry, { capabilityId: "m.rev" });
        assert.equal((await registry.authorize({
            capabilityId: "m.rev", action: "use" })).allowed, true);
        await registry.revoke("m.rev");
        outcomes.afterRevoke = await registry.consumeExecution("m.rev");
    }

    // unknown id:
    {
        const { registry } = makeRegistry();
        outcomes.unknown = await registry.consumeExecution("m.nope");
    }

    // exhausted:
    {
        const { registry } = makeRegistry();
        await seedGrant(registry, { capabilityId: "m.exh", maxExecutions: 1 });
        await registry.consumeExecution("m.exh");
        outcomes.exhausted = await registry.consumeExecution("m.exh");
    }

    // generation stale:
    {
        const { registry } = makeRegistry();
        await seedGrant(registry, { capabilityId: "m.gen" });
        await registry.revokeSubjectGeneration("damar-core");
        outcomes.stale = await registry.consumeExecution("m.gen");
    }

    // expired:
    {
        const r = makeRegistry();
        const registry = r.registry;
        const clock = r.clock;
        await seedGrant(registry, { capabilityId: "m.exp" });
        clock.advance(1000 * 60 * 60 * 24 * 365 * 10);   // +10 tahun
        outcomes.expired = await registry.consumeExecution("m.exp");
    }

    // suspended:
    {
        const { registry } = makeRegistry();
        await seedGrant(registry, { capabilityId: "m.sus" });
        await registry.suspend("m.sus");
        outcomes.suspended = await registry.consumeExecution("m.sus");
    }

    return outcomes;
}

test("B8: memory vs sqlite PARITY — reason/status identik untuk seluruh " +
     "matrix konsumsi (termasuk authorize->revoke->consume)", async () => {
    const memoryOutcomes =
        await runConsumptionMatrix(() => acc.makeRegistry());

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-parity-"));
    const Database = require("../../src/memory/db/Database");
    const migrate = require("../../src/memory/db/migrate");
    const database = new Database(path.join(dir, "authority.db"));
    await database.open();
    await migrate(database, {});
    const store = acc.createSqliteAuthorityStore(database);
    const sqliteOutcomes = await runConsumptionMatrix(() => {
        const registry = new acc.AuthorityRegistry({ store,
            clock: acc.manualClock(acc.T0) });
        return { registry, store, clock: registry.clock };
    });

    for (const key of Object.keys(memoryOutcomes)) {
        const m = memoryOutcomes[key];
        const s = sqliteOutcomes[key];
        assert.equal(m.allowed, s.allowed, `parity allowed: ${key}`);
        assert.equal(m.reasonCode, s.reasonCode, `parity reason: ${key}`);
        assert.notEqual(m.allowed, undefined);
    }

    // Kasus kunci blocker 8 secara eksplisit:
    assert.equal(memoryOutcomes.afterRevoke.allowed, false);
    assert.equal(memoryOutcomes.afterRevoke.reasonCode, "CAP_REVOKED");
    assert.equal(sqliteOutcomes.afterRevoke.reasonCode, "CAP_REVOKED");

    await database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("B8: revoke interleaved SETELAH precheck authorize tetap menutup " +
     "konsumsi (revalidasi in-atomic)", async () => {
    for (const backend of ["memory", "sqlite"]) {
        let registry, cleanup = async () => {};
        if (backend === "memory") {
            ({ registry } = acc.makeRegistry());
        } else {
            const { dir, database, store } = await openSqlite();
            registry = new acc.AuthorityRegistry({ store,
                clock: acc.manualClock(acc.T0) });
            cleanup = async () => {
                await database.close();
                fs.rmSync(dir, { recursive: true, force: true });
            };
        }

        await seedGrant(registry, { capabilityId: "toctou.cap",
                                    maxExecutions: 5 });
        // Precheck lolos:
        assert.equal((await registry.authorize({
            capabilityId: "toctou.cap", action: "use" })).allowed, true);
        // Revoke interleaved:
        await registry.revoke("toctou.cap");
        // Konsumsi WAJIB gagal meski precheck lama lolos:
        const c = await registry.consumeExecution("toctou.cap");
        assert.equal(c.allowed, false, `backend=${backend}`);
        assert.equal(c.reasonCode, "CAP_REVOKED", `backend=${backend}`);
        assert.equal(await registry.store.countConsumption("toctou.cap"),
            0, `backend=${backend}`);

        await cleanup();
    }
});
