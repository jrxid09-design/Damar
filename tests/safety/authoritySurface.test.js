const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const Authorization = require("../../src/ai/tools/Authorization");
const { resolveDelegator, isCanonicalInternalGrant } = Authorization;
const lint = require("../helpers/authorityLint");

/**
 * B/F — INVARIAN OTORITAS YANG DITEGAKKAN SECARA STRUKTURAL.
 *
 * Guard memeriksa DUA kelas pelanggaran di seluruh berkas sumber
 * (src, rekursif):
 *
 *   1. PEMBENTUKAN OTORITAS tanpa sah:
 *      literal peran eksekusi privileged ("system"/"admin"/
 *      "superadmin") — termasuk lewat VARIABEL (camelCase pun),
 *      peran terkomputasi (`cond ? "system" : "user"`), dan
 *      objek chat({messages,...}) biasa yang menyelundupkan role.
 *      Objek PESAN ({role:"system", content}) BUKAN identitas.
 *
 *   2. KEHILANGAN RESTRIKSI di transit: berkas yang membawa konteks
 *      delegasi (`exec`) wajib membawa bukti capabilitySet pada
 *      tiap panggilan chat()/stream() — kelas bug watchdog:
 *      grant kanonik membawa set, hop agentHub→aiRuntime menjatuhkan.
 *
 * Situs tersanksi eksplisit ada di ALLOWLIST (dengan alasan).
 */

const SRC = path.join(__dirname, "..", "..", "src");

test("B/F-STATIS: tidak ada pembentukan otoritas & tidak ada pelucutan restriction", () => {
    const violations = lint.scanTree(SRC);
    assert.deepEqual(violations, [],
        `pelanggaran permukaan otoritas ditemukan:\n${violations.join("\n")}`);
});

// ---- FIKTUR NEGATIF: guard HARUS menangkap tiap kelas -------------------

test("B/F-STATIS: fiksur negatif — detektor menangkap semua kelas pelanggaran", () => {

    // Kelas 1a: literal role dalam objek chat({messages,...}) TANPA content
    const k1a = lint.scanSource(
        `aiRuntime.chat({ messages, role: "system", sessionId });`,
        "fiktur/a.js");
    assert.ok(k1a.some(v => /role/.test(v)), "literal role harus tertangkap");

    // Kelas 1b: variabel camelCase pembawa otoritas
    const k1b = lint.scanSource(
        `const systemRole = "system";
         aiRuntime.chat({ messages, role: systemRole });`,
        "fiktur/b.js");
    assert.ok(
        k1b.some(v => /systemRole/.test(v)),
        "variabel camelCase harus tertangkap");

    // Kelas 1c: peran terkomputasi
    const k1c = lint.scanSource(
        `ai.chat({ messages, role: flag ? "system" : "user" });`,
        "fiktur/c.js");
    assert.ok(k1c.length >= 1, "peran terkomputasi harus tertangkap");

    // Kelas 2: PELUCUTAN capabilitySet — bentuk PERSIS bug watchdog:
    // fungsi membawa exec delegator, tetapi chat() menjatuhkan set.
    const dropFixture = `
        async runDamar(task, { contextRefs = [], exec = null } = {}) {
            const response = await aiRuntime.chat({
                messages: [{ role: "user", content: String(task) }],
                contextRefs,
                role: this.delegatedRoleOf(exec),
                sessionId: exec?.sessionId ?? "anon"
            });
            return response.content ?? "";
        }
    `;
    const k2 = lint.scanSource(dropFixture, "fiktur/d.js");
    assert.ok(
        k2.some(v => /capabilitySet/.test(v)),
        "KELAS BUG WATCHDOG (capabilitySet-drop) WAJIB tertangkap");

    // Versi diperbaiki dari fiktur yang sama TIDAK melanggar.
    const fixedFixture = dropFixture.replace(
        "sessionId: exec?.sessionId ?? \"anon\"",
        "sessionId: exec?.sessionId ?? \"anon\",\n                capabilitySet: exec?.capabilitySet"
    );
    assert.deepEqual(lint.scanSource(fixedFixture, "fiktur/e.js"), []);

    // Pesan chat sah tetap dikecualikan.
    const okMsg = lint.scanSource(
        `const msgs = [{ role: "system", content: "halo" }];`,
        "fiktur/f.js");
    assert.deepEqual(okMsg, [], "objek pesan bukan identitas eksekusi");

});

// ---- C. Watchdog recovery capability set (ID KANONIK) ------------------

const watchdogMod = require("../../src/autonomy/watchdog");
const { Watchdog } = watchdogMod;
const healing = require("../../src/autonomy/SelfHealingEngine");

const FORBIDDEN = [
    "terminal_run",
    "create_tool",
    "skill_build",
    "filesystem.writeFile",
    "filesystem.deleteFile",
    "kali_run",
    "wa_send",
    "damarSkills__wa_send",
    "wa_broadcast",
    "whatsapp_send_photo",
    "goal_run"
];

