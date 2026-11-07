const test = require("node:test");
const assert = require("node:assert");

const { AffectCore, HALF_LIFE_MS } = require("../../src/consciousness/AffectCore");
const { GlobalWorkspace } = require("../../src/consciousness/GlobalWorkspace");
const { Empathy } = require("../../src/consciousness/Empathy");
const { Metacognition } = require("../../src/consciousness/Metacognition");
const { Character, LAJU } = require("../../src/consciousness/Character");
const { Deliberation } = require("../../src/consciousness/Deliberation");
const { Mind } = require("../../src/consciousness");

/**
 * Lapisan kesadaran (afek, perhatian, model-diri, metakognisi, empati).
 *
 * Yang diuji di sini bukan "apakah Damar sadar" — itu bukan
 * pertanyaan yang bisa dijawab oleh tes. Yang diuji adalah janji-janji
 * yang bisa dilanggar diam-diam:
 *
 *   - suasana hati PULIH (kalau tidak, satu kegagalan mengunci Damar
 *     jadi murung selamanya),
 *   - perhatian TERBATAS (kalau tidak, ia bukan perhatian),
 *   - empati mengubah SIKAP, bukan cuma melabeli,
 *   - keyakinan TURUN saat buktinya buruk,
 *   - blok prompt tetap kecil (ia ikut di setiap giliran).
 */

/** Penyimpan tiruan: tes tidak boleh menyentuh configs/mind.json asli. */
function storePalsu(isi = {}) {

    let data = { ...isi };

    return {
        read: () => data,
        write: (baru) => { data = { ...baru }; return data; }
    };

}

// ---- Afek --------------------------------------------------------

test("afek meluruh kembali ke garis dasar — suasana hati tidak mengunci", () => {

    const afek = new AffectCore(storePalsu());
    const dasar = afek.baseline.valence;

    afek.appraise("tool:gagal");
    afek.appraise("tool:gagal");
    afek.appraise("tool:gagal");

    const buruk = afek.now().valence;

    assert.ok(buruk < dasar, "kegagalan beruntun harus menurunkan valensi");

    // Majukan waktu empat paruh: sisa simpangan sekitar 6%.
    afek.luruh(Date.now() + HALF_LIFE_MS * 4);

    const pulih = afek.now().valence;

    assert.ok(pulih > buruk, "afek harus bergerak pulih seiring waktu");
    assert.ok(
        Math.abs(pulih - dasar) < Math.abs(buruk - dasar) * 0.25,
        "setelah empat paruh waktu, sisa simpangan harus kecil"
    );

});

test("afek tidak pernah keluar rentang walau dihantam terus", () => {

    const afek = new AffectCore(storePalsu());

    for (let i = 0; i < 100; i++) afek.appraise("tool:gagal");

    const { valence, arousal } = afek.now();

    assert.ok(valence >= -1 && valence <= 1, `valensi ${valence} keluar rentang`);
    assert.ok(arousal >= 0 && arousal <= 1, `arousal ${arousal} keluar rentang`);

});

test("keadaan buruk mempertajam ketelitian TANPA melumpuhkan tindakan", () => {

    const afek = new AffectCore(storePalsu());
    const tenang = afek.bias().ketelitian;

    for (let i = 0; i < 50; i++) afek.appraise("tool:gagal");

    const bias = afek.bias();

    assert.ok(bias.ketelitian > tenang, "afek buruk harus menaikkan ketelitian");
    assert.ok(bias.keberanian >= 0.5, "tapi tidak pernah menjatuhkan kesediaan bertindak");
    assert.ok(bias.dorongan >= 0.65, "dan tidak pernah menjatuhkan dorongan bekerja");

});

test("tidak ada keputusasaan: valensi punya lantai", () => {

    const afek = new AffectCore(storePalsu());

    for (let i = 0; i < 200; i++) afek.appraise("tool:gagal");

    assert.ok(afek.now().valence >= -0.45, "boleh murung, tidak boleh tenggelam");

});

