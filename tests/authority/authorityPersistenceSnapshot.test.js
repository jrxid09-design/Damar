const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const acc = require("./evolution-harness");

/** Â§30 restart, Â§31 rollback atomik, Â§32 snapshot immutable, Â§33 revalidasi. */

async function openSqlite(existingFile = null) {
    const dir = existingFile ? path.dirname(existingFile) : fs.mkdtempSync(path.join(os.tmpdir(), "auth-sqlite-"));
    const Database = require("../../src/memory/db/Database");
    const migrate = require("../../src/memory/db/migrate");
    const dbFile = existingFile ?? path.join(dir, "authority.db");
    const database = new Database(dbFile);
    await database.open();
    await migrate(database, {});
    return { dir, dbFile, database,
             store: acc.createSqliteAuthorityStore(database) };
}

async function seedApprovedExpansion(registry, { capabilityId, maxExecutions }) {
    await registry.proposeEvolution({
        proposalId: "p-" + capabilityId, createdBy: "owner",
        kind: "authority_expansion",
        problem: "uji", proposedChange: "uji",
        requestedAuthority: { capabilityId, subject: "damar-core",
                              actions: ["use"], maxExecutions }
    }, "owner");
    await registry.ratify({ ratificationId: "r-" + capabilityId,
        proposalId: "p-" + capabilityId, ownerIdentity: "operator",
        decision: "APPROVED" });
    const issued = await registry.issueRatifiedRootGrant({
        proposalId: "p-" + capabilityId,
        ratificationId: "r-" + capabilityId });
    assert.equal(issued.allowed, true);
    return issued.grant;
}

test("#30 RESTART sqlite: grant/konsumsi/status selamat persis", async () => {

    const { dir, dbFile, database, store } = await openSqlite();
    const clock = acc.manualClock(acc.T0);
    const reg1 = new acc.AuthorityRegistry({ store, clock });

    const grant = await seedApprovedExpansion(reg1,
        { capabilityId: "restart.cap", maxExecutions: 5 });

    await reg1.consumeExecution(grant.capabilityId);   // used=1

    // Simulasi restart: koneksi baru ke FILE yang sama.
    await database.close?.();
    const reopened = await openSqlite(dbFile);
    void database;

    const clock2 = acc.manualClock(acc.T0 + 1000);
    const reg2 = new acc.AuthorityRegistry({ store: reopened.store,
                                             clock: clock2 });

    const cap = await reg2.store.getCapability("restart.cap");
    assert.equal(cap.status, "ACTIVE");
    assert.equal(cap.payload.subject, "damar-core");

    const d = await reg2.authorize({ capabilityId: "restart.cap",
                                     action: "use" });
    assert.equal(d.allowed, true);
    assert.equal(d.snapshot.generation, 0);

    const consumed = await reg2.store
        .countConsumption("restart.cap");
    assert.equal(consumed, 1, "ledger konsumsi ikut selamat");

    await reopened.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("#31 consumeExecution ATOMIK: event-gagal -> ROLLBACK penuh", async () => {

    const { dir, dbFile, database, store } = await openSqlite();
    const reg = new acc.AuthorityRegistry({
        store, clock: acc.manualClock(acc.T0) });

    const grant = await seedApprovedExpansion(reg,
        { capabilityId: "atomic.cap", maxExecutions: 1 });

    // Sabotase tabel audit SETELAH grant ada:
    await database.exec("DROP TABLE capability_events");

    let threw = false;
    try {
        await reg.consumeExecution(grant.capabilityId);
    } catch { threw = true; }

    assert.equal(threw, true,
        "kegagalan menulis event di dalam tx wajib melempar");

    // ROLLBACK penuh: ledger kosong & status tetap ACTIVE.
    assert.equal(await store.countConsumption("atomic.cap"), 0);
    const cap = await store.getCapability("atomic.cap");
    assert.equal(cap.status, "ACTIVE",
        "status tidak boleh terlanjur EXHAUSTED setelah rollback");

    await database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("#32 EXECUTION SNAPSHOT immutable (frozen mendalam)", async () => {

    const { registry } = acc.makeRegistry();
    const grant = await seedApprovedExpansion(registry,
        { capabilityId: "snap.cap", maxExecutions: 3 });

    const d = await registry.authorize({
        capabilityId: grant.capabilityId, action: "use" });

    assert.equal(d.allowed, true);
    const snap = d.snapshot;

    assert.equal(Object.isFrozen(snap), true);
    assert.equal(Object.isFrozen(snap.restrictions), true);
    assert.ok(Object.isFrozen(snap.actions));
    assert.ok(Object.isFrozen(snap.scope));

    // Upaya mutasi tidak berefek (strict mode melempar; non-strict diam):
    const before = JSON.stringify(snap);
    try { snap.decisionId = "hacked"; } catch {}
    try { snap.actions.push("administer"); } catch {}
    assert.equal(JSON.stringify(snap), before);
});

test("#33 REVOKE sebelum eksekusi -> revalidasi material DITOLAK", async () => {

    const store = acc.createMemoryAuthorityStore();
    const { core } = { core: null };
    void core;

    const { registry } = acc.makeRegistry({ store });
    const grant = await seedApprovedExpansion(registry,
        { capabilityId: "material.patch", maxExecutions: null });

    const d = await registry.authorize({
        capabilityId: grant.capabilityId, action: "use" });
    assert.equal(d.allowed, true);

    const snapshot = d.snapshot;
    assert.equal((await registry.revalidateExecution(snapshot)).allowed, true);

    // Revoke TERJADI setelah otorisasi:
    await registry.revoke(grant.capabilityId);

    const re = await registry.revalidateExecution(snapshot);
    assert.equal(re.allowed, false);
    assert.match(re.reasonCode || "", /CAP_REVOKED|CAP_INACTIVE/);

    // Dan snapshot lama TIDAK bisa dipakai memaksa konsumsi:
    const c = await registry.consumeExecution(grant.capabilityId);
    assert.equal(c.allowed, false);
});

