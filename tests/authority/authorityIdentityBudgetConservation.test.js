const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const acc = require("./evolution-harness");

/**
 * REPAIR ROUND 2.
 *
 * BLOCKER R2-1 — Identity binding attenuation PER-DIMENSI:
 *   parent mengikat dimensi d:
 *     child omit d   -> warisi
 *     child []       -> DENY CAP_IDENTITY_MISMATCH
 *     child subset   -> sah
 *     child wider    -> DENY
 *   parent TIDAK mengikat d -> child bebas mem-bind/narrow.
 *   {} terkendali-parent tidak pernah dinormalkan jadi null/unrestricted.
 *
 * BLOCKER R2-2 — Konservasi anggaran pohon delegasi:
 *   effectiveRemaining(node) =
 *       maxExecutions - usedExecutions - outstandingChildReservations
 *   Reservasi mengurangi kapasitas eksekusi delegator SENDIRI;
 *   invarian konservasi divalidasi ke SEMUA leluhur finite dalam tx;
 *   total eksekusi aktual seluruh pohon <= anggaran root yang finite.
 */

/* ------------------------------ helpers ------------------------------- */

async function seedRoot(registry, {
    capabilityId = "root.cap", maxExecutions = 4,
    identityBinding = null, actions = ["use", "delegate"],
    proposalId = "prop-" + capabilityId,
    ratificationId = "rat-" + capabilityId } = {}) {
    await registry.proposeEvolution({
        proposalId, createdBy: "owner",
        kind: "authority_expansion",
        problem: "p", proposedChange: "c",
        requestedAuthority: {
            capabilityId, subject: "damar-core", actions,
            scope: ["scope=home-lan"],
            allowedPurposes: ["ops.maintenance"],
            restrictions: ["tool:fs.read"],
            maxExecutions, identityBinding,
            remainingDelegationDepth: 5 }
    }, "owner");
    await registry.ratify({ ratificationId, proposalId,
        ownerIdentity: "o", decision: "APPROVED" });
    const g = await registry.issueRatifiedRootGrant({
        proposalId, ratificationId });
    assert.equal(g.allowed, true);
    return g.grant;
}

function delegationRequest(capabilityId, { actions = ["use"],
                                            maxExecutions = 1,
                                            identityBinding } = {}) {
    const req = {
        capabilityId, subject: "damar-core", actions,
        scope: ["scope=home-lan"],
        allowedPurposes: ["ops.maintenance"],
        restrictions: ["tool:fs.read"], maxExecutions
    };
    if (identityBinding !== undefined) {
        req.identityBinding = identityBinding;
    }
    return req;
}

async function openSqlite() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-r2-"));
    const Database = require("../../src/memory/db/Database");
    const migrate = require("../../src/memory/db/migrate");
    const database = new Database(path.join(dir, "authority.db"));
    await database.open();
    await migrate(database, {});
    const store = acc.createSqliteAuthorityStore(database);
    return { dir, database, store,
             cleanup: async () => {
                 await database.close();
                 fs.rmSync(dir, { recursive: true, force: true });
             } };
}

/** Jumlah EKSEKUSI AKTUAL seluruh pohon (bukan ukuran reservasi). */
async function treeActualExecutions(store, nodes) {
    let total = 0;
    for (const n of nodes) {
        total += await store.countConsumption(n);
    }
    return total;
}

/* ===================== BLOCKER R2-1: IDENTITY ========================= */

test("R2-1: child {} mewarisi KEDUA dimensi parent; authorize child OK",
     async () => {
    const { registry } = acc.makeRegistry();
    await seedRoot(registry, { capabilityId: "idn.root",
        identityBinding: { channels: ["cli"], principals: ["p1"] } });

    const d = await registry.delegate("idn.root",
        delegationRequest("idn.child", { maxExecutions: 3 }));
    assert.equal(d.allowed, true);

    // {} TIDAK dinormalkan menjadi unrestricted null:
    assert.deepEqual(d.grant.identityBinding, {
        channels: ["cli"], principals: ["p1"] });

    const ok = await registry.authorize({
        capabilityId: "idn.child", action: "use",
        scope: ["scope=home-lan"], purpose: "ops.maintenance",
        identity: { channel: "cli", principal: "p1" } });
    assert.equal(ok.allowed, true);
});

