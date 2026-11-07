const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const engine = require("../../src/core/verify/VerificationEngine");

/** Tes Verification Engine (§46, Konstitusi Pasal 5). */

const TMP = path.join(os.tmpdir(), `damar-verify-${Date.now()}`);

test.before(() => fs.mkdirSync(TMP, { recursive: true }));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("tool risiko rendah dilewati, tidak diklaim terverifikasi", () => {

    return engine.verify("calculator.calculator", {}, { result: 42 })
        .then(r => {
            assert.equal(r.state, "skipped");
            assert.notEqual(r.state, "verified", "dilewati BUKAN berarti terverifikasi");
        });

});

test("tool tanpa verifier ditandai belum terverifikasi", async () => {

    // Sengaja memakai tool yang memang belum punya verifier.
    // (Dulu tes ini memakai device_on — lalu device_on DAPAT
    // verifier, dan tes ini gagal. Kegagalan yang benar: dunia
    // berubah, tesnya yang harus menyesuaikan.)
    const r = await engine.verify("damarSkills.scene_activate", {}, { ok: true });

    assert.equal(r.state, "unverified");
    assert.ok(r.note, "harus menjelaskan kenapa belum terverifikasi");

    // Ini inti Pasal 5: ketiadaan verifier tidak boleh menjadi
    // klaim keberhasilan.
    assert.notEqual(r.state, "verified");

});

test("penulisan berkas nyata terverifikasi dengan bukti", async () => {

    const p = path.join(TMP, "nyata.txt");
    const isi = "bukti verifikasi";

    fs.writeFileSync(p, isi);

    const r = await engine.verify(
        "filesystem.writeFile",
        { path: p, content: isi },
        { success: true }
    );

    assert.equal(r.state, "verified");
    assert.equal(r.passed, r.total);

    const names = r.checks.map(c => c.name);
    assert.ok(names.includes("berkas ada"));
    assert.ok(names.includes("ukuran > 0"));
    assert.ok(names.includes("isi cocok"), "isi harus dibuktikan lewat hash, bukan diasumsikan");

});

test("KLAIM SUKSES PALSU tertangkap", async () => {

    // Inti keberadaan modul ini: tool boleh mengembalikan
    // { success: true } tanpa dunia benar-benar berubah.
    const r = await engine.verify(
        "filesystem.writeFile",
        { path: path.join(TMP, "tidak-pernah-ditulis.txt"), content: "x" },
        { success: true }          // ← tool mengaku berhasil
    );

    assert.equal(r.state, "failed", "klaim palsu harus terdeteksi");
    assert.ok(r.checks.some(c => c.name === "berkas ada" && !c.passed));

});

test("isi berbeda dari yang diminta terdeteksi", async () => {

    const p = path.join(TMP, "beda.txt");
    fs.writeFileSync(p, "isi yang salah");

    const r = await engine.verify(
        "filesystem.writeFile",
        { path: p, content: "isi yang diminta" },
        { success: true }
    );

    assert.equal(r.state, "failed", "berkas ada tapi isinya salah tetap kegagalan");
    assert.ok(r.checks.some(c => c.name === "isi cocok" && !c.passed));

});

test("penghapusan dibuktikan lewat KETIADAAN", async () => {

    const p = path.join(TMP, "hapus-aku.txt");
    fs.writeFileSync(p, "sementara");
    fs.unlinkSync(p);

    const r = await engine.verify("filesystem.deleteFile", { path: p }, { success: true });

    assert.equal(r.state, "verified");
    assert.ok(r.checks.some(c => c.name === "berkas sudah tidak ada" && c.passed));

});

test("penghapusan yang gagal tidak diklaim berhasil", async () => {

    const p = path.join(TMP, "masih-ada.txt");
    fs.writeFileSync(p, "masih di sini");

    const r = await engine.verify("filesystem.deleteFile", { path: p }, { success: true });

    assert.equal(r.state, "failed");

});

test("status HTTP dinilai, bukan dipercaya begitu saja", async () => {

    const ok = await engine.verify("http.post", {}, { status: 200 });
    assert.equal(ok.state, "verified");

    const gagal = await engine.verify("http.post", {}, { status: 500 });
    assert.equal(gagal.state, "failed");

});

test("ringkasan dapat dibaca manusia", async () => {

    const r = await engine.verify("filesystem.deleteFile", { path: "/tidak/ada" }, {});
    const s = engine.summarize(r);

    assert.equal(typeof s, "string");
    assert.ok(s.length > 0);

});
