const test = require("node:test");
const assert = require("node:assert");

const { selectTools, ALWAYS, isAlways, isExternal, tail } = require("../../src/ai/tools/ToolSelector");

/**
 * Pemilih tool (§28 anggaran konteks).
 *
 * Damar mendaftarkan 138 tool sementara anggaran prompt hanya 32 —
 * 106 dibuang pada setiap permintaan. Yang lolos menentukan apa yang
 * MUNGKIN dilakukan Damar sama sekali, jadi kesalahan di sini
 * terlihat sebagai "Damar memilih tool yang aneh", bukan sebagai
 * kegagalan pemilihan.
 */

/** Nama seperti yang benar-benar dilihat model. */
const NAMA_ASLI = [
    // Jembatan plugin: id "plugin.tool" menjadi "plugin__tool".
    "filesystem__readFile",
    "filesystem__writeFile",
    "filesystem__listDirectory",
    "filesystem__deleteFile",
    "system__time__currentTime",
    "http__get",
    "calculator__calculator",
    // Tool asli, tanpa awalan.
    "memory_remember",
    "memory_recall",
    "memory_forget",
    "terminal_run",
    "home_control",
    "whatsapp_send_photo",
    "code_commit",
    "code_hover"
];

const buat = names => names.map(name => ({
    name,
    description: name.replace(/[_.]+/g, " ")
}));

// ---- Jaminan tulang punggung -------------------------------------

test("SETIAP entri ALWAYS benar-benar cocok dengan tool terdaftar", () => {

    // Inilah tes yang absen. Daftar lama menuliskan "readFile"
    // padahal model melihat "filesystem__readFile", jadi jaminannya
    // tidak pernah berlaku — dan tak ada yang memberi tahu.
    const tools = buat(NAMA_ASLI);

    for (const entri of ALWAYS) {

        const cocok = tools.some(t => t.name === entri || tail(t.name) === entri);

        assert.ok(
            cocok,
            `"${entri}" tidak cocok dengan nama tool mana pun — jaminannya mati diam-diam`
        );

    }

});

test("ruas terakhir nama terbaca untuk kedua gaya penamaan", () => {

    assert.equal(tail("filesystem__readFile"), "readFile");
    assert.equal(tail("system__time__currentTime"), "currentTime");
    assert.equal(tail("memory_recall"), "memory_recall");
    assert.equal(tail("filesystem.readFile"), "readFile");

});

test("tulang punggung ikut SETIAP KALI tool dilampirkan", () => {

    // Jaminannya dipersempit dengan sengaja: bukan lagi "selalu
    // terkirim", melainkan "selalu ikut bila ada tool yang
    // terkirim". Pesan yang tidak menyinggung kemampuan apa pun
    // tidak melampirkan tool sama sekali — lihat tes di bawah.
    const dipilih = selectTools(buat(NAMA_ASLI), "tolong nyalakan lampu ruang tamu", 10)
        .map(t => t.name);

    assert.ok(dipilih.length > 0, "permintaan ini jelas butuh tool");

    for (const wajib of ["filesystem__readFile", "filesystem__writeFile", "filesystem__listDirectory"]) {
        assert.ok(dipilih.includes(wajib), `${wajib} harus ikut saat tool dilampirkan`);
    }

});

// ---- Kasus yang benar-benar terjadi -------------------------------

test("\"jam berapa sekarang\" membawa tool waktu, bukan terminal", () => {

    // Persis yang gagal pada daemon: model memakai `terminal_run`
    // (destruktif, ditahan) untuk menanyakan jam, karena tool waktu
    // kalah dalam pemilihan sementara terminal dijamin selalu ikut.
    const dipilih = selectTools(buat(NAMA_ASLI), "jam berapa sekarang", 8)
        .map(t => t.name);

    assert.ok(
        dipilih.includes("system__time__currentTime"),
        "tool waktu harus terkirim untuk pertanyaan tentang jam"
    );

});

test("terminal_run TIDAK lagi dijamin satu slot", () => {

    // Ia destruktif dan ditahan gerbang; slot terjamin untuknya
    // memboroskan anggaran dan menuntun model ke tool yang ditolak.
    const dipilih = selectTools(buat(NAMA_ASLI), "halo apa kabar", 6)
        .map(t => t.name);

    assert.ok(!dipilih.includes("terminal_run"));

});

test("terminal_run tetap terpilih saat memang diminta", () => {

    const dipilih = selectTools(buat(NAMA_ASLI), "jalankan perintah docker ps di terminal", 10)
        .map(t => t.name);

    assert.ok(
        dipilih.includes("terminal_run"),
        "menghapus jaminan tidak boleh membuat tool hilang saat dibutuhkan"
    );

});

test("permintaan rumah membawa tool rumah", () => {

    const dipilih = selectTools(buat(NAMA_ASLI), "tolong nyalakan lampu ruang tamu", 8)
        .map(t => t.name);

    assert.ok(dipilih.includes("home_control"));

});