test("R2-1: child {channels:[]} pada parent terikat -> DENY",
     async () => {
    const { registry } = acc.makeRegistry();
    await seedRoot(registry, { capabilityId: "idn.root",
        identityBinding: { channels: ["cli"], principals: ["p1"] } });

    const d = await registry.delegate("idn.root",
        delegationRequest("idn.child", { maxExecutions: 1,
                                         identityBinding: { channels: [] } }));
    assert.equal(d.allowed, false);
    assert.ok(d.violations.some(v =>
        v.field === "identityBinding.channels" &&
        v.reasonCode === "CAP_IDENTITY_MISMATCH"),
        JSON.stringify(d.violations));
    assert.equal(await registry.store.getCapability("idn.child"), null);
});

test("R2-1: partial object {channels:[..]} tetap MEWARISI principals",
     async () => {
    const { registry } = acc.makeRegistry();
    await seedRoot(registry, { capabilityId: "idn.root",
        identityBinding: { channels: ["cli"], principals: ["p1"] } });

    const d = await registry.delegate("idn.root",
        delegationRequest("idn.child", { maxExecutions: 3,
            identityBinding: { channels: ["cli"] } }));
    assert.equal(d.allowed, true);
    assert.deepEqual(d.grant.identityBinding, {
        channels: ["cli"],           // eksplisit subset
        principals: ["p1"] });      // diwarisi

    // principals benar-benar aktif pada child:
    const wrong = await registry.authorize({
        capabilityId: "idn.child", action: "use",
        scope: ["scope=home-lan"], purpose: "ops.maintenance",
        identity: { channel: "cli", principal: "other" } });
    assert.equal(wrong.reasonCode, "CAP_IDENTITY_MISMATCH");
});

test("R2-1: subset sah; wider set DENY (per dimensi)",
     async () => {
    const { registry } = acc.makeRegistry();
    await seedRoot(registry, { capabilityId: "idn.root",
        identityBinding: { channels: ["cli", "webhook"],
                           sessionIds: ["s1", "s2"],
                           principals: ["p1", "p2"] } });

    // Subset ketiga dimensi -> sah:
    const sub = await registry.delegate("idn.root",
        delegationRequest("idn.sub", { maxExecutions: 3,
            identityBinding: { channels: ["webhook"],
                               sessionIds: ["s1"],
                               principals: ["p1", "p2"] } }));
    assert.equal(sub.allowed, true);
    assert.deepEqual([...sub.grant.identityBinding.channels], ["webhook"]);
    assert.deepEqual([...sub.grant.identityBinding.sessionIds], ["s1"]);

    // Wider pada salah satu dimensi -> DENY:
    for (const [label, ib] of Object.entries({
        channels: { channels: ["http"], sessionIds: ["s1"],
                    principals: ["p1"] },
        sessionIds: { channels: ["cli"], sessionIds: ["s1", "s9"],
                      principals: ["p1"] },
        principals: { channels: ["cli"], sessionIds: ["s1"],
                      principals: ["px"] }
    })) {
        void label;
        const d = await registry.delegate("idn.root",
            delegationRequest("idn.wider." +
                Math.random().toString(36).slice(2, 8),
                { maxExecutions: 1, identityBinding: ib }));
        assert.equal(d.allowed, false);
        assert.equal(d.reasonCode, "CAP_IDENTITY_MISMATCH");
    }
});

test("R2-1: empty array pada dimensi TERIKAT DENY; pada dimensi BEBAS " +
     "no-op; unbound dimension boleh di-bind anak", async () => {
    const { registry } = acc.makeRegistry();
    await seedRoot(registry, { capabilityId: "idn.root",
        identityBinding: { channels: ["cli"] } });

    // channels[] DENY (terikat):
    const emptyBound = await registry.delegate("idn.root",
        delegationRequest("idn.eb", { maxExecutions: 1,
            identityBinding: { channels: [] } }));
    assert.equal(emptyBound.allowed, false);

    // sessionIds[] no-op pada dimensi bebas; channels diwarisi:
    const emptyFree = await registry.delegate("idn.root",
        delegationRequest("idn.ef", { maxExecutions: 1,
            identityBinding: { sessionIds: [] } }));
    assert.equal(emptyFree.allowed, true);
    assert.deepEqual(emptyFree.grant.identityBinding,
        { channels: ["cli"] });

    // Dimensi bebas boleh di-bind anak (narrowing):
    const bindFree = await registry.delegate("idn.root",
        delegationRequest("idn.bf", { maxExecutions: 1,
            identityBinding: { principals: ["p1"] } }));
    assert.equal(bindFree.allowed, true);
    assert.deepEqual(bindFree.grant.identityBinding, {
        channels: ["cli"], principals: ["p1"] });
});

