const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const ExecutionPlan = require("../../src/agent/models/executionPlan");
const planStore = require("../../src/agent/planStore");

/** Tes planner DAG, checkpoint, dan pemulihan (§28, §29, §30). */

const dibuat = [];

test.after(() => {
    for (const id of dibuat) planStore.remove(id);
});

function buatRencana() {
    const p = new ExecutionPlan({ goal: "uji" });
    dibuat.push(p.id);
    return p;
}

test("konstruktor lama tetap bekerja — tanpa dependensi semua siap", () => {

    // Pemanggil lama: new ExecutionPlan({ thought, steps })
    const p = new ExecutionPlan({
        thought: "pikiran",
        steps: [{ tool: "a" }, { tool: "b" }, { tool: "c" }]
    });

    assert.equal(p.hasSteps, true);
    assert.equal(p.ready().length, 3, "tanpa dependensi, semua langkah siap sekaligus");

});

test("dependensi menahan langkah sampai prasyaratnya selesai", () => {

    const p = buatRencana();
    const a = p.addStep({ tool: "ambil" });
    const b = p.addStep({ tool: "olah", dependsOn: [a.id] });

    assert.deepEqual(p.ready().map(s => s.id), [a.id], "hanya a yang siap");

    a.status = "done";

    assert.deepEqual(p.ready().map(s => s.id), [b.id], "setelah a selesai, b jadi siap");

});

test("langkah paralel siap bersamaan", () => {

    const p = buatRencana();
    const root = p.addStep({ tool: "root" });
    const x = p.addStep({ tool: "x", dependsOn: [root.id] });
    const y = p.addStep({ tool: "y", dependsOn: [root.id] });

    root.status = "done";

    const siap = p.ready().map(s => s.id).sort();
    assert.deepEqual(siap, [x.id, y.id].sort(), "x dan y tidak saling bergantung");

});

test("dependensi yang GAGAL tidak membuka langkah berikutnya", () => {

    // Melanjutkan di atas fondasi yang gagal menghasilkan pekerjaan
    // yang tidak dapat dipercaya.
    const p = buatRencana();
    const a = p.addStep({ tool: "a" });
    const b = p.addStep({ tool: "b", dependsOn: [a.id] });

    a.status = "failed";

    assert.equal(p.ready().length, 0, "b tidak boleh jalan setelah a gagal");
    assert.deepEqual(p.blocked().map(s => s.id), [b.id], "b harus terbaca sebagai terhambat");

});

test("siklus dependensi terdeteksi, bukan menggantung diam-diam", () => {

    const p = buatRencana();
    const a = p.addStep({ tool: "a" });
    const b = p.addStep({ tool: "b" });

    a.dependsOn = [b.id];
    b.dependsOn = [a.id];

    const cycles = p.findCycles();

    assert.ok(cycles.length >= 2, "kedua langkah harus terlibat siklus");
    assert.equal(p.ready().length, 0, "siklus memang membuat tak ada yang siap");

});

test("rencana sehat tidak dilaporkan bersiklus", () => {

    const p = buatRencana();
    const a = p.addStep({ tool: "a" });
    p.addStep({ tool: "b", dependsOn: [a.id] });

    assert.deepEqual(p.findCycles(), []);

});

test("dependensi menggantung terdeteksi", () => {

    const p = buatRencana();
    p.addStep({ tool: "a", dependsOn: ["langkah-yang-tidak-ada"] });

    const dangling = p.danglingDependencies();

    assert.equal(dangling.length, 1);
    assert.equal(dangling[0].missing, "langkah-yang-tidak-ada");

});

test("kemajuan dihitung dari keadaan nyata", () => {

    const p = buatRencana();
    const a = p.addStep({ tool: "a" });
    const b = p.addStep({ tool: "b" });
    p.addStep({ tool: "c" });

    a.status = "done";
    b.status = "failed";

    const pr = p.progress;

    assert.equal(pr.total, 3);
    assert.equal(pr.done, 1);
    assert.equal(pr.failed, 1);
    assert.equal(pr.pending, 1);
    assert.equal(pr.percent, 33);

});

test("checkpoint tersimpan dan dapat dimuat kembali", () => {

    const p = buatRencana();
    const a = p.addStep({ tool: "tulis", arguments: { path: "x" } });
    a.status = "done";
    a.result = { ok: true };

    planStore.save(p);

    const muat = planStore.load(p.id);

    assert.ok(muat, "rencana harus dapat dimuat");
    assert.equal(muat.id, p.id);
    assert.equal(muat.steps.length, 1);
    assert.equal(muat.steps[0].status, "done", "kemajuan ikut tersimpan");
    assert.deepEqual(muat.steps[0].result, { ok: true });

});

test("PEMULIHAN: langkah yang tergantung dikembalikan ke antrean", () => {

    // Inti §30. Proses mati saat sebuah langkah berstatus "running";
    // kita tidak tahu apakah ia sempat selesai.
    const p = buatRencana();
    const a = p.addStep({ tool: "selesai" });
    const b = p.addStep({ tool: "tergantung" });

    a.status = "done";
    b.status = "running";        // ← mati di sini

    planStore.save(p);

    const lanjut = planStore.resume(p.id);

    assert.equal(lanjut.get(a.id).status, "done", "yang sudah selesai TIDAK diulang");
    assert.equal(lanjut.get(b.id).status, "pending", "yang tergantung diulang");
    assert.equal(lanjut.ready().length, 1, "tepat satu langkah siap dilanjutkan");

});

test("rencana belum tuntas terdaftar untuk dilanjutkan", () => {

    const p = buatRencana();
    p.addStep({ tool: "belum" });
    planStore.save(p);

    const daftar = planStore.unfinished();

    assert.ok(daftar.some(x => x.id === p.id), "rencana belum tuntas harus terdaftar");

});

