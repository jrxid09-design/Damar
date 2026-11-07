const test = require("node:test");
const assert = require("node:assert");

const RuntimeExecutor = require("../../src/ai/executors/RuntimeExecutor");
const InternalGrant = require("../../src/ai/tools/internalGrant").createInternalGrantDomain();
const { AIToolRegistry, AIToolCall } = require("../../src/ai/tools");
const AITool = require("../../src/ai/tools/AITool");
const AIStreamChunk = require("../../src/ai/models/AIStreamChunk");
const OpenRouterMapper = require("../../src/ai/providers/openrouter/OpenRouterMapper");
const OpenRouterProvider = require("../../src/ai/providers/openrouter/OpenRouterProvider");
const loopGuard = require("../../src/core/safety/loopGuard");
const planStore = require("../../src/agent/planStore");

/**
 * Tes terfokus untuk streaming SUNGGUHAN di runtime Console:
 *
 *   1. Balasan biasa tanpa tool — potongan provider diteruskan live.
 *   2. Satu panggilan tool lalu jawaban akhir.
 *   3. Beberapa panggilan tool dalam satu putaran.
 *   4. Tool gagal — kegagalan dikembalikan ke model.
 *   5. Metadata reasoning tidak mencemari konten.
 *   6. Provider OpenAI-compatible (mapper + SSE end-to-end).
 *   7. Kontrak SSE Console: start/chunk/done/error tetap utuh.
 */

const jeda = ms => new Promise(r => setTimeout(r, ms));

const chunk = fields => new AIStreamChunk(fields);

function buatExecutor(service, daftarTool = [], opsi = {}) {

    loopGuard.resetAll();

    const registry = new AIToolRegistry();

    for (const tool of daftarTool) {
        registry.register(tool);
    }

    const executor = new RuntimeExecutor(service, { ...opsi, grantDomain: InternalGrant });

    executor.setToolRegistry({ get(name) { return registry.get(name); } });

    // Identitas eksekusi eksplisit (invariant G — Round-2): mekanika
    // streaming diuji sebagai superadmin; otorisasi diuji terpisah.
    const asli = executor.execute.bind(executor);
    const asliStream = executor.stream.bind(executor);
    const makeExec = () => InternalGrant.mintCanonicalInternalGrant({ authorizedTools: daftarTool.map(t => t.name), provenance: "stream-test" });
    executor.execute = (r) => asli({ exec: makeExec(), ...r });
    executor.stream = async function* (r) {
        yield* asliStream({ exec: makeExec(), ...r });
    };

    return executor;

}

async function kumpulkan(gen) {
    const out = [];
    for await (const c of gen) {
        out.push(c);
    }
    return out;
}

// ================================================================
// 1 — Balasan biasa: potongan provider diteruskan apa adanya
// ================================================================

test("stream tanpa tool meneruskan potongan provider secara live", async () => {

    const service = {
        stream: async function* () {
            yield chunk({ delta: "satu dua" });               // utuh, bukan per kata
            yield chunk({ delta: " tiga" });
            yield chunk({
                delta: "",
                finishReason: "stop",
                usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
                done: true,
                id: "r1",
                model: "probe-model",
                provider: "probe"
            });
        }
    };

    const exec = buatExecutor(service);

    const out = await kumpulkan(
        exec.stream({ messages: [{ role: "user", content: "halo" }] })
    );

    // Tidak ada pemecahan kata: delta "satu dua" harus utuh.
    assert.deepEqual(
        out.map(c => c.delta),
        ["satu dua", " tiga", ""]
    );

    // Penutup sintetis membawa metadata terminal provider.
    const terminal = out[out.length - 1];

    assert.equal(terminal.done, true);
    assert.equal(terminal.finishReason, "stop");
    assert.equal(terminal.usage.totalTokens, 8);
    assert.equal(terminal.id, "r1");
    assert.equal(terminal.model, "probe-model");
    assert.equal(terminal.provider, "probe");

});