// ---- Ruang kerja global ------------------------------------------

test("perhatian TERBATAS: slot tidak pernah melebihi kapasitas", () => {

    const ws = new GlobalWorkspace({ kapasitas: 7 });

    for (let i = 0; i < 50; i++) {
        ws.terima({ type: "user:pesan", payload: { ringkas: `pesan ${i}` } });
    }

    assert.ok(ws.isi().length <= 7, "kapasitas panggung harus ditegakkan");

});

test("yang di bawah ambang tidak pernah menyala", () => {

    const ws = new GlobalWorkspace();
    const hasil = ws.terima({ type: "host:metrik", salience: 0.1 });

    assert.equal(hasil, null);
    assert.equal(ws.isi().length, 0);
    assert.equal(ws.diabaikan, 1);

});

test("peristiwa penting menggeser yang remeh dari panggung", () => {

    const ws = new GlobalWorkspace({ kapasitas: 2 });

    ws.terima({ type: "memory:injected", payload: { ringkas: "a" } });
    ws.terima({ type: "memory:injected", payload: { ringkas: "b" } });
    ws.terima({ type: "user:pesan", payload: { ringkas: "pengguna bicara" } });

    const jenis = ws.isi().map(s => s.type);

    assert.ok(jenis.includes("user:pesan"), "pesan pengguna harus menang bersaing");
    assert.equal(ws.isi().length, 2);

});

test("kejadian sama yang berulang menguatkan satu slot, bukan memborong panggung", () => {

    const ws = new GlobalWorkspace();

    for (let i = 0; i < 10; i++) {
        ws.terima({ type: "tool:gagal", payload: { ringkas: "binance timeout" } });
    }

    assert.equal(ws.isi().length, 1, "sepuluh kejadian identik tetap satu isi kesadaran");
    assert.equal(ws.isi()[0].ulang, 10);

});

// ---- Empati ------------------------------------------------------

test("empati membaca kemarahan DAN mengubah sikap, bukan cuma melabeli", () => {

    const baca = new Empathy().baca("kok belum kelar juga sih, dari tadi gagal terus!!");

    assert.ok(baca.valence < -0.3, "kemarahan harus terbaca negatif");
    assert.ok(baca.arousal > 0.6, "kemarahan harus terbaca terjaga");
    assert.match(baca.postur, /akui|perbaikan/i, "sikapnya harus berubah, bukan cuma label");
    assert.ok(baca.kebutuhan, "harus menyebut apa yang dibutuhkan pengguna");

});

test("pujian terbaca positif dan tidak memicu sikap minta maaf", () => {

    const baca = new Empathy().baca("makasih ya, akhirnya berhasil!");

    assert.ok(baca.valence > 0.3);
    assert.doesNotMatch(baca.postur, /akui dulu masalahnya/i);

});

test("singkatan huruf besar bukan teriakan — BTC tidak dibaca marah", () => {

    const baca = new Empathy().baca("BTC?");

    assert.ok(baca.valence > -0.2, `"BTC?" tidak boleh terbaca marah (${baca.valence})`);

});

test("penularan afek kecil: Damar tidak ikut panik", () => {

    const e = new Empathy();
    const tular = e.penularan(e.baca("PANIK BANGET AKU TAKUT KEHILANGAN SEMUANYA!!"));

    assert.ok(
        Math.abs(tular.valence) <= 0.3,
        "penularan harus lemah — kalau penuh, Damar ikut panik dan berhenti menolong"
    );

});

// ---- Metakognisi -------------------------------------------------

test("keyakinan TURUN saat tool gagal dan NAIK saat terverifikasi", () => {

    const m = new Metacognition();
    const awal = m.nilai().keyakinan;

    m.catat("tool:gagal");
    assert.ok(m.nilai().keyakinan < awal);

    m.reset();
    m.catat("verifikasi:ok");
    assert.ok(m.nilai().keyakinan > awal);

});