test("C: himpunan kapabilitas watchdog tertutup & tanpa kapabilitas berbahaya", () => {

    const set = Watchdog.RECOVERY_CAPABILITIES;

    assert.ok(Array.isArray(set) && set.length > 0);
    assert.ok(Object.isFrozen(set), "set harus dibekukan");

    for (const f of FORBIDDEN) {
        assert.ok(!set.includes(f), `${f} tidak boleh dalam set pemulihan`);
        // tail juga tak boleh menabrak (mis. 'writeFile')
        assert.ok(!set.includes(f.split(/[._]/).pop()),
            `tail '${f.split(/[._]/).pop()}' tidak boleh dalam set pemulihan`);
    }

});

test("C: gerbang eksekusi MENOLAK kapabilitas di luar set — bahkan untuk system", () => {

    const set = Watchdog.RECOVERY_CAPABILITIES;

    for (const f of FORBIDDEN) {
        assert.throws(
            () => Authorization.assertExecution(
                { name: f }, { role: "system", channel: "autonomous", capabilitySet: set }),
            e => e.code === "PERMISSION_DENIED",
            `${f} harus DENY walau eksekutor system`
        );
    }

    // Anggota set tetap boleh — lewat BENTUK LIVE-nya:
    // native persis, dan nama model-facing bridged yang kanoniknya
    // sama dengan entri set.
    const liveMembers = [
        "memory_recall",                    // native
        "tool_search",                      // native meta
        "system__time__currentTime",        // bridged dari system.time.currentTime
        "damarSkills__system_health",      // bridged dari damarSkills.system_health
        "damarSkills__agents_status"       // bridged dari damarSkills.agents_status
    ];
    for (const ok of liveMembers) {
        assert.doesNotThrow(() =>
            Authorization.assertExecution(
                { name: ok }, { role: "system", channel: "autonomous", capabilitySet: set }),
            `${ok} adalah anggota set pemulihan (bentuk live)`);
    }

});

test("C/CANONICAL: tail collision TIDAK memberi otoritas", () => {

    const set = Watchdog.RECOVERY_CAPABILITIES;

    // Plugin jahat mendaftar capability yang ruas akhirnya menabrak
    // anggota set — ia TIDAK masuk grant, baik eksekusi maupun disklosur.
    for (const evil of [
        "evil__system_health",
        "evilplugin__memory_recall",
        "mcp__evil__tool_search"
    ]) {
        assert.throws(
            () => Authorization.assertExecution(
                { name: evil }, { role: "system", channel: "autonomous", capabilitySet: set }),
            e => e.code === "PERMISSION_DENIED",
            `${evil} tidak boleh lolos karena tail collision`);

        const disclosed = Authorization.disclosureFilter(
            [{ name: evil, description: "evil" }],
            { role: "system", channel: "autonomous", capabilitySet: set });
        assert.equal(disclosed.length, 0, `${evil} tidak boleh terdisklosur`);
    }

});

test("C: eskalasi watchdog membawa capability set sampai ke pemulihan", async () => {

    let captured = null;
    const orig = healing.recover;
    healing.recover = async ctx => { captured = ctx; return { klass: "unknown", attempts: [], outcome: { ok: true } }; };
    const origJournal = Watchdog.prototype.journal;
    Watchdog.prototype.journal = () => {};

    try {
        const w = Object.create(Watchdog.prototype);
        w.remediationFailures = {};
        await w.escalateAutonomously("restart_mcp", new Error("gagal"));

        assert.equal(captured?.internal, true);
        assert.deepEqual(captured?.capabilitySet, Watchdog.RECOVERY_CAPABILITIES);

        // Dan delegasi hasil kanonik terkunci pada set itu:
        const delegator = resolveDelegator(null, true, `heal:${captured.goalId ?? "?"}`);
        const scoped = { ...delegator, capabilitySet: captured.capabilitySet };

        assert.throws(() =>
            Authorization.assertExecution(
                { name: "terminal_run" }, { ...scoped, role: undefined }),
            e => e.code === "PERMISSION_DENIED");
    }
    finally {
        healing.recover = orig;
        Watchdog.prototype.journal = origJournal;
    }

});

// ---- D. Token symbol — pemalsuan lintas-batas mustahil ------------------

test("D: grant kanonik ber-token symbol; JSON/objek palsu tidak dipercaya", () => {

    const grant = require("../../src/ai/tools/internalGrant")
        .mintCanonicalInternalGrant({ provenance: "watchdog:test" });

    assert.equal(isCanonicalInternalGrant(grant), true);

    // Lintasan JSON (HTTP/MCP/model) memusnahkan symbol → bukan grant.
    const throughJson = JSON.parse(JSON.stringify(grant));
    assert.equal(isCanonicalInternalGrant(throughJson), false);
    assert.equal(throughJson.source, grant.source,
        "label telemetri ikut, tapi ia bukan bukti trust");

    // Objek tiruan sempurna bentuk string pun tetap ditolak.
    assert.equal(isCanonicalInternalGrant({
        internalGrant: true,
        source: grant.source,
        sessionId: grant.sessionId
    }), false);

    // Identitas berperan dengan token dicuri pun dilucuti.
    const stolen = { ...grant, role: "user" };
    const inherited = resolveDelegator(stolen);
    assert.equal(isCanonicalInternalGrant(inherited), false);
    assert.equal(inherited.role, "user");

});
