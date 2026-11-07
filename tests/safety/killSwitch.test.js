const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG = path.join(__dirname, "..", "..", "configs", "safety.json");

/**
 * Tes kill switch (§37).
 *
 * Modul ini menulis ke configs/safety.json yang dipakai produksi,
 * jadi isinya dicadangkan dan dipulihkan. Tes keselamatan tidak
 * boleh meninggalkan sistem dalam keadaan berhenti.
 */

let snapshot = null;

test.before(() => {
    snapshot = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, "utf8") : null;
});

test.after(() => {
    // Sengaja TIDAK menghapus berkasnya walau tadinya belum ada:
    // berkas tes lain memakai konfigurasi yang sama, dan
    // menghapusnya di tengah jalan memicu ENOENT pada penulisan
    // atomik mereka. Kembalikan isinya saja.
    if (snapshot !== null) fs.writeFileSync(CONFIG, snapshot, "utf8");
});

test("awalnya tidak berhenti, dan tool boleh jalan", () => {

    const killSwitch = require("../../src/core/safety/killSwitch");

    killSwitch.release({ actor: "test" });

    assert.equal(killSwitch.isEngaged(), false);
    assert.doesNotThrow(() => killSwitch.assertRunning("calculator.calculator"));

});

test("STOP memblokir eksekusi tool", () => {

    const killSwitch = require("../../src/core/safety/killSwitch");

    killSwitch.engage({ reason: "uji", actor: "test" });

    assert.equal(killSwitch.isEngaged(), true);

    assert.throws(
        () => killSwitch.assertRunning("calculator.calculator"),
        err => err.code === "SAFETY_STOP_ENGAGED",
        "assertRunning harus melempar SAFETY_STOP_ENGAGED saat berhenti"
    );

    killSwitch.release({ actor: "test" });

});

test("tool baca-saja tetap lolos saat berhenti", () => {

    // Pemilik harus tetap bisa melihat keadaan sistem untuk
    // memutuskan apakah aman melanjutkan.
    const killSwitch = require("../../src/core/safety/killSwitch");

    killSwitch.engage({ reason: "uji", actor: "test" });

    assert.doesNotThrow(
        () => killSwitch.assertRunning("damarSkills.system_health"),
        "tool dalam allowlist baca-saja harus lolos"
    );

    killSwitch.release({ actor: "test" });

});

test("STOP bertahan di berkas, bukan hanya di memori", () => {

    // Kalau daemon crash lalu hidup lagi, otonomi tidak boleh
    // menyala diam-diam.
    const killSwitch = require("../../src/core/safety/killSwitch");

    killSwitch.engage({ reason: "uji persistensi", actor: "test" });

    const saved = JSON.parse(fs.readFileSync(CONFIG, "utf8"));

    assert.equal(saved.stopped, true);
    assert.equal(saved.reason, "uji persistensi");
    assert.ok(saved.since, "waktu berhenti harus tercatat");

    killSwitch.release({ actor: "test" });

    const after = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    assert.equal(after.stopped, false);

});

test("engage dua kali tidak error, dan menandai sudah berhenti", () => {

    const killSwitch = require("../../src/core/safety/killSwitch");

    killSwitch.release({ actor: "test" });

    const first = killSwitch.engage({ reason: "sekali", actor: "test" });
    const second = killSwitch.engage({ reason: "dua kali", actor: "test" });

    assert.equal(first.alreadyEngaged, false);
    assert.equal(second.alreadyEngaged, true);

    // Alasan pertama dipertahankan — yang penting kenapa MULAI berhenti.
    assert.equal(second.reason, "sekali");

    killSwitch.release({ actor: "test" });

});
