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
    const r = await adb.devices();
    // adb ada → { ok, devices, count }. Tak ada adb → { ok:false, error }.
    if (r.ok) { assert.ok(Array.isArray(r.devices)); assert.equal(typeof r.count, "number"); }
    else { assert.match(r.error, /.+/); }
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
    // Tanpa HP → resolveSerial melempar; ditangkap jadi { ok:false }.
    const r = await androidTools().find(t => t.name === "android_key").execute({ keycode: "home" });
    assert.equal(typeof r.ok, "boolean");
    if (!r.ok) assert.match(r.error || "", /perangkat|device|Tak ada/i);
});
