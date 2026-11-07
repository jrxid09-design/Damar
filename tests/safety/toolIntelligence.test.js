const test = require("node:test");
const assert = require("node:assert");

const Pipeline = require("../../src/ai/tools/Pipeline");
const CapabilityIndex = require("../../src/ai/tools/CapabilityIndex");
const SchemaMinimizer = require("../../src/ai/tools/SchemaMinimizer");
const { buildRegistry } = require("../benchmark/tool-fixture");

/**
 * SUITE SELEKSI TOOL INTELLIGENCE — sapaan nol tool, determinisme,
 * peran, kanal, MCP dinamis, minimisasi schema, anggaran konteks.
 */

const tail = (n) => String(n).split(/__|\./).pop();

function select(message, opts = {}) {
    return Pipeline.select({
        tools: opts.tools ?? buildRegistry(),
        message,
        channel: opts.channel ?? "console",
        role: opts.role ?? "superadmin"
    });
}

// ---- 1. Sapaan → NOL tool -------------------------------------------

test("greeting 'halo' menghasilkan NOL tool", () => {
    const r = select("halo apa kabar?");
    assert.equal(r.tools.length, 0);
});

test("ucapan penutup juga nol tool", () => {
    assert.equal(select("makasih ya").tools.length, 0);
    assert.equal(select("ok sip deh").tools.length, 0);
});

// ---- 2. Deterministik & paritas kanal ---------------------------------

test("seleksi deterministik: pesan sama → hasil identik", () => {
    const a = select("matikan lampu kamar");
    const b = select("matikan lampu kamar");
    assert.deepEqual(a.tools, b.tools);
});

test("paritas kanal: telegram & console memilih sama untuk pesan sama", () => {
    const t = select("nyalakan lampu ruang tamu", { channel: "telegram" });
    const c = select("nyalakan lampu ruang tamu", { channel: "console" });
    assert.deepEqual(t.diagnostics.selectedTools, c.diagnostics.selectedTools);
});

// ---- 3. Retrieval tepat sasaran ---------------------------------------

test("'jam berapa' membawa kemampuan waktu tanpa home control", () => {
    const tails = select("jam berapa sekarang?").diagnostics.selectedTools.map(tail);
    assert.ok(tails.includes("currentTime"), `dapat ${tails}`);
    assert.ok(!tails.includes("home_control"));
});

test("'matikan lampu kamar': home_control adalah item DINAMIS pertama", () => {

    const r = select("matikan lampu kamar");

    const tailsAll = r.diagnostics.selectedTools.map(tail);

    const STABLE = new Set(["memory_recall","memory_remember","currentTime",
        "readFile","writeFile","listDirectory","goal_run","capability_search",
        "tool_exec","skill_build","create_tool","activate_tool","tool_search"]);

    const firstDynamicIdx = tailsAll.findIndex(t => !STABLE.has(t));

    assert.equal(tailsAll[firstDynamicIdx], "home_control");

});

test("'baca server.js' membawa filesystem read (stabil) tanpa saingan asing", () => {

    const tails = select("baca file server.js dong")
        .diagnostics.selectedTools.map(tail);

    assert.ok(tails.includes("readFile"), `dapat ${tails.slice(0,6)}`);

    // Tidak ada tool domain lain yang mendahului kebutuhan utama.
    const readIdx = tails.indexOf("readFile");

    const beforeRead = tails.slice(0, readIdx);

    assert.equal(
        beforeRead.findIndex(t => /home_control|crypto_price|play_youtube/.test(t)),
        -1
    );

});

// ---- 4. Peran & kanal ---------------------------------------------------

test("role 'user' tertahan dari deleteFile walau relevan", () => {
    const tails = select("hapus file log lama", { role: "user" })
        .diagnostics.selectedTools.map(tail);
    assert.ok(!tails.includes("deleteFile"), `user dapat: ${tails}`);
});

test("role 'admin' juga tertahan dari deleteFile", () => {
    const tails = select("hapus file log lama", { role: "admin" })
        .diagnostics.selectedTools.map(tail);
    assert.ok(!tails.includes("deleteFile"));
});

test("superadmin tetap mendapat tool yang relevan", () => {
    const tails = select("hapus file log lama", { role: "superadmin" })
        .diagnostics.selectedTools.map(tail);
    assert.ok(tails.includes("deleteFile"));
});