test("stream live: potongan tiba sebelum generator selesai", async () => {

    // Penanda waktu tiap potongan: bila ini palsu (teks dikumpulkan
    // dulu lalu diacak ulang), semua potongan muncul SETELAH selesai.
    const tiba = [];
    let selesai = false;

    const service = {
        stream: async function* () {
            yield chunk({ delta: "a" });
            await jeda(30);
            yield chunk({ delta: "b" });
            await jeda(30);
            yield chunk({ delta: "c", finishReason: "stop", done: true });
            selesai = true;
        }
    };

    const exec = buatExecutor(service);

    const out = [];
    for await (const c of exec.stream({ messages: [{ role: "user", content: "x" }] })) {
        tiba.push(selesai);
        out.push(c);
    }

    assert.equal(out.length, 3);
    // Potongan awal harus tiba SEBELUM generator provider selesai.
    assert.equal(tiba[0], false);
    assert.equal(tiba[1], false);
    // Chunk terminal provider (delta + finishReason) diteruskan
    // live — tidak diduplikasi penutup sintetis.
    assert.equal(out[2].delta, "c");
    assert.equal(out[2].finishReason, "stop");
    assert.equal(out[2].done, true);

});

// ================================================================
// 2 — Satu panggilan tool lalu jawaban akhir
// ================================================================

test("stream: satu tool dipanggil, diumumkan utuh, lalu dijawab", async () => {

    loopGuard.resetAll();

    let giliran = 0;
    const dilihatOlehModel = [];

    const service = {
        stream: async function* (request) {
            giliran += 1;
            dilihatOlehModel.push(request.messages);
            if (giliran === 1) {
                yield chunk({ delta: "Sebentar, saya cek. " });
                // Fragmen OpenAI-style: id+nama dulu, argumen menyambung.
                yield chunk({
                    toolCalls: [{
                        index: 0,
                        id: "call_1",
                        function: { name: "probe", arguments: "{\"q\":" }
                    }]
                });
                yield chunk({
                    toolCalls: [{
                        index: 0,
                        function: { arguments: "1}" }
                    }],
                    finishReason: "tool_calls",
                    done: true
                });
                return;
            }
            yield chunk({ delta: "Jawabannya 1." });
            yield chunk({ delta: "", finishReason: "stop", done: true });
        }
    };

    let dieksekusi = 0;

    const exec = buatExecutor(service, [
        new AITool({
            name: "probe",
            description: "probe",
            execute: async args => { dieksekusi += 1; return { ok: true, args }; }
        })
    ]);

    const request = { messages: [{ role: "user", content: "cek" }] };

    const out = await kumpulkan(exec.stream(request));

    // Tool benar-benar dijalankan sekali.
    assert.equal(dieksekusi, 1);

    // Pengumuman panggilan utuh (bukan fragmen) ada di aliran.
    const announcements = out.filter(c => c.toolCalls?.length);

    assert.equal(announcements.length, 1);

    const call = announcements[0].toolCalls[0];

    assert.ok(call instanceof AIToolCall);
    assert.equal(call.id, "call_1");
    assert.equal(call.name, "probe");
    assert.deepEqual(call.arguments, { q: 1 });
    assert.equal(announcements[0].done, false);

    // Konten dua putaran sama-sama mengalir.
    assert.equal(
        out.map(c => c.delta).join(""),
        "Sebentar, saya cek. Jawabannya 1."
    );

    // Penutup akhir.
    const terminal = out[out.length - 1];
    assert.equal(terminal.done, true);
    assert.equal(terminal.finishReason, "stop");

    // Model putaran kedua menerima pesan hasil tool.
    const putaranKedua = dilihatOlehModel[1];

    const pesanTool = putaranKedua.filter(m => m.role === "tool");

    assert.equal(pesanTool.length, 1);
    assert.equal(pesanTool[0].tool_call_id, "call_1");
    assert.ok(pesanTool[0].content.includes("\"ok\":true"));

    // Pesan assistant pembawa tool_calls ikut tercatat.
    const asisten = putaranKedua.find(m => m.role === "assistant" && m.tool_calls);

    assert.equal(asisten.tool_calls[0].function.name, "probe");

});

// ================================================================
// 3 — Beberapa tool dalam satu putaran
// ================================================================

