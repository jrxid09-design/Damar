const { createMcpHandler } = require("./mcpHandler");
const { ToolRegistry } = require("../core/tools");
const { riskOf } = require("../core/safety/riskCatalog");
const { clampExternalRole } = require("../core/auth/tokenCompare");
const { McpClient } = require("./mcpClient");
const { rejectLegacyActionRoute } = require("../manager/legacyBoundary");

/**
 * Pasang endpoint MCP Damar pada aplikasi Express.
 *
 *   POST /mcp         — JSON-RPC 2.0 (initialize / tools/list / tools/call)
 *   GET  /mcp/health  — cek + jumlah tool yang terekspos
 *
 * Klien MCP (Claude Desktop, agen lain, penghuni koloni) memakai 140+
 * tool Damar lewat sini. Tool destruktif disembunyikan kecuali
 * DAMAR_MCP_ALLOW_DESTRUCTIVE=1; eksekusi tetap lewat toolGuard.
 *
 * Damar juga bisa jadi KLIEN MCP (memakai server eksternal sebagai
 * tool) — lihat mcpClientManager; dimulai otomatis oleh
 * aiRuntimeService saat daemon boot.
 */
function attachMcp(app) {

    const handler = createMcpHandler({
        registry: {
            describe: () => ToolRegistry.describe(),
            has: (id) => ToolRegistry.has(id),
            execute: (id, args, ctx) => {
                // The legacy MCP tools/call contract accepts an arbitrary
                // registry id and bypasses Manager → Lane 2 → Lane 3.
                // Keep discovery available, but fail before authorization or
                // registry execution until a trusted Manager adapter exists.
                rejectLegacyActionRoute("MCP tool");
            }
        },
        isDestructive: (id) => !!riskOf(id),
        allowDestructive: process.env.DAMAR_MCP_ALLOW_DESTRUCTIVE === "1"
    });

    // Guard fail-closed + identitas berprovenance (C2); permukaan MCP
    // eksternal = hak minimum ('user') kecuali ditinggikan eksplisit.
    // G-FINAL: DAMAR_MCP_ROLE dikunci enum eksternal — tidak bisa
    // mencetak "system" di permukaan token.
    const guard = require("../core/auth/tokenCompare")
        .tokenGuard({
            roleWhenAuthenticated:
                clampExternalRole(process.env.DAMAR_MCP_ROLE, "user"),
            surface: "mcp"
        });

    // Teruskan identitas auth ke handler (ctx.exec untuk execute).
    app.use("/mcp", (req, _res, next) => {
        req.mcpExec = {
            role: req.authIdentity?.role ?? "user",
            channel: "mcp",
            sessionId: req.authIdentity?.sessionId ?? "mcp:anon",
            source: "mcp"
        };
        next();
    });

    app.post("/mcp", guard, async (req, res, next) => {
        try {
            const out = await handler.handle(req.body, { exec: req.mcpExec });
            if (out === null) return res.status(202).end();
            res.json(out);
        } catch (e) { next(e); }
    });

    app.get("/mcp/health", guard, (req, res) => {
        // H9: jumlah tool kini identitas-spesifik (paritas disklosur).
        res.json({ ok: true, server: "damar-mcp", tools: handler.visibleTools(req.mcpExec).length, destructive: process.env.DAMAR_MCP_ALLOW_DESTRUCTIVE === "1" });
    });

    return handler;
}

module.exports = { attachMcp, McpClient };
