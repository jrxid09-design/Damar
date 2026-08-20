const { createMcpHandler } = require("./mcpHandler");
const { ToolRegistry } = require("../core/tools");
const { riskOf } = require("../core/safety/riskCatalog");
const { McpClient } = require("./mcpClient");

/**
 * Pasang endpoint MCP Aether pada aplikasi Express.
 *
 *   POST /mcp         — JSON-RPC 2.0 (initialize / tools/list / tools/call)
 *   GET  /mcp/health  — cek + jumlah tool yang terekspos
 *
 * Klien MCP (Claude Desktop, agen lain, penghuni koloni) memakai 140+
 * tool Aether lewat sini. Tool destruktif disembunyikan kecuali
 * AETHER_MCP_ALLOW_DESTRUCTIVE=1; eksekusi tetap lewat toolGuard.
 *
 * Aether juga bisa jadi KLIEN MCP (memakai server eksternal sebagai
 * tool) — lihat mcpClientManager; dimulai otomatis oleh
 * aiRuntimeService saat daemon boot.
 */
function attachMcp(app) {

    const handler = createMcpHandler({
        registry: {
            describe: () => ToolRegistry.describe(),
            has: (id) => ToolRegistry.has(id),
            execute: (id, args, ctx) => ToolRegistry.execute(id, args, ctx)
        },
        isDestructive: (id) => !!riskOf(id),
        allowDestructive: process.env.AETHER_MCP_ALLOW_DESTRUCTIVE === "1"
    });

    app.post("/mcp", async (req, res, next) => {
        try {
            const out = await handler.handle(req.body);
            if (out === null) return res.status(202).end();
            res.json(out);
        } catch (e) { next(e); }
    });

    app.get("/mcp/health", (req, res) => {
        res.json({ ok: true, server: "aether-mcp", tools: handler.visibleTools().length, destructive: process.env.AETHER_MCP_ALLOW_DESTRUCTIVE === "1" });
    });

    return handler;
}

module.exports = { attachMcp, McpClient };