test("stream: beberapa panggilan tool dikumpulkan & diumumkan sekaligus", async () => {

    loopGuard.resetAll();

    let giliran = 0;

    const service = {
        stream: async function* () {
            giliran += 1;
            if (giliran === 1) {
                yield chunk({
                    toolCalls: [{
                        index: 0,
                        id: "a",
                        function: { name: "baca_satu", arguments: "{\"n\":" }
                    }]
                });
                yield chunk({
                    toolCalls: [{ index: 1, id: "b", function: { name: "baca_dua", arguments: "{}" } }]
                });
                yield chunk({
                    toolCalls: [{ index: 0, function: { arguments: "1}" } }],
                    finishReason: "tool_calls",
                    done: true
                });
                return;
            }
            yield chunk({ delta: "selesai", finishReason: "stop", done: true });
        }
    };

    const urutan = [];

    const exec = buatExecutor(service, [
        new AITool({ name: "baca_satu", description: "p", execute: async a => { urutan.push(`satu:${a.n}`); return { v: 1 }; } }),
        new AITool({ name: "baca_dua", description: "p", execute: async () => { urutan.push("dua"); return { v: 2 }; } })
    ]);

    const out = await kumparkan(exec.stream({ messages: [{ role: "user", content: "dua bacaan" }] }));

    assert.equal(urutan.length, 2);

    // Satu pengumuman berisi KEDUA panggilan utuh, urut index.
    const announcements = out.filter(c => c.toolCalls?.length);

    assert.equal(announcements.length, 1);
    assert.equal(announcements[0].toolCalls.length, 2);
    assert.equal(announcements[0].toolCalls[0].name, "baca_satu");
    assert.deepEqual(announcements[0].toolCalls[0].arguments, { n: 1 });
    assert.equal(announcements[0].toolCalls[1].name, "baca_dua");

});

// helper kecil untuk test 3 (nama beda agar tidak menutupi kumpulkan)
async function kumparkan(gen) {
    const out = [];
    for await (const c of gen) out.push(c);
    return out;
}

// ================================================================
// 4 — Tool gagal → model menerima kegagalan
// ================================================================

test("stream: tool gagal — pesan error dikembalikan ke model", async () => {

    loopGuard.resetAll();

    let giliran = 0;
    let kontenTool = null;

    const service = {
        stream: async function* (request) {
            giliran += 1;
            if (giliran === 1) {
                yield chunk({
                    toolCalls: [{ id: "g1", name: "meledak", arguments: { x: 1 } }],
                    finishReason: "tool_calls",
                    done: true
                });
                return;
            }
            const pesanTool = request.messages.find(m => m.role === "tool");
            kontenTool = pesanTool?.content ?? null;
            yield chunk({ delta: "sayangnya gagal", finishReason: "stop", done: true });
        }
    };

    const exec = buatExecutor(service, [
        new AITool({
            name: "meledak",
            description: "p",
            execute: async () => { throw new Error("disk penuh"); }
        })
    ]);

    const out = await kumpulkan(exec.stream({ messages: [{ role: "user", content: "x" }] }));

    // Tool diumumkan, loop tidak pecah, jawaban akhir tetap mengalir.
    assert.equal(out[out.length - 1].finishReason, "stop");

    // Model putaran kedua benar-benar membaca kegagalan — bukan sukses palsu.
    assert.ok(kontenTool, "pesan tool harus ada");
    assert.ok(kontenTool.includes("disk penuh"), `harus memuat pesan error: ${kontenTool}`);
    assert.ok(!kontenTool.includes("\"ok\""));

});

// ================================================================
// 5 — Reasoning tidak mencemari konten
// ================================================================

test("stream: reasoning mengalir terpisah dari konten", async () => {

    const service = {
        stream: async function* () {
            yield chunk({ reasoning: "mikir duluan" });
            yield chunk({ delta: "Jawaban", reasoning: "sambil mikir" });
            yield chunk({ delta: " benar." });
            yield chunk({ delta: "", finishReason: "stop", done: true });
        }
    };

    const exec = buatExecutor(service);

    const out = await kumpulkan(exec.stream({ messages: [{ role: "user", content: "?" }] }));

    // Konten hanya berasal dari delta.
    assert.equal(
        out.map(c => c.delta).join(""),
        "Jawaban benar."
    );

    // Chunk reasoning diteruskan dengan bidangnya sendiri.
    assert.equal(out[0].reasoning, "mikir duluan");
    assert.equal(out[0].delta, "");
    assert.equal(out[1].reasoning, "sambil mikir");
    assert.equal(out[1].delta, "Jawaban");

    // Penutup bersih dari reasoning.
    assert.equal(out[out.length - 1].reasoning, null);

});

// ================================================================
// 6 — Provider OpenAI-compatible
// ================================================================

