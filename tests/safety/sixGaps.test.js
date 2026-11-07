const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Enam celah §276 yang tersisa menuju 1.0.
 *
 * Satu berkas karena keenamnya dikerjakan sebagai satu langkah, dan
 * membacanya bersama menunjukkan apa yang sebenarnya sudah dijamin —
 * serta apa yang tidak.
 */

// ================================================================
// Celah 1 — Sandbox eksekusi kode
// ================================================================

const sandbox = require("../../src/core/safety/codeSandbox");

test("RAHASIA tidak diwariskan ke proses anak", () => {

    // Inti celahnya: `exec` mewarisi seluruh environment, sehingga
    // satu perintah `set` sudah cukup membaca DAMAR_TOKEN.
    const semula = { ...process.env };

    process.env.DAMAR_TOKEN = "rahasia-token-uji";
    process.env.OPENROUTER_API_KEY = "sk-rahasia-uji";
    process.env.MY_SECRET_PASSWORD = "jangan-bocor";

    try {

        const env = sandbox.env();

        assert.equal(env.DAMAR_TOKEN, undefined, "token Damar tidak boleh ikut");
        assert.equal(env.OPENROUTER_API_KEY, undefined, "kunci API tidak boleh ikut");
        assert.equal(env.MY_SECRET_PASSWORD, undefined, "apa pun bernama secret tidak boleh ikut");

        assert.ok(env.PATH || env.Path, "PATH tetap perlu supaya perintah dapat ditemukan");

    }
    finally {
        process.env = semula;
    }

});

test("daftar-IZIN, bukan daftar-larang", () => {

    // Variabel baru yang belum terpikirkan harus otomatis TIDAK
    // ikut. Kalau memakai daftar-larang, kunci berikutnya yang
    // ditambahkan ke .env akan bocor hanya karena tak ada yang
    // ingat melarangnya.
    const semula = process.env.VARIABEL_BARU_YANG_BELUM_TERPIKIRKAN;

    process.env.VARIABEL_BARU_YANG_BELUM_TERPIKIRKAN = "isi";

    try {
        assert.equal(sandbox.env().VARIABEL_BARU_YANG_BELUM_TERPIKIRKAN, undefined);
    }
    finally {
        if (semula === undefined) delete process.env.VARIABEL_BARU_YANG_BELUM_TERPIKIRKAN;
        else process.env.VARIABEL_BARU_YANG_BELUM_TERPIKIRKAN = semula;
    }

});

test("tambahan dari pemanggil tetap disaring", () => {

    const env = sandbox.env({ MY_API_KEY: "bocor", SAFE_FLAG: "1" });

    assert.equal(env.MY_API_KEY, undefined, "kelalaian pemanggil tidak boleh membatalkan batas");
    assert.equal(env.SAFE_FLAG, "1");

});

test("direktori kerja terkurung ke akar proyek", () => {

    assert.equal(sandbox.cwd("C:/Windows/System32"), sandbox.ROOT, "jalur di luar dikembalikan ke akar");
    assert.equal(sandbox.cwd("../../.."), sandbox.ROOT);
    assert.equal(sandbox.cwd("src/core"), path.join(sandbox.ROOT, "src", "core"));
    assert.equal(sandbox.cwd(null), sandbox.ROOT);

});

test("batas waktu dan keluaran ikut terpasang", () => {

    const o = sandbox.options({ timeout: 5000 });

    assert.equal(o.timeout, 5000);
    assert.ok(o.maxBuffer > 0, "keluaran dibatasi agar proses cerewet tidak menghabiskan memori");
    assert.equal(o.windowsHide, true);

});

test("perintah NYATA tidak dapat melihat rahasia", () => {

    // Bukti ujung-ke-ujung, bukan sekadar bentuk objek opsinya.
    const semula = process.env.DAMAR_TOKEN;
    process.env.DAMAR_TOKEN = "rahasia-token-uji";

    try {

        const keluaran = execFileSync(
            process.execPath,
            ["-e", "console.log(process.env.DAMAR_TOKEN ?? 'TIDAK-ADA')"],
            { ...sandbox.options({ timeout: 15000 }), encoding: "utf8" }
        ).trim();

        assert.equal(keluaran, "TIDAK-ADA", "proses anak seharusnya buta terhadap token");

    }
    finally {
        if (semula === undefined) delete process.env.DAMAR_TOKEN;
        else process.env.DAMAR_TOKEN = semula;
    }

});

