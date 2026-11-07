const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const kali = require("../../src/kali/bridge");
const { kaliTools } = require("../../src/kali/tools");

/**
 * Penguasaan Kali Linux (Damar 2.0).
 *
 * Test bebas-lingkungan: tidak menuntut Kali terpasang di CI. Yang
 * dijamin selalu: perintah kosong ditolak, kali_run tercatat destruktif
 * (lewat gerbang konfirmasi seperti terminal_run), tool terdaftar &
 * terpilih, dan doktrin ada di prompt. Eksekusi nyata diuji hanya bila
 * Kali memang tersedia.
 */

test("kali_run menolak perintah kosong tanpa menyentuh WSL", async () => {
    const r = await kali.run("   ");
    assert.equal(r.ok, false);
    assert.match(r.error, /kosong/i);
});

test("kali_run tergolong destruktif — lewat gerbang konfirmasi", () => {
    const { DESTRUCTIVE } = require("../../src/core/safety/riskCatalog");
    assert.ok(DESTRUCTIVE.has("kali_run"), "kali_run harus destruktif seperti terminal_run");
});

test("tool Kali terdaftar dan profil selektor ada", () => {
    const nama = kaliTools().map(t => t.name);
    assert.deepEqual(nama, ["kali_run", "kali_tools", "kali_which", "kali_status"]);

    const selector = fs.readFileSync(
        path.join(__dirname, "../../src/ai/tools/ToolSelector.js"), "utf8"
    );
    assert.match(selector, /kali: \[/);
    assert.match(selector, /"kali_run"/);
    assert.match(selector, /"nmap"/);
});

test("arsenal terkelompok per tugas dan tak kosong", () => {
    const kategori = Object.keys(kali.ARSENAL);
    assert.ok(kategori.includes("pemetaan-jaringan"));
    assert.ok(kali.ARSENAL["web"].includes("sqlmap"));
    assert.ok(Object.values(kali.ARSENAL).flat().length >= 30);
});

test("doktrin Kali dimuat untuk pesan pentest, tidak untuk obrolan biasa", () => {
    const { doctrineFor } = require("../../src/prompts/doctrines");
    const d = doctrineFor("jalankan nmap lalu sqlmap ke target lab");
    assert.match(d, /KAMU MENGUASAI ARSENALNYA/);
    assert.match(d, /kali_run/);
    assert.match(d, /aset milik pemilik|diizinkan beserta cakupannya/);
    assert.equal(doctrineFor("selamat pagi"), "");
});

// Eksekusi nyata — hanya bila Kali tersedia di mesin uji.
test("kali_run mengeksekusi di dalam Kali bila tersedia", async (t) => {
    if (!(await kali.available())) return t.skip("Kali tak tersedia di mesin ini");
    const r = await kali.run("uname -s && whoami", { timeout: 60000 });
    assert.equal(r.ok, true);
    assert.match(r.stdout, /Linux/);
});
