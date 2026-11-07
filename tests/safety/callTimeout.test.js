const test = require("node:test");
const assert = require("node:assert");

const RuntimeExecutor = require("../../src/ai/executors/RuntimeExecutor");
const { AIToolRegistry } = require("../../src/ai/tools");
const AITool = require("../../src/ai/tools/AITool");
const loopGuard = require("../../src/core/safety/loopGuard");

/**
 * Batas waktu berlaku per PANGGILAN MODEL, bukan per permintaan.
 *
 * Sebelumnya satu batas membungkus seluruh loop tool. Di inferensi
 * CPU satu panggilan saja bisa 40–60 detik, sehingga permintaan yang
 * memakai dua tool hampir pasti gagal — batasnya menghukum tepat
 * perilaku yang diinginkan. Terbukti pada daemon: pertanyaan yang
 * butuh satu ronde tool dijawab "Request timeout."
 */

const jeda = ms => new Promise(r => setTimeout(r, ms));

function buat(chat, { callTimeout } = {}) {

    const registry = new AIToolRegistry();

    registry.register(new AITool({
        name: "memory_recall",
        description: "probe",
        execute: async () => ({ ok: true })
    }));

    const exec = new RuntimeExecutor({ chat }, { callTimeout });
    exec.setToolRegistry(registry);

    return exec;

}

test("beberapa panggilan lambat TIDAK menumpuk jadi kegagalan", async () => {

    // Tiga putaran, masing-masing 120 ms. Total 360 ms — jauh di atas
    // batas per panggilan 250 ms, namun tiap panggilan sendiri sehat.
    loopGuard.resetAll();

    let giliran = 0;

    const exec = buat(async () => {

        giliran += 1;

        await jeda(120);

        return giliran < 3
            ? { content: "", toolCalls: [{ id: `c${giliran}`, name: "memory_recall", arguments: { q: giliran } }] }
            : { content: "selesai", toolCalls: [] };

    }, { callTimeout: 250 });

    const hasil = await exec.execute({ messages: [{ role: "user", content: "tugas bertahap" }] });

    assert.equal(hasil.content, "selesai");
    assert.equal(giliran, 3, "seluruh putaran harus sempat berjalan");

});

test("satu panggilan yang benar-benar menggantung tetap dihentikan", async () => {

    loopGuard.resetAll();

    const exec = buat(async () => { await jeda(5000); }, { callTimeout: 150 });

    await assert.rejects(
        () => exec.execute({ messages: [{ role: "user", content: "menggantung" }] }),
        /tidak menjawab dalam/
    );

});

test("pesan galat menyebut putaran keberapa yang mandek", async () => {

    // "Request timeout." tanpa konteks tidak memberi tahu apakah
    // modelnya lambat atau loopnya yang kepanjangan.
    loopGuard.resetAll();

    let giliran = 0;

    const exec = buat(async () => {

        giliran += 1;

        if (giliran === 1) {
            return { content: "", toolCalls: [{ id: "c1", name: "memory_recall", arguments: {} }] };
        }

        await jeda(5000);

    }, { callTimeout: 150 });

    await assert.rejects(
        () => exec.execute({ messages: [{ role: "user", content: "mandek di ronde dua" }] }),
        e => /putaran tool ke-2/.test(e.message)
    );

});

test("batas 0 berarti tanpa batas per panggilan", async () => {

    loopGuard.resetAll();

    const exec = buat(async () => {
        await jeda(80);
        return { content: "lolos", toolCalls: [] };
    }, { callTimeout: 0 });

    const hasil = await exec.execute({ messages: [{ role: "user", content: "tanpa batas" }] });

    assert.equal(hasil.content, "lolos");

});

test("penghitung waktu dibersihkan agar proses tidak tertahan", async () => {

    loopGuard.resetAll();

    const exec = buat(async () => ({ content: "cepat", toolCalls: [] }), { callTimeout: 60000 });

    const mulai = Date.now();

    await exec.execute({ messages: [{ role: "user", content: "cepat" }] });

    // Bila timer tidak di-clear, proses tes akan menggantung sampai
    // batas 60 detik alih-alih selesai seketika.
    assert.ok(Date.now() - mulai < 1000);

});