test("keyakinan rendah menghasilkan ARAHAN untuk berterus terang", () => {

    const m = new Metacognition();

    m.catat("tebakan");
    m.catat("kontradiksi");

    assert.equal(m.tingkat(), "tidak yakin");
    assert.match(m.arahan(), /terus terang|belum kamu tahu/i);

});

test("ketidaktahuan yang diakui tersimpan dengan nama, bukan hilang", () => {

    const m = new Metacognition();

    m.akuiTidakTahu("saldo Binance tak terbaca dari wilayah ini");

    assert.equal(m.nilai().ragu.length, 1);
    assert.match(m.nilai().ragu[0], /Binance/);

});

// ---- Lapisan utuh ------------------------------------------------

test("blok keadaan batin tetap kecil — ia ikut di SETIAP giliran", () => {

    const mind = new Mind({ store: storePalsu() });

    mind.perceiveUser("tolong cepat, ini mendesak banget!!");
    mind.afterTurn({ toolsGagal: 2 });

    const blok = mind.stateOfMind();

    assert.ok(blok.length <= 560, `blok ${blok.length} karakter — terlalu besar untuk tiap giliran`);
    assert.match(blok, /KEADAAN BATINMU/);

});

test("blok keadaan JUJUR: menyebut ini bukan klaim pengalaman subjektif", () => {

    const blok = new Mind({ store: storePalsu() }).stateOfMind();

    assert.match(
        blok, /bukan klaim pengalaman subjektif/i,
        "kejujuran soal sifat keadaan ini bagian dari kontrak, bukan hiasan"
    );

});

test("giliran percakapan mengubah keadaan: pengguna marah terbaca dan tercatat", () => {

    const mind = new Mind({ store: storePalsu() });
    const sebelum = mind.affect.now().valence;

    mind.perceiveUser("payah banget, dari tadi gagal terus!");

    assert.ok(mind.affect.now().valence < sebelum, "keadaan pengguna harus menular sedikit");
    assert.equal(mind.bacaanTerakhir.label, "marah");
    assert.match(mind.stateOfMind(), /Pembacaanmu atas pengguna/);

});

test("model-diri menghitung interaksi dan menyimpan perubahan diri", () => {

    const mind = new Mind({ store: storePalsu() });
    const awal = mind.self.interaksi;

    mind.perceiveUser("halo");
    assert.equal(mind.self.interaksi, awal + 1);

    mind.self.catatRevisi("belajar bahwa Binance memblokir wilayah ini", "HTTP 403");

    assert.match(mind.self.revisi[0].apa, /Binance/);
    assert.match(mind.self.ringkas(), /aku Damar/);

});

test("lapisan kesadaran tidak pernah melempar walau masukannya kacau", () => {

    const mind = new Mind({ store: storePalsu() });

    assert.doesNotThrow(() => {
        mind.perceiveUser(null);
        mind.perceiveUser(undefined);
        mind.perceiveUser({ bukan: "teks" });
        mind.afterTurn({});
        mind.afterTurn({ toolsOk: "x", toolsGagal: null });
        mind.workspace.terima({});
        mind.workspace.terima(undefined);
        mind.stateOfMind();
        mind.potret();
    });

});

// ---- Karakter yang tumbuh sendiri --------------------------------

test("watak LAMBAN: satu pengalaman tidak mengubah siapa dirinya", () => {

    const c = new Character(storePalsu());
    const sebelum = c.sifat.ketelitian;

    c.alami("teliti_menolong");

    assert.ok(
        Math.abs(c.sifat.ketelitian - sebelum) <= LAJU * 1.01,
        "satu kejadian tidak boleh menggeser sifat lebih dari satu langkah belajar"
    );

});