test("OpenRouterMapper.toStreamChunk: reasoning, usage, tool_calls, id/model/role/raw", () => {

    const mapper = new OpenRouterMapper();

    // Chunk biasa tanpa reasoning/usage → null, bukan undefined.
    const biasa = mapper.toStreamChunk({
        id: "chatcmpl-1",
        model: "m-1",
        choices: [{ delta: { role: "assistant", content: "Hel" }, finish_reason: null }]
    });

    assert.equal(biasa.delta, "Hel");
    assert.equal(biasa.reasoning, null);
    assert.equal(biasa.usage, null);
    assert.equal(biasa.id, "chatcmpl-1");
    assert.equal(biasa.model, "m-1");
    assert.equal(biasa.role, "assistant");
    assert.equal(biasa.done, false);
    assert.equal(biasa.raw.choices.length, 1);

    // Varian reasoning_content (OpenAI-compatible tertentu).
    const denganReasoning = mapper.toStreamChunk({
        id: "chatcmpl-2",
        model: "m-1",
        choices: [{ delta: { reasoning_content: "proses berpikir" } }]
    });

    assert.equal(denganReasoning.reasoning, "proses berpikir");
    assert.equal(denganReasoning.delta, "");

    // Varian reasoning (OpenRouter) menang bila keduanya ada.
    const keduanya = mapper.toStreamChunk({
        choices: [{ delta: { reasoning: "utama", reasoning_content: "cadangan" } }]
    });

    assert.equal(keduanya.reasoning, "utama");

    // Terminal: usage dinormalisasi, done=true.
    const terminal = mapper.toStreamChunk({
        id: "chatcmpl-3",
        model: "m-1",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
            prompt_tokens: 7,
            completion_tokens: 11,
            total_tokens: 18,
            completion_tokens_details: { reasoning_tokens: 4 }
        }
    });

    assert.equal(terminal.done, true);
    assert.equal(terminal.finishReason, "stop");
    assert.deepEqual(terminal.usage, {
        promptTokens: 7,
        completionTokens: 11,
        totalTokens: 18,
        reasoningTokens: 4
    });

    // Fragmen tool_calls diteruskan mentah (disatukan di executor).
    const fragmen = mapper.toStreamChunk({
        choices: [{
            delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "probe", arguments: "{\"a\":" } }] },
            finish_reason: null
        }]
    });

    assert.equal(fragmen.toolCalls.length, 1);
    assert.equal(fragmen.toolCalls[0].function.name, "probe");

});

test("OpenRouterProvider: SSE mentah → chunk terpetakan (end-to-end)", async () => {

    const sse = [
        "data: {\"id\":\"c-1\",\"model\":\"g-test\",\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"c-1\",\"model\":\"g-test\",\"choices\":[{\"delta\":{\"content\":\"Hai\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"c-1\",\"model\":\"g-test\",\"choices\":[{\"delta\":{\"reasoning\":\"berpikir\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"c-1\",\"model\":\"g-test\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
        "data: [DONE]\n\n"
    ].join("");

    const webStream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
        }
    });

    const httpClient = {
        stream: async () => webStream
    };

    const provider = new OpenRouterProvider({
        httpClient,
        config: { baseUrl: "http://probe.local/v1", apiKey: "k" }
    });

    const out = await kumpulkan(provider.stream({
        messages: [{ role: "user", content: "hai" }],
        model: "g-test"
    }));

    assert.equal(out.length, 4);

    assert.equal(out[1].delta, "Hai");
    assert.equal(out[1].provider, "openrouter");

    assert.equal(out[2].reasoning, "berpikir");
    assert.equal(out[2].delta, "");

    assert.equal(out[3].done, true);
    assert.equal(out[3].finishReason, "stop");
    assert.deepEqual(out[3].usage, {
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
        reasoningTokens: 0
    });

});

// ================================================================
// 7 — Kontrak SSE Console (start/chunk/done/error)
// ================================================================

const aiController = require("../../src/controllers/aiController");
const aiRuntime = require("../../src/services/aiRuntimeService");

function resMock() {

    const frames = [];

    const handlers = {};

    return {
        frames,
        writeHead() { },
        write(bagian) { frames.push(bagian); },
        end() { this.beres = true; },
        on(nama, fn) { handlers[nama] = fn; },
        tutup() { handlers.close?.(); }
    };

}

function parseFrames(res) {

    return res.frames.join("")
        .split("\n\n")
        .filter(Boolean)
        .map(frame => {
            const bagian = frame.split("\n");
            return {
                event: bagian.find(l => l.startsWith("event:"))?.slice(6).trim(),
                data: JSON.parse(bagian.find(l => l.startsWith("data:"))?.slice(5).trim())
            };
        });

}

// Stub aiRuntime (singleton) — dipulihkan setelah tes.
const asliEnsure = aiRuntime.ensure;
const asliStream = aiRuntime.stream;
const asliDefaultModel = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(aiRuntime), "defaultModel"
);