test("R2-1: authorize child pasca-delegasi memakai identitas gabungan",
     async () => {
    const { registry } = acc.makeRegistry();
    await seedRoot(registry, { capabilityId: "idn.root",
        identityBinding: { channels: ["cli"],
                           sessionIds: ["s1","s2"],
                           principals: ["p1"] } });

    const d = await registry.delegate("idn.root",
        delegationRequest("idn.authchild", { maxExecutions: 3,
            identityBinding: { sessionIds: ["s2"] } }));
    assert.equal(d.allowed, true);

    const ok = await registry.authorize({
        capabilityId: "idn.authchild", action: "use",
        scope: ["scope=home-lan"], purpose: "ops.maintenance",
        identity: { channel: "CLI", sessionId: "s2",
                    principal: "p1" } });
    assert.equal(ok.allowed, true);

    const wrongSession = await registry.authorize({
        capabilityId: "idn.authchild", action: "use",
        scope: ["scope=home-lan"], purpose: "ops.maintenance",
        identity: { channel: "cli", sessionId: "s1" } });
    assert.equal(wrongSession.reasonCode, "CAP_IDENTITY_MISMATCH");
});

/* ================ BLOCKER R2-2: BUDGET CONSERVATION =================== */

test("R2-2 A [memory+sqlite]: root max=2, delegate child max=2 -> " +
     "combined executions root+child <= 2", async () => {
    for (const backend of ["memory", "sqlite"]) {
        let registry, store, cleanup = async () => {};
        if (backend === "memory") {
            ({ registry, store } = acc.makeRegistry());
        } else {
            ({ store, cleanup, } = await openSqlite());
            registry = new acc.AuthorityRegistry({ store,
                clock: acc.manualClock(acc.T0) });
        }

        await seedRoot(registry, { capabilityId: "a.root",
                                   maxExecutions: 2 });
        const d = await registry.delegate("a.root",
            delegationRequest("a.child", { maxExecutions: 2 }));
        assert.equal(d.allowed, true, backend);

        // Parent TIDAK bisa lagi mengeksekusi 2 kali:
        const rootC1 = await registry.consumeExecution("a.root");
        assert.equal(rootC1.allowed, false,
            `${backend}: reservasi anak mengurangi kapasitas parent`);
        assert.match(rootC1.reasonCode, /CAP_EXHAUSTED/);

        // Child mengeksekusi penuh 2x:
        assert.equal((await registry.consumeExecution("a.child")).allowed,
            true);
        assert.equal((await registry.consumeExecution("a.child")).allowed,
            true);
        assert.equal((await registry.consumeExecution("a.child")).allowed,
            false);

        // SUM EKSEKUSI AKTUAL pohon <= 2:
        const total = await treeActualExecutions(store,
            ["a.root", "a.child"]);
        assert.equal(total, 2, `${backend}: total aktual = ${total}`);

        await cleanup();
    }
});

