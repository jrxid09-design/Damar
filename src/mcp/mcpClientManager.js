const path = require("node:path");
const fs = require("node:fs");
const { McpClient } = require("./mcpClient");
const JsonStore = require("../core/config/JsonStore");

/**
 * McpClientManager — pemilik seluruh koneksi MCP klien Aether.
 *
 * Membaca configs/mcp.json (atau AETHER_MCP_SERVERS dari env sebagai
 * JSON inline), menyalakan tiap server, melakukan handshake, lalu
 * mengekspos seluruh tool eksternal sebagai AITool terbridging.
 *
 * Dipakai oleh aiRuntimeService.initialize()/refreshTools():
 *
 *   builder.registerTools(mcpManager.bridgeTools());
 *
 * Tool eksternal TIDAK didaftarkan ke registry inti (ToolRegistry)
 * — mereka hidup di registry AI dengan flag `bridged`, sehingga
 * ToolExecutor menjalankan toolGuard untuk mereka persis seperti
 * tool asli Aether (memori, terminal, coding): kill switch, kebijakan
 * risiko, rem kebuntuan, batas jalur, audit.
 *
 * Kegagalan satu server tidak menjatuhkan yang lain: masing-masing
 * start() ditangkap sendiri, dan daftar tool yang gagal kosong.
 */
class McpClientManager {

    constructor({ configFile = null } = {}) {

        this.configFile = configFile
            || process.env.AETHER_MCP_CONFIG
            || path.join(process.cwd(), "configs", "mcp.json");

        this.clients = new Map();     // id -> McpClient
        this._bridgedTools = [];      // AITool-like terbridging
        this._started = false;
    }

    /**
     * Konfigurasi server eksternal.
     *
     * Urutan sumber: berkas configs/mcp.json → env AETHER_MCP_SERVERS
     * (JSON inline). Keduanya bisa hadir; berkas menang.
     */
    _config() {

        const read = (file) => {
            try {
                if (!fs.existsSync(file)) return null;
                const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
                return Array.isArray(parsed?.servers) ? parsed.servers : null;
            }
            catch {
                return null;   // config rusak: perlakukan sebagai kosong
            }
        };

        let servers = read(this.configFile);

        if (!servers && process.env.AETHER_MCP_SERVERS) {
            try {
                const parsed = JSON.parse(process.env.AETHER_MCP_SERVERS);
                servers = Array.isArray(parsed) ? parsed : (parsed?.servers ?? null);
            }
            catch {
                servers = null;
            }
        }

        return servers || [];
    }

    /**
     * Nyalakan semua server yang terkonfigurasi dan kumpulkan toolnya.
     * Aman dipanggil berkali-kali.
     */
    async start() {

        if (this._started) return this._bridgedTools;
        this._started = true;

        const servers = this._config();

        for (const cfg of servers) {

            if (!cfg?.id || !cfg?.command) continue;

            try {

                const client = new McpClient({
                    id: cfg.id,
                    command: cfg.command,
                    args: cfg.args,
                    env: cfg.env,
                    cwd: cfg.cwd,
                    allowedTools: Array.isArray(cfg.allowedTools)
                        ? new Set(cfg.allowedTools)
                        : null
                });

                await client.start();
                this.clients.set(cfg.id, client);

            }
            catch (error) {
                // Server yang gagal tidak boleh menjatuhkan daemon.
                const telemetry = require("../services/telemetryService");
                telemetry?.warn?.(`[mcp] server '${cfg.id}' gagal: ${error.message}`);
            }

        }

        this._bridgedTools = this._bridgeAll();
        return this._bridgedTools;

    }

    /** Bridge tool dari SEMUA server jadi satu daftar. */
    _bridgeAll() {

        const out = [];

        for (const client of this.clients.values()) {
            try {
                out.push(...client.bridge());
            }
            catch { /* server tanpa tool: lewati */ }
        }

        return out;
    }

    /** Daftar AITool terbridging untuk registerTools(). */
    bridgeTools() {
        return this._bridgedTools;
    }

    /** Status semua server (diagnostik / endpoint health). */
    status() {
        return {
            servers: [...this.clients.values()].map(c => c.status()),
            bridgedTools: this._bridgedTools.length
        };
    }

    /**
     * Matikan semua dan bersihkan. restart() = stop() + start().
     */
    async stop() {
        for (const client of this.clients.values()) {
            try { await client.stop(); } catch { /* */ }
        }
        this.clients.clear();
        this._bridgedTools = [];
        this._started = false;
    }

    async restart() {
        await this.stop();
        return this.start();
    }

}

module.exports = new McpClientManager();
