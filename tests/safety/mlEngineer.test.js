const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { probe } = require("../../src/ml/env");
const { mlTools } = require("../../src/ml/tools");

/**
 * Peneliti & insinyur ML (Damar 2.0).
 *
 * Yang dijaga: probe lingkungan JUJUR (tak mengaku GPU tanpa bukti),
 * tool terdaftar & terpilih, dan doktrin metode ilmiah + anti-bocor
 * ada di prompt.
 */

test("ml_env melaporkan lingkungan nyata tanpa mengarang GPU", async () => {

    const r = await probe();

    // Bebas-lingkungan: ok true/false valid, tapi bentuknya harus jujur.
    assert.equal(typeof r.ok, "boolean");
    assert.ok(Array.isArray(r.gpu));

    if (r.ok) {
        assert.equal(typeof r.python, "string");
        assert.equal(typeof r.frameworks, "object");
        // CUDA hanya boleh 'siap' bila memang terdeteksi torch.cuda.
        if (/CUDA siap/.test(r.catatan)) assert.equal(r.cuda.available, true);
    } else {
        // Tanpa Python: katakan apa adanya, jangan menyalahkan torch.
        assert.match(r.catatan, /Python/);
        assert.doesNotMatch(r.catatan, /torch tidak terpasang/i);
    }

});

test("tool ml_env & ml_run terdaftar dan profil selektor ada", () => {

    assert.deepEqual(mlTools().map(t => t.name), ["ml_env", "ml_run"]);

    const selector = fs.readFileSync(
        path.join(__dirname, "../../src/ai/tools/ToolSelector.js"), "utf8"
    );
    assert.match(selector, /ml: \[/);
    assert.match(selector, /"ml_env"/);
    assert.match(selector, /"ml_run"/);
    assert.match(selector, /"pytorch"/);

});

test("ml_run mengeksekusi Python nyata dan mengembalikan exit-code apa adanya", async () => {

    const { run } = require("../../src/ml/env");

    const ok = await run({ code: "print(6*7)" });
    if (ok.error && /tak ditemukan/.test(ok.error)) return;   // tanpa Python: lewati

    assert.equal(ok.ok, true);
    assert.match(ok.stdout, /42/);
    assert.equal(typeof ok.seconds, "number");

    // Kegagalan = data, bukan exception yang menelan keluaran.
    const gagal = await run({ code: "raise SystemExit(3)" });
    assert.equal(gagal.ok, false);
    assert.equal(gagal.code, 3);

});

test("doktrin ML dimuat untuk pesan riset, memuat empat topi peran", () => {

    const { doctrineFor } = require("../../src/prompts/doctrines");
    const d = doctrineFor("latih model klasifikasi dari dataset ini");

    assert.match(d, /PENELITI & INSINYUR ML SENIOR/);
    assert.match(d, /EMPAT TOPI/);
    assert.match(d, /Machine Learning Engineer/);
    assert.match(d, /Deep Learning Engineer/);
    assert.match(d, /Research Engineer/);
    assert.match(d, /AI Architect/);
    assert.match(d, /BASELINE/);
    assert.match(d, /ANTI-BOCOR/);
    assert.match(d, /ml_run/);

    assert.equal(doctrineFor("apa kabar hari ini"), "");

});
