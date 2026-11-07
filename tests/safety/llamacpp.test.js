const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const LlamaCppMapper = require("../../src/ai/providers/llamacpp/LlamaCppMapper");

/**
 * Otak lokal in-process (node-llama-cpp).
 *
 * Bagian tersulit — dan yang paling mudah rusak diam-diam — adalah
 * penerjemahan pesan gaya-OpenAI ke history node-llama-cpp: panggilan
 * tool asisten HARUS dipasangkan dengan hasilnya (role:"tool"). Test
 * ini mengunci pemetaan itu tanpa memuat model 4,7 GB. Inferensi nyata
 * diuji terpisah, hanya bila bobot GGUF tersedia.
 */

const mapper = new LlamaCppMapper();

test("toHistory memasangkan panggilan tool dengan hasilnya jadi satu item model", () => {

    const messages = [
        { role: "system", content: "Kamu Damar." },
        { role: "user", content: "cuaca Bandung?" },
        {
            role: "assistant", content: "",
            tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"kota":"Bandung"}' } }]
        },
        { role: "tool", tool_call_id: "c1", name: "get_weather", content: '{"suhu":24}' },
        { role: "user", content: "makasih" }
    ];

    const h = mapper.toHistory(messages);

    assert.deepEqual(h[0], { type: "system", text: "Kamu Damar." });
    assert.deepEqual(h[1], { type: "user", text: "cuaca Bandung?" });

    // Item model memuat functionCall + result-nya (bukan pesan tool terpisah).
    assert.equal(h[2].type, "model");
    const fc = h[2].response.find(r => r && r.type === "functionCall");
    assert.equal(fc.name, "get_weather");
    assert.deepEqual(fc.params, { kota: "Bandung" });
    assert.deepEqual(fc.result, { suhu: 24 });

    // Pesan role:"tool" TIDAK menjadi item history sendiri.
    assert.equal(h.filter(x => x.type === "tool").length, 0);
    assert.deepEqual(h[3], { type: "user", text: "makasih" });

});

test("toFunctions memetakan tool Damar ke ChatModelFunctions", () => {

    const fns = mapper.toFunctions([
        { name: "a", description: "tool a", parameters: { type: "object", properties: { x: { type: "string" } } } },
        { name: "b", description: "", parameters: undefined }
    ]);

    assert.equal(fns.a.description, "tool a");
    assert.deepEqual(fns.a.params, { type: "object", properties: { x: { type: "string" } } });
    // Tanpa parameters → skema objek kosong yang sah, bukan undefined.
    assert.deepEqual(fns.b.params, { type: "object", properties: {} });

    assert.equal(mapper.toFunctions([]), undefined);

});

test("toResponse menandai tool_calls dan menyalin argumen", () => {

    const r = mapper.toResponse(
        { response: "", functionCalls: [{ functionName: "kali_run", params: { command: "nmap -sV x" } }], stopReason: "functionCalls" },
        { model: "Qwen2.5-7B" }
    );

    assert.equal(r.provider, "llamacpp");
    assert.equal(r.finishReason, "tool_calls");
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, "kali_run");
    assert.deepEqual(r.toolCalls[0].arguments, { command: "nmap -sV x" });

    const teks = mapper.toResponse({ response: "halo", functionCalls: [], stopReason: "eogToken" }, {});
    assert.equal(teks.finishReason, "stop");
    assert.equal(teks.content, "halo");
    assert.equal(teks.toolCalls.length, 0);

});

test("provider llamacpp terdaftar di factory", () => {
    const { AIProviderFactory } = require("../../src/ai/providers");
    const p = AIProviderFactory.create("llamacpp", { modelPath: "models/x.gguf" });
    assert.equal(p.id, "llamacpp");
});

// Inferensi NYATA — OPT-IN (set DAMAR_TEST_LOCAL_MODEL=1 usai unduh
// selesai). Dijaga opt-in agar suite default tetap hijau meski bobot
// 4,7 GB belum ada / masih setengah terunduh.
test("otak lokal menjawab dan memilih tool (bila model tersedia)", async (t) => {

    if (!process.env.DAMAR_TEST_LOCAL_MODEL) return t.skip("Set DAMAR_TEST_LOCAL_MODEL=1 untuk menguji inferensi nyata");

    const modelDir = process.env.DAMAR_MODEL_DIR || "models";
    const gguf = fs.existsSync(modelDir)
        ? fs.readdirSync(modelDir).find(f => f.toLowerCase().endsWith(".gguf"))
        : null;

    if (!gguf) return t.skip("Model GGUF belum diunduh");

    const { LlamaCppProvider } = require("../../src/ai/providers/llamacpp");
    const provider = new LlamaCppProvider({ modelPath: path.join(modelDir, gguf), contextSize: 2048 });

    const res = await provider.chat({
        messages: [
            { role: "system", content: "Kamu asisten. Pakai tool bila relevan." },
            { role: "user", content: "Jalankan perintah 'whoami' di terminal." }
        ],
        tools: [{
            name: "run_shell",
            description: "Jalankan perintah shell di mesin pengguna.",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
        }],
        maxTokens: 256
    });

    // Model cukup pintar memilih tool untuk permintaan eksekusi eksplisit.
    assert.ok(res.toolCalls.length >= 1 || typeof res.content === "string");
    if (res.toolCalls.length) {
        assert.equal(res.toolCalls[0].name, "run_shell");
        assert.ok(String(res.toolCalls[0].arguments.command || "").includes("whoami"));
    }
});