function pasangStub({ generator, model = "m-default" }) {
    aiRuntime.ensure = () => ({
        activeProviderId: "probe",
        runtime: { options: { defaultModel: model } }
    });
    aiRuntime.stream = generator;
}

test.afterEach(() => {
    aiRuntime.ensure = asliEnsure;
    aiRuntime.stream = asliStream;
    if (asliDefaultModel) {
        Object.defineProperty(
            Object.getPrototypeOf(aiRuntime),
            "defaultModel",
            asliDefaultModel
        );
    }
});

test("SSE: start/chunk/done utuh, metadata ekstra diteruskan bila ada", async () => {

    pasangStub({
        generator: async function* () {
            yield chunk({ delta: "Hel" });
            yield chunk({
                delta: "lo",
                reasoning: "pikir",
                usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
                id: "c-9",
                model: "g-test",
                provider: "openrouter"
            });
            yield chunk({ delta: "", finishReason: "stop", done: true });
        }
    });

    const res = resMock();

    await aiController.stream(
        { body: { messages: [{ role: "user", content: "x" }] } },
        res
    );

    const frames = parseFrames(res);

    assert.deepEqual(frames.map(f => f.event), ["start", "chunk", "chunk", "chunk", "done"]);

    // Kontrak lama tetap.
    assert.equal(frames[0].data.provider, "probe");
    assert.equal(frames[0].data.model, "m-default");
    assert.deepEqual(frames[4].data, { ok: true });

    // Chunk pertama: bidang inti selalu ada, tanpa ekstra.
    assert.deepEqual(
        Object.keys(frames[1].data).sort(),
        ["delta", "done", "finishReason", "toolCalls"]
    );

    // Chunk kedua: ekstra diteruskan bila provider mengirim.
    assert.equal(frames[2].data.delta, "lo");
    assert.equal(frames[2].data.reasoning, "pikir");
    assert.deepEqual(frames[2].data.usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    assert.equal(frames[2].data.id, "c-9");
    assert.equal(frames[2].data.model, "g-test");
    assert.equal(frames[2].data.provider, "openrouter");

    // toolCalls tetap diteruskan (kontrak lama).
    assert.ok(Array.isArray(frames[1].data.toolCalls));

    assert.equal(res.beres, true);

});

test("SSE: error setelah header terkirim menjadi event error", async () => {

    pasangStub({
        generator: async function* () {
            yield chunk({ delta: "sebagian" });
            throw new Error("koneksi putus");
        }
    });

    const res = resMock();

    await aiController.stream(
        { body: { messages: [{ role: "user", content: "x" }] } },
        res
    );

    const frames = parseFrames(res);

    assert.equal(frames[frames.length - 1].event, "error");
    assert.equal(frames[frames.length - 1].data.message, "koneksi putus");
    assert.equal(res.beres, true);

});

test("SSE: klien membatalkan → tidak ada done, koneksi ditutup", async () => {

    pasangStub({
        generator: async function* (resMockRef) {
            yield chunk({ delta: "satu" });
            resMockRef.tutup();     // klien pergi setelah chunk pertama
            yield chunk({ delta: "dua" });
        }
    });

    const res = resMock();

    // Generator stub menerima res lewat argumen kedua? Tidak —
    // controller tidak meneruskannya; pakai closure.
    aiRuntime.stream = async function* () {
        yield chunk({ delta: "satu" });
        res.tutup();
        yield chunk({ delta: "dua" });
    };

    await aiController.stream(
        { body: { messages: [{ role: "user", content: "x" }] } },
        res
    );

    const frames = parseFrames(res);

    const nama = frames.map(f => f.event);

    assert.ok(!nama.includes("done"), `tidak boleh ada done: ${nama}`);
    assert.ok(!frames.some(f => f.data?.delta === "dua"), "chunk setelah batal tidak terkirim");
    assert.equal(res.beres, true);

});

test("SSE: body tanpa messages ditolak sebelum header terkirim", async () => {

    const res = resMock();
    res.status = 500;

    // response.error memakai res.status().json() — mock sederhana.
    res.status = (kode) => ({ json: (isi) => { res.ditolak = { kode, isi }; return res; } });

    await aiController.stream({ body: {} }, res);

    assert.ok(res.ditolak);
    assert.equal(res.ditolak.isi.success, false);
    assert.equal(res.frames.length, 0, "tidak ada SSE yang dikirim");

});
