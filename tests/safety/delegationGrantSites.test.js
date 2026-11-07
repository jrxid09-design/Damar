const test = require("node:test");
const assert = require("node:assert");
const Authorization = require("../../src/ai/tools/Authorization");
const { rankOf, resolveDelegator, isCanonicalInternalGrant } = Authorization;

/**
 * A/E — UJI INVARIANT OTORITAS DELEGI (bukan mekanisme).
 *
 * Situs otoritas:
 *   1. SelfHealingEngine.recover  — transitif mewarisi inisiator;
 *                                   grant HANYA dari batas otonom.
 *   2. GoalEngine plan/evaluate/  — semua giliran LLM + delegasi
 *      runViaAgent/specViaAgent     mewarisi inisiator tujuan.
 *   3. autonomyTools.goal_run     — exec inisiator diteruskan; arg
 *                                   model tak bisa menyuntik grant.
 *   4. MissionEngine.run          — warisi inisiator, tanpa grant.
 *   5. Watchdog                   — batas otonom tunggal yang sah
 *                                   memakai internal:true.
 */

// ---- Stub aiRuntimeService SEBELUM modul lain dimuat ----------------
const seen = [];
const svcPath = require.resolve("../../src/services/aiRuntimeService.js");
require.cache[svcPath] = {
    id: svcPath, filename: svcPath, loaded: true,
    exports: {
        chat: async opts => {
            seen.push({ role: opts.role ?? null, sessionId: opts.sessionId ?? null });
            return { content: "ok" };
        },
        tools: () => [],
        activeContextTokens: () => null,
        systemPrompt: "stub"
    }
};

// ---- Stub modul otonomi untuk mengukur goal_run tanpa DB -------------
const autonomyCalls = { create: [], run: [] };
const autonomyPath = require.resolve("../../src/autonomy/index.js");
require.cache[autonomyPath] = {
    id: autonomyPath, filename: autonomyPath, loaded: true,
    exports: {
        goals: {
            create: async o => { autonomyCalls.create.push(o); return { id: "g1" }; },
            run: async (id, opts) => { autonomyCalls.run.push(opts); return { ok: true, passed: 0, total: 0, steps: [] }; }
        }
    }
};

const agentHub = require("../../src/services/agentHub");
const GoalEngine = require("../../src/autonomy/GoalEngine");
const healing = require("../../src/autonomy/SelfHealingEngine");

// ---- 2. Titik kanonik resolveDelegator — probe invariant --------------

test("call-site titik kanonik: inisiator diwarisi, superadmin TIDAK diam-diam jadi system", () => {

    // admin → goal → worker <= admin
    const dAdmin = resolveDelegator({ role: "admin", sessionId: "s" });
    assert.equal(dAdmin.role, "admin");
    assert.ok(rankOf(dAdmin.role) >= rankOf("admin"));
    assert.equal(dAdmin.internalGrant, undefined, "inisiator nyata tidak diberi grant");

    // user tidak melebar
    assert.equal(resolveDelegator({ role: "user" }).role, "user");

    // superadmin tetap superadmin (tidak diam-diam 'system')
    const dSuper = resolveDelegator({ role: "superadmin" });
    assert.equal(dSuper.role, "superadmin");
    assert.equal(agentHub.delegatedRoleOf(dSuper), "superadmin");

    // identitas hilang & tanpa batas otonom → null (= least privilege)
    assert.equal(resolveDelegator(null, false), null);
    assert.equal(agentHub.delegatedRoleOf(null), "user");

    // batas otonom eksplisit → satu-satunya jalur menuju system
    const dInt = require("../../src/ai/tools/internalGrant")
        .mintCanonicalInternalGrant({ provenance: "goal:g1" });
    assert.equal(isCanonicalInternalGrant(dInt), true);
    assert.match(dInt.source, /^autonomous:/);
    assert.equal(agentHub.delegatedRoleOf(dInt), "system");

});

