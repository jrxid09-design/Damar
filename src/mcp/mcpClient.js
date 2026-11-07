const { spawn } = require("node:child_process");

/**
 * McpClient — Damar sebagai KLIEN MCP (Model Context Protocol).
 *
 * Lawan dari mcpHandler (Damar sebagai server): di sini Damar
 * memanggil server MCP eksternal — Claude Desktop, agen lain,
 * alat pihak ketiga — dan mengekspos tool mereka ke model Damar
 * seolah itu tool native.
 *
 * Transport: stdio (newline-delimited JSON-RPC 2.0), sama seperti
 * klien MCP pada umumnya. Tiap pesan satu baris JSON; balasan
 * tiba baris-per-baris di stdout.
 *
 *   spawn child ── initialize ── tools/list ── bridge AITool[]
 *
 * Tool eksternal dijembatani sebagai AITool dengan nama
 * `mcp__{serverId}__{toolName}` (konvensi `__` agar kompatibel
 * dengan ToolExecutor dan riskCatalog). Flag `bridged` mengarah
 * ke id server+tool; ToolExecutor melewati toolGuard untuknya
 * karena tool eksternal tak terdaftar di registry inti.
 *
 * Tool destruktif (menurut riskCatalog) tetap dipajang ke model
 * — penjagaan ada di toolGuard saat eksekusi, bukan di pendaftaran.
 */
class McpClient {

    constructor({ id, command, args = [], env = {}, cwd, allowedTools = null } = {}) {

        if (!id) throw new Error("McpClient butuh id server.");
        if (!command) throw new Error(`McpClient '${id}' butuh command.`);

        this.id = id;
        this.command = command;
        this.args = Array.isArray(args) ? args : [];
        this.env = env || {};
        this.cwd = cwd || null;
        this.allowedTools = allowedTools;   // null = semua; atau Set<string>

        this.proc = null;
        this._id = 0;
        this._pending = new Map();
        this._buf = "";
        this._tools = [];            // [{ name, description, inputSchema }]
        this._serverInfo = null;
        this._ready = false;
        this._started = false;
    }

    /** Id unik untuk request JSON-RPC berikutnya. */
    _nextId() { return ++this._id; }

    /** Nama tool terbridging: mcp__{serverId}__{toolName}. */
    _bridgedName(rawName) {
        return `mcp__${this.id}__${rawName}`;
    }

    /** Id asli untuk dikirim ke server (dari nama bridge). */
    _rawName(bridgedName) {
        const prefix = `mcp__${this.id}__`;
        return bridgedName.startsWith(prefix)
            ? bridgedName.slice(prefix.length)
            : bridgedName;
    }

    /** Apakah tool ini diizinkan oleh allowlist (bila ada). */
    _isAllowed(rawName) {
        if (!this.allowedTools) return true;
        return this.allowedTools.has(rawName);
    }

