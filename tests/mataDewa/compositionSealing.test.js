"use strict";

/**
 * Sertifikasi MD-008 — komposisi kanonik tersegel.
 *
 * Bukti wajib:
 *  - Permukaan publik src/mataDewa TIDAK mengekspos setService/resetService.
 *  - Tidak ada jalan lain yang bisa mengganti singleton komposisi dari
 *    luar (scan struktural: tidak ada tulisan variabel singleton dari
 *    modul lain).
 *  - Konflik komposisi (options kedua setelah singleton berdiri) gagal
 *    keras — tidak ada pengabaian diam-diam.
 *  - getService tanpa options idempoten (instance sama).
 *  - Seam test-only hidup di composition.js dan TIDAK di-re-export.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const md = require("../../src/mataDewa");
const composition = require("../../src/mataDewa/composition");
const { MataDewaService, SUBSYSTEM_STATE } = require("../../src/mataDewa/service");

const REPO_ROOT = path.join(__dirname, "..", "..");

test("MD-008: permukaan publik tidak mengekspos setService/resetService", () => {
    assert.equal("setService" in md, false);
    assert.equal("resetService" in md, false);
    assert.equal(Object.isFrozen(md), true);
    // Seam test-only tetap di modul privat.
    assert.equal(typeof composition.setMataDewaServiceForTests, "function");
    assert.equal(typeof composition.resetMataDewaServiceForTests, "function");
});

test("MD-008: tidak ada modul lain yang bisa mengganti singleton komposisi", () => {
    // Scan struktural: satu-satunya tulisan `singleton =` di mataDewa ada
    // di composition.js; index.js hanya membaca lewat getOrCreate/get.
    const compositionSrc = fs.readFileSync(
        path.join(REPO_ROOT, "src", "mataDewa", "composition.js"), "utf8");
    const indexSrc = fs.readFileSync(
        path.join(REPO_ROOT, "src", "mataDewa", "index.js"), "utf8");
    assert.match(compositionSrc, /singleton = new MataDewaService/);
    assert.match(compositionSrc, /singleton = service/);       // test-only seam
    assert.equal(/singleton\s*=/.test(indexSrc), false,
        "index.js tidak boleh menulis singleton komposisi");
});

test("MD-008: konflik komposisi (options kedua) gagal keras", () => {
    composition.resetMataDewaServiceForTests();
    const first = md.getService({ clock: { nowMs: () => Date.now() } });
    assert.ok(first);
    assert.throws(
        () => md.getService({ credentialsFilePath: "/tmp/other.json" }),
        /MATA_DEWA_COMPOSITION_CONFLICT/);
    // Tanpa options → idempoten (instance sama).
    assert.equal(md.getService(), first);
    composition.resetMataDewaServiceForTests();
});

test("MD-008: getService tanpa options membuat instance siap-dipakai", async () => {
    composition.resetMataDewaServiceForTests();
    const service = md.getService();
    assert.ok(service instanceof MataDewaService);
    const status = service.status();
    assert.ok(Object.values(SUBSYSTEM_STATE).includes(status.state));
    composition.resetMataDewaServiceForTests();
});