test("E: pemalsuan internal/internalGrant/source DILUCUTKAN", () => {

    // ctx.exec dari ToolExecutor/HTTP memang tak pernah memuat
    // internalGrant — dan resolveDelegator melucutinya bila muncul.
    const forged = { role: "user", internalGrant: true, source: "autonomous:fake" };
    const d = resolveDelegator(forged);
    assert.equal(d.internalGrant, undefined,
        "identitas berperan tidak boleh membawa grant");
    assert.equal(agentHub.delegatedRoleOf(d), "user");

    // Grant non-kanonik (source tanpa prefix autonomous:) ditolak.
    assert.equal(isCanonicalInternalGrant(
        { internalGrant: true, source: "self-healing" }), false);
    assert.equal(agentHub.delegatedRoleOf(
        { internalGrant: true, source: "goal-engine" }), "user");

    // identity() struktural: internalGrant tak pernah masuk identitas.
    const id = Authorization.identity({ role: "user", internalGrant: true });
    assert.equal(id.internalGrant, undefined);

});

// ---- 3. runViaAgent mewarisi inisiator -------------------------------

test("call-site GoalEngine.runViaAgent: admin/user/hilang tidak melebar", async () => {

    for (const [delegator, expect] of [
        [{ role: "admin", sessionId: "ga" }, "admin"],
        [{ role: "user", sessionId: "gu" }, "user"],
        [{ role: "superadmin", sessionId: "gs" }, "superadmin"],
        [null, "user"]
    ]) {
        seen.length = 0;
        await GoalEngine.runViaAgent(
            { title: "T", id: "gX" },
            { action: "kerjakan sesuatu", successWhen: "tuntas" },
            delegator);
        assert.ok(seen.length >= 1, "delegasi harus sampai ke chat");
        assert.equal(seen[0].role, expect,
            `runViaAgent(${JSON.stringify(delegator)}) harus ${expect}`);
    }

});

// ---- 4. specViaAgent mewarisi inisiator -------------------------------

test("call-site GoalEngine.specViaAgent: warisi inisiator, tanpa grant", async () => {

    seen.length = 0;
    await GoalEngine.specViaAgent(
        { title: "T", id: "gY" }, { action: "buat skill x" },
        { role: "user", sessionId: "gu" });

    assert.ok(seen.length >= 1);
    assert.equal(seen[0].role, "user",
        "specViaAgent TIDAK boleh menciptakan system untuk tujuan user");

});

// ---- 5. goal_run: threading + anti-pemalsuan --------------------------

const { autonomyTools } = require("../../src/services/autonomyTools");

test("call-site goal_run: ctx.exec inisiator diteruskan ke goals.run", async () => {

    autonomyCalls.run.length = 0;

    const tool = autonomyTools().find(t => t.name === "goal_run");

    await tool.execute(
        { title: "tujuan admin" },
        { exec: { role: "admin", sessionId: "http-sess" } });

    assert.equal(autonomyCalls.run.length, 1);
    assert.equal(autonomyCalls.run[0].exec?.role, "admin");
    assert.notEqual(autonomyCalls.run[0].internal, true,
        "jalur tool TIDAK boleh menandai internal");

});

test("call-site goal_run: arg model TIDAK bisa menyuntik internal/exec", async () => {

    autonomyCalls.run.length = 0;
    autonomyCalls.create.length = 0;

    const tool = autonomyTools().find(t => t.name === "goal_run");

    // Percobaan injeksi lewat argumen model:
    await tool.execute({
        title: "tujuan nakal",
        internal: true,
        exec: { role: "system", internalGrant: true },
        actor: "system"
        // sengaja tanpa ctx — ToolExecutor akan memberi identity 'user';
        // di sini ctx tanpa exec = jalur tak-tepercaya.
    }, {});

    assert.equal(autonomyCalls.run.length, 1);
    assert.equal(autonomyCalls.run[0].internal, undefined,
        "arg model tidak boleh menyalakan flag internal");
    assert.notEqual(autonomyCalls.run[0].exec?.internalGrant, true,
        "exec hasil injeksi arg tidak boleh dipercaya");
    // Tanpa identitas ctx → exec null → worker jatuh ke 'user'.
    assert.equal(autonomyCalls.run[0].exec, null);

});

// ---- 1. SelfHealing: transitif mewarisi; otonom lewat batas kanonik --

