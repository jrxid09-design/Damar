const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { verifierFor } = require("../../src/core/verify/verifiers");

/**
 * Verifier git (§46, Konstitusi Pasal 5).
 *
 * `gitPatcher.restore()` menelan kegagalan git dan tetap
 * mengembalikan `{ restored: [...] }`. Tanpa verifier, rollback yang
 * gagal total terbaca berhasil — persis klaim palsu yang hendak
 * dihapus. Tes ini memakai repo sungguhan di direktori sementara.
 */

let repo = null;

const git = (...argv) =>
    execFileSync("git", argv, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

test.before(() => {

    repo = fs.mkdtempSync(path.join(os.tmpdir(), "damar-verify-"));

    git("init", "-q");
    git("config", "user.email", "uji@damar.local");
    git("config", "user.name", "Uji Damar");
    git("config", "commit.gpgsign", "false");

    fs.writeFileSync(path.join(repo, "awal.txt"), "isi mula-mula\n");

    git("add", "-A");
    git("commit", "-q", "-m", "commit awal");

});

test.after(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); }
    catch { /* biarkan OS yang membersihkan */ }
});

const jalankan = async (tool, args, result = {}) =>
    verifierFor(tool)(args, result);

// ---- code_commit -------------------------------------------------

test("commit nyata terverifikasi lewat HEAD, bukan lewat klaim tool", async () => {

    fs.writeFileSync(path.join(repo, "baru.txt"), "tambahan\n");
    git("add", "-A");
    git("commit", "-q", "-m", "tambah berkas baru");

    const { checks } = await jalankan(
        "code_commit",
        { message: "tambah berkas baru", project: repo },
        { committed: true }
    );

    assert.ok(checks.every(c => c.passed), JSON.stringify(checks));

});

test("KLAIM COMMIT PALSU tertangkap — pesan tidak ada di HEAD", async () => {

    // Tool melapor berhasil, tetapi commit dengan pesan itu tak pernah ada.
    const { checks } = await jalankan(
        "code_commit",
        { message: "commit yang tidak pernah terjadi", project: repo },
        { committed: true }
    );

    const cocok = checks.find(c => c.name === "pesan commit cocok");

    assert.equal(cocok.passed, false, "pesan yang tak ada di HEAD harus terdeteksi");

});

test("pengakuan gagal dari tool dihormati", async () => {

    const { checks } = await jalankan(
        "code_commit",
        { message: "apa pun", project: repo },
        { committed: false, out: "nothing to commit" }
    );

    assert.equal(checks[0].passed, false);
    assert.match(checks[0].detail, /nothing to commit/);

});

test("sisa yang ter-stage terbaca sebagai commit tak lengkap", async () => {

    fs.writeFileSync(path.join(repo, "tertinggal.txt"), "belum ikut\n");
    git("add", "tertinggal.txt");

    const { checks } = await jalankan(
        "code_commit",
        { message: "tambah berkas baru", project: repo },
        { committed: true }
    );

    const sisa = checks.find(c => c.name === "tidak ada sisa ter-stage");

    assert.equal(sisa.passed, false);

    git("reset", "-q");
    fs.unlinkSync(path.join(repo, "tertinggal.txt"));

});

// ---- code_rollback -----------------------------------------------

test("rollback yang benar-benar terjadi terverifikasi", async () => {

    fs.writeFileSync(path.join(repo, "awal.txt"), "DIUBAH\n");

    git("checkout", "--", ".");

    const { checks } = await jalankan("code_rollback", { files: ["."], project: repo });

    assert.equal(checks[0].passed, true, JSON.stringify(checks));

});

test("KLAIM ROLLBACK PALSU tertangkap — berkas masih berubah", async () => {

    // Persis perilaku gitPatcher.restore(): kegagalan git ditelan,
    // hasilnya tetap { restored: [...] }.
    fs.writeFileSync(path.join(repo, "awal.txt"), "MASIH BERUBAH\n");

    const { checks } = await jalankan(
        "code_rollback",
        { files: ["."], project: repo },
        { restored: ["."] }
    );

    assert.equal(checks[0].passed, false, "selisih terhadap HEAD harus terlihat");
    assert.match(checks[0].detail, /awal\.txt/);

    git("checkout", "--", ".");

});

test("berkas belum terlacak tidak dianggap kegagalan rollback", async () => {

    // `git checkout --` memang tidak menyentuhnya, jadi keberadaannya
    // bukan tanda rollback gagal.
    fs.writeFileSync(path.join(repo, "belum-terlacak.txt"), "baru\n");

    const { checks } = await jalankan("code_rollback", { files: ["."], project: repo });

    assert.equal(checks[0].passed, true, JSON.stringify(checks));

    fs.unlinkSync(path.join(repo, "belum-terlacak.txt"));

});

// ---- code_branch -------------------------------------------------

test("branch terverifikasi lewat HEAD sungguhan", async () => {

    git("checkout", "-q", "-b", "damar/uji-cabang");

    const { checks } = await jalankan(
        "code_branch",
        { name: "damar/uji-cabang", project: repo },
        { branch: "damar/uji-cabang" }
    );

    assert.equal(checks[0].passed, true, JSON.stringify(checks));

});

test("KLAIM BRANCH PALSU tertangkap — HEAD di tempat lain", async () => {

    const { checks } = await jalankan(
        "code_branch",
        { name: "damar/tidak-pernah-dibuat", project: repo },
        { branch: "damar/tidak-pernah-dibuat" }
    );

    assert.equal(checks[0].passed, false);
    assert.match(checks[0].detail, /damar\/uji-cabang/);

});

// ---- Batas -------------------------------------------------------

test("bukan repo git → tidak terverifikasi, bukan dinyatakan gagal", async () => {

    // Membedakan keduanya penting: "tidak dapat diperiksa" bukan
    // "terbukti salah".
    const kosong = fs.mkdtempSync(path.join(os.tmpdir(), "damar-bukan-repo-"));

    try {

        const { checks } = await jalankan(
            "code_rollback",
            { files: ["."], project: kosong }
        );

        assert.equal(checks[0].name, "git dapat dibaca");
        assert.equal(checks[0].passed, false);

    }
    finally {
        fs.rmSync(kosong, { recursive: true, force: true });
    }

});

test("verifier tidak pernah melempar walau argumen kacau", async () => {

    for (const tool of ["code_commit", "code_rollback", "code_branch"]) {
        const hasil = await jalankan(tool, null, null);
        assert.ok(Array.isArray(hasil.checks), `${tool} harus tetap mengembalikan checks`);
    }

});