test("watak TUMBUH: puluhan pengalaman searah menggeser sifat dan menandai tonggak", () => {

    const c = new Character(storePalsu());
    const sebelum = c.sifat.ketelitian;
    let tonggak = [];

    for (let i = 0; i < 30; i++) tonggak = tonggak.concat(c.alami("teliti_menolong"));

    assert.ok(c.sifat.ketelitian > sebelum + 0.1, "pengalaman searah harus membentuk watak");
    assert.ok(tonggak.length >= 1, "perubahan besar harus tercatat sebagai tonggak");
    assert.equal(tonggak[0].sifat, "ketelitian");

});

test("kegagalan mengajari TELITI dan TEKUN, bukan menjadi penakut atau malas", () => {

    const c = new Character(storePalsu());
    const teliti = c.sifat.ketelitian;

    for (let i = 0; i < 200; i++) c.alami("gegabah");

    assert.ok(c.sifat.ketelitian > teliti, "gagal harus menguatkan ketelitian");
    assert.ok(c.sifat.keberanian >= 0.55, "keberanian punya lantai — tidak ada watak penakut");
    assert.ok(c.sifat.ketekunan >= 0.8, "ketekunan punya lantai — tidak ada watak malas");

});

test("sifat tidak pernah keluar rentang walau dihantam ratusan pengalaman", () => {

    const c = new Character(storePalsu());

    for (let i = 0; i < 300; i++) c.alami("dihargai");

    for (const [nama, nilai] of Object.entries(c.sifat)) {
        assert.ok(nilai >= 0.05 && nilai <= 0.95, nama + " = " + nilai + " keluar rentang");
    }

});

test("watak BERAKIBAT: teliti menurunkan ambang berpikir dalam", () => {

    const c = new Character(storePalsu());
    const awal = c.ambangDeliberasi();

    for (let i = 0; i < 20; i++) c.alami("teliti_menolong");

    assert.ok(c.ambangDeliberasi() < awal, "watak yang tidak mengubah apa pun bukan watak");

});

test("watak menggeser rumah suasana hati, bukan cuma angka di berkas", () => {

    const c = new Character(storePalsu());
    const dasar = c.baselineAfek().valence;

    for (let i = 0; i < 20; i++) c.alami("dihargai");

    assert.ok(c.baselineAfek().valence > dasar, "kehangatan yang tumbuh harus mencerahkan garis dasar");

});

// ---- Berpikir dua kecepatan --------------------------------------

test("pertanyaan ringan TIDAK memicu berpikir dalam", () => {

    const d = new Deliberation();
    const hasil = d.nilai({ teks: "jam berapa sekarang?", keyakinan: 0.6, ambang: 0.55 });

    assert.equal(hasil.mode, "cepat", "memaksa penalaran panjang di hal ringan cuma memperlambat");
    assert.equal(d.protokol(), null);

});

test("taruhan dinilai dari TOOL destruktif yang tersedia, bukan dari kata", () => {

    const d = new Deliberation();

    // Kalimat sopan tanpa satu pun kata "berbahaya" — tapi tool yang
    // terlampir memang bisa merusak. Inilah yang dulu lolos.
    const hasil = d.nilai({
        teks: "tolong rapikan ya",
        tools: ["terminal_run", "crypto_confirm_order"],
        ambang: 0.55
    });

    assert.equal(hasil.mode, "dalam");
    assert.ok(hasil.destruktif >= 1, "risiko harus datang dari tool, bukan dari kosakata");
    assert.match(d.protokol(), /MINIMAL dua|MEMBANTAH|premortem/i);

});

test("kata menakutkan TANPA tool berbahaya tidak lagi memicu rem", () => {

    const d = new Deliberation();

    const hasil = d.nilai({
        teks: "jangan hapus apa pun ya, cukup lihat saja",
        tools: ["crypto_price"],
        keyakinan: 0.7,
        ambang: 0.55
    });

    assert.equal(hasil.mode, "cepat", "deteksi berbasis kata sudah dihapus");

});

test("keyakinan rendah sendirian sudah cukup untuk melambat", () => {

    const d = new Deliberation();
    const rendah = d.nilai({ teks: "kira-kira ini kenapa ya", keyakinan: 0.2, ambang: 0.3 });

    assert.equal(rendah.mode, "dalam");
    assert.ok(rendah.sebab.includes("keyakinan rendah"));

});

