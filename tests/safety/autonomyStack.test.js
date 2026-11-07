const { test } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Bukti bahwa tulang punggung otonomi Damar BENAR-BENAR terpasang,
 * bukan sekadar ada sebagai berkas (§53, §55, §56).
 *
 * Yang diuji di sini hanya bagian DETERMINISTIK — yang tidak menuntut
 * panggilan model hidup: pemuatan modul, penemuan tool (§7), pencarian
 * kapabilitas (§36), dan kehadiran computer control (§8). Loop penuh
 * (§16) menuntut model responsif dan diuji terpisah saat model
 * tersedia; kegagalan model di sana bukan kegagalan mesin otonominya.
 */

test("§53 seluruh modul autonomy dimuat tanpa melempar", () => {
    const A = require("../../src/autonomy");
    for (const nama of ["toolBus", "capabilities", "skillFactory", "goals", "healing", "modelRouter", "checkpoints", "environment"]) {
        assert.ok(A[nama], `modul ${nama} harus ada`);
    }
    assert.equal(typeof A.init, "function");
});

test("§7 ToolBus menemukan tool nyata", () => {
    const A = require("../../src/autonomy");
    const tools = A.toolBus.discover();
    assert.ok(Array.isArray(tools), "discover() harus mengembalikan array");
    assert.ok(tools.length > 0, "harus ada tool terdaftar");
    for (const t of tools.slice(0, 5)) {
        assert.ok(t.name || t.id, "tool harus punya name/id");
    }
});

test("§8 computer control benar-benar terekspos", () => {
    const dc = require("../../src/services/desktopControlService");
    assert.equal(typeof dc.openApp, "function", "desktopControlService.openApp harus fungsi");
});

test("§36 capability discovery mengembalikan kandidat dari kueri alami", async () => {
    const A = require("../../src/autonomy");
    // Registry menamainya discover(query) — inilah gerbang §36 sebelum
    // Damar memutuskan membuat kapabilitas baru.
    // Kueri berisi → { capabilities, packages }: kandidat terdaftar
    // plus paket yang bisa dipasang (§36 lapis 3, §11).
    const hasil = await A.capabilities.discover("kirim pesan", { limit: 5 });
    assert.ok(Array.isArray(hasil.capabilities), "discover harus punya daftar capabilities");
    assert.ok(Array.isArray(hasil.packages), "discover harus melaporkan paket yang bisa dipasang");
});

test("tool-discovery: ToolBus.resolve mengenal kedua gaya nama (§7/§36)", (t) => {
    const A = require("../../src/autonomy");

    // Tool waktu terdaftar plugin sebagai "system.time.currentTime"
    // dengan nama pendek "currentTime". Sebelum perbaikan, resolve hanya
    // cocok persis — jadi "jam" jatuh ke agent yang model-loop lalu
    // timeout. Kini KEDUA bentuk harus menemukan tool yang sama.
    //
    // Discovery hanya bermakna bila tool memang sudah termuat. Di
    // lingkungan tes bare (tanpa daemon), registry bisa kosong — di situ
    // yang benar adalah SKIP, bukan gagal palsu.
    const tools = A.toolBus.discover();
    if (!tools.some(x => String(x.name).split(/__|\./).pop() === "currentTime")) {
        return t.skip("tool waktu belum termuat di lingkungan tes ini");
    }

    const penuh = A.toolBus.resolve("system.time.currentTime");
    const pendek = A.toolBus.resolve("currentTime");
    assert.ok(penuh, "nama plugin penuh harus resolve");
    assert.ok(pendek, "nama pendek harus resolve ke tool yang sama");
});

test("§37 self-extending: pathPolicy tidak lagi memblokir tulis ke inti sendiri", () => {
    const path = require("node:path");
    const pathPolicy = require("../../src/core/safety/pathPolicy");
    const core = path.join(__dirname, "..", "..", "src", "core", "safety", "killSwitch.js");
    assert.doesNotThrow(() => pathPolicy.assertPathAllowed(core, true));
});
