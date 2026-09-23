const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const adb = require("../../src/android/adb");
const { androidTools } = require("../../src/android/tools");

/**
 * Kendali Android via ADB.
 *
 * Bebas-lingkungan: tak menuntut HP tersambung. Yang dijaga — daftar
 * perangkat aman saat kosong, aksi ketuk/ketik tergolong DESTRUKTIF
 * (gerbang konfirmasi), tool terdaftar & terpilih. Perintah perangkat
 * nyata diuji hanya bila ada perangkat siap.
 */

test("android_devices tak error saat tak ada HP (adb terpasang)", async () => {
    // IW1: the adapter is deny-until-ratified, so with no owner grant it
    // refuses before any ADB process and reports a denial, never a throw.
    const r = await adb.devices();
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 0);
});

test("aksi HP tergolong destruktif — lewat gerbang konfirmasi", () => {
    const { DESTRUCTIVE } = require("../../src/core/safety/riskCatalog");
    for (const t of ["android_tap", "android_swipe", "android_type", "android_key", "android_open_app", "android_shell"]) {
        assert.ok(DESTRUCTIVE.has(t), `${t} harus destruktif`);
    }
    // Baca-saja TIDAK destruktif.
    assert.ok(!DESTRUCTIVE.has("android_devices"));
    assert.ok(!DESTRUCTIVE.has("android_screenshot"));
});

test("tool Android terdaftar dan profil selektor ada", () => {
    const nama = androidTools().map(t => t.name);
    assert.ok(nama.includes("android_devices"));
    assert.ok(nama.includes("android_tap"));
    assert.ok(nama.includes("android_screenshot"));
    assert.equal(nama.length, 12);

    const selector = fs.readFileSync(path.join(__dirname, "../../src/ai/tools/ToolSelector.js"), "utf8");
    assert.match(selector, /android: \[/);
    assert.match(selector, /"android_tap"/);
    assert.match(selector, /"adb"/);
});

test("android_key menambah prefix KEYCODE_ dan menyaring input", async () => {
    // The tool still normalises KEYCODE_ before the capability request, and
    // without an owner grant the request is denied before any device is touched.
    const tool = androidTools().find(t => t.name === "android_key");
    const r = await tool.execute({ keycode: "home" });
    assert.equal(r.ok, false);
    assert.equal(r.denied, true);
    const { shellCommand } = require("../../src/manager/internal/adbCapabilities");
    assert.equal(shellCommand("key", { keycode: "KEYCODE_HOME" }), "input keyevent KEYCODE_HOME");
    assert.equal(shellCommand("key", { keycode: "home;id" }), "input keyevent homeid");
});
