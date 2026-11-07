const test = require("node:test");
const assert = require("node:assert");

const { createMcpHandler } = require("../../src/mcp/mcpHandler");

/**
 * Jembatan MCP Damar.
 *
 * Yang dijaga: JSON-RPC benar (initialize/tools/list/tools/call),
 * tool DESTRUKTIF disembunyikan & ditolak secara default, notifikasi
 * tak dibalas, dan eksekusi diteruskan ke registry.
 */

function mockRegistry(calls = []) {
    const tools = {
        "math.calc": { description: "Hitung", parameters: { a: { type: "number", required: true } } },
        "terminal_run": { description: "Jalankan perintah", parameters: { cmd: { type: "string" } } }
    };
    return {
        describe: () => Object.entries(tools).map(([id, t]) => ({ id, name: id, description: t.description, parameters: t.parameters })),
        has: (id) => !!tools[id],
        execute: async (id, args) => { calls.push({ id, args }); return id === "math.calc" ? { result: (args.a || 0) * 2 } : "ran"; }
    };
}

const DESTRUCTIVE = new Set(["terminal_run"]);
const mk = (allow = false, calls = []) => createMcpHandler({ registry: mockRegistry(calls), isDestructive: id => DESTRUCTIVE.has(id), allowDestructive: allow });

test("initialize mengembalikan protokol & serverInfo", async () => {
    const r = await mk().handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(r.result.protocolVersion, "2024-11-05");
    assert.equal(r.result.serverInfo.name, "damar");
    assert.ok(r.result.capabilities.tools);
});

test("tools/list menyembunyikan tool destruktif secara default + skema ternormalisasi", async () => {
    // Identitas sistem eksplisit (H9): tanpa identitas → fail-closed
    // sebagai user anonim yang melihat sangat sedikit.
    const r = await mk().handle(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { exec: { role: "system", channel: "mcp" } });
    const names = r.result.tools.map(t => t.name);
    assert.ok(names.includes("math.calc"));
    assert.ok(!names.includes("terminal_run"), "destruktif harus tersembunyi");
    const calc = r.result.tools.find(t => t.name === "math.calc");
    assert.equal(calc.inputSchema.type, "object");
    assert.deepEqual(calc.inputSchema.required, ["a"]);
});

test("tools/call meneruskan ke registry dan mengemas hasil", async () => {
    const calls = [];
    const r = await mk(false, calls).handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "math.calc", arguments: { a: 21 } } });
    assert.equal(calls[0].id, "math.calc");
    assert.match(r.result.content[0].text, /42/);
    assert.ok(!r.result.isError);
});

test("tools/call destruktif DITOLAK default, tak dieksekusi", async () => {
    const calls = [];
    const r = await mk(false, calls).handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "terminal_run", arguments: { cmd: "x" } } });
    assert.equal(r.result.isError, true);
    assert.equal(calls.length, 0, "tool destruktif tak boleh dieksekusi");
});

test("allowDestructive=true membuka tool destruktif", async () => {
    const calls = [];
    const h = mk(true, calls);
    const list = await h.handle(
        { jsonrpc: "2.0", id: 5, method: "tools/list" },
        { exec: { role: "system", channel: "mcp" } });
    assert.ok(list.result.tools.map(t => t.name).includes("terminal_run"));
    const call = await h.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "terminal_run", arguments: {} } });
    assert.ok(!call.result.isError);
    assert.equal(calls.length, 1);
});

// ---- H9: PERMISSION-BEFORE-DISCLOSURE ---------------------------------

const Authorization = require("../../src/ai/tools/Authorization");

test("H9: user TIDAK melihat kapabilitas yang tak bisa ia eksekusi", async () => {

    // tools/list tanpa identitas → fail-closed sebagai user anonim.
    const r = await mk().handle({ jsonrpc: "2.0", id: 20, method: "tools/list" });

    const names = r.result.tools.map(t => t.name);

    // 'terminal_run' destruktif (tersembunyi terpisah); 'math.calc'
    // bukan allowlist user → juga tidak boleh muncul.
    assert.equal(names.length, 0,
        `user hanya boleh melihat yang bisa dieksekusi; dapat: ${names}`);

});

test("H9: paritas disklosur vs eksekusi untuk peran user", async () => {

    const privileged = ["terminal_run", "math.calc"];

    for (const name of privileged) {
        let execDenied = false;
        try {
            Authorization.assertExecution(
                { name }, { role: "user", channel: "mcp" });
        } catch { execDenied = true; }

        const r = await mk(true).handle(
            { jsonrpc: "2.0", id: 21, method: "tools/list" },
            { exec: { role: "user", channel: "mcp" } });

        const disclosed = r.result.tools.some(t => t.name === name);

        assert.equal(disclosed, !execDenied,
            `'${name}': disclosure=${disclosed} tapi executionDenied=${execDenied}`);
    }

});

test("H9: system tetap melihat kapabilitas yang diizinkan", async () => {
    const r = await mk().handle(
        { jsonrpc: "2.0", id: 22, method: "tools/list" },
        { exec: { role: "system", channel: "mcp" } });
    assert.ok(r.result.tools.some(t => t.name === "math.calc"));
});

test("tool tak dikenal → error -32602", async () => {
    const r = await mk().handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "tidak.ada" } });
    assert.equal(r.error.code, -32602);
});

test("notifications/initialized tak dibalas (null)", async () => {
    assert.equal(await mk().handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("method asing → -32601", async () => {
    const r = await mk().handle({ jsonrpc: "2.0", id: 8, method: "resources/list" });
    assert.equal(r.error.code, -32601);
});
