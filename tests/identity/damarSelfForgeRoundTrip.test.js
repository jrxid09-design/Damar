"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * FORGE ROUND-TRIP REGENERATION — damar-self TIDAK BOLEH dihidupkan
 * kembali sebagai split-brain self store.
 *
 * Latar: tool.js kanonik kini mendelegasikan persistensi ke
 * createDamarSelfService() (satu store kanonik DamarSelf). Dulu
 * manifest.forge.spec masih menyimpan implementasi LAMA yang menulis
 * langsung ke DAMAR_SELF.md + DAMAR_STATE.json. owner bisa membuka
 * tool lewat forge.read("damar-self"), menekan Save, dan forge.create
 * → toolForge.writePlugin akan meregenerasi tool.js dari spec lama —
 * membangkitkan kembali store kedua yang sudah dihapus.
 *
 * Invarian yang dijaga (root invariant):
 *   manifest.forge.spec (RAW) === tool.js kanonik,
 *   sehingga siklus read → create/save → writePlugin menghasilkan
 *   tool.js yang byte-identik, dua kali beruntun (idempoten), tanpa
 *   jalur persistensi DAMAR_STATE.json / DAMAR_SELF.md yang aktif.
 *
 * Jalur produksi yang dipakai: src/services/toolForge.js sungguhan
 * (read + create + writePlugin + verifyLoads), dengan DAMAR_USER_PLUGINS
 * diarahkan ke root sementara yang diisi salinan plugin damar-self —
 * file plugin produksi tidak pernah disentuh.
 */

const ROOT = path.join(__dirname, "..", "..");
const PROD_PLUGIN_DIR = path.join(ROOT, "userPlugins", "damar-self");

// toolForge membaca pluginLoader.userRoot saat modul di-load, dan
// userRoot dibaca dari env saat modul pluginLoader di-load. Karena
// itu env disetel SEBELUM require — di sini, di level modul.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "damar-forge-rt-"));
process.env.DAMAR_USER_PLUGINS = testRoot;

const forge = require("../../src/services/toolForge");
const canonicalToolSource = fs.readFileSync(
    path.join(PROD_PLUGIN_DIR, "tool.js"), "utf8");
const canonicalManifest = JSON.parse(fs.readFileSync(
    path.join(PROD_PLUGIN_DIR, "manifest.json"), "utf8"));

// Salinan plugin produksi ke root terisolasi (target generasi tidak
// merusak file produksi; byte-identik dengan yang di-commit).
function installCopy() {
    const dir = path.join(testRoot, "damar-self");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"),
        JSON.stringify(canonicalManifest, null, 4) + "\n", "utf8");
    fs.writeFileSync(path.join(dir, "tool.js"), canonicalToolSource, "utf8");
    fs.writeFileSync(path.join(dir, "index.js"),
        "const tools = require('./tool');\n" +
        "module.exports = { tools, skills: [], events: [], scheduler: [] };\n",
        "utf8");
}

test("forge read untuk damar-self mengembalikan spec RAW", () => {

    installCopy();

    const detail = forge.read("damar-self");

    assert.ok(detail, "forge.read harus menemukan damar-self di jalur aktif");
    assert.equal(detail.status, "active");
    assert.equal(detail.id, "damar-self");

    const spec = detail.spec;
    assert.ok(spec, "manifest.forge.spec harus ada");
    assert.equal(Object.prototype.hasOwnProperty.call(spec, "raw"), true,
        "spec harus RAW mode (kunci raw)");
    assert.equal(Object.prototype.hasOwnProperty.call(spec, "code"), false,
        "spec tidak boleh lagi memegang mode formulir (code)");
    assert.equal(Object.prototype.hasOwnProperty.call(spec, "toolName"), false,
        "spec tidak boleh lagi memegang metadata formulir lama");

    // RAW harus verbatim tool.js kanonik.
    assert.equal(spec.raw, canonicalToolSource,
        "spec.raw harus identik byte-per-byte dengan tool.js kanonik");

});