test("call-site SelfHealingEngine.recover: inisiator transitif TIDAK melebar", async () => {

    seen.length = 0;

    // Log DB dilewati (instance override) — yang diukur adalah exec
    // yang dikirim ke agentHub.
    healing.log = async () => {};

    // Goal user → pemulihan transitif → worker tetap 'user'.
    await healing.recover({
        tool: "agent:janaka",
        action: "pulihkan langkah",
        error: new Error("boom"),
        goalId: "g9",
        exec: { role: "user", sessionId: "goal-user" }
    });

    assert.ok(seen.length >= 1);
    assert.equal(seen[0].role, "user",
        "pemulihan atas tujuan user tidak boleh mendapat system");

    // Goal admin → pemulihan mewarisi admin.
    seen.length = 0;
    await healing.recover({
        tool: "agent:janaka", action: "x", error: new Error("y"), goalId: "g8",
        exec: { role: "admin", sessionId: "goal-admin" }
    });
    assert.equal(seen[0].role, "admin");

});

test("call-site SelfHealingEngine.recover: batas otonom eksplisit boleh system", async () => {

    seen.length = 0;

    await healing.recover({
        tool: "agent:damar",
        action: "pemulihan mandiri watchdog",
        error: new Error("remediasi langsung gagal berulang"),
        goalId: null,
        internal: true   // ← hanya batas runtime otonom yang menyetel ini
    });

    assert.ok(seen.length >= 1);
    assert.equal(seen[0].role, "system",
        "peristiwa otonom sungguhan (tanpa inisiator) boleh system");
    assert.match(seen[0].sessionId, /^heal:/,
        "provenance grant kanonik harus tercatat");

});

// ---- B. Giliran LLM GoalEngine mewarisi inisiator ----------------------

test("call-site GoalEngine.plan: planner <= inisiator", async () => {

    seen.length = 0;
    await GoalEngine.plan({ id: "gp", title: "tujuan admin", successCriteria: [] }, {}, { role: "admin" });
    assert.ok(seen.length >= 1);
    assert.equal(seen[0].role, "admin",
        "planner harus <= admin (dulu hardcoded 'system')");

    seen.length = 0;
    await GoalEngine.plan({ id: "gu", title: "tujuan user", successCriteria: [] }, {}, { role: "user" });
    assert.equal(seen[0].role, "user");

});

test("call-site GoalEngine.evaluate: evaluator <= inisiator", async () => {

    seen.length = 0;
    await GoalEngine.evaluate(
        { id: "ge", title: "t", successCriteria: [] },
        { action: "langkah" },
        { ok: true, result: { ok: true } },
        { role: "admin" });
    assert.ok(seen.length >= 1);
    assert.equal(seen[0].role, "admin",
        "evaluator harus <= admin (dulu hardcoded 'system')");

});

test("call-site GoalEngine skill-spec LLM: <= inisiator", async () => {

    // Jalur specViaAgent sudah teruji; jalur LLM-langsung di
    // createCapability memakai turnRole() yang sama — buktikan lewat
    // kanal yang bisa dipanggil tanpa DB:
    assert.equal(GoalEngine.turnRole(resolveDelegator({ role: "admin" })), "admin");
    assert.equal(GoalEngine.turnRole(null), "user");
    assert.equal(
        GoalEngine.turnRole(resolveDelegator(null, true, "goal:g1")),
        "system");

});

// ---- D. Watchdog — batas internal otonom tunggal ------------------------

test("call-site Watchdog.escalateAutonomously: satu-satunya pemakai internal:true", async () => {

    const watchdog = require("../../src/autonomy/watchdog");
    const { Watchdog } = watchdog;

    let captured = null;
    const origRecover = healing.recover;
    healing.recover = async ctx => { captured = ctx; return { klass: "unknown", attempts: [], outcome: { ok: true } }; };
    const origJournal = Watchdog.prototype.journal;

    try {
        const w = Object.create(Watchdog.prototype);
        w.remediationFailures = {};
        w.journal = () => {};   // jangan tulis data/watchdog.json

        await w.escalateAutonomously("restart_mcp", new Error("restart gagal"), 2);

        assert.ok(captured, "eskalasi harus sampai ke SelfHealing");
        assert.equal(captured.internal, true,
            "batas otonom menandai dirinya secara eksplisit");
        assert.equal(captured.tool, "agent:damar");

        // Dan grant hasil resolusinya adalah system kanonik.
        const delegator = resolveDelegator(captured.exec ?? null, captured.internal === true, `heal:${captured.goalId ?? "?"}`);
        assert.equal(agentHub.delegatedRoleOf(delegator), "system");
        assert.match(delegator.source, /^autonomous:/);
    }
    finally {
        healing.recover = origRecover;
        Watchdog.prototype.journal = origJournal;
    }

});

