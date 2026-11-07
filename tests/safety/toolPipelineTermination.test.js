const test = require("node:test");
const assert = require("node:assert");

const Pipeline = require("../../src/ai/tools/Pipeline");
const { buildRegistry } = require("../benchmark/tool-fixture");

/**
 * B — JAMINAN TERMINASI TOOL PIPELINE.
 *
 * Dulu: while-loop pemangkasan berputar selamanya bila riwayat saja
 * sudah melampaui hard cap dan hanya kapabilitas stabil tersisa
 * (tidak ada yang bisa dibuang). Invariant kini: setiap iterasi
 * mengurangi keadaan ATAU berhenti dengan diagnostik.
 */

function pressureCase(window, usedTokens) {
    return Pipeline.select({
        tools: buildRegistry(),
        message: "matikan lampu kamar, cek kamera depan, baca file server.js",
        channel: "console",
        role: "superadmin",
        historyTexts: Array.from({ length: 20 }, (_, i) =>
            `riwayat percakapan ${i}: ` + "konteks panjang ".repeat(50)),
        usedTokens,
        contextTokens: window
    });
}

// Setiap probe dibungkus timeout keras — kalau loop hidup lagi,
// test GAGAL (bukan menggantung).
const withDeadline = (p, ms = 5000) =>
    Promise.race([p, new Promise((_, rej) =>
        setTimeout(() => rej(new Error("HANG: seleksi tidak berakhir")), ms))]);

test("B 8K: usedTokens=5000 → selesai, tanpa overflow", async () => {
    const r = await withDeadline(pressureCase(8192, 5000));
    assert.equal(r.diagnostics.contextAlreadyOverBudget, false);
    assert.ok(Array.isArray(r.tools));
});

for (const used of [6600, 7000, 9000]) {
    test(`B 8K: usedTokens=${used} → selesai terbatas + diagnostik`, async () => {
        const r = await withDeadline(pressureCase(8192, used));
        assert.ok(r.diagnostics.overflowUnresolvable || r.diagnostics.contextAlreadyOverBudget,
            "overflow yang tak bisa disembuhkan penghapusan tool harus ditandai");
        assert.ok(r.diagnostics.selectionLatencyMs < 5000);
    });
}

for (const used of [3000, 4000]) {
    test(`B 4K: tekanan ekuivalen usedTokens=${used} → selesai`, async () => {
        const r = await withDeadline(pressureCase(4096, used));
        assert.ok(r.diagnostics.overflowUnresolvable || r.diagnostics.contextAlreadyOverBudget);
        assert.ok(r.diagnostics.selectionLatencyMs < 5000);
    });
}

test("B: jalur resolveTools produksi dengan riwayat berat selesai terbatas", async () => {

    const AIRuntime = require("../../src/ai/runtime/AIRuntime");
    const { AIToolRegistry } = require("../../src/ai/tools");

    const rt = new AIRuntime(null, { defaultModel: "m" });
    const reg = new AIToolRegistry();
    for (const t of buildRegistry()) reg.register(t);
    rt.setToolRegistry(reg);

    const heavyHistory = Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: "pesan riwayat nomor " + i + ": " + "detail pekerjaan ".repeat(400)
    }));

    const t0 = Date.now();

    await withDeadline(rt.resolveTools({
        messages: [...heavyHistory, { role: "user", content: "matikan lampu kamar" }],
        exec: { role: "superadmin", channel: "console", sessionId: "tes-hang", contextTokens: 8192 }
    }), 10000);

    assert.ok(Date.now() - t0 < 10000, "resolveTools harus berakhir terbatas");
});
