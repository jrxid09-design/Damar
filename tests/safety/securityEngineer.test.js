const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const auditor = require("../../src/security/auditor");
const { securityTools } = require("../../src/security/tools");

/**
 * Insinyur keamanan (Damar 2.0).
 *
 * Yang dijaga di sini: temuan harus BERBUKTI (berkas:baris benar),
 * aturan tidak boleh menuduh kode yang wajar, dan audit yang gagal
 * tidak boleh terbaca sebagai "aman".
 */

function proyekUji(berkas) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-sec-"));
    for (const [nama, isi] of Object.entries(berkas)) {
        const abs = path.join(dir, nama);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, isi);
    }
    return dir;
}

test("sec_secret_scan menemukan kunci ter-hardcode dengan nomor baris", async () => {

    const dir = proyekUji({
        "src/app.js": [
            "const a = 1;",
            "const apiKey = \"sk-abcdefghijklmnop1234\";",
            "module.exports = a;"
        ].join("\n")
    });

    const hasil = await auditor.scanSecrets(dir);

    assert.equal(hasil.ok, false);
    assert.equal(hasil.findings[0].file, "src/app.js");
    assert.equal(hasil.findings[0].line, 2);

});

test("sec_secret_scan bersih pada proyek tanpa rahasia", async () => {

    const dir = proyekUji({ "src/app.js": "const key = process.env.API_KEY;\n" });

    const hasil = await auditor.scanSecrets(dir);

    assert.equal(hasil.ok, true);
    assert.equal(hasil.findings.length, 0);

});

test("placeholder di berkas contoh tidak dihitung sebagai kebocoran", async () => {

    const dir = proyekUji({
        "configs/providers.json.example": '{ "apiKey": "sk-GANTI_DENGAN_KUNCI_ANDA" }\n',
        "src/nyata.js": "const token = \"ghp_abcdefghijklmnopqrstuvwxyz12\";\n"
    });

    const hasil = await auditor.scanSecrets(dir);

    assert.equal(hasil.ok, false, "kunci sungguhan tetap harus terdeteksi");

    // Yang sungguhan diurutkan lebih dulu; placeholder turun jadi 'rendah'.
    assert.equal(hasil.findings[0].rule, "rahasia");
    assert.equal(hasil.findings[0].file, "src/nyata.js");
    assert.equal(hasil.findings.filter(f => f.rule === "rahasia").length, 1);
    assert.equal(hasil.findings.at(-1).rule, "rahasia-contoh");

});

test("temuan berat tidak tergusur temuan ringan saat kuota penuh", async () => {

    const ringan = Array.from({ length: 30 }, () => "el.innerHTML = x;").join("\n");

    const dir = proyekUji({
        "src/a-ringan.js": ringan,                    // berkas ringan dibaca lebih dulu
        "src/z-berat.js": "eval(userInput);\n"
    });

    const hasil = await auditor.auditCode(dir, { maxTemuan: 5 });

    assert.equal(hasil.dipangkas, true);
    assert.equal(hasil.findings[0].severity, "tinggi");
    assert.equal(hasil.findings[0].rule, "eksekusi-dinamis");

});

test("sec_code_audit menandai eval, TLS mati, dan injeksi perintah", async () => {

    const dir = proyekUji({
        "src/bahaya.js": [
            "eval(userInput);",
            "const opt = { rejectUnauthorized: false };",
            "execSync(`ls ${dir}`);",
            "const h = crypto.createHash('md5');"
        ].join("\n")
    });

    const hasil = await auditor.auditCode(dir);
    const rules = hasil.findings.map(f => f.rule);

    assert.equal(hasil.ok, false, "ada temuan tinggi — tidak boleh ok");
    assert.ok(rules.includes("eksekusi-dinamis"));
    assert.ok(rules.includes("tls-dimatikan"));
    assert.ok(rules.includes("injeksi-perintah"));
    assert.ok(rules.includes("kripto-lemah"));

});

test("sec_code_audit tidak menuduh kode wajar", async () => {

    const dir = proyekUji({
        "src/wajar.js": [
            "const id = crypto.randomUUID();",
            "const acak = Math.random();",                    // tanpa konteks rahasia
            "db.query('SELECT * FROM users WHERE id = ?', [id]);",
            "execFile('git', ['status'], opts);"
        ].join("\n")
    });

    const hasil = await auditor.auditCode(dir);

    assert.deepEqual(hasil.findings, []);
    assert.equal(hasil.ok, true);

});

test("audit dependensi pada folder tanpa package.json = tidak diketahui, bukan aman", async () => {

    const dir = proyekUji({ "catatan.txt": "bukan proyek node\n" });

    const hasil = await auditor.auditDeps(dir);

    assert.equal(hasil.ok, false);
    assert.match(hasil.note, /package\.json/);

});

test("tool keamanan terdaftar dan terpilih pada giliran keamanan", () => {

    const nama = securityTools().map(t => t.name);

    assert.deepEqual(nama, ["sec_secret_scan", "sec_code_audit", "sec_dep_audit"]);

    const selector = fs.readFileSync(
        path.join(__dirname, "../../src/ai/tools/ToolSelector.js"),
        "utf8"
    );

    assert.match(selector, /keamanan: \[/);
    assert.match(selector, /"sec_secret_scan"/);

});

test("doktrin keamanan dimuat untuk pesan audit keamanan", () => {

    const { doctrineFor } = require("../../src/prompts/doctrines");

    const d = doctrineFor("tolong audit keamanan repo ini, ada kerentanan?");
    assert.match(d, /INSINYUR KEAMANAN SENIOR/);
    assert.match(d, /MODEL ANCAMAN DULU/);
    assert.match(d, /TIDAK\s+DIKETAHUI/);

    assert.equal(doctrineFor("terima kasih ya"), "");

});
