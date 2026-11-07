const test = require("node:test");
const assert = require("node:assert");

const RuntimeExecutor = require("../../src/ai/executors/RuntimeExecutor");
const AIToolCall = require("../../src/ai/tools/AIToolCall");
const { TurnController } = require("../../src/ai/tools/TurnController");
const ArgumentValidator = require("../../src/ai/tools/ArgumentValidator");
const toolStats = require("../../src/ai/tools/ToolStats");
const loopGuard = require("../../src/core/safety/loopGuard");
const killSwitch = require("../../src/core/safety/killSwitch");

/**
 * SUITE EKSEKUSI TOOL — validasi argumen, error terstruktur,
 * ToolGuard tetap aktif, timeout, pembatalan, anggaran giliran,
 * isolasi kegagalan eksternal, metrik sukses tool.
 */

function makeExecutor(scripted) {
    /** RuntimeExecutor dengan service palsu: balasan diambil berurutan. */
    const executor = new RuntimeExecutor(
        { chat: async () => scripted.shift() ?? { content: "selesai", toolCalls: [] } },
        { callTimeout: 5000 }
    );

    // Identitas eksekusi eksplisit (invariant G): unit-test mekanika
    // eksekusi berjalan sebagai superadmin; otorisasi diuji terpisah
    // di toolSecurity.test.js.
    const originalExecute = executor.execute.bind(executor);
    executor.execute = (request) =>
        originalExecute({ exec: { role: "superadmin", channel: "test" }, ...request });

    executor.setToolRegistry({
        map: new Map(),
        get(name) { return this.map.get(name); }
    });

    return executor;
}

const call = (name, args) => new AIToolCall({
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: args
});

/** Rekam hasil tool lewat hook appendToolMessages. */
function capture(executor) {
    const out = [];
    const orig = executor.appendToolMessages.bind(executor);
    executor.appendToolMessages = (req, res, results) => {
        out.push(...results);
        orig(req, res, results);
    };
    return out;
}

// ---- Validasi argumen -------------------------------------------------

test("argumen tidak valid DITOLAK tanpa dieksekusi (VALIDATION_ERROR)", async () => {

    let executed = false;

    const exec = makeExecutor([
        { content: "", toolCalls: [call("search_photos", {})] }   // query wajib hilang
    ]);

    exec.toolRegistry.map.set("search_photos", {
        name: "search_photos",
        description: "Search photos by query",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute: async () => { executed = true; return {}; }
    });

    await exec.execute({ messages: [{ role: "user", content: "cari foto" }] });

    assert.equal(executed, false);

});

test("argumen dinormalisasi (angka string → number) lalu dieksekusi", async () => {

    let received = null;

    const exec = makeExecutor([
        { content: "", toolCalls: [call("set_level", { level: "42" })] },
        { content: "ok", toolCalls: [] }
    ]);

    exec.toolRegistry.map.set("set_level", {
        name: "set_level",
        description: "Set level",
        parameters: { type: "object", properties: { level: { type: "integer" } }, required: ["level"] },
        execute: async (args) => { received = args.level; return { ok: true }; }
    });

    await exec.execute({ messages: [{ role: "user", content: "setel level" }] });

    assert.equal(received, 42);

});

test("hasil gagal berbentuk {error:{code,message}} — bukan string bebas", async () => {

    const exec = makeExecutor([
        { content: "", toolCalls: [call("boom", {})] },
        { content: "dicatat", toolCalls: [] }
    ]);

    exec.toolRegistry.map.set("boom", {
        name: "boom",
        description: "Always fails",
        parameters: {},
        execute: async () => { throw new Error("ledakan sintetis"); }
    });

    const captured = capture(exec);

    await exec.execute({ messages: [{ role: "user", content: "ledakan" }] });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].result.error.code, "EXECUTION_ERROR");
    assert.match(String(captured[0].result.error.message), /ledakan sintetis/);

});

test("TOOL_NOT_FOUND mengarahkan model ke tool_search", async () => {

    const exec = makeExecutor([
        { content: "", toolCalls: [call("tidak_ada_ini", {})] },
        { content: "baik", toolCalls: [] }
    ]);

    const captured = capture(exec);

    await exec.execute({ messages: [{ role: "user", content: "apa saja" }] });

    assert.equal(captured[0].result.error.code, "TOOL_NOT_FOUND");

});

// ---- ToolGuard tetap aktif ---------------------------------------------

test("kill switch menghentikan eksekusi → POLICY_DENIED", async () => {

    const wasEngaged = killSwitch.isEngaged();

    if (!wasEngaged) killSwitch.engage({ reason: "test", actor: "test" });

    try {

        loopGuard.resetAll();

        const exec = makeExecutor([
            { content: "", toolCalls: [call("memory_recall", { query: "x" })] },
            { content: "oke", toolCalls: [] }
        ]);

        exec.toolRegistry.map.set("memory_recall", {
            name: "memory_recall",
            description: "Recall memories",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            execute: async () => ({ items: [] })
        });

        const captured = capture(exec);

        await exec.execute({ messages: [{ role: "user", content: "ingat apa" }] });

        assert.equal(captured[0].result.error.code, "POLICY_DENIED");

    }
    finally {
        if (!wasEngaged) killSwitch.release({ actor: "test" });
        loopGuard.resetAll();
    }

});

// ---- Timeout & pembatalan ------------------------------------------------

