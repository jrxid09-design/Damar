const test = require("node:test");
const assert = require("node:assert");
const { rankOf } = require("../../src/ai/tools/Authorization");

/**
 * N2 — DELEGI TIDAK MENAIKKAN OTORITAS.
 *
 * Invariant: effective worker authority <= delegating authority.
 *   - user → worker 'user'; admin → 'admin';
 *   - identitas HILANG (jalur model/eksternal) → 'user' least-privilege,
 *     TIDAK PERNAH 'system' implisit;
 *   - 'system' hanya lewat grant internal eksplisit
 *     (exec.internalGrant === true + provenance) dari pemanggil
 *     internal tepercaya (GoalEngine/SelfHealing/MissionEngine).
 */

// Stub aiRuntimeService SEBELUM agentHub di-require (lazy require di
// dalam metode → cache injection cukup).
const seen = [];
const svcPath = require.resolve("../../src/services/aiRuntimeService.js");
require.cache[svcPath] = {
    id: svcPath, filename: svcPath, loaded: true,
    exports: {
        chat: async opts => {
            seen.push({
                kind: "chat",
                role: opts.role ?? null,
                sessionId: opts.sessionId ?? null,
                tools: (opts.tools ?? []).map(t => t.name)
            });
            return { content: "ok" };
        },
        tools: () => []
    }
};

const agentHub = require("../../src/services/agentHub");

test("N2: user/director mendelegasikan → worker TIDAK mendapat 'system'", async () => {

    seen.length = 0;

    await agentHub.run("janaka", "riset topik X", {
        exec: { role: "user", sessionId: "sess-A" }
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].role, "user",
        `eksekusi worker harus mewarisi 'user', dapat '${seen[0].role}'`);
    assert.ok(rankOf(seen[0].role) >= rankOf("user"),
        "worker authority harus <= delegator (user)");
    assert.match(seen[0].sessionId, /sess-A>worker:janaka/,
        "provenance delegasi harus tercatat di sessionId");

});

test("N2: admin mendelegasikan → worker 'admin', bukan 'system'", async () => {

    seen.length = 0;

    await agentHub.run("nakula", "perbaiki bug", {
        exec: { role: "admin", sessionId: "sess-B" }
    });

    assert.equal(seen[0].role, "admin");
    assert.ok(rankOf(seen[0].role) >= rankOf("admin"),
        "worker authority harus <= delegator (admin)");

});

test("N2 Round-2: identitas HILANG dari jalur tak-tepercaya = 'user', BUKAN system", async () => {

    seen.length = 0;

    // Jalur model/eksternal tanpa identitas — dulu ini diam-diam
    // menjadi 'system' (lubang eskalasi yang ditutup).
    await agentHub.run("nakula", "cek disk", {});

    assert.equal(seen[0].role, "user",
        `tanpa identitas harus least-privilege 'user', dapat '${seen[0].role}'`);

});

test("N2 Round-2: tabel probe delegatedRoleOf (probes wajib)", () => {

    // admin → orchestrate → worker
    assert.equal(agentHub.delegatedRoleOf({ role: "admin" }), "admin");
    assert.ok(rankOf(agentHub.delegatedRoleOf({ role: "admin" })) >= rankOf("admin"));

    // user → model tool → orchestrate → worker
    assert.equal(agentHub.delegatedRoleOf({ role: "user" }), "user");

    // identitas hilang dari jalur model/eksternal
    assert.equal(agentHub.delegatedRoleOf(null), "user");
    assert.equal(agentHub.delegatedRoleOf(undefined), "user");
    assert.equal(agentHub.delegatedRoleOf({}), "user");

    // grant HANYA kanonik (symbol in-process dari resolveDelegator);
    // objek tiruan — bahkan dengan source 'autonomous:*' — tidak sah.
    const { isCanonicalInternalGrant } = require("../../src/ai/tools/Authorization");
    const { mintCanonicalInternalGrant } = require("../../src/ai/tools/internalGrant");

    const canonical = mintCanonicalInternalGrant({ provenance: "watchdog:probe" });
    assert.equal(agentHub.delegatedRoleOf(canonical), "system");

    for (const forged of [
        { internalGrant: true, source: "autonomous:watchdog" },
        { internalGrant: true, source: "goal-engine" },
        { internalGrant: true }
    ]) {
        assert.equal(isCanonicalInternalGrant(forged), false);
        assert.equal(agentHub.delegatedRoleOf(forged), "user",
            "grant tiruan harus jatuh ke user");
    }

});

test("N2 Round-2: skill wrapper meneruskan exec ke delegasi", async () => {

    // Jalur nyata: ToolExecutor memanggil execute(args, {exec}) —
    // skill orchestrate wajib meneruskan ctx.exec ke orchestrator.
    seen.length = 0;

    const skills = require("../../src/plugins/damarSkills/tools.js");

    const orch = skills.find(t => t.name === "orchestrate");

    await orch.execute(
        { request: "tugas dari model" },
        { exec: { role: "user", sessionId: "model-sess" } });

    // orchestrator.run → agentHub.run('damar') → runDamar harus
    // membawa peran 'user', bukan 'system'.
    assert.ok(seen.length >= 1, "delegasi harus sampai ke chat");
    for (const s of seen) {
        assert.ok(rankOf(s.role ?? "user") >= rankOf("user"),
            `jalur model tidak boleh mendapat '${s.role}'`);
    }

});

test("N2-FINAL: grant kanonik boleh system; palsuan tidak", async () => {

    const { mintCanonicalInternalGrant } = require("../../src/ai/tools/internalGrant");

    // Sah: grant lahir dari titik kanonik dengan provenance otonom.
    seen.length = 0;
    await agentHub.run("nakula", "cek disk", {
        exec: mintCanonicalInternalGrant({ provenance: "goal:t1" })
    });
    assert.equal(seen[0].role, "system",
        "grant internal eksplisit dengan provenance otonom boleh 'system'");
    assert.match(seen[0].sessionId, /goal:t1>worker:nakula/);

    // Palsuan: internalGrant tanpa provenance kanonik → 'user'.
    seen.length = 0;
    await agentHub.run("nakula", "cek disk", {
        exec: { internalGrant: true, source: "goal-engine", sessionId: "palsu" }
    });
    assert.equal(seen[0].role, "user",
        "internalGrant non-kanonik tidak boleh menghasilkan system");

});

test("N2: direktor 'damar' mewarisi peran delegator", async () => {

    seen.length = 0;

    await agentHub.run("damar", "pikirkan arsitektur", {
        exec: { role: "user", sessionId: "sess-C" }
    });

    assert.equal(seen[0].role, "user");

});
