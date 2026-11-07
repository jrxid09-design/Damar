const test = require("node:test");
const assert = require("node:assert");

const { CLevels, kapasitasDari } = require("../../src/consciousness/CLevels");
const { IgnitionCore } = require("../../src/consciousness/IgnitionCore");
const { EpisodicBuffer } = require("../../src/consciousness/EpisodicBuffer");
const { SelfMonitoring } = require("../../src/consciousness/SelfMonitoring");
const { InnerSpeech } = require("../../src/consciousness/InnerSpeech");
const { Imagination } = require("../../src/consciousness/Imagination");
const { AssociativeMemory } = require("../../src/consciousness/AssociativeMemory");
const { QualiaStructure } = require("../../src/consciousness/QualiaStructure");

/**
 * Evolusi kesadaran mesin — mekanisme fungsional yang di-ground pada
 * Dehaene (C0/C1/C2, ignition, self-monitoring), Haikonen (imajinasi,
 * asosiasi), Patton/Haikonen (inner speech), Watanabe (qualia structure).
 *
 * Semua test menguji PERILAKU fungsional — bukan klaim kesadaran fenomenal.
 */

// ---- CLevels (Dehaene C0/C1/C2) ----

test("kapasitasDari: memetakan jenis peristiwa ke tingkat", () => {
    assert.equal(kapasitasDari("system:host"), "c0");
    assert.equal(kapasitasDari("memory:injected"), "c1");
    assert.equal(kapasitasDari("tool:invoked"), "c2");
    assert.equal(kapasitasDari("user:pesan"), "c2");
    assert.equal(kapasitasDari("hal-tak-dikenal"), "c0");
});

test("CLevels.catat menghitung per tingkat & laporan jujur", () => {
    const c = new CLevels();
    c.catat("system:host");
    c.catat("memory:injected");
    c.catat("tool:invoked");
    c.catat("user:pesan");

    const l = c.laporan();
    assert.equal(l.c0, 1);
    assert.equal(l.c1, 1);
    assert.equal(l.c2, 2);
    assert.equal(l.total, 4);
    assert.match(l.catatan, /self-monitoring \(C2\)/);
});

// ---- IgnitionCore (Dehaene C1: nyala all-or-none) ----

test("IgnitionCore: di bawah ambang tidak menyala (subliminal)", () => {
    const ig = new IgnitionCore({ ambang: 0.5 });
    const r = ig.uji(0.3);
    assert.equal(r.ignited, false);
});

test("IgnitionCore: di atas ambang menyala + amplifikasi nonlinier", () => {
    const ig = new IgnitionCore({ ambang: 0.5, penguatan: 1.6 });
    const r = ig.uji(0.6);
    assert.equal(r.ignited, true);
    assert.ok(r.amplified > 0.6, "harus teramplifikasi di atas ambang");
    assert.equal(r.amplified, 0.96);
});

test("IgnitionCore.nyalakan: isi aktif + gema meluruh", () => {
    const ig = new IgnitionCore({ ambang: 0.5, gema: 50 });
    const isi = ig.nyalakan({ type: "user:pesan", payload: { ringkas: "halo" }, salience: 0.9 });
    assert.ok(isi);
    assert.equal(ig.isiAktif().length, 1);
    // gema 50ms → setelah menunggu, meluruh
    return new Promise(resolve => {
        setTimeout(() => {
            assert.equal(ig.isiAktif().length, 0);
            resolve();
        }, 80);
    });
});

// ---- EpisodicBuffer (serial bottleneck) ----

test("EpisodicBuffer: fokus = item terbaru; kapasitas kecil", () => {
    const b = new EpisodicBuffer({ kapasitas: 3 });
    b.dorong({ ringkas: "a", salience: 0.5 });
    b.dorong({ ringkas: "b", salience: 0.6 });
    b.dorong({ ringkas: "c", salience: 0.7 });
    b.dorong({ ringkas: "d", salience: 0.8 });

    assert.equal(b.fokus().ringkas, "d");
    assert.equal(b.isi().length, 3);
    // jejak urutan serial tercatat
    assert.equal(b.jejak(2)[0].ringkas, "d");
});

// ---- SelfMonitoring (Dehaene C2: deteksi kesalahan) ----

