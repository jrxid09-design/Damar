const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");

const { McpClient } = require("../../src/mcp/mcpClient");

/**
 * Damar sebagai KLIEN MCP.
 *
 * Yang dijaga: handshake initialize → tools/list, korelasi id
 * JSON-RPC, pemanggilan tools/call dengan argumen, allowlist
 * allowedTools, penamaan bridge mcp__{server}__{tool}, dan
 * penanganan error/isError dari server.
 */

/** Server MCP dummy: newline-delimited JSON-RPC di stdio. */
const DUMMY_SERVER = `
const lines = [];
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        handle(msg);
    }
});

function reply(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

function handle(msg) {
    if (msg.method === "initialize") {
        return reply({ jsonrpc: "2.0", id: msg.id, result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "dummy-mcp", version: "1.0.0" }
        }});
    }
    if (msg.method === "notifications/initialized") return;   // tanpa balasan
    if (msg.method === "tools/list") {
        return reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [
            { name: "echo", description: "Balas argumen", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
            { name: "add", description: "Tambah dua angka", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
            { name: "boom", description: "Selalu error", inputSchema: { type: "object", properties: {} } },
            { name: "secret", description: "Tool tersembunyi", inputSchema: { type: "object", properties: {} } }
        ]}});
    }
    if (msg.method === "tools/call") {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        if (name === "echo") return reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + (args.text ?? "") }] } });
        if (name === "add") return reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String((args.a ?? 0) + (args.b ?? 0)) }] } });
        if (name === "boom") return reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "kaboom dari server" }], isError: true } });
        if (name === "slow") { setTimeout(() => reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "slow done" }] } }), 5000); return; }
        return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool: " + name } });
    }
    reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
`;

function writeDummyServer(dir) {
    const file = path.join(dir, "dummy-mcp-server.js");
    fs.writeFileSync(file, DUMMY_SERVER, "utf8");
    return file;
}

async function withClient(t, opts = {}) {
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "mcp-test-"));
    t.after(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    });
    const serverFile = writeDummyServer(dir);
    const client = new McpClient({
        id: "dummy",
        command: process.execPath,
        args: [serverFile],
        ...opts
    });
    t.after(() => client.stop().catch(() => {}));
    await client.start();
    return client;
}

test("start: handshake initialize + tools/list", async t => {
    const client = await withClient(t);
    assert.equal(client._ready, true);
    assert.equal(client._serverInfo.name, "dummy-mcp");
    const names = client._tools.map(t => t.name).sort();
    assert.deepEqual(names, ["add", "boom", "echo", "secret"]);
});

test("tools/call mengirim argumen dan mengembalikan teks hasil", async t => {
    const client = await withClient(t);
    const out = await client.callTool("echo", { text: "halo damar" });
    assert.equal(out, "echo: halo damar");
});

test("tools/call multi-argumen dan angka", async t => {
    const client = await withClient(t);
    const out = await client.callTool("add", { a: 21, b: 21 });
    assert.equal(out, "42");
});

test("isError dari server melempar error dengan pesan teks", async t => {
    const client = await withClient(t);
    await assert.rejects(
        () => client.callTool("boom", {}),
        /kaboom dari server/
    );
});

test("bridge: nama mcp__{server}__{tool} + execute berfungsi", async t => {
    const client = await withClient(t);
    const tools = client.bridge();
    assert.equal(tools.length, 4);
    const echo = tools.find(t => t.name === "mcp__dummy__echo");
    assert.ok(echo, "tool echo harus terbridging");
    assert.equal(echo.bridged, undefined, "tool MCP TIDAK boleh ber-flag bridged (agar toolGuard berjalan penuh)");
    assert.equal(echo.description, "Balas argumen");
    assert.deepEqual(echo.parameters.properties.text, { type: "string" });
    const out = await echo.execute({ text: "via bridge" });
    assert.equal(out, "echo: via bridge");
});

test("allowedTools memfilter tool yang terlihat", async t => {
    const client = await withClient(t, { allowedTools: new Set(["echo", "add"]) });
    const tools = client.bridge();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, ["mcp__dummy__add", "mcp__dummy__echo"]);
});

test("tool tak dikenal di server → error terkirim ke pemanggil", async t => {
    const client = await withClient(t);
    await assert.rejects(
        () => client.callTool("tidak-ada", {}),
        /unknown tool/
    );
});

test("server crash: pending request ditolak, status tidak siap", async t => {
    const client = await withClient(t);
    client.proc.kill("SIGKILL");
    await new Promise(r => setTimeout(r, 300));
    assert.equal(client._ready, false);
});