test("permintaan chart live membawa show_chart, bukan tool foto", () => {

    // "tampilkan" memicu profil galeri; tanpa profil crypto, permintaan
    // chart pulang membawa tool foto dan chart tak pernah muncul.
    const tools = buat([...NAMA_ASLI, "show_chart", "crypto_price", "search_photos"]);

    const dipilih = selectTools(tools, "tampilkan chart live BTC", 12).map(t => t.name);

    assert.ok(dipilih.includes("show_chart"), "show_chart wajib ikut untuk permintaan chart");
    assert.ok(!dipilih.includes("search_photos"), "tool foto tidak relevan untuk chart");

});

// ---- Batas -------------------------------------------------------

test("anggaran dihormati sebagai BATAS ATAS, bukan target", () => {

    const dipilih = selectTools(buat(NAMA_ASLI), "apa saja", 5);

    assert.ok(dipilih.length <= 5);

});

test("obrolan biasa tidak melampirkan tool sama sekali", () => {

    // Melampirkan tool punya harga tetap ± 777 token (template
    // tool-calling llama3.1) = ± 16 detik di mesin ini, dan untuk
    // sapaan itu membeli nol manfaat.
    for (const basa of ["halo", "terima kasih ya", "oke siap"]) {
        assert.deepEqual(
            selectTools(buat(NAMA_ASLI), basa, 10),
            [],
            `"${basa}" tidak menyinggung kemampuan apa pun`
        );
    }

});

test("pertanyaan waktu TETAP membawa tool waktu", () => {

    // Jebakan yang sempat saya buat: tool waktu ada di tulang
    // punggung, jadi bila relevansi dinilai tanpa menyertakannya,
    // "jam berapa" terbaca sebagai obrolan biasa dan Damar
    // kehilangan satu-satunya cara mengetahui jam.
    const dipilih = selectTools(buat(NAMA_ASLI), "jam berapa sekarang", 10).map(t => t.name);

    assert.ok(dipilih.includes("system__time__currentTime"));

});

test("mode 'backbone' mengembalikan perilaku lama", () => {

    const semula = process.env.DAMAR_TOOLS_WHEN_IDLE;
    process.env.DAMAR_TOOLS_WHEN_IDLE = "backbone";

    try {
        const dipilih = selectTools(buat(NAMA_ASLI), "halo", 10).map(t => t.name);
        assert.ok(dipilih.includes("memory_remember"), "tulang punggung tetap terkirim");
        assert.ok(dipilih.length <= 8);
    }
    finally {
        if (semula === undefined) delete process.env.DAMAR_TOOLS_WHEN_IDLE;
        else process.env.DAMAR_TOOLS_WHEN_IDLE = semula;
    }

});

test("sapaan tidak memborong anggaran dengan tool tak relevan", () => {

    // Diukur pada sistem sungguhan: "halo" mengirim 32 definisi
    // (± 1.900 token) berisi tool WhatsApp, kamera, dan lainnya —
    // semuanya berskor nol, terpilih hanya karena urutan pendaftaran.
    // Di inferensi CPU tiap token prompt dibayar dengan waktu.
    // Anggaran harus di bawah jumlah tool, jika tidak jalan pintas
    // "sudah muat, kirim semua" yang berlaku — bukan pemilihannya.
    const dipilih = selectTools(buat(NAMA_ASLI), "halo", 10).map(t => t.name);

    assert.ok(dipilih.length <= 8, `hanya tulang punggung yang perlu, dapat ${dipilih.length}`);

    for (const tak of ["home_control", "whatsapp_send_photo", "code_commit", "terminal_run"]) {
        assert.ok(!dipilih.includes(tak), `${tak} tidak ada hubungannya dengan sapaan`);
    }

});

test("permintaan yang jelas tetap membawa toolnya", () => {

    // Menyusutkan untuk obrolan biasa tidak boleh melumpuhkan
    // permintaan yang benar-benar butuh tool.
    const rumah = selectTools(buat(NAMA_ASLI), "tolong nyalakan lampu ruang tamu", 10).map(t => t.name);
    assert.ok(rumah.includes("home_control"));

    const kirim = selectTools(buat(NAMA_ASLI), "kirim foto ini ke whatsapp istri", 10).map(t => t.name);
    assert.ok(kirim.includes("whatsapp_send_photo"));

    const jalankan = selectTools(buat(NAMA_ASLI), "jalankan perintah docker ps", 10).map(t => t.name);
    assert.ok(jalankan.includes("terminal_run"));

});

test("anggaran 0 berarti kirim semua", () => {

    const semua = buat(NAMA_ASLI);

    assert.equal(selectTools(semua, "apa saja", 0).length, semua.length);

});