test("permintaan berlangkah banyak melambat karena BENTUKNYA", () => {

    const d = new Deliberation();

    const hasil = d.nilai({
        teks: "ambil data harga, hitung rata-ratanya, bandingkan dengan minggu lalu, lalu simpan ringkasannya",
        keyakinan: 0.6,
        ambang: 0.5
    });

    assert.equal(hasil.mode, "dalam");
    assert.ok(hasil.sebab.some(x => /bagian harus benar/.test(x)));

});

test("protokol berpikir dalam menuntut alternatif, bukti pembantah, lalu TINDAKAN", () => {

    const d = new Deliberation();

    d.nilai({ teks: "a, b, c, d", keyakinan: 0.2, ambang: 0.3 });

    const teks = d.protokol();

    assert.match(teks, /MINIMAL dua/);
    assert.match(teks, /MEMBANTAH/);
    assert.match(teks, /premortem/i);
    assert.match(teks, /LALU KERJAKAN/, "berpikir dalam tidak boleh berhenti jadi tawaran");

});

test("perintah mendalam memuat semua tahap dan larangan mengarang bukti", () => {

    const teks = new Deliberation().perintahMendalam("kenapa order Binance gagal", "HTTP 403");

    for (const tahap of ["INTI", "PECAH", "KANDIDAT", "UJI", "PREMORTEM", "PUTUSAN"]) {
        assert.match(teks, new RegExp(tahap));
    }

    assert.match(teks, /Jangan mengarang bukti/);

});

// ---- Watak + berpikir di dalam lapisan utuh ----------------------

test("permintaan bertaruh besar membawa protokol berpikir ke dalam prompt", () => {

    const mind = new Mind({ store: storePalsu() });

    mind.perceiveUser("kerjakan yang tadi ya", { tools: ["terminal_run", "crypto_confirm_order"] });

    assert.equal(mind.deliberation.terakhir.mode, "dalam");

    const blok = mind.stateOfMind();

    assert.match(blok, /BERPIKIR DALAM DIWAJIBKAN/);
    assert.match(blok, /Tunjukkan HASILNYA saja/, "protokol tidak boleh terpotong di tengah");

});

test("giliran ringan tetap ringan — blok prompt tidak membengkak", () => {

    const mind = new Mind({ store: storePalsu() });

    mind.perceiveUser("jam berapa sekarang?");

    assert.equal(mind.deliberation.terakhir.mode, "cepat");
    assert.ok(mind.stateOfMind().length <= 560);

});

test("hasil giliran membentuk watak, dan perubahannya tercatat sebagai riwayat diri", () => {

    const mind = new Mind({ store: storePalsu() });
    const teliti = mind.character.sifat.ketelitian;

    // Berkali-kali menjawab cepat lalu gagal.
    for (let i = 0; i < 25; i++) {
        mind.perceiveUser("cek harga BTC");
        mind.afterTurn({ toolsGagal: 1 });
    }

    assert.ok(mind.character.sifat.ketelitian > teliti, "gagal berulang harus menajamkan ketelitian");
    assert.ok(mind.character.sifat.ketekunan >= 0.8, "dan tidak pernah membuatnya malas");
    assert.ok(mind.character.pengalaman >= 25);
    assert.ok(mind.character.tonggak.length >= 1, "perubahan sebesar itu harus jadi tonggak");
    assert.ok(
        mind.self.revisi.some(r => /menguat|melemah/.test(r.apa)),
        "tonggak watak harus masuk riwayat diri, supaya Damar tahu ia berubah"
    );

});

test("watak ikut ke prompt setiap giliran", () => {

    const mind = new Mind({ store: storePalsu() });

    mind.perceiveUser("halo");

    assert.match(mind.stateOfMind(), /Watakmu \(tumbuh dari pengalaman/);

});