// ---- 6. MissionEngine: warisi inisiator, tanpa grant -------------------

test("call-site MissionEngine.run: exec inisiator diteruskan apa adanya", async t => {

    // Stub kolaborator MissionEngine (DB memori-lab, aktivitas,
    // project, orchestrator) — kode MissionEngine tetap ASLI.
    const dbPath = require.resolve("../../src/memory/db/index.js");
    let orchExec = "BELUM-DIPANGGIL";
    let missionStatus = "PLANNING";   // stateful: transition() membaca ulang
    require.cache[dbPath] = {
        id: dbPath, filename: dbPath, loaded: true,
        exports: {
            initialize: async () => {},
            database: {
                get: async sql => {
                    if (/SELECT status FROM lab_missions/.test(sql)) return { status: missionStatus };
                    if (/FROM lab_missions WHERE id/.test(sql)) return {
                        id: "m1", project_id: "p1", title: "Misi uji", objective: "analisis data saja",
                        status: missionStatus, priority: "normal", owner_agent: null,
                        plan: null, progress: 0
                    };
                    if (/FROM lab_projects/i.test(sql)) return {
                        id: "p1", title: "Proyek", phase: "DISCOVERY", dir: "/tmp/lab-p1"
                    };
                    return null;
                },
                run: async (sql, params = []) => {
                    // transition(): UPDATE ... SET status=? (param[0] = status baru)
                    if (/UPDATE lab_missions SET status=\?/.test(String(sql))) {
                        missionStatus = params?.[0] ?? missionStatus;
                    }
                },
                all: async () => []
            }
        }
    };

    const actPath = require.resolve("../../src/lab/ActivityLog.js");
    require.cache[actPath] = { id: actPath, filename: actPath, loaded: true, exports: { record: async () => {} } };

    const projPath = require.resolve("../../src/lab/ProjectEngine.js");
    require.cache[projPath] = {
        id: projPath, filename: projPath, loaded: true,
        exports: {
            get: async () => ({ id: "p1", title: "Proyek", phase: "DISCOVERY", dir: "/tmp/lab-p1" }),
            agentsForPhase: () => ["janaka"]
        }
    };

    const orchPath = require.resolve("../../src/services/orchestrator.js");
    require.cache[orchPath] = {
        id: orchPath, filename: orchPath, loaded: true,
        exports: {
            run: async (_req, onEvent, opts) => {
                orchExec = opts?.exec ?? null;
                await onEvent({ type: "final", ok: true, final: "selesai", steps: [] });
                return { goal: "g", plan: { steps: [] }, steps: [], final: "selesai" };
            }
        }
    };

    // Hapus instance ter-cache bila ada, lalu muat segar.
    delete require.cache[require.resolve("../../src/lab/MissionEngine.js")];
    const missions = require("../../src/lab/MissionEngine.js");

    const initiator = { role: "admin", sessionId: "console:sesi-admin" };
    await missions.run("m1", { actor: "admin", exec: initiator });

    assert.deepEqual(orchExec, initiator,
        "MissionEngine harus mewarisi inisiator — tanpa grant, tanpa pelebaran");
    assert.notEqual(orchExec?.internalGrant, true);

    // Inisiator hilang → orchestrator menerima null → worker 'user'.
    orchExec = "BELUM-DIPANGGIL";
    missionStatus = "PLANNING";
    delete require.cache[require.resolve("../../src/lab/MissionEngine.js")];
    const missions2 = require("../../src/lab/MissionEngine.js");
    await missions2.run("m1", {});
    assert.equal(orchExec, null);
});
