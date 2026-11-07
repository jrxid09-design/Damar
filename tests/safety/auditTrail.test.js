const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Biasanya sudah dipasang `tests/helpers/testEnv.js`; baris ini
// menjaga berkas tetap benar saat dijalankan sendirian.
process.env.DAMAR_AUDIT_DIR ||=
    fs.mkdtempSync(path.join(os.tmpdir(), "damar-audit-"));

const auditTrail = require("../../src/core/safety/auditTrail");
const toolGuard = require("../../src/core/safety/toolGuard");
const loopGuard = require("../../src/core/safety/loopGuard");

/**
 * Jejak audit yang bertahan (§96, Konstitusi Pasal 5).
 *
 * `telemetry.publish()` hanya memancarkan event tanpa menyimpannya:
 * kalau Console tidak terbuka, tidak ada catatan bahwa Damar
 * mengirim pesan atau bahwa sebuah verifikasi gagal.
 */

const berkasHariIni = () =>
    path.join(auditTrail.DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);

/**
 * Baca jejak hari ini, lewati baris yang tak dapat diurai.
 *
 * Berkas audit berumur panjang dan tes "baris rusak" di bawah
 * memang menyuntikkan baris cacat ke dalamnya. Helper yang menyerah
 * pada baris pertama yang rusak akan membuat SELURUH tes lain gagal
 * pada eksekusi berikutnya — kegagalan yang menuduh kode padahal
 * yang salah alat ukurnya.
 */
function bacaSemua() {

    let isi;

    try { isi = fs.readFileSync(berkasHariIni(), "utf8"); }
    catch { return []; }

    const out = [];

    for (const baris of isi.split("\n")) {
        if (!baris.trim()) continue;
        try { out.push(JSON.parse(baris)); }
        catch { /* sama seperti recent(): dilewati, bukan menggagalkan */ }
    }

    return out;

}

test("peristiwa tercatat ke berkas, bukan hanya dipancarkan", () => {

    const tanda = `uji_${Date.now()}`;

    auditTrail.record({ tool: tanda, risk: "destructive", outcome: "ok" });

    const ada = bacaSemua().some(e => e.tool === tanda);

    assert.ok(ada, "peristiwa harus bertahan di berkas");

});

test("PENOLAKAN tercatat — inilah yang paling perlu terlihat", () => {

    // Gerbang izin kini DIMATIKAN (Damar langsung bertindak). Yang
    // masih menolak adalah kill switch: tarik STOP, lalu coba tool.
    const killSwitch = require("../../src/core/safety/killSwitch");
    loopGuard.resetAll();

    const sebelum = bacaSemua().length;

    killSwitch.engage({ reason: "uji penolakan", actor: "uji" });

    try {
        assert.throws(() => toolGuard.before("terminal_run", { command: "echo x" }));
    }
    finally {
        killSwitch.release({ actor: "uji" });
    }

    const baru = bacaSemua().slice(sebelum);
    const tolak = baru.find(e => e.tool === "terminal_run" && e.outcome === "denied");

    assert.ok(tolak, "penolakan harus tercatat");
    assert.equal(tolak.risk, "destructive");
    assert.equal(tolak.reason, "SAFETY_STOP_ENGAGED");

});

test("kegagalan tool tercatat", () => {

    loopGuard.resetAll();

    const sebelum = bacaSemua().length;

    toolGuard.failed("code_commit", new Error("git tidak merespons"));

    const baru = bacaSemua().slice(sebelum);
    const gagal = baru.find(e => e.tool === "code_commit" && e.outcome === "error");

    assert.ok(gagal);
    assert.match(gagal.reason, /git tidak merespons/);

});

test("hasil terverifikasi tercatat lengkap dengan keadaannya", async () => {

    const sebelum = bacaSemua().length;

    await toolGuard.after(
        "whatsapp_send_photo",
        { to: "628123" },
        { messageIds: ["abc"], errors: [] }
    );

    const baru = bacaSemua().slice(sebelum);
    const entri = baru.find(e => e.tool === "whatsapp_send_photo");

    assert.ok(entri, "tindakan berkirim pesan harus tercatat");
    assert.equal(entri.outcome, "ok");
    assert.ok(entri.verification, "keadaan verifikasi ikut tersimpan");

});