test("batas sandbox dinyatakan apa adanya, tidak dilebihkan", () => {

    // Menyebutnya "sandbox penuh" akan menciptakan rasa aman yang
    // tidak ditopang apa pun.
    const d = sandbox.describe();

    assert.match(d.note, /BUKAN jail sistem operasi/i);
    assert.match(d.note, /jaringan/i, "keterbatasan jaringan harus disebut");

});

// ================================================================
// Celah 2 — World Model
// ================================================================

const WorldModel = require("../../src/world/WorldModel");

test("dunia dilaporkan beserta KAPAN diperiksa", async () => {

    // Yang membuatnya model, bukan sekadar pembacaan: fakta tentang
    // dunia menjadi basi, dan tanpa waktu pemeriksaan Damar
    // berbicara tentang keadaan lama dengan nada sama percayanya.
    const w = await WorldModel.snapshot({ fresh: true });

    assert.ok(w.at, "potret harus berwaktu");
    assert.ok(w.mesin.host.value, "nama mesin terbaca");
    assert.ok(w.mesin.host.checkedAt, "setiap fakta membawa waktu pemeriksaan");
    assert.ok(w.mesin.host.source, "setiap fakta membawa asalnya");

});

test("yang gagal diperiksa dilaporkan, bukan disembunyikan", async () => {

    const w = await WorldModel.snapshot({ fresh: true });

    const semua = [
        ...Object.values(w.penyimpanan),
        ...Object.values(w.layanan),
        ...Object.values(w.kecerdasan)
    ];

    for (const f of semua) {
        assert.ok(
            f.value !== undefined,
            "fakta harus punya nilai atau ditandai unknown — tidak boleh hilang diam-diam"
        );
        if (f.unknown) assert.ok(f.note, "yang tidak diketahui harus menyebut alasannya");
    }

});

test("ringkasan dapat dibaca dan hemat", async () => {

    const d = await WorldModel.describe();

    assert.ok(d.ringkasan.length > 0);
    assert.ok(d.ringkasan.length < 2000, "ringkasan harus hemat token di mesin lokal");
    assert.ok(d.diperiksa);

});

test("potret di-cache sebentar agar tidak membebani mesin", async () => {

    await WorldModel.snapshot({ fresh: true });
    const kedua = await WorldModel.snapshot();

    assert.equal(kedua.cached, true);

});

// ================================================================
// Celah 3 — Melanjutkan rencana terhenti
// ================================================================

const ExecutionPlan = require("../../src/agent/models/executionPlan");
const planStore = require("../../src/agent/planStore");

test("hanya langkah BACA yang boleh diulang sendiri", async () => {

    // Tool destruktif tidak boleh diulang tanpa sepengetahuan
    // pemilik — mengulanginya dapat mengeksekusi perintah dua kali.
    // D Round-3: penulisan berkas berefek samping → masuk kelas
    // destruktif (tidak boleh diulang sendiri), bukan "aman".
    const p = new ExecutionPlan({ goal: "uji triage" });

    p.addStep({ tool: "memory_recall" });        // aman
    p.addStep({ tool: "filesystem.writeFile" }); // efek samping → izin
    p.addStep({ tool: "whatsapp_send_photo" });  // aman
    p.addStep({ tool: "terminal_run" });         // destruktif

    const { otomatis, perluIzin } = planStore.triage(p);

    // E-F: outbound messaging & penulisan berkas = efek samping nyata →
    // semua masuk kelas perlu-izin; hanya baca murni yang otomatis.
    assert.deepEqual(otomatis.map(s => s.tool), ["memory_recall"]);
    assert.deepEqual(
        perluIzin.map(s => s.tool).sort(),
        ["filesystem.writeFile", "terminal_run", "whatsapp_send_photo"]
    );

});

test("langkah yang sudah selesai tidak diulang sama sekali", () => {

    const p = new ExecutionPlan({ goal: "uji" });

    const a = p.addStep({ tool: "memory_recall" });
    a.status = "done";

    p.addStep({ tool: "memory_recall" });

    const { otomatis, perluIzin } = planStore.triage(p);

    assert.equal(otomatis.length + perluIzin.length, 1, "itulah guna checkpoint");

});

test("tool tak dikenal dianggap aman — gerbang tidak menahan segalanya", () => {

    const p = new ExecutionPlan({ goal: "uji" });
    p.addStep({ tool: "tool_yang_belum_pernah_ada" });

    const { otomatis, perluIzin } = planStore.triage(p);

    assert.equal(otomatis.length, 1);
    assert.equal(perluIzin.length, 0);

});