test("rencana yang seluruh langkahnya TUNTAS tidak dilaporkan sebagai terhenti", () => {

    // Berkas yang tertinggal padahal semua langkahnya `done` adalah
    // puing, bukan pekerjaan yang terhenti: jalur keluar selain
    // "model menjawab tanpa tool" tidak sempat menghapusnya. Dulu
    // puing seperti ini ikut diteriakkan saat boot ("N rencana tool
    // terhenti di tengah jalan") sampai memenuhi layar pemilik.
    // Sekarang ia dibuang diam-diam di sini.
    const p = buatRencana();
    const a = p.addStep({ tool: "sudah" });
    a.status = "done";
    planStore.save(p);

    assert.equal(p.isComplete, true);
    assert.ok(!planStore.unfinished().some(x => x.id === p.id), "puing tuntas tidak dilaporkan");
    assert.equal(planStore.load(p.id), null, "berkasnya sekalian dibereskan");

});

test("rantai yang seluruh langkahnya GAGAL tetap dilaporkan", () => {

    // Kekhawatiran aslinya tetap berlaku: langkah gagal juga
    // "terminal", padahal permintaan pemilik tidak pernah terjawab.
    // Yang seperti ini justru paling perlu dilihat.
    const p = buatRencana();
    const a = p.addStep({ tool: "gagal" });
    a.status = "failed";
    a.error = "tool meledak";
    planStore.save(p);

    assert.ok(planStore.unfinished().some(x => x.id === p.id), "rantai gagal harus terdaftar");

    planStore.remove(p.id);

    assert.ok(!planStore.unfinished().some(x => x.id === p.id));

});

test("checkpoint ditulis atomik — tidak ada berkas .tmp tertinggal", () => {

    const p = buatRencana();
    p.addStep({ tool: "a" });

    const target = planStore.save(p);

    assert.ok(fs.existsSync(target));
    assert.ok(!fs.existsSync(`${target}.tmp`), "berkas sementara harus sudah di-rename");

});

test("memuat rencana tak dikenal mengembalikan null, bukan melempar", () => {

    assert.equal(planStore.load("tidak-pernah-ada"), null);
    assert.equal(planStore.resume("tidak-pernah-ada"), null);

});

// ---- Loop tool yang benar-benar berjalan -------------------------

const RuntimeExecutor = require("../../src/ai/executors/RuntimeExecutor");
const { AIToolRegistry } = require("../../src/ai/tools");
const AITool = require("../../src/ai/tools/AITool");
const loopGuard = require("../../src/core/safety/loopGuard");

function runtimeWith(chat, toolFn) {

    const registry = new AIToolRegistry();

    const t = new AITool({
        name: "memory_recall",
        description: "probe",
        execute: async args => toolFn(args)
    });

    registry.register(t);

    const exec = new RuntimeExecutor({ chat });
    exec.setToolRegistry(registry);

    return exec;

}

test("permintaan yang MATI di tengah rantai meninggalkan checkpoint", async () => {

    loopGuard.resetAll();

    const sebelum = planStore.unfinished().map(p => p.id);

    // Proses "mati" saat tool sedang berjalan.
    const exec = runtimeWith(
        async () => ({
            content: "",
            toolCalls: [{ id: "c1", name: "memory_recall", arguments: { query: "sesuatu" } }]
        }),
        () => { throw new Error("proses mati"); }
    );

    // Kegagalan tool dikembalikan ke model, jadi loop lanjut sampai
    // batas iterasi lalu melempar — persis permintaan yang tak tuntas.
    await assert.rejects(() => exec.execute({ messages: [{ role: "user", content: "tugas panjang" }] }));

    const sesudah = planStore.unfinished().filter(p => !sebelum.includes(p.id));

    assert.equal(sesudah.length, 1, "harus ada satu rencana tertinggal");

    const plan = sesudah[0];
    dibuat.push(plan.id);

    assert.equal(plan.goal, "tugas panjang", "tujuan diambil dari pesan pengguna");
    assert.ok(plan.steps.length > 0, "langkah yang sempat dicoba tercatat");
    assert.equal(plan.steps[0].tool, "memory_recall");
    assert.equal(plan.steps[0].status, "failed");
    assert.match(plan.steps[0].error, /proses mati/);

});

test("permintaan yang TUNTAS tidak meninggalkan puing", async () => {

    loopGuard.resetAll();

    const sebelum = planStore.unfinished().map(p => p.id);

    let giliran = 0;

    const exec = runtimeWith(
        async () => {
            giliran += 1;
            return giliran === 1
                ? { content: "", toolCalls: [{ id: "c1", name: "memory_recall", arguments: { query: "x" } }] }
                : { content: "selesai", toolCalls: [] };
        },
        () => ({ ok: true })
    );

    const hasil = await exec.execute({ messages: [{ role: "user", content: "tugas pendek" }] });

    assert.equal(hasil.content, "selesai");

    const sesudah = planStore.unfinished().filter(p => !sebelum.includes(p.id));

    assert.equal(sesudah.length, 0, "checkpoint dibersihkan setelah tuntas");

});

test("pencatatan tidak menjatuhkan permintaan bila penyimpanan bermasalah", async () => {

    loopGuard.resetAll();

    const asli = planStore.save;

    planStore.save = () => { throw new Error("disk penuh"); };

    try {

        const exec = runtimeWith(
            async () => ({ content: "tetap dijawab", toolCalls: [] }),
            () => ({ ok: true })
        );

        const hasil = await exec.execute({ messages: [{ role: "user", content: "halo" }] });

        assert.equal(hasil.content, "tetap dijawab", "gagal mencatat bukan alasan gagal melayani");

    }
    finally {
        planStore.save = asli;
    }

});
