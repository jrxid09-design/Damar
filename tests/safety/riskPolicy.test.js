const test = require("node:test");
const assert = require("node:assert");

const { riskOf } = require("../../src/core/safety/riskCatalog");
const riskPolicy = require("../../src/core/safety/riskPolicy");

/** Tes klasifikasi destruktif & guard selalu-mengizinkan. */

test("tool destruktif terklasifikasi destruktif", () => {

    assert.equal(riskOf("filesystem.deleteFile"), true);
    assert.equal(riskOf("run-command.runCommand"), true);
    assert.equal(riskOf("terminal_run"), true);

});

test("tool baca terklasifikasi aman", () => {

    assert.equal(riskOf("calculator.calculator"), false);
    assert.equal(riskOf("filesystem.readFile"), false);
    assert.equal(riskOf("http.get"), false);
    assert.equal(riskOf("damarSkills.recall"), false);
    assert.equal(riskOf("memory_recall"), false);

});

test("kendali dunia fisik terklasifikasi destruktif", () => {

    // Menyalakan lampu di rumah nyata tidak boleh sekelas
    // dengan membaca berkas.
    assert.equal(riskOf("damarSkills.device_on"), true);
    assert.equal(riskOf("damarSkills.set_temperature"), true);
    assert.equal(riskOf("cursor-control.controlCursor"), true);
    assert.equal(riskOf("home_control"), true);

});

test("E-F: outbound messaging destruktif — TIDAK parallel-safe/read-only", () => {

    // Temuan E: dulu wa_send/wa_broadcast terklasifikasi read-only
    // karena katalog memuat nama bare sementara model menjalankan
    // nama bridged — dua pesan keluar bisa dirangkai Promise.all.
    // Klasifikasi kanonik kini menangkap SEMUA bentuk live-nya.
    assert.equal(riskOf("damarSkills.wa_send"), true);
    assert.equal(riskOf("damarSkills.wa_broadcast"), true);
    assert.equal(riskOf("damarSkills__wa_send"), true);
    assert.equal(riskOf("wa_send"), true);
    // HTTP post biasa bukan outbound messaging Damar.
    assert.equal(riskOf("http.post"), false);

});

test("tool tak dikenal dianggap aman — klasifikasi tidak menahan segalanya", () => {

    assert.equal(riskOf("tool.yang.belum.pernah.ada"), false);

});

test("pola nama menangkap tool buatan sendiri yang berbahaya", () => {

    // Tool hasil forge tidak ada di katalog; polanya yang menjaga.
    assert.equal(riskOf("myplugin.deleteEverything"), true);
    assert.equal(riskOf("myplugin.runShellScript"), true);
    assert.equal(riskOf("myplugin.sendEmail"), false);
    assert.equal(riskOf("myplugin.listItems"), false);

});

test("tool dapat mendeklarasikan dirinya sendiri", () => {

    assert.equal(
        riskOf("calculator.calculator", { metadata: { destructive: true } }),
        true,
        "deklarasi tool harus mengalahkan katalog"
    );

    assert.equal(
        riskOf("filesystem.deleteFile", { metadata: { destructive: false } }),
        false,
        "deklarasi aman pun dihormati bila tool menyatakannya sendiri"
    );

});

test("guard selalu mengizinkan: semua tool lolos tanpa dilempar", () => {

    assert.doesNotThrow(() => riskPolicy.assertAllowed("calculator.calculator"));
    assert.doesNotThrow(() => riskPolicy.assertAllowed("damarSkills.wa_send"));
    assert.doesNotThrow(() => riskPolicy.assertAllowed("filesystem.writeFile"));
    assert.doesNotThrow(() => riskPolicy.assertAllowed("run-command.runCommand"));
    assert.doesNotThrow(() => riskPolicy.assertAllowed("terminal_run"));

});

test("bahaya tetap dilaporkan walau tidak pernah ditahan", () => {

    assert.equal(riskPolicy.assertAllowed("run-command.runCommand"), true);
    assert.equal(riskPolicy.assertAllowed("terminal_run"), true);
    assert.equal(riskPolicy.assertAllowed("calculator.calculator"), false);

});

test("keadaan kebijakan mencerminkan guard yang selalu terbuka", () => {

    const s = riskPolicy.state();

    assert.equal(s.enforcement.enabled, false);
    assert.deepEqual(s.authorizations, {});

});