    /**
     * Mulai child, handshake, dan ambil daftar tool. Aman dipanggil
     * berkali-kali: bila sudah siap, kembalikan yang sudah ada.
     */
    async start({ timeout = 15000 } = {}) {

        if (this._ready) return this._tools;
        if (this._started) {
            // sudah memulai tapi belum siap — tunggu init yang berjalan.
            return this._initPromise || [];
        }
        this._started = true;

        this._initPromise = (async () => {

            this.proc = spawn(this.command, this.args, {
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, ...this.env },
                ...(this.cwd ? { cwd: this.cwd } : {})
            });

            this.proc.stdout.setEncoding("utf8");
            this.proc.stderr?.setEncoding?.("utf8");

            this.proc.stdout.on("data", chunk => this._onData(chunk));
            this.proc.on("exit", (code, signal) => {
                // G: server mati = TIDAK siap. Dulu hanya pending yang
                // dibatalkan; flag _ready tetap true (readiness basi).
                this._ready = false;
                this._failAll(
                    new Error(`MCP server '${this.id}' exit (code=${code} signal=${signal})`)
                );
            });
            this.proc.stderr?.on("data", () => { /* log ops, bukan protokol */ });

            // 1. initialize
            const init = await this._request("initialize", {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "damar", version: "2.0.0" }
            }, { timeout });

            this._serverInfo = init?.serverInfo ?? null;

            // 2. notifications/initialized (satu arah, tanpa balasan)
            this._notify("notifications/initialized", {});

            // 3. tools/list
            const list = await this._request("tools/list", {}, { timeout });
            const tools = Array.isArray(list?.tools) ? list.tools : [];

            this._tools = tools
                .filter(t => t && typeof t.name === "string")
                .filter(t => this._isAllowed(t.name));

            this._ready = true;
            return this._tools;

        })();

        return this._initPromise;

    }

    /**
     * Panggil sebuah tool di server. name = nama asli (bukan bridge).
     */
    async callTool(name, args = {}, { timeout = 60000 } = {}) {

        if (!this._ready) {
            await this.start();
        }

        const res = await this._request("tools/call", {
            name,
            arguments: args
        }, { timeout });

        // Hasil MCP: { content: [{ type, text }], isError }
        const content = Array.isArray(res?.content) ? res.content : [];
        const text = content
            .map(c => (c?.type === "text" ? c.text : "") || "")
            .join("\n")
            .trim();

        if (res?.isError) {
            const err = new Error(text || `MCP tool '${name}' error`);
            err.mcp = { server: this.id, tool: name };
            throw err;
        }

        return text || res;
    }

    /** Bridge tool eksternal menjadi daftar AITool (siap didaftarkan). */
    bridge() {

        return this._tools.map(t => {

            const bridged = this._bridgedName(t.name);
            const client = this;

            // Metadata eksternal = INPUT TIDAK TERPERCAYA (invariant D).
            // Deskripsi dibatasi ketat sebelum menyentuh index/prompt;
            // provenance (source/provider) selalu ditentukan INTERNAL.
            const rawDesc = String(t.description ?? "").slice(0, 300);

            const tool = {
                name: bridged,
                description: rawDesc || `MCP tool ${t.name} dari server ${this.id}`,
                parameters: t.inputSchema && typeof t.inputSchema === "object"
                    ? t.inputSchema
                    : { type: "object", properties: {} },
                // Metadata first-class: pipeline seleksi membaca ini —
                // tool MCP masuk discovery/ranking yang sama dengan
                // tool native, tetap bertanda eksternal (penalti kecil
                // saat ambigu, preferensi milik sendiri).
                meta: {
                    source: "mcp",
                    provider: this.id,
                    external: true
                },
                async execute(args) {
                    const raw = client._rawName(bridged);
                    return client.callTool(raw, args || {});
                }
                // TIDAK ada flag `bridged` di sini. Flag itu memberi tahu
                // ToolExecutor "sudah dijaga registry inti" — benar untuk
                // tool plugin Damar, SALAH untuk tool MCP: mereka tak
                // terdaftar di registry inti mana pun. Tanpa flag,
                // toolGuard (kill switch, kebijakan risiko, rem kebuntuan,
                // batas jalur, audit) berjalan penuh untuk tool eksternal.
            };

            return tool;
        });

    }

    /** Status singkat untuk diagnostik. */
    status() {
        return {
            id: this.id,
            ready: this._ready,
            tools: this._tools.map(t => t.name),
            server: this._serverInfo
        };
    }

    /**
     * Kirim request JSON-RPC dan tunggu balasan (newline-delimited).
     * id di-korelasikan: tiap baris balasan yang membawa id yang sama
     * menyelesaikan promise-nya.
     */
    _request(method, params = {}, { timeout = 30000 } = {}) {

        const id = this._nextId();

        return new Promise((resolve, reject) => {

            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`MCP timeout: ${method} (server=${this.id})`));
            }, timeout);

            this._pending.set(id, { resolve, reject, timer });

            this._write({ jsonrpc: "2.0", id, method, params });

        });

    }

    _notify(method, params = {}) {
        this._write({ jsonrpc: "2.0", method, params });
    }

    _write(msg) {
        if (!this.proc || !this.proc.stdin.writable) {
            throw new Error(`MCP server '${this.id}' tak dapat ditulisi (proses mati?).`);
        }
        this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }

    _onData(chunk) {
        this._buf += chunk;
        let i;
        while ((i = this._buf.indexOf("\n")) >= 0) {
            const line = this._buf.slice(0, i).trim();
            this._buf = this._buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); }
            catch { continue; }   // baris non-JSON diabaikan
            this._dispatch(msg);
        }
    }

    _dispatch(msg) {

        // Balasan atas request kita.
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
            const p = this._pending.get(msg.id);
            if (!p) return;
            this._pending.delete(msg.id);
            clearTimeout(p.timer);
            return msg.error
                ? p.reject(Object.assign(new Error(msg.error.message || "MCP error"), { mcp: msg.error }))
                : p.resolve(msg.result);
        }

        // Notifikasi dari server (tanpa id): diabaikan untuk sekarang.
        // MCP 2024-11-05 tak mengirim notifikasi server→klien yang butuh
        // balasan; kalau nanti ada (resources/updated), tangani di sini.
    }

    _failAll(err) {
        for (const { reject, timer } of this._pending.values()) {
            clearTimeout(timer);
            reject(err);
        }
        this._pending.clear();
    }

    /**
     * Hentikan child process.
     *
     * G: proses yang SUDAH mati tidak akan pernah memancarkan "exit"
     * lagi — menunggu event itu membuat teardown menggantung selamanya
     * (test suite macet ~168s). Cek exitCode/signalCode dulu; bila
     * masih hidup baru SIGTERM → tunggu → SIGKILL.
     */
    async stop() {
        this._ready = false;
        this._started = false;
        this._failAll(new Error(`MCP server '${this.id}' dihentikan.`));
        if (this.proc) {
            const proc = this.proc;
            try { proc.stdin?.end?.(); } catch { /* */ }

            if (proc.exitCode === null && proc.signalCode === null) {
                try { proc.kill("SIGTERM"); } catch { /* */ }
                const force = setTimeout(() => {
                    try { proc.kill("SIGKILL"); } catch { /* */ }
                }, 2000);
                await new Promise(r =>
                    proc.once("exit", () => { clearTimeout(force); r(); }));
            }
        }
        this.proc = null;
    }

}

module.exports = { McpClient };