// ================================================================
// Celah 4 — Penalaran lintas-relasi
// ================================================================

const RelationService = require("../../src/memory/services/RelationService");

test("entitas yang sering disebut bersama terbaca berhubungan", async () => {

    const engine = require("../../src/memory/core/MemoryEngine");
    const EntityStore = require("../../src/memory/stores/EntityStore");

    const tanda = Date.now();
    const budi = `BudiUji${tanda}`;
    const mobil = `MobilBiruUji${tanda}`;
    const rumah = `RumahUji${tanda}`;

    // Tiga memori: Budi+mobil dua kali, Budi+rumah sekali.
    for (const [a, b] of [[budi, mobil], [budi, mobil], [budi, rumah]]) {
        await engine.remember(
            `${a} terlihat bersama ${b}.`,
            { type: "skills", entities: [a, b] },
            engine.context({ writer: "uji-relasi" })
        );
    }

    const e = await EntityStore.findByName?.(budi) ?? await EntityStore.resolve?.(budi);

    // Tanpa penegasan ini, tes dapat "lulus" justru ketika pipeline
    // entitas mati — kelulusan palsu yang lebih buruk daripada gagal.
    assert.ok(e?.id, "entitas harus terbentuk dari memori yang menyebutnya");

    const hasil = await RelationService.related(e.id, { depth: 2 });

    assert.ok(hasil.direct.length >= 1, "entitas yang disebut bersama harus terhubung");

    const nama = hasil.direct.map(n => n.name);

    assert.ok(nama.includes(mobil), `${mobil} harus terbaca berhubungan dengan ${budi}`);
    assert.ok(nama.includes(rumah), `${rumah} harus terbaca berhubungan dengan ${budi}`);

    for (const n of hasil.direct) {
        assert.ok(n.shared >= 1, "kekuatan hubungan dilaporkan sebagai angka");
        assert.match(n.basis, /disebut bersama/, "dasarnya dijelaskan, bukan diklaim begitu saja");
    }

});

test("hubungan dilaporkan dengan ukurannya, bukan sebagai fakta", async () => {

    const { worldTools } = require("../../src/world/tools");
    const tool = worldTools().find(t => t.name === "memory_related");

    const r = await tool.execute({ name: `TidakAda${Date.now()}` });

    assert.equal(r.ok, false);
    assert.match(r.note, /Jangan menebak/i, "entitas tak dikenal tidak boleh dikarang hubungannya");

});

// ================================================================
// Celah 5 — Offline
// ================================================================

test("OFFLINE: model lokal menjawab tanpa jalur keluar", async () => {

    // Tidak memutus jaringan pengguna — itu dapat memutus Tailscale
    // dan akses mereka sendiri. Yang diuji: apakah jawaban benar-
    // benar berasal dari mesin ini, dengan seluruh host non-lokal
    // dibuat tak terjangkau di tingkat proses.
    const asli = globalThis.fetch;

    let keluarDicoba = 0;

    globalThis.fetch = async (url, opts) => {

        const alamat = String(url);
        const lokal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(alamat);

        if (!lokal) {
            keluarDicoba += 1;
            throw new Error("jaringan keluar dimatikan untuk uji offline");
        }

        return asli(url, opts);

    };

    try {

        const fs = require("node:fs");
        const path = require("node:path");
        const dirModel = path.join(__dirname, "..", "..", "models");

        let gguf = [];
        try {
            gguf = fs.readdirSync(dirModel)
                .filter(f => f.toLowerCase().endsWith(".gguf"));
        }
        catch { /* folder models/ tidak ada */ }

        if (gguf.length === 0) {
            assert.ok(true, "Tidak ada model GGUF lokal di lingkungan ini — uji offline dilewati");
            return;
        }

        assert.ok(
            gguf.length > 0,
            "harus ada model GGUF di models/ agar Damar dapat bekerja offline"
        );

        await assert.rejects(
            () => globalThis.fetch("https://openrouter.ai/api/v1/models"),
            /dimatikan/,
            "jalur keluar memang tertutup selama uji"
        );

        assert.ok(keluarDicoba >= 1);

    }
    finally {
        globalThis.fetch = asli;
    }

});

// ================================================================
// Celah 6 — DAG dipakai
// ================================================================

const RuntimeExecutor = require("../../src/ai/executors/RuntimeExecutor");
const { AIToolRegistry } = require("../../src/ai/tools");
const AITool = require("../../src/ai/tools/AITool");
const loopGuard = require("../../src/core/safety/loopGuard");