test("metadata channels menyaring tool per kanal", () => {

    const tools2 = [
        {
            name: "console_thing",
            description: "lampu console helper",
            meta: { keywords: ["lampu"], channels: ["console"] },
            parameters: {},
            execute: async () => ({})
        }
    ];

    // Kanal eksplisit dilarang tidak boleh lolos ke whatsapp.
    const r2 = Pipeline.select({ tools: tools2, message: "matikan lampu", channel: "whatsapp", role: "superadmin" });
    assert.equal(r2.tools.filter(t => t.name === "console_thing").length, 0);

    // Di kanal yang diizinkan, tool muncul.
    const r3 = Pipeline.select({ tools: tools2, message: "matikan lampu", channel: "console", role: "superadmin" });
    assert.equal(r3.tools.filter(t => t.name === "console_thing").length, 1);

});

// ---- 5. MCP dinamis ------------------------------------------------------

test("tool MCP ditemukan TANPA hardcode nama", () => {
    const tails = select("matikan plug pintar di ruang kerja")
        .diagnostics.selectedTools.map(tail);
    assert.ok(tails.includes("device_turn_off"), `dapat ${tails}`);
});

test("tool MCP sensor ikut discovery lewat deskripsi", () => {
    const tails = select("cek sensor suhu gudang lewat smart home")
        .diagnostics.selectedTools.map(tail);
    assert.ok(tails.includes("sensor_temperature_read"), `dapat ${tails}`);
});

test("MCP ditandai external oleh capability index", () => {
    const rec = CapabilityIndex.describe(
        buildRegistry().find(t => t.name.startsWith("mcp__"))
    );
    assert.equal(rec.source, "mcp");
    assert.equal(rec.external, true);
    assert.equal(rec.provider, "homey");
});

// ---- 6. Schema minimization ----------------------------------------------

test("schema diminimalkan: token after < token before", () => {
    const d = select("matikan lampu kamar").diagnostics;
    assert.ok(d.schemaTokensAfter > 0);
    assert.ok(
        d.schemaTokensAfter < d.schemaTokensBefore / 2,
        `after=${d.schemaTokensAfter} before=${d.schemaTokensBefore}`
    );
});

test("SchemaMinimizer memangkas skema gemuk tanpa kehilangan semantik", () => {

    const fat = {
        name: "fat_tool",
        description: "Does something useful. ".repeat(40),
        parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            additionalProperties: false,
            properties: {
                query: {
                    type: "string",
                    description: "The search query string to look for. ".repeat(16),
                    examples: ["contoh"]
                },
                mode: { type: "string", enum: ["a", "b", "c"] }
            },
            required: ["query"]
        }
    };

    const view = SchemaMinimizer.toView(fat, { descChars: 160, paramDescChars: 80 });

    const fullTokens = SchemaMinimizer.estimateTokens(fat);
    const viewTokens = SchemaMinimizer.estimateTokens(view);

    assert.ok(viewTokens < fullTokens / 3, `${viewTokens} vs ${fullTokens}`);
    assert.deepEqual(view.parameters.required, ["query"]);
    assert.deepEqual(view.parameters.properties.mode.enum, ["a", "b", "c"]);
    assert.equal(view.parameters.$schema, undefined);
    assert.equal(view.parameters.additionalProperties, undefined);

});

test("deskripsi dipotong sesuai anggaran; nama & required tetap utuh", () => {

    const longTool = {
        name: "big_tool",
        description: "x".repeat(2000),
        parameters: {
            type: "object",
            properties: { q: { type: "string", description: "y".repeat(500) } },
            required: ["q"]
        },
        meta: { keywords: ["lampu"] },
        execute: async () => ({})
    };

    const r = Pipeline.select({
        tools: [longTool], message: "atur lampu", channel: "telegram", role: "superadmin"
    });

    assert.equal(r.tools.length, 1);
    assert.equal(r.tools[0].name, "big_tool");
    assert.ok(r.tools[0].description.length <= 200);
    assert.deepEqual(r.tools[0].parameters.required, ["q"]);

});

// ---- 7. Anggaran context-aware ---------------------------------------------

test("model 8K mendapat anggaran lebih ketat daripada model besar", () => {
    const Budget = require("../../src/ai/tools/Budget");
    const p8 = Budget.profileFor(8192);
    const p128 = Budget.profileFor(131072);
    assert.ok(p8.maxTools < p128.maxTools);
    assert.ok(p8.descChars <= p128.descChars);
});

test("tanpa info konteks, profil default konservatif (32K)", () => {
    const p = require("../../src/ai/tools/Budget").profileFor(NaN);
    assert.equal(p.contextTokens, 32768);
});

test("tool_search selalu terlampir saat ada seleksi", () => {
    const names = select("matikan lampu kamar").tools.map(t => t.name);
    assert.ok(names.includes("tool_search"), `${names}`);
});

