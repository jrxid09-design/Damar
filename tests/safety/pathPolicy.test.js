const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const pathPolicy = require("../../src/core/safety/pathPolicy");

/** Tes batas jalur berkas (§38, Konstitusi Pasal 9 & 12). */

test("direktori sistem Windows ditolak", () => {

    for (const p of [
        "C:\\Windows\\System32\\drivers\\etc\\hosts",
        "C:\\Program Files\\sesuatu.exe",
        "C:\\Windows"
    ]) {
        assert.throws(
            () => pathPolicy.assertPathAllowed(p, false),
            err => err.code === "PATH_DENIED",
            `seharusnya ditolak: ${p}`
        );
    }

});

test("penyimpanan kredensial ditolak — bahkan untuk dibaca", () => {

    // Konstitusi Pasal 9.1: rahasia tidak boleh masuk ke prompt,
    // log, atau memori. Membacanya saja sudah melanggar.
    const ssh = path.join(os.homedir(), ".ssh", "id_rsa");

    assert.throws(
        () => pathPolicy.assertPathAllowed(ssh, false),
        err => err.code === "PATH_DENIED"
    );

});

test("sesi WhatsApp ditolak", () => {

    const wa = path.join(__dirname, "..", "..", "configs", "wa-auth", "creds.json");

    assert.throws(
        () => pathPolicy.assertPathAllowed(wa, false),
        err => err.code === "PATH_DENIED"
    );

});

test("path traversal tidak dapat keluar dari batas", () => {

    // "../.." diselesaikan oleh path.resolve sebelum diperiksa,
    // jadi upaya menyamarkan tujuan tetap tertangkap.
    assert.throws(
        () => pathPolicy.assertPathAllowed("C:\\Workspace\\Aether\\..\\..\\Windows\\System32", false),
        err => err.code === "PATH_DENIED",
        "traversal ke direktori sistem harus tertangkap"
    );

});

test("Damar kini BOLEH menulis kebijakan/konstitusi/inti-nya sendiri (§37)", () => {

    // Larangan hanya-baca dihapus atas keputusan pemilik: self-extending
    // menuntut Damar dapat mengubah runtime & kebijakannya sendiri.
    // Rollback dijamin git + CheckpointSystem, bukan larangan tulis.
    const cfg = path.join(__dirname, "..", "..", "configs", "safety.json");
    const konstitusi = path.join(__dirname, "..", "..", "docs", "constitution.md");
    const inti = path.join(__dirname, "..", "..", "src", "core", "safety", "killSwitch.js");

    for (const p of [cfg, konstitusi, inti]) {
        assert.doesNotThrow(() => pathPolicy.assertPathAllowed(p, true));
        assert.doesNotThrow(() => pathPolicy.assertPathAllowed(p, false));
    }

});

test("kredensial mentah TETAP ditolak — kebocorannya tak menambah kemampuan", () => {

    const os = require("node:os");
    const ssh = path.join(os.homedir(), ".ssh", "id_rsa");

    assert.throws(
        () => pathPolicy.assertPathAllowed(ssh, true),
        err => err.code === "PATH_DENIED"
    );

});

test("jalur kerja nyata tetap boleh — sandbox tidak mematikan gunanya", () => {

    // §277: sistem harus tetap dapat dipakai. Mengunci semuanya
    // sama saja mematikan Damar.
    for (const p of [
        "D:\\DamarNAS\\media\\foto.jpg",
        "E:\\DamarNAS\\backup\\arsip.zip",
        "C:\\Workspace\\Aether\\data\\catatan.txt",
        path.join(os.tmpdir(), "kerja.txt")
    ]) {
        assert.doesNotThrow(
            () => pathPolicy.assertPathAllowed(p, true),
            `jalur kerja sah harus lolos: ${p}`
        );
    }

});

test("penjaga tingkat tool membaca argumen yang benar", () => {

    assert.throws(
        () => pathPolicy.assertToolPaths("filesystem.writeFile", { path: "C:\\Windows\\x.txt" }),
        err => err.code === "PATH_DENIED"
    );

    // moveFile memeriksa sumber DAN tujuan.
    assert.throws(
        () => pathPolicy.assertToolPaths("filesystem.moveFile", {
            source: "D:\\ok.txt",
            destination: "C:\\Windows\\x.txt"
        }),
        err => err.code === "PATH_DENIED"
    );

});

test("tool tanpa argumen jalur dilewati tanpa error", () => {

    assert.doesNotThrow(
        () => pathPolicy.assertToolPaths("calculator.calculator", { a: 1, b: 2 })
    );

});

test("pathFrom dipakai bersama verifier — satu sumber kunci jalur", () => {

    assert.equal(pathPolicy.pathFrom({ path: "a" }, "path", "file"), "a");
    assert.equal(pathPolicy.pathFrom({ file: "b" }, "path", "file"), "b");
    assert.equal(pathPolicy.pathFrom({ x: "c" }, "path", "file"), null);
    assert.equal(pathPolicy.pathFrom({ path: "   " }, "path"), null, "spasi kosong bukan jalur");

});
