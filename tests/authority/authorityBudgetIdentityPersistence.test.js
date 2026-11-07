const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const acc = require("./evolution-harness");

/** Â§H budget atomik, Â§I purpose/identity, Â§30 persistence restart. */

async function seededGrant(registry, { maxExecutions = 2 } = {}) {
    await registry.proposeEvolution({
        proposalId: "p-budget", createdBy: "owner",
        kind: "authority_expansion",
        problem: "b", proposedChange: "c",
        requestedAuthority: {
            capabilityId: "tool.heavy",
            subject: "damar-core",
            actions: ["use"],
            maxExecutions
        }
    }, "owner");
    await registry.ratify({ ratificationId: "r-b",
        proposalId: "p-budget", ownerIdentity: "operator",
        decision: "APPROVED" });
    const issued = await registry.issueRatifiedRootGrant({
        proposalId: "p-budget", ratificationId: "r-b" });
    assert.equal(issued.allowed, true);
    return issued.grant;
}

test("#26 budget tidak bisa dilewati (konsumsi ke limit lalu ditolak)", async () => {
    const { registry } = acc.makeRegistry();
    const grant = await seededGrant(registry, { maxExecutions: 2 });

    const c1 = await registry.consumeExecution(grant.capabilityId);
    const c2 = await registry.consumeExecution(grant.capabilityId);
    const c3 = await registry.consumeExecution(grant.capabilityId);

    assert.equal(c1.allowed && c2.allowed, true);
    assert.equal(c3.allowed, false);
    assert.equal(c3.reasonCode, "CAP_EXHAUSTED");
    assert.equal(await registry.store.countConsumption(grant.capabilityId), 2,
        "ledger konsumsi = 2 baris persis (tidak ada race/tambahan)");
});

test("#27 purpose mismatch DENY; yang cocok ALLOW", async () => {
    const { registry } = acc.makeRegistry();
    await registry.proposeEvolution({
        proposalId: "p-mail", createdBy: "owner",
        kind: "authority_expansion",
        problem: "butuh email", proposedChange: "grant email.send",
        requestedAuthority: {
            capabilityId: "email.send", subject: "damar-core",
            actions: ["use"],
            allowedPurposes: ["reply_to_user_request"]
        }
    }, "owner");
    await registry.ratify({ ratificationId: "r-mail",
        proposalId: "p-mail", ownerIdentity: "o", decision: "APPROVED" });
    await registry.issueRatifiedRootGrant({
        proposalId: "p-mail", ratificationId: "r-mail" });

    const deny = await registry.authorize({
        capabilityId: "email.send", action: "use",
        purpose: "marketing_broadcast" });
    assert.equal(deny.reasonCode, "CAP_PURPOSE_MISMATCH");

    const allow = await registry.authorize({
        capabilityId: "email.send", action: "use",
        purpose: "REPLY_TO_USER_REQUEST" });
    assert.equal(allow.allowed, true);   // kanonik lowercase âœ“
});

test("#28 identity/channel binding mismatch DENY", async () => {

    const { registry } = acc.makeRegistry();
    await registry.proposeEvolution({
        proposalId: "p-idn", createdBy: "owner",
        kind: "authority_expansion",
        problem: "i", proposedChange: "c",
        requestedAuthority: {
            capabilityId: "session.write", subject: "damar-core",
            actions: ["use"], identityBinding: { channels: ["console"] }
        }
    }, "owner");
    await registry.ratify({ ratificationId: "r-idn",
        proposalId: "p-idn", ownerIdentity: "o", decision: "APPROVED" });
    await registry.issueRatifiedRootGrant({
        proposalId: "p-idn", ratificationId: "r-idn" });

    const wrong = await registry.authorize({
        capabilityId: "session.write", action: "use",
        identity: { channel: "whatsapp" } });
    assert.equal(wrong.reasonCode, "CAP_IDENTITY_MISMATCH");

    const right = await registry.authorize({
        capabilityId: "session.write", action: "use",
        identity: { channel: "CONSOLE" } });   // kanonik lowercase
    assert.equal(right.allowed, true);
});

test("#29/#31 MALFORMED -> DENY ; issuance event-gagal -> rollback atomik", async () => {

    // Malformed input:
    const { registry } = acc.makeRegistry();
    const malformed = await registry.authorize({
        capabilityId: "..bad..", action: "use" });
    assert.equal(malformed.reasonCode, "CAP_MALFORMED");

    // Rollback atomik pada ROOT ISSUANCE: sabotase tabel events agar
    // appendEvent gagal DI DALAM transaksi yang sama dengan penulisan
    // capability + konsumsi ratifikasi.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-tx-"));
    const dbFile = path.join(dir, "authority.db");

    const Database = require("../../src/memory/db/Database");
    const migrate = require("../../src/memory/db/migrate");
    const db = new Database(dbFile);
    await db.open();
    await migrate(db, {});

    const store = acc.createSqliteAuthorityStore(db);
    const reg = new acc.AuthorityRegistry({ store, clock: acc.manualClock(1) });

    await reg.proposeEvolution({
        proposalId: "p-tx", createdBy: "owner",
        kind: "authority_expansion",
        problem: "tx", proposedChange: "tx",
        requestedAuthority: { capabilityId: "tx.cap", subject: "damar-core",
                              actions: ["use"] }
    }, "owner");
    await reg.ratify({ ratificationId: "r-tx",
        proposalId: "p-tx", ownerIdentity: "o", decision: "APPROVED" });

    // Sabotase HANYA penulisan event:
    await db.exec(
        `CREATE TRIGGER IF NOT EXISTS fail_event_insert
         BEFORE INSERT ON capability_events
         BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;`);

    let threw = false;
    try {
        await reg.issueRatifiedRootGrant({
            proposalId: "p-tx", ratificationId: "r-tx" });
    } catch { threw = true; }

    assert.equal(threw, true,
        "kegagalan menulis event di dalam tx wajib melempar");

    // ROLLBACK PENUH: tidak ada capability yang lahir DAN ratifikasi
    // TIDAK terkonsumsi (masih bisa dipakai setelah sabotage dihapus).
    const capAfterFail = await store.getCapability("tx.cap");
    assert.equal(capAfterFail, null,
        "capability TIDAK boleh tertinggal dari transaksi yang gagal");
    const ratAfterFail = await store.getRatification("r-tx");
    assert.equal(ratAfterFail?.consumedAt ?? null, null,
        "ratifikasi tidak boleh terkonsumsi oleh transaksi yang gagal");

    // Setelah sabotage dihilangkan, issuance yang sama HARUS berhasil
    // (bukti ratifikasi belum terbakar):
    await db.exec("DROP TRIGGER fail_event_insert");
    const retried = await reg.issueRatifiedRootGrant({
        proposalId: "p-tx", ratificationId: "r-tx" });
    assert.equal(retried.allowed, true);
    assert.equal(await store.countConsumption("tx.cap"), 0);

    // Bersihkan tmp:
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