test("pembacaan rutin TIDAK menenggelamkan jejak", async () => {

    const sebelum = bacaSemua().length;

    await toolGuard.after("memory_recall", { query: "apa saja" }, { ok: true });

    assert.equal(bacaSemua().length, sebelum, "bacaan murni tidak dicatat");

});

test("menulis berkas TERCATAT — disk berubah, pemilik berhak tahu", async () => {

    // Batasnya bukan "berbahaya", melainkan "ada yang berubah di
    // luar kepala Damar". Menulis berkas termasuk.
    const sebelum = bacaSemua().length;

    await toolGuard.after(
        "filesystem.writeFile",
        { path: "C:/tidak/ada/berkas.txt", content: "halo" },
        { ok: true }
    );

    const baru = bacaSemua().slice(sebelum);
    const entri = baru.find(e => e.tool === "filesystem.writeFile");

    assert.ok(entri, "penulisan berkas harus tercatat");
    // Kontrak D Round-3: penulisan berkas berefek samping → tercatat
    // sebagai 'destructive' (tetap tercatat; label risikonya jujur).
    assert.equal(entri.risk, "destructive");

    // Berkasnya memang tidak ada — verifikasi harus mengatakannya,
    // bukan ikut mengklaim berhasil.
    assert.equal(entri.verification, "failed");

});

// ---- Privasi -----------------------------------------------------

test("isi sensitif TIDAK disalin ke berkas audit", () => {

    // Melindungi lewat pencatatan tidak boleh menciptakan
    // kebocorannya sendiri.
    const rahasia = "x".repeat(500);

    const hasil = auditTrail.redact({
        path: "C:/rahasia/kunci.txt",
        content: rahasia,
        token: "sk-ini-kunci-rahasia-yang-panjang-sekali-sekali"
    });

    assert.ok(!hasil.content.includes("x".repeat(200)), "isi panjang harus dipotong");
    assert.match(hasil.content, /500 kar\./, "panjang aslinya tetap dilaporkan");
    assert.ok(hasil.content.length < 150);

});

test("bentuk argumen tetap terbaca tanpa membocorkan isinya", () => {

    const hasil = auditTrail.redact({
        files: ["a.js", "b.js", "c.js"],
        options: { deep: true, force: false },
        count: 7,
        nothing: null
    });

    assert.equal(hasil.files, "[3 item]");
    assert.equal(hasil.options, "{deep,force}");
    assert.equal(hasil.count, 7);
    assert.equal(hasil.nothing, null);

});

// ---- Ketahanan ---------------------------------------------------

test("baris rusak dilewati, bukan menggagalkan seluruh jejak", () => {

    fs.mkdirSync(auditTrail.DIR, { recursive: true });
    fs.appendFileSync(berkasHariIni(), "{ini bukan json}\n", "utf8");

    const tanda = `setelah_rusak_${Date.now()}`;
    auditTrail.record({ tool: tanda, risk: "safe", outcome: "ok" });

    const hasil = auditTrail.recent({ limit: 50 });

    assert.ok(hasil.some(e => e.tool === tanda), "entri sesudah baris rusak tetap terbaca");

});

test("penyaringan per hasil bekerja", () => {

    const tanda = `saring_${Date.now()}`;

    auditTrail.record({ tool: tanda, risk: "destructive", outcome: "denied", reason: "uji" });

    const hanyaDitolak = auditTrail.recent({ limit: 200, outcome: "denied" });

    assert.ok(hanyaDitolak.every(e => e.outcome === "denied"));
    assert.ok(hanyaDitolak.some(e => e.tool === tanda));

});

test("ringkasan menghitung yang bermasalah", () => {

    const s = auditTrail.summary();

    assert.equal(typeof s.total, "number");
    assert.ok(s.denied >= 1, "penolakan dari tes di atas harus terhitung");

});

test("mencatat tidak pernah melempar walau masukan kacau", () => {

    assert.doesNotThrow(() => auditTrail.record(null));
    assert.doesNotThrow(() => auditTrail.record({ tool: undefined, args: "bukan objek" }));

});

test("jejak tes tidak menyentuh jejak sungguhan", () => {

    assert.ok(
        !auditTrail.DIR.includes(path.join("Workspace", "Damar", "data")),
        `tes harus menulis ke direktori sementara, bukan ${auditTrail.DIR}`
    );

});