test("R2-2 B [memory+sqlite]: chain root->a->b->c each requests 4 " +
     "(root max=4) -> combined executions across chain <= 4",
     async () => {
    for (const backend of ["memory", "sqlite"]) {
        let registry, store, cleanup = async () => {};
        if (backend === "memory") {
            ({ registry, store } = acc.makeRegistry());
        } else {
            ({ store, cleanup } = await openSqlite());
            registry = new acc.AuthorityRegistry({ store,
                clock: acc.manualClock(acc.T0) });
        }

        await seedRoot(registry, { capabilityId: "b.root",
                                   maxExecutions: 4 });
        const a = await registry.delegate("b.root",
            delegationRequest("b.a", { maxExecutions: 4 }));
        assert.equal(a.allowed, true, backend);
        const b = await registry.delegate("b.a",
            delegationRequest("b.b", { maxExecutions: 4 }));
        assert.equal(b.allowed, true, backend);

        // b mendelegasikan penuh ke c: kapasitas eksekusi b SENDIRI
        // jadi 0 (reservasi mengurangi kuota delegator) — konservasi
        // tetap terjaga; yang boleh mengeksekusi hanya ujung rantai.
        const c = await registry.delegate("b.b",
            delegationRequest("b.c", { maxExecutions: 4 }));
        assert.equal(c.allowed, true, backend);

        // Tidak ada yang bisa mendelegasikan melebihi sisa kapasitas:
        const tooBigDeep = await registry.delegate("b.c",
            delegationRequest("b.toobig", { maxExecutions: 5 }));
        assert.equal(tooBigDeep.allowed, false, backend);
        // 5 > budget parent sendiri -> tertangkap di attenuation;
        // permintaan <= budget parent tapi > sisa efektif -> tertangkap
        // CAP_DELEGATION_BUDGET_EXHAUSTED di commit (repro A/C/D/E).
        assert.match(tooBigDeep.reasonCode, /CAP_DELEGATION/);

        // a sendiri tidak punya sisa (semua terkomit ke b):
        assert.equal((await registry.consumeExecution("b.a")).allowed,
            false, backend);
        // root juga tidak:
        assert.equal((await registry.consumeExecution("b.root")).allowed,
            false, backend);
        // b sudah mengorbankan seluruh kapasitasnya ke c:
        assert.equal((await registry.consumeExecution("b.b")).allowed,
            false, backend);
        // Hanya c yang mengeksekusi, sampai 4 lalu habis:
        for (let i = 0; i < 4; i++) {
            assert.equal((await registry.consumeExecution("b.c")).allowed,
                true, `${backend} run ${i}`);
        }
        assert.equal((await registry.consumeExecution("b.c")).allowed,
            false);

        // Setelah c tuntas, tidak ada kapasitas utk delegasi/eksekusi:
        const afterEmpty = await registry.delegate("b.c",
            delegationRequest("b.after", { maxExecutions: 1 }));
        assert.equal(afterEmpty.allowed, false, backend);
        // c sudah EXHAUSTED (ditolak saat parent-load) atau tertangkap
        // sebagai budget habis di commit — keduanya fail-closed:
        assert.match(afterEmpty.reasonCode,
            /CAP_EXHAUSTED|CAP_DELEGATION_BUDGET_EXHAUSTED/);

        // SUM AKTUAL SELURUH CHAIN <= 4:
        const total = await treeActualExecutions(store,
            ["b.root", "b.a", "b.b", "b.c"]);
        assert.equal(total, 4, `${backend}: total aktual rantai = ${total}`);

        // Skenario alternatif: intermediate mengeksekusi DULU sebelum
        // mendelegasikan sisa -> tetap <= 4.
        {
            await seedRoot(registry, { capabilityId: "b2.root",
                                       maxExecutions: 4 });
            const a2 = await registry.delegate("b2.root",
                delegationRequest("b2.a", { maxExecutions: 4 }));
            assert.equal(a2.allowed, true, backend);

            // a mengeksekusi 3x (used=3):
            for (let i = 0; i < 3; i++) {
                assert.equal(
                    (await registry.consumeExecution("b2.a")).allowed,
                    true);
            }
            // Sisa a = 4-3-0 = 1 -> delegasi 4 DENY, delegasi 1 OK:
            const tooBig = await registry.delegate("b2.a",
                delegationRequest("b2.toobig", { maxExecutions: 4 }));
            assert.equal(tooBig.allowed, false, backend);
            const fits = await registry.delegate("b2.a",
                delegationRequest("b2.fits", { maxExecutions: 1 }));
            assert.equal(fits.allowed, true, backend);
            // a kunci; hanya b2.fits yang punya 1 eksekusi:
            assert.equal((await registry.consumeExecution("b2.a")).allowed,
                false);
            assert.equal((await registry.consumeExecution("b2.fits"))
                .allowed, true);

            const totalAlt = await treeActualExecutions(store,
                ["b2.root", "b2.a", "b2.toobig", "b2.fits"]);
            assert.equal(totalAlt, 4,
                `${backend}: total skenario alternatif = ${totalAlt}`);
        }

        await cleanup();
    }
});

