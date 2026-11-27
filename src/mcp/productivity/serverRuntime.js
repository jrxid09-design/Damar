"use strict";

const readline = require("node:readline");

/**
 * serverRuntime — runtime server MCP stdio minimal untuk suite
 * produktivitas Damar.
 *
 * Setiap server suite adalah proses Node terpisah yang diawasi
 * McpClientManager Damar lewat configs/mcp.json (transport stdio,
 * JSON-RPC 2.0 newline-delimited — protokol yang sama dengan
 * McpClient di src/mcp/mcpClient.js). Runtime ini menangani
 * initialize / ping / tools/list / tools/call; logika tool hidup di
 * modul server masing-masing (servers/*.js) agar dapat diuji tanpa
 * proses.
 *
 * Hasil tool dikemas sebagai konten teks MCP. Error dilempar sebagai
 * ToolError (atau Error biasa) → isError:true, pesan saja — tidak ada
 * stack, tidak ada nilai rahasia (pemanggil wajib menjaga pesannya).
 */

const PROTOCOL_VERSION = "2024-11-05";

class ToolError extends Error {
    constructor(message, code = "TOOL_ERROR") {
        super(message);
        this.name = "ToolError";
        this.code = code;
    }
}

/** Error standar: server belum terhubung (belum login / token absen). */
function notConnected(serverId) {
    return new ToolError(
        `Server '${serverId}' belum terhubung. Buka Control Dashboard → Produktivitas untuk connect/login.`,
        "NOT_CONNECTED"
    );
}

function stringifyResult(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/**
 * Buat definisi server dari modul suite.
 * @param {{ name: string, version?: string,
 *           tools: Array<{name, description, inputSchema}>,
 *           callTool: (name: string, args: object) => Promise<any>,
 *           health?: () => Promise<object> }} def
 */
function createServerDefinition(def) {
    if (!def?.name || !Array.isArray(def.tools) || typeof def.callTool !== "function") {
        throw new Error("createServerDefinition butuh { name, tools[], callTool }.");
    }
    return Object.freeze({
        name: def.name,
        version: def.version || "1.0.0",
        tools: def.tools,
        callTool: def.callTool,
        health: def.health || (async () => ({ ok: true }))
    });
}

/** Tangani satu pesan JSON-RPC (murni — dapat diuji tanpa stdio). */
async function handleMessage(server, msg) {
    if (!msg || msg.jsonrpc !== "2.0") {
        return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    }
    const { id = null, method, params } = msg;
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

    switch (method) {
        case "initialize":
            return ok({
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: server.name, version: server.version }
            });
        case "notifications/initialized":
        case "notifications/cancelled":
            return null;
        case "ping":
            return ok({});
        case "tools/list":
            return ok({
                tools: server.tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema || { type: "object", properties: {} }
                }))
            });
        case "tools/call": {
            const name = params?.name;
            const args = params?.arguments ?? {};
            if (!name || !server.tools.some(t => t.name === name)) {
                return err(-32602, `Tool tidak dikenal: ${name}`);
            }
            try {
                const result = await server.callTool(name, args);
                return ok({ content: [{ type: "text", text: stringifyResult(result) }] });
            } catch (e) {
                return ok({
                    content: [{ type: "text", text: `ERROR${e?.code ? ` [${e.code}]` : ""}: ${e?.message || String(e)}` }],
                    isError: true
                });
            }
        }
        default:
            return err(-32601, `Method not found: ${method}`);
    }
}

/** Jalankan server di stdio proses ini (dipakai entry script). */
function runStdioServer(server, { input = process.stdin, output = process.stdout } = {}) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on("line", async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
            return;
        }
        const out = await handleMessage(server, msg);
        if (out !== null) output.write(JSON.stringify(out) + "\n");
    });
    return rl;
}

module.exports = {
    PROTOCOL_VERSION,
    ToolError,
    notConnected,
    createServerDefinition,
    handleMessage,
    runStdioServer,
    stringifyResult
};
