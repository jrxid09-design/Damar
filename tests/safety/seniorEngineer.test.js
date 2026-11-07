const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const { codingTools } = require("../../src/coding/tools");

/**
 * Disiplin insinyur senior (Damar 2.0).
 *
 * Dua hal yang harus tetap ada: tool peninjau diff sendiri sebelum
 * commit, dan urutan kerjanya di system prompt. Tanpa diff review,
 * Damar commit tanpa pernah membaca perubahannya sendiri.
 */

function tool(name) {
    return codingTools().find(t => t.name === name);
}

test("code_diff terdaftar dan terpilih pada giliran koding", () => {

    assert.ok(tool("code_diff"), "code_diff harus ada di codingTools");

    const selector = fs.readFileSync(
        path.join(__dirname, "../../src/ai/tools/ToolSelector.js"),
        "utf8"
    );

    assert.match(selector, /"code_diff"/);

});

test("code_diff menolak folder yang bukan repo git", async () => {

    const kosong = fs.mkdtempSync(path.join(os.tmpdir(), "damar-nonrepo-"));

    const hasil = await tool("code_diff").execute({ project: kosong });

    assert.equal(hasil.ok, false);

});

test("code_diff melaporkan status + diff dan memangkas keluaran panjang", async () => {

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "damar-repo-"));
    const git = args => execFileSync("git", args, { cwd: repo, windowsHide: true });

    git(["init", "-q"]);
    git(["config", "user.email", "test@damar.local"]);
    git(["config", "user.name", "Damar Test"]);

    fs.writeFileSync(path.join(repo, "a.txt"), "baris awal\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "awal"]);

    // Perubahan besar → diff harus dipangkas, bukan membanjiri konteks.
    fs.writeFileSync(path.join(repo, "a.txt"), "x".repeat(5000) + "\n");

    const hasil = await tool("code_diff").execute({ project: repo, maxChars: 200 });

    assert.equal(hasil.ok, true);
    assert.match(hasil.status, /a\.txt/);
    assert.equal(hasil.truncated, true);
    assert.equal(hasil.diff.length, 200);

});

test("code_review menandai rahasia sebagai blok, dengan nomor baris", () => {

    const { review } = require("../../src/coding/review/diffReviewer");

    const diff = [
        "diff --git a/src/x.js b/src/x.js",
        "--- a/src/x.js",
        "+++ b/src/x.js",
        "@@ -10,2 +10,4 @@",
        " const a = 1;",
        '+const apiKey = "sk-abcdefghijklmnop1234";',
        "+console.log(a);",
        " const b = 2;"
    ].join("\n");

    const hasil = review(diff);

    assert.equal(hasil.ok, false, "rahasia harus memblokir commit");

    const rahasia = hasil.findings.find(f => f.rule === "rahasia");
    assert.equal(rahasia.level, "blok");
    assert.equal(rahasia.file, "src/x.js");
    assert.equal(rahasia.line, 11);

    assert.ok(hasil.findings.some(f => f.rule === "debug" && f.line === 12));

    // Kode berubah tanpa berkas test yang ikut berubah.
    assert.ok(hasil.findings.some(f => f.rule === "tanpa-test"));

});

test("code_review tidak menuduh baris yang DIHAPUS", () => {

    const { review } = require("../../src/coding/review/diffReviewer");

    const diff = [
        "--- a/src/x.js",
        "+++ b/src/x.js",
        "@@ -3,3 +3,2 @@",
        " const a = 1;",
        "-console.log(a);",
        " const b = 2;"
    ].join("\n");

    const hasil = review(diff);

    assert.equal(hasil.ok, true);
    assert.equal(hasil.findings.filter(f => f.rule === "debug").length, 0);

});

test("code_review terdaftar sebagai tool koding", () => {

    assert.ok(tool("code_review"), "code_review harus ada di codingTools");

    const selector = fs.readFileSync(
        path.join(__dirname, "../../src/ai/tools/ToolSelector.js"),
        "utf8"
    );

    assert.match(selector, /"code_review"/);

});

test("doktrin rekayasa dimuat untuk pesan koding, tidak untuk obrolan biasa", () => {

    const { doctrineFor } = require("../../src/prompts/doctrines");

    const d = doctrineFor("tolong perbaiki bug di fungsi login");
    assert.match(d, /INSINYUR SENIOR/);
    assert.match(d, /AKAR MASALAH, BUKAN GEJALA/);
    assert.match(d, /code_diff/);

    assert.equal(doctrineFor("hai apa kabar"), "");

});
