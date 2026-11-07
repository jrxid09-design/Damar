const test = require("node:test");
const assert = require("node:assert");

const AIRuntime = require("../../src/ai/runtime/AIRuntime");
const { AIToolRegistry } = require("../../src/ai/tools");
const Budget = require("../../src/ai/tools/Budget");
const SchemaMinimizer = require("../../src/ai/tools/SchemaMinimizer");
const ContextPipeline = require("../../src/ai/context/Pipeline");
const ContextItem = require("../../src/ai/context/ContextItem");
const { buildRegistry } = require("../benchmark/tool-fixture");

/**
 * H6 — PROPAGASI JENDELA KONTeks MODEL AKTIF lewat jalur produksi.
 *
 * Produksi: aiRuntimeService.chat/stream → exec.contextTokens =
 * activeContextTokens() (dari konfigurasi model lokal / provider) →
 * AIRuntime.resolveTools + ContextBudget. Env DAMAR_MODEL_CONTEXT_TOKENS
 * hanya fallback — test ini TIDAK meng-set env apa pun.
 */

function newRuntime() {
    const rt = new AIRuntime(null, { defaultModel: "test-model" });
    const registry = new AIToolRegistry();
    for (const tool of buildRegistry()) registry.register(tool);
    rt.setToolRegistry(registry);
    return rt;
}

// ---- 1. Tool Intelligence: window aktif ikut ke anggaran --------------

for (const [label, window] of [
    ["4K", 4096],
    ["8K", 8192],
    ["16K", 16384],
    ["large", 131072]
]) {

    test(`H6 ${label}: resolveTools memakai window model (${window}), bukan default 32K`, () => {

        const rt = newRuntime();

        // Bentuk request PERSIS seperti jalur produksi aiRuntimeService:
        // exec.contextTokens — BUKAN request.execContextTokens.
        const request = {
            messages: [{ role: "user", content: "baca file server.js dong" }],
            exec: {
                role: "superadmin",
                channel: "console",
                sessionId: "h6-test",
                contextTokens: window
            }
        };

        const tools = rt.resolveTools(request);

        const diag = rt.lastSelection;

        assert.ok(diag?.budget, "diagnostics.budget harus ada");
        assert.equal(diag.budget.contextTokens, window,
            `anggaran harus diturunkan dari window ${window}`);

        // Serialized payload tool tidak boleh melebihi langit-langit
        // window aktif (win − reserve output − safety margin).
        const hardCap = window - 1024 - 512;

        const totalToolTokens = tools.reduce(
            (sum, view) => sum + SchemaMinimizer.estimateTokens(view), 0);

        assert.ok(totalToolTokens <= hardCap,
            `payload tool (${totalToolTokens} tok) melebihi hardCap ${hardCap} utk window ${window}`);
    });

}

// ---- 2. Context Intelligence: window aktif membatasi payload final ----

test("H6: Pipeline.select(contextTokens=4096) menjaga system+history+dinamik di bawah window", async () => {

    const bigCorpus = Array.from({ length: 30 }, (_, i) => ({
        role: "user",
        content: `catatan panjang nomor ${i}: ` + "proyek damar ".repeat(400)
    }));

    const { diagnostics } = await ContextPipeline.select({
        messages: [...bigCorpus, { role: "user", content: "ringkas catatan proyek" }],
        channel: "console",
        includeMind: false,
        memoryFn: async () => [{
            source: "memory",
            kind: ContextItem.KIND.MEMORY,
            content: "memori uji: " + "detail penting ".repeat(300),
            priority: 50,
            compressible: true
        }],
        mindFn: () => [],
        contextTokens: 4096   // ← jalur baru: dari model aktif, tanpa env
    });

    const hardCap = 4096 - 1024 - 512;

    assert.equal(diagnostics.windowHardCap, hardCap);
    assert.ok(diagnostics.tokensAfter <= hardCap,
        `payload final (${diagnostics.tokensAfter}) melebiji hardCap ${hardCap}`);
});

test("H6: tanpa env dan tanpa exec.contextTokens, fallback konservatif tetap aman", () => {

    const rt = newRuntime();
    const request = {
        messages: [{ role: "user", content: "baca file server.js dong" }]
    };

    delete process.env.DAMAR_MODEL_CONTEXT_TOKENS;

    try {
        rt.resolveTools(request);
        const diag = rt.lastSelection;
        // Default konservatif Budget.profileFor(undefined) = 32768.
        assert.equal(diag.budget.contextTokens, 32768);
    }
    finally {
        delete process.env.DAMAR_MODEL_CONTEXT_TOKENS;
    }

});