test("R2-2 C [memory+sqlite]: parent consume FIRST, then delegate -> " +
     "remaining capacity reflects consumption", async () => {
    for (const backend of ["memory", "sqlite"]) {
        let registry, store, cleanup = async () => {};
        if (backend === "memory") {
            ({ registry, store } = acc.makeRegistry());
        } else {
            ({ store, cleanup } = await openSqlite());
            registry = new acc.AuthorityRegistry({ store,
                clock: acc.manualClock(acc.T0) });
        }

        await seedRoot(registry, { capabilityId: "c.root",
                                   maxExecutions: 3 });
        assert.equal((await registry.consumeExecution("c.root")).allowed,
            true);                                  // used=1

        const ok = await registry.delegate("c.root",
            delegationRequest("c.child", { maxExecutions: 2 }));
        assert.equal(ok.allowed, true, backend);    // 3-1-0 >= 2

        // Sisa root = 3 - 1 - 2 = 0 -> konsumsi kedua ditolak:
        const again = await registry.consumeExecution("c.root");
        assert.equal(again.allowed, false, backend);
        assert.match(again.reasonCode, /CAP_EXHAUSTED/);

        // Child tetap bisa 2x; total pohon <= 3:
        assert.equal((await registry.consumeExecution("c.child")).allowed,
            true);
        assert.equal((await registry.consumeExecution("c.child")).allowed,
            true);
        const total = await treeActualExecutions(store,
            ["c.root", "c.child"]);
        assert.equal(total, 3, backend);

        await cleanup();
    }
});

test("R2-2 D [memory+sqlite]: parent delegates FIRST, then consumes -> " +
     "remaining capacity reflects reservation", async () => {
    for (const backend of ["memory", "sqlite"]) {
        let registry, cleanup = async () => {};
        if (backend === "memory") {
            ({ registry } = acc.makeRegistry());
        } else {
            ({ cleanup } = await openSqlite());
            registry = new acc.AuthorityRegistry(
                { store: null, clock: acc.manualClock(acc.T0) });
        }
        // Untuk D cukup memory-grade assertion via sqlite store reuse:
        void registry;

        let reg, st;
        if (backend === "memory") {
            const made = acc.makeRegistry();
            reg = made.registry; st = made.store;
        } else {
            const opened = await openSqlite();
            cleanup = opened.cleanup; st = opened.store;
            reg = new acc.AuthorityRegistry({ store: st,
                clock: acc.manualClock(acc.T0) });
        }

        await seedRoot(reg, { capabilityId: "d.root", maxExecutions: 3 });
        assert.equal((await reg.delegate("d.root",
            delegationRequest("d.child", { maxExecutions: 2 })))
            .allowed, true);

        // 3 - 0 - 2 = 1 -> tepat satu konsumsi root tersisa:
        assert.equal((await reg.consumeExecution("d.root")).allowed, true);
        const second = await reg.consumeExecution("d.root");
        assert.equal(second.allowed, false, backend);
        assert.match(second.reasonCode, /CAP_EXHAUSTED/);

        await cleanup();
    }
});

test("R2-2 E [memory+sqlite]: concurrent consume + delegate tidak " +
     "oversubscribe", async () => {
    for (const backend of ["memory", "sqlite"]) {
        let registry, store, cleanup = async () => {};
        if (backend === "memory") {
            ({ registry, store } = acc.makeRegistry());
        } else {
            ({ store, cleanup } = await openSqlite());
            registry = new acc.AuthorityRegistry({ store,
                clock: acc.manualClock(acc.T0) });
        }

        for (let round = 0; round < 5; round++) {
            const capId = `e.root.r${round}`;
            await seedRoot(registry, { capabilityId: capId,
                                       maxExecutions: 2 });

            const results = await Promise.all([
                registry.consumeExecution(capId),
                registry.delegate(capId,
                    delegationRequest(`${capId}.child`,
                        { maxExecutions: 2 }))
            ]);

            const consumedOk = results[0].allowed === true;
            const delegatedOk = results[1].allowed === true;
            assert.equal(consumedOk && delegatedOk, false,
                `${backend} round ${round}: oversubscribed!`);

            // Invarian: used + reserved <= max, selalu.
            const used = await store.countConsumption(capId);
            const reservations =
                await store.getDelegationReservations(capId);
            const reservedSum =
                reservations.reduce((s, r) => s + r.amount, 0);
            assert.ok(used + reservedSum <= 2,
                `${backend} round ${round}: ${used}+${reservedSum} > 2`);
        }

        await cleanup();
    }
});