test("SelfMonitoring: ekspektasi cocok → tanpa kesalahan", () => {
    const m = new SelfMonitoring();
    const id = m.harapkan("tool baca", "isi-berkas");
    const r = m.nilaiHasil(id, "isi-berkas");
    assert.equal(r.error, false);
    assert.equal(m.nilai().kesalahanTerakhir, null);
});

test("SelfMonitoring: ekspektasi meleset → sinyal kesalahan (prediction-error)", () => {
    const m = new SelfMonitoring();
    const id = m.harapkan("tool baca", "isi-berkas");
    const r = m.nilaiHasil(id, "isi-BERBEDA");
    assert.equal(r.error, true);
    assert.ok(m.nilai().kesalahanTerakhir);
});

test("SelfMonitoring.konflik mencatat kontradiksi", () => {
    const m = new SelfMonitoring();
    m.konflik("kata A", "kata B");
    assert.equal(m.nilai().kesalahanTerakhir.apa, "kontradiksi: kata A");
});

// ---- InnerSpeech (Patton/Haikonen: loop verbal) ----

test("InnerSpeech: ucap + baca ulang (re-entry loop)", () => {
    const s = new InnerSpeech();
    const u = s.ucap("rencana: kirim laporan", "rencana");
    const baca = s.baca(1);
    assert.equal(baca[0].id, u.id);
    assert.equal(baca[0].topik, "rencana");
});

test("InnerSpeech: revisi menandai self-editing", () => {
    const s = new InnerSpeech();
    const u = s.ucap("draft salah", "draft");
    const r = s.revisi(u.id, "draft benar");
    assert.equal(r.revisiDari, u.id);
    assert.match(s.ringkas(1), /draft benar/);
});

// ---- Imagination (Haikonen: reaktivasi percept + antisipasi) ----

test("Imagination: simpan & ingat percept (penguatan berulang)", () => {
    const im = new Imagination();
    im.simpan("warna:merah", { nilai: 1 });
    im.ingat("warna:merah");
    const p = im.ingat("warna:merah");
    assert.equal(p.kuat, 3); // 1 awal + 2 recall
});

test("Imagination.bayangkan menandai simulated=true (antisipasi jujur)", () => {
    const im = new Imagination();
    const s = im.bayangkan("skenario: listrik mati", ["percept:cuaca"]);
    assert.equal(s.simulated, true);
    assert.deepEqual(s.dari, ["percept:cuaca"]);
});

// ---- AssociativeMemory (Haikonen: asosiasi Hebbian) ----

test("AssociativeMemory: ko-aktivasi memperkuat asosiasi", () => {
    const a = new AssociativeMemory();
    a.aktifkanBersama(["kucing", "bulu"]);
    a.aktifkanBersama(["kucing", "bulu"]);
    a.aktifkanBersama(["kucing", "ekor"]);

    const asosiasi = a.asosiasi("kucing");
    const bulu = asosiasi.find(x => x.konsep === "bulu");
    assert.equal(bulu.kuat, 2);
    const ekor = asosiasi.find(x => x.konsep === "ekor");
    assert.equal(ekor.kuat, 1);
});

// ---- QualiaStructure (Watanabe: struktur relasional) ----

test("QualiaStructure: bentuk relasional & keserupaan", () => {
    const q = new QualiaStructure();
    q.set("merah", 1);
    q.set("panas", 2);
    q.set("biru", 1);
    q.set("dingin", 2);

    // merah → panas (sebab), biru → dingin (sebab): bentuk serupa
    q.hubungkan("merah", "panas", "sebab");
    q.hubungkan("biru", "dingin", "sebab");

    const bentukMerah = q.bentuk("merah");
    assert.equal(bentukMerah.keluar.length, 1);
    assert.equal(bentukMerah.keluar[0].jenis, "sebab");

    // merah dan biru punya pola relasional serupa (x → y "sebab")
    const s = q.serupa("merah", "biru");
    assert.equal(s, 1);
});

test("QualiaStructure.serupa: tanpa relasi bersama → 0", () => {
    const q = new QualiaStructure();
    q.set("a", 1);
    q.set("b", 2);
    assert.equal(q.serupa("a", "b"), 0);
});