// ---- H6 Round-3: PRESEDENS WINDOW — env TIDAK boleh memperbesar ------

const ContextBudget = require("../../src/ai/context/ContextBudget");

test("H6 R3: activeContextTokens — env fallback tidak pernah melampaui window nyata", () => {

    const svc = require("../../src/services/aiRuntimeService");

    // Instansi ringan dari prototype yang sama (constructor singleton
    // hanya membangun string prompt — aman dimuat).
    const inst = Object.create(Object.getPrototypeOf(svc));

    const savedEnv = process.env.DAMAR_MODEL_CONTEXT_TOKENS;

    try {
        // real=4096, env=32768 → efektif <= 4096
        inst._localContextTokens = 4096;
        inst.activePlatform = { id: "llamacpp" };
        process.env.DAMAR_MODEL_CONTEXT_TOKENS = "32768";
        assert.equal(inst.activeContextTokens(), 4096,
            "env TIDAK boleh memperbesar window model yang diketahui");

        // real=8192, env=4096 → 4096 (mengecilkan boleh)
        inst._localContextTokens = 8192;
        process.env.DAMAR_MODEL_CONTEXT_TOKENS = "4096";
        assert.equal(inst.activeContextTokens(), 4096);

        // real=4096, tanpa env → 4096
        inst._localContextTokens = 4096;
        delete process.env.DAMAR_MODEL_CONTEXT_TOKENS;
        assert.equal(inst.activeContextTokens(), 4096);

        // real tidak diketahui (cloud), env=8192 → fallback bekerja
        inst._localContextTokens = null;
        inst.activePlatform = { id: "openai" };
        process.env.DAMAR_MODEL_CONTEXT_TOKENS = "8192";
        assert.equal(inst.activeContextTokens(), 8192);

        // real tidak diketahui, tanpa env → null (default konservatif)
        delete process.env.DAMAR_MODEL_CONTEXT_TOKENS;
        assert.equal(inst.activeContextTokens(), null);
    }
    finally {
        if (savedEnv === undefined) delete process.env.DAMAR_MODEL_CONTEXT_TOKENS;
        else process.env.DAMAR_MODEL_CONTEXT_TOKENS = savedEnv;
    }

});

test("H6 R3: ContextBudget.compute — empat probe preseden wajib", () => {

    const savedEnv = process.env.DAMAR_MODEL_CONTEXT_TOKENS;

    try {
        // real=4096, env=32768 → efektif <= 4096
        process.env.DAMAR_MODEL_CONTEXT_TOKENS = "32768";
        let p = ContextBudget.compute({ contextTokens: 4096 }).profile;
        assert.ok(p.contextTokens <= 4096,
            `compute memakai ${p.contextTokens}; env memperbesar window nyata`);

        // real=8192, env=4096 → nilai lebih kecil sah
        process.env.DAMAR_MODEL_CONTEXT_TOKENS = "4096";
        p = ContextBudget.compute({ contextTokens: 8192 }).profile;
        assert.equal(p.contextTokens, 4096);

        // real tidak diketahui, env=8192 → fallback bekerja
        process.env.DAMAR_MODEL_CONTEXT_TOKENS = "8192";
        p = ContextBudget.compute({ contextTokens: null }).profile;
        assert.equal(p.contextTokens, 8192);

        // real=4096, tanpa env → 4096
        delete process.env.DAMAR_MODEL_CONTEXT_TOKENS;
        p = ContextBudget.compute({ contextTokens: 4096 }).profile;
        assert.equal(p.contextTokens, 4096);
    }
    finally {
        if (savedEnv === undefined) delete process.env.DAMAR_MODEL_CONTEXT_TOKENS;
        else process.env.DAMAR_MODEL_CONTEXT_TOKENS = savedEnv;
    }

});

test("H6 R3: Tool Pipeline mematuhi window efektif walau env lebih besar", async () => {

    const PipelineTools = require("../../src/ai/tools/Pipeline");
    const savedEnv = process.env.DAMAR_MODEL_CONTEXT_TOKENS;

    process.env.DAMAR_MODEL_CONTEXT_TOKENS = "32768";

    try {
        const r = await PipelineTools.select({
            tools: buildRegistry(),
            message: "matikan lampu kamar",
            channel: "console",
            role: "superadmin",
            contextTokens: 4096
        });

        assert.equal(r.diagnostics.budget.contextTokens, 4096,
            "Tool Intelligence harus memakai window efektif, bukan env yang lebih besar");
    }
    finally {
        if (savedEnv === undefined) delete process.env.DAMAR_MODEL_CONTEXT_TOKENS;
        else process.env.DAMAR_MODEL_CONTEXT_TOKENS = savedEnv;
    }

});
