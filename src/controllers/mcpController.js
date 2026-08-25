const response = require("../utils/response");

const configStore = require("../mcp/configStore");
const mcpClientManager = require("../mcp/mcpClientManager");

/**
 * McpController — kelola MCP langsung dari Console:
 *
 *   - SERVER  : tool Aether (140+) diekspos ke klien mana pun — status,
 *               jumlah tool terlihat, flag destruktif.
 *   - CLIENT  : server MCP eksternal dijadikan tool (CRUD + restart).
 *
 * Panel pengganti integrasi lama: setup MCP.
 */
class McpController {

    /** GET /mcp/servers — konfigurasi + status runtime + info server. */
    list(req, res, next) {

        try {

            const { riskOf } = require("../core/safety/riskCatalog");
            const { ToolRegistry } = require("../core/tools");

            const allowDestructive =
                process.env.AETHER_MCP_ALLOW_DESTRUCTIVE === "1";

            const allTools = ToolRegistry.describe();
            const visible = allTools.filter(t => allowDestructive || !riskOf(t.id));

            const configured = configStore.read();

            const servers = configured.map(cfg => {
                const client = mcpClientManager.clients.get(cfg.id);
                return {
                    ...cfg,
                    online: Boolean(client?._ready),
                    tools: client ? client._tools.length : 0,
                    lastError: client?.lastError ?? null
                };
            });

            return response.success(res, "MCP", {
                server: {
                    name: "aether",
                    exposed: visible.length,
                    total: allTools.length,
                    destructiveHidden: !allowDestructive
                },
                clients: {
                    running: mcpClientManager.clients.size,
                    bridged: mcpClientManager.bridgeTools().length
                },
                servers
            });

        }
        catch (error) {
            next(error);
        }

    }

    /** POST /mcp/servers — tambah/perbarui satu server klien + restart. */
    async save(req, res, next) {

        try {

            const entry = configStore.normalize(req.body ?? {});

            configStore.upsert(entry);

            await this._restartAndRefresh();

            return response.success(res, "Server MCP disimpan", entry, 201);

        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    /** DELETE /mcp/servers/:id — hapus + restart. */
    async remove(req, res, next) {

        try {

            const ok = configStore.remove(req.params.id);

            if (!ok) {
                return response.error(res, "Server tidak ditemukan.", 404);
            }

            await this._restartAndRefresh();

            return response.success(res, "Server MCP dihapus", { id: req.params.id });

        }
        catch (error) {
            next(error);
        }

    }

    /** POST /mcp/restart — nyalakan ulang semua klien + re-bridge tool. */
    async restart(req, res, next) {

        try {

            const tools = await this._restartAndRefresh();

            return response.success(res, "MCP direstart", { bridged: tools.length });

        }
        catch (error) {
            next(error);
        }

    }

    async _restartAndRefresh() {

        await mcpClientManager.restart();

        // Re-bridge: tool MCP baru masuk registry AI tanpa restart daemon.
        try { require("../services/aiRuntimeService").refreshTools(); }
        catch { /* registry belum siap */ }

        return mcpClientManager.bridgeTools();

    }

}

module.exports = new McpController();