test("siklus read → save (forge.create) meregenerasi tool.js byte-identik, dua kali", () => {

    installCopy();

    for (let cycle = 1; cycle <= 2; cycle++) {

        // 1. Baca lewat jalur Forge produksi (sama seperti Console).
        const detail = forge.read("damar-self");
        assert.ok(detail, `siklus ${cycle}: forge.read gagal`);

        const spec = detail.spec;
        assert.ok(spec && spec.raw, `siklus ${cycle}: spec RAW hilang`);

        // 2. Owner menekan Save → forge.create dengan spec apa adanya
        //    (bentuk yang sama dengan yang dikirim Console/API: id +
        //    raw). Ini jalur regenerasi produksi: validate → writePlugin.
        const result = forge.create(
            { id: detail.id, raw: spec.raw },
            { activate: false }
        );

        // activate=false → hasil ditulis sebagai draft, bukan menimpa
        // jalur aktif; writePlugin + verifyLoads tetap dijalankan penuh
        // (jalur generasi produksi yang sama).
        assert.equal(result.status, "draft",
            `siklus ${cycle}: regenerasi harus berhenti di draft`);
        assert.equal(result.tools, 1,
            `siklus ${cycle}: tool.js hasil regenerasi harus loadable`);

        // 3. Hasil regenerasi (draft) harus byte-identik dengan kanonik.
        const regenerated = fs.readFileSync(
            path.join(forge.draftsRoot, "damar-self", "tool.js"), "utf8");

        assert.equal(regenerated, canonicalToolSource,
            `siklus ${cycle}: tool.js hasil regenerasi tidak byte-identik dengan kanonik`);

        // Manifest draft yang baru juga harus RAW — siklus kedua tidak
        // boleh mengubah bentuk representasi.
        const regeneratedManifest = JSON.parse(fs.readFileSync(
            path.join(forge.draftsRoot, "damar-self", "manifest.json"), "utf8"));
        assert.deepEqual(Object.keys(regeneratedManifest.forge.spec),
            ["raw"], `siklus ${cycle}: manifest regenerasi harus RAW tunggal`);
        assert.equal(regeneratedManifest.forge.spec.raw, canonicalToolSource,
            `siklus ${cycle}: raw regenerasi harus identik dengan kanonik`);

        // Idempoten: file draft siklus-1 dan siklus-2 identik.
        if (cycle === 2) {
            // (perbandingan dilakukan terhadap kanonik di atas — sudah
            // cukup; siklus kedua membuktikan stabilitas baca-tulis.)
        }

    }

});

test("sumber regenerasi tidak membangkitkan split-brain self store", () => {

    installCopy();

    const detail = forge.read("damar-self");
    assert.ok(detail);

    const regenerated = fs.readFileSync(
        path.join(forge.draftsRoot, "damar-self", "tool.js"), "utf8");

    // Delegasi kanonik wajib hadir.
    assert.match(regenerated, /createDamarSelfService/,
        "tool.js regenerasi harus mendelegasikan ke createDamarSelfService");

    // Tidak ada persistensi langsung yang aktif ke store lama.
    assert.doesNotMatch(regenerated, /DAMAR_STATE\.json/,
        "tool.js regenerasi tidak boleh menyentuh DAMAR_STATE.json");
    assert.doesNotMatch(regenerated, /DAMAR_SELF\.md/,
        "tool.js regenerasi tidak boleh menyentuh DAMAR_SELF.md");
    assert.doesNotMatch(regenerated, /writeFileSync\(\s*STATE_PATH/,
        "tool.js regenerasi tidak boleh menulis state ke path lama");

    // Dan spec yang dikembalikan Forge juga bersih dari store lama.
    const specText = JSON.stringify(detail.spec);
    assert.doesNotMatch(specText, /DAMAR_STATE\.json|DAMAR_SELF\.md/,
        "spec Forge tidak boleh lagi membawa implementasi store lama");

});

test("tidak ada sumber regenerasi plugin aktif yang memuat store lama", () => {

    // Residual check pada SEMUA manifest plugin (bawaan + pengguna):
    // keberadaan DAMAR_STATE.json / DAMAR_SELF.md di dalam
    // manifest.forge.spec berarti ada salinan executable yang bisa
    // menghidupkan kembali store kedua lewat Save.
    const roots = [
        path.join(ROOT, "userPlugins"),
        path.join(ROOT, "src", "plugins")
    ];

    const offenders = [];

    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // .drafts adalah area kerja forge, bukan sumber regenerasi plugin aktif.
                if (entry.name === ".drafts" || entry.name === "node_modules") continue;
                walk(full);
            }
            else if (entry.name === "manifest.json") {
                const text = fs.readFileSync(full, "utf8");
                if (/DAMAR_STATE\.json|DAMAR_SELF\.md/.test(text)) {
                    offenders.push(path.relative(ROOT, full));
                }
            }
        }
    };

    for (const root of roots) {
        if (fs.existsSync(root)) walk(root);
    }

    assert.deepEqual(offenders, [],
        "tidak boleh ada manifest yang menyimpan salinan executable store lama: " +
        offenders.join(", "));

});

// Bersih-bersih setelah seluruh tes di berkas ini selesai.
test.after(() => {
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch { }
});