test("tool lebih sedikit dari anggaran dikirim apa adanya", () => {

    const sedikit = buat(NAMA_ASLI.slice(0, 4));

    assert.equal(selectTools(sedikit, "apa saja", 32).length, 4);

});

test("urutan keluaran stabil: inti dulu, lalu tambahan profil", () => {

    // Tes ini dulu menuntut URUTAN PENDAFTARAN — warisan dari pemilih
    // versi skor yang merakit daftar segar tiap pesan. Pemilih
    // sekarang sengaja tidak begitu: inti selalu di depan dengan
    // urutan tetap, karena inferensi lokal memakai ulang prefix prompt di
    // tingkat token. Diukur: daftar sama diulang → prompt eval
    // 0,19–0,39 dtk; daftar berubah → 7,6–12,5 dtk. Urutannya bagian
    // dari kontrak, jadi itulah yang dikunci di sini.
    const semua = buat(NAMA_ASLI);
    const dipilih = selectTools(semua, "nyalakan lampu", 8).map(t => t.name);

    assert.deepEqual(
        dipilih.slice(0, 6),
        [
            "memory_recall",
            "memory_remember",
            "system__time__currentTime",
            "filesystem__readFile",
            "filesystem__writeFile",
            "filesystem__listDirectory"
        ],
        "inti harus selalu di depan dengan urutan yang sama"
    );

    assert.ok(dipilih.includes("home_control"), "tambahan profil menyusul sesudah inti");

});

test("dua pesan seprofil menghasilkan daftar tool IDENTIK", () => {

    // Inilah properti yang membuat cache berguna. Kalau dua pesan
    // rumah menghasilkan daftar berbeda, setiap pesan membayar
    // evaluasi prompt penuh.
    const semua = buat(NAMA_ASLI);

    const a = selectTools(semua, "nyalakan lampu ruang tamu", 10).map(t => t.name);
    const b = selectTools(semua, "matikan lampu kamar", 10).map(t => t.name);
    const c = selectTools(semua, "cek status lampu dapur", 10).map(t => t.name);

    assert.deepEqual(a, b);
    assert.deepEqual(b, c);

});

test("profil berbeda tetap berbagi prefix inti", () => {

    // Berpindah profil hanya membatalkan cache mulai titik
    // perbedaannya, bukan dari token pertama.
    const semua = buat(NAMA_ASLI);

    const rumah = selectTools(semua, "nyalakan lampu", 10).map(t => t.name);
    const kode = selectTools(semua, "perbaiki bug di kode ini", 10).map(t => t.name);

    assert.deepEqual(rumah.slice(0, 6), kode.slice(0, 6), "enam pertama harus sama persis");
    assert.notDeepEqual(rumah, kode, "tambahannya memang berbeda");

});

test("isAlways tidak melempar pada masukan kacau", () => {

    assert.doesNotThrow(() => isAlways(null));
    assert.doesNotThrow(() => isAlways({}));
    assert.equal(isAlways({ name: undefined }), false);

});

// ---- Tool eksternal (MCP) ------------------------------------------

test("isExternal mengenali nama bridge mcp__ tapi bukan tool asli", () => {

    assert.equal(isExternal({ name: "mcp__e2e__search" }), true);
    assert.equal(isExternal({ name: "filesystem__readFile" }), false);
    assert.equal(isExternal({ name: "memory_recall" }), false);
    assert.equal(isExternal(null), false);

});

test("tool MCP terpilih saat pesan relevan, tak dilampirkan saat idle", () => {

    // Daftar besar agar anggaran benar-benar bekerja (≤ anggaran
    // dikirim apa adanya).
    const banyak = [];
    for (let i = 0; i < 160; i++) banyak.push({ name: `tool_${i}`, description: `desc ${i}` });
    banyak.push({ name: "mcp__e2e__search", description: "Cari web" });
    banyak.push({ name: "mcp__e2e__fetch_page", description: "Ambil halaman" });

    // "cari" cocok dengan deskripsi tool MCP → terlampir.
    const cari = selectTools(banyak, "cari informasi tentang kucing", 32);
    assert.ok(cari.some(t => t.name === "mcp__e2e__search"), "mcp search harus terpilih");

    // Sapaan idle: tak satu pun tool (termasuk MCP) dilampirkan.
    const halo = selectTools(banyak, "halo", 32);
    assert.equal(halo.some(t => isExternal(t)), false, "tool MCP tak boleh ikut saat idle");

});

test("tool MCP stabil untuk pesan yang sama (cache prefix)", () => {

    const banyak = [];
    for (let i = 0; i < 160; i++) banyak.push({ name: `tool_${i}`, description: `desc ${i}` });
    banyak.push({ name: "mcp__e2e__search", description: "Cari web" });

    const a = selectTools(banyak, "cari informasi", 32).map(t => t.name);
    const b = selectTools(banyak, "cari informasi", 32).map(t => t.name);

    assert.deepEqual(a, b);

});
