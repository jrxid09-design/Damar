const test = require("node:test");
const assert = require("node:assert");

const ToolExecutor = require("../../src/ai/tools/ToolExecutor");
const { AIToolRegistry } = require("../../src/ai/tools");
const AITool = require("../../src/ai/tools/AITool");
const loopGuard = require("../../src/core/safety/loopGuard");
const riskCatalog = require("../../src/core/safety/riskCatalog");

/**
 * Rantai keselamatan di JALUR MODEL (§33, §37, §38, §140, §46).
 *
 * Tool asli model tidak melewati registry inti. Selama rantai hanya
 * ada di sana, `terminal_run` dan `code_commit` berjalan tanpa
 * otorisasi sama sekali. Tes ini mengunci bahwa jalur model dijaga
 * oleh rantai yang sama.
 */

function registryWith(...tools) {
    const r = new AIToolRegistry();
    for (const t of tools) r.register(t);
    return r;
}

const probe = (name, onCall = () => ({ ok: true })) =>
    new AITool({ name, description: "probe", execute: async args => onCall(args) });

test("tool asli model dijaga rem kebuntuan", async () => {

    const exec = new ToolExecutor(registryWith(probe("memory_recall")));

    loopGuard.resetAll();

    const hasil = [];

    for (let i = 0; i < 5; i++) {
        try {
            await exec.execute({ id: `p${i}`, name: "memory_recall", arguments: { query: "identik" } });
            hasil.push("lolos");
        } catch (e) {
            hasil.push(e.code);
        }
    }

    assert.deepEqual(
        hasil,
        ["lolos", "lolos", "lolos", "lolos", "LOOP_DETECTED"],
        "panggilan identik ke-5 harus dihentikan, bukan diteruskan"
    );

});

test("tool destruktif asli model berjalan dengan identitas sah (tanpa konfirmasi manual)", async () => {

    let dijalankan = false;

    const exec = new ToolExecutor(
        registryWith(probe("terminal_run", () => { dijalankan = true; return { ok: true }; }))
    );

    loopGuard.resetAll();

    // Kontrak BARU (otorisasi kini hidup): jalur pemilik berjalan dengan
    // identitas eksplisit; tanpa identitas = 'user' fail-closed DENY.
    // Yang dikunci di sini: tool destruktif TIDAK ditahan gerbang
    // konfirmasi, tetap tercatat & terverifikasi.
    const r = await exec.execute(
        { id: "r1", name: "terminal_run", arguments: { command: "echo x" } },
        { role: "superadmin", channel: "console", sessionId: "tes-owner" });

    assert.equal(dijalankan, true, "tool berjalan dengan otorisasi pemilik");
    assert.ok(r.result, "hasil dikembalikan");

});

test("tool destruktif asli model TANPA identitas DITOLAK fail-closed", async () => {

    let dijalankan = false;

    const exec = new ToolExecutor(
        registryWith(probe("terminal_run", () => { dijalankan = true; return { ok: true }; }))
    );

    loopGuard.resetAll();

    await assert.rejects(
        () => exec.execute({ id: "r2", name: "terminal_run", arguments: {} }),
        e => e.code === "PERMISSION_DENIED",
        "identitas hilang = 'user', terminal_run bukan allowlist user"
    );

    assert.equal(dijalankan, false);

});

test("tool jembatan TIDAK dijaga dua kali", async () => {

    // Penjagaan ganda membuat rem kebuntuan menghitung satu
    // panggilan sebagai dua, sehingga tool sah tertahan pada
    // panggilan ke-3, bukan ke-5.
    const bridged = probe("filesystem__readFile");
    bridged.bridged = "filesystem.readFile";

    const exec = new ToolExecutor(registryWith(bridged));

    loopGuard.resetAll();

    let lolos = 0;

    for (let i = 0; i < 4; i++) {
        await exec.execute(
            { id: `b${i}`, name: "filesystem__readFile", arguments: { path: "x" } },
            { role: "superadmin", channel: "console", sessionId: "tes-owner" });
        lolos += 1;
    }

    assert.equal(lolos, 4, "registry inti yang menjaga tool jembatan");

});

test("hasil tool asli model membawa laporan verifikasi", async () => {

    const exec = new ToolExecutor(registryWith(probe("memory_recall")));

    loopGuard.resetAll();

    const r = await exec.execute({
        id: "v1",
        name: "memory_recall",
        arguments: { query: "sekali saja" }
    });

    assert.ok(r.result.verification, "verifikasi harus tertempel");
    assert.equal(r.result.verification.tool, "memory_recall");

});

test("STOP tetap menghentikan tool asli model", async () => {

    // Dulu kill switch dipanggil langsung di ToolExecutor. Sekarang
    // ia bagian dari rantai bersama — tes ini mengunci bahwa
    // pemindahan itu tidak melonggarkan rem.
    const killSwitch = require("../../src/core/safety/killSwitch");

    let dijalankan = false;

    const exec = new ToolExecutor(
        registryWith(probe("memory_recall", () => { dijalankan = true; return { ok: true }; }))
    );

    loopGuard.resetAll();

    killSwitch.engage({ reason: "tes", actor: "tes" });

    try {

        await assert.rejects(
            () => exec.execute({ id: "s1", name: "memory_recall", arguments: { query: "saat berhenti" } }),
            e => e.code === "SAFETY_STOP_ENGAGED"
        );

        assert.equal(dijalankan, false);

    }
    finally {
        killSwitch.release({ actor: "tes" });
    }

});

test("tool tak dikenal ditolak sebelum penjagaan", async () => {

    const exec = new ToolExecutor(registryWith());

    await assert.rejects(
        () => exec.execute({ id: "x", name: "tidak_ada", arguments: {} }),
        /not found/
    );

});

// ---- Katalog risiko ---------------------------------------------

test("'get' di dalam 'forget' tidak membuatnya terlihat berbahaya", () => {

    // Pola substring lama membaca `memory_forget` sebagai pembacaan
    // murni karena "get" ada di dalamnya. Kini kata harus berdiri
    // sendiri — dan lupa lunak memang bukan tindakan destruktif.
    assert.equal(riskCatalog.riskOf("memory_forget"), false);
    assert.equal(riskCatalog.riskOf("forget_everything"), false);

});

test("kata harus berdiri sebagai kata, bukan potongan", () => {

    const kasus = [
        ["target_lock",   false],  // "lock" di dalam "target" tidak dihitung
        ["budget_report", false],
        ["readFile",      false],  // punuk camelCase tetap terbaca
        ["runCommand",    true],
        ["terminal_run",  true]
    ];

    for (const [id, harapan] of kasus) {
        assert.equal(riskCatalog.riskOf(id), harapan, `${id} harus ${harapan ? "destruktif" : "aman"}`);
    }

});

test("tool destruktif inti terdaftar eksplisit", () => {

    for (const id of ["terminal_run", "home_control", "filesystem.deleteFile"]) {
        assert.ok(
            riskCatalog.DESTRUCTIVE.has(id),
            `${id} harus terdaftar eksplisit sebagai destruktif`
        );
    }

});

test("tool baca murni tidak ikut terkunci", () => {

    for (const id of ["code_hover", "code_definition", "home_state", "terminal_read"]) {
        assert.equal(riskCatalog.riskOf(id), false, `${id} hanya membaca`);
    }

});

test("eksekusi perintah sembarang tetap destruktif di mana pun terdaftar", () => {

    assert.equal(riskCatalog.riskOf("run-command.runCommand"), true);
    assert.equal(riskCatalog.riskOf("terminal_run"), true);

});