test("tool menggantung → TIMEOUT terstruktur", async () => {

    process.env.DAMAR_TOOL_TIMEOUT_MS = "80";

    try {

        const exec = makeExecutor([
            { content: "", toolCalls: [call("slow", {})] },
            { content: "lanjut", toolCalls: [] }
        ]);

        exec.toolRegistry.map.set("slow", {
            name: "slow",
            description: "sleeps",
            parameters: {},
            execute: () => new Promise(resolve => setTimeout(resolve, 10_000))
        });

        const captured = capture(exec);

        await exec.execute({ messages: [{ role: "user", content: "pelan" }] });

        assert.equal(captured[0].result.error.code, "TIMEOUT");

    }
    finally {
        delete process.env.DAMAR_TOOL_TIMEOUT_MS;
    }

});

test("AbortSignal batal sejak awal → giliran berhenti dengan pesan batal", async () => {

    const controller = new AbortController();

    controller.abort();

    const exec = makeExecutor([]);

    await assert.rejects(
        () => exec.execute({
            messages: [{ role: "user", content: "mulai" }],
            signal: controller.signal
        }),
        /batal/i
    );

});

// ---- Anggaran giliran ------------------------------------------------------

test("TurnController menahan jumlah panggilan per giliran", () => {

    const tc = new TurnController({});
    tc.maxToolCalls = 2;

    tc.beginTool("a"); tc.endTool("a", null);
    tc.beginTool("a"); tc.endTool("a", null);

    assert.throws(() => tc.beginTool("a"), /MAX_TOOL_CALLS/);

});

test("TurnController menghentikan error sama berulang pada satu tool", () => {

    const tc = new TurnController({});
    tc.maxRetriesPerTool = 2;

    tc.beginTool("x"); tc.endTool("x", "EXECUTION_ERROR");
    tc.beginTool("x"); tc.endTool("x", "EXECUTION_ERROR");

    // Percobaan ketiga dengan error yang sama → ditolak saat selesai.
    tc.beginTool("x");
    assert.throws(() => { tc.endTool("x", "EXECUTION_ERROR"); }, /MAX_SAME_ERROR|gagal/);

});

test("giliran melewati batas MAX_TOOL_CALLS → jawaban penutup jujur", async () => {

    process.env.DAMAR_MAX_TOOL_CALLS_PER_TURN = "2";

    try {

        loopGuard.resetAll();

        // Model selalu memanggil tool dengan ARGUMEN BERBEDA supaya
        // loopGuard tidak ikut mencampur; yang diuji murni anggaran.
        let n = 0;

        const exec = new RuntimeExecutor(
            { chat: async () => ({ content: "", toolCalls: [call(`counter_${++n}`, {})] }) },
            { callTimeout: 5000 }
        );

        exec.setToolRegistry({ get: () => ({
            name: `counter_${n}`,
            description: "counter",
            parameters: {},
            execute: async () => ({ n })
        }) });

        const result = await exec.execute({ messages: [{ role: "user", content: "kerjakan" }] });

        assert.match(String(result.content), /batas|MAX_TOOL_CALLS/i);

    }
    finally {
        delete process.env.DAMAR_MAX_TOOL_CALLS_PER_TURN;
        loopGuard.resetAll();
    }

});

// ---- Isolasi kegagalan eksternal & metrik -----------------------------------

test("kegagalan satu tool MCP tidak menjatuhkan tool lain", async () => {

    const exec = makeExecutor([
        {
            content: "",
            toolCalls: [
                call("mcp__x__broken", {}),
                call("memory_remember", { content: "fakta penting" })
            ]
        },
        { content: "dua-duanya tuntas", toolCalls: [] }
    ]);

    exec.toolRegistry.map.set("mcp__x__broken", {
        name: "mcp__x__broken",
        description: "Broken external tool",
        meta: { source: "mcp", provider: "x" },
        parameters: {},
        execute: async () => { throw new Error("server mati"); }
    });

    exec.toolRegistry.map.set("memory_remember", {
        name: "memory_remember",
        description: "Remember a fact",
        parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
        execute: async () => ({ saved: true })
    });

    const captured = capture(exec);

    await exec.execute({ messages: [{ role: "user", content: "dua kerjaan" }] });

    const byName = Object.fromEntries(captured.map(c => [c.name, c]));

    assert.equal(byName["mcp__x__broken"].result.error.code, "EXECUTION_ERROR");
    assert.ok(byName["memory_remember"].result.saved !== undefined);

});

test("metrik sukses/gagal tool tercatat dan mempengaruhi keandalan", () => {

    toolStats.reset();

    toolStats.record("stat_tool", true, 10);
    toolStats.record("stat_tool", true, 20);
    toolStats.record("stat_tool", false, 30, "EXECUTION_ERROR");

    const snap = toolStats.snapshot().find(s => s.name === "stat_tool");

    assert.equal(snap.calls, 3);
    assert.equal(snap.ok, 2);
    assert.equal(snap.lastErrorCategory, "EXECUTION_ERROR");

    // Sampel < minimum → reliability null (konservatif).
    assert.equal(toolStats.reliability("stat_tool"), null);

    for (let i = 0; i < 5; i++) toolStats.record("stat_tool", true, 5);

    assert.ok(toolStats.reliability("stat_tool") > 0.7);

    toolStats.flush();
    toolStats.reset();

});

test("kode error lengkap tersedia machine-readable", () => {

    for (const code of ["VALIDATION_ERROR", "PERMISSION_DENIED", "POLICY_DENIED",
        "TOOL_NOT_FOUND", "EXECUTION_ERROR", "TIMEOUT", "CANCELLED"]) {
        assert.equal(typeof ArgumentValidator.CODES[code], "string");
    }

    const e = ArgumentValidator.make(ArgumentValidator.CODES.VALIDATION_ERROR, "tes");
    assert.equal(e.code, "VALIDATION_ERROR");
    assert.equal(e.toolError, true);

});