test("R2-2 F [memory+sqlite]: failed delegation transaction tidak " +
     "meninggalkan reservasi leluhur", async () => {
    // SQLite: sabotase event DI DALAM tx delegasi.
    {
        const { store, database, cleanup } = await openSqlite();
        const registry = new acc.AuthorityRegistry({ store,
            clock: acc.manualClock(acc.T0) });
        await seedRoot(registry, { capabilityId: "f.root",
                                   maxExecutions: 4 });

        await database.exec(
            `CREATE TRIGGER fail_ev_r2 BEFORE INSERT ON capability_events
             BEGIN SELECT RAISE(ABORT, 'injected'); END;`);

        let threw = false;
        try {
            await registry.delegate("f.root",
                delegationRequest("f.child", { maxExecutions: 2 }));
        } catch { threw = true; }
        assert.equal(threw, true);

        assert.deepEqual(
            await store.getDelegationReservations("f.root"), [],
            "tidak ada reservasi yang bocor di root");
        assert.equal(await store.getCapability("f.child"), null);

        // Hentikan sabotage SEBELUM precheck kapasitas:
        await database.exec("DROP TRIGGER fail_ev_r2");
        // Root kapasitasnya utuh kembali:
        assert.equal((await registry.consumeExecution("f.root")).allowed,
            true);
        await cleanup();
    }

    // Memory: proxy appendEvent gagal -> rollback snapshot.
    {
        const store = acc.createMemoryAuthorityStore();
        let injectFail = false;
        const origAppend = store.appendEvent.bind(store);
        store.appendEvent = async (e) => {
            if (injectFail) throw new Error("injected");
            return origAppend(e);
        };
        const registry = new acc.AuthorityRegistry({ store,
            clock: acc.manualClock(acc.T0) });
        await seedRoot(registry, { capabilityId: "fm.root",
                                   maxExecutions: 4 });

        injectFail = true;
        let threw = false;
        try {
            await registry.delegate("fm.root",
                delegationRequest("fm.child", { maxExecutions: 2 }));
        } catch { threw = true; }
        assert.equal(threw, true);
        assert.deepEqual(
            await store.getDelegationReservations("fm.root"), []);
        assert.equal(await store.getCapability("fm.child"), null);
        injectFail = false;
        assert.equal((await registry.consumeExecution("fm.root")).allowed,
            true);
    }
});

test("R2-2 G: memory vs native-SQLite parity untuk repro A-D " +
     "(keputusan identik, sum aktual identik)", async () => {
    async function runScenario(make) {
        const { registry, store, cleanup } = await make();
        await seedRoot(registry, { capabilityId: "g.root",
                                   maxExecutions: 2 });
        const del = await registry.delegate("g.root",
            delegationRequest("g.child", { maxExecutions: 2 }));

        const rootTry = await registry.consumeExecution("g.root");
        const c1 = await registry.consumeExecution("g.child");
        const c2 = await registry.consumeExecution("g.child");
        const c3 = await registry.consumeExecution("g.child");

        const out = {
            delegated: del.allowed,
            rootConsumeAfterReservation: rootTry.allowed,
            rootReason: rootTry.reasonCode ?? null,
            childConsumes: [c1.allowed, c2.allowed, c3.allowed],
            total: (await store.countConsumption("g.root")) +
                   (await store.countConsumption("g.child"))
        };
        await cleanup();
        return out;
    }

    const memoryOut = await runScenario(async () => {
        const made = acc.makeRegistry();
        return { registry: made.registry, store: made.store,
                 cleanup: async () => {} };
    });

    const sqliteOut = await runScenario(async () => {
        const opened = await openSqlite();
        return { registry: new acc.AuthorityRegistry({ store: opened.store,
                     clock: acc.manualClock(acc.T0) }),
                 store: opened.store, cleanup: opened.cleanup };
    });

    assert.deepEqual(sqliteOut, memoryOut);
    assert.equal(memoryOut.delegated, true);
    assert.equal(memoryOut.rootConsumeAfterReservation, false);
    assert.deepEqual(memoryOut.childConsumes, [true, true, false]);
    assert.equal(memoryOut.total, 2);
});