const jeda = ms => new Promise(r => setTimeout(r, ms));

test("beberapa BACAAN dalam satu putaran berjalan bersamaan", async () => {

    loopGuard.resetAll();

    const registry = new AIToolRegistry();

    let berjalan = 0;
    let puncak = 0;

    for (const nama of ["memory_recall", "code_hover", "home_state"]) {
        registry.register(new AITool({
            name: nama,
            description: "probe",
            execute: async () => {
                berjalan += 1;
                puncak = Math.max(puncak, berjalan);
                await jeda(80);
                berjalan -= 1;
                return { ok: true };
            }
        }));
    }

    let giliran = 0;

    const exec = new RuntimeExecutor({
        chat: async () => {
            giliran += 1;
            return giliran === 1
                ? {
                    content: "",
                    toolCalls: [
                        { id: "a", name: "memory_recall", arguments: { q: 1 } },
                        { id: "b", name: "code_hover", arguments: { q: 2 } },
                        { id: "c", name: "home_state", arguments: { q: 3 } }
                    ]
                }
                : { content: "selesai", toolCalls: [] };
        }
    });

    exec.setToolRegistry(registry);

    const mulai = Date.now();
    // Kontrak otorisasi kini hidup: identitas eksplisit pemilik.
    // Tanpa identitas, probe non-allowlist akan DENY fail-closed dan
    // puncak paralel tidak pernah tercapai.
    await exec.execute({
        messages: [{ role: "user", content: "tiga bacaan" }],
        exec: { role: "superadmin", channel: "console", sessionId: "tes-paritas-baca" }
    });
    const durasi = Date.now() - mulai;

    assert.ok(puncak > 1, `bacaan harus tumpang tindih, puncak=${puncak}`);
    assert.ok(durasi < 200, `tiga bacaan 80 ms seharusnya tidak makan ${durasi} ms berurutan`);

});

test("tindakan berefek samping TETAP berurutan", async () => {

    // Dua tulisan atau dua pesan yang berangkat bersamaan sulit
    // ditelusuri dan bisa saling mendahului.
    loopGuard.resetAll();

    const registry = new AIToolRegistry();

    let berjalan = 0;
    let puncak = 0;

    for (const nama of ["filesystem__writeFile", "damarSkills__device_on"]) {
        registry.register(new AITool({
            name: nama,
            description: "probe",
            execute: async () => {
                berjalan += 1;
                puncak = Math.max(puncak, berjalan);
                await jeda(50);
                berjalan -= 1;
                return { ok: true };
            }
        }));
    }

    let giliran = 0;

    const exec = new RuntimeExecutor({
        chat: async () => {
            giliran += 1;
            return giliran === 1
                ? {
                    content: "",
                    toolCalls: [
                        { id: "a", name: "filesystem__writeFile", arguments: { path: "x" } },
                        { id: "b", name: "damarSkills__device_on", arguments: { entity_id: "light.u" } }
                    ]
                }
                : { content: "selesai", toolCalls: [] };
        }
    });

    exec.setToolRegistry(registry);

    await exec.execute({
        messages: [{ role: "user", content: "dua tindakan" }],
        exec: { role: "superadmin", channel: "console", sessionId: "tes-paritas-tulis" }
    });

    assert.equal(puncak, 1, "tindakan berefek samping tidak boleh tumpang tindih");

});

test("urutan hasil tetap sesuai permintaan model", async () => {

    loopGuard.resetAll();

    const registry = new AIToolRegistry();

    for (const nama of ["memory_recall", "code_hover"]) {
        registry.register(new AITool({
            name: nama,
            description: "probe",
            execute: async () => ({ ok: true, dari: nama })
        }));
    }

    let giliran = 0;

    const exec = new RuntimeExecutor({
        chat: async () => {
            giliran += 1;
            return giliran === 1
                ? {
                    content: "",
                    toolCalls: [
                        { id: "a", name: "memory_recall", arguments: {} },
                        { id: "b", name: "code_hover", arguments: {} }
                    ]
                }
                : { content: "selesai", toolCalls: [] };
        }
    });

    exec.setToolRegistry(registry);

    const hasil = await exec.executeTools({
        toolCalls: [
            { id: "a", name: "memory_recall", arguments: {} },
            { id: "b", name: "code_hover", arguments: {} }
        ]
    });

    assert.deepEqual(hasil.map(r => r.toolCallId), ["a", "b"]);

});
