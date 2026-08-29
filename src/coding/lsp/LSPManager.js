const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { RpcConnection } = require("./jsonrpc");
const telemetry = require("../../services/telemetryService");

/**
 * LSPManager — mesin LSP internal Coding Brain (Fase 4).
 *
 * Bukan wrapper sekali-panggil: mengelola SIKLUS HIDUP language server
 * (spawn stdio + JSON-RPC), workspace per-proyek (dibuat otomatis saat
 * proyek dibuka), cache klien (multi-project), health check, auto-restart
 * saat server mati, deteksi kapabilitas server, dan FALLBACK anggun bila
 * server tak terpasang (kembalikan { available:false } — Damar lalu
 * memakai Serena/Tree-sitter).
 *
 * Urutan analisis Coding Brain: Graphify → Serena → LSP → Tree-sitter →
 * Planner → Execution Loop. LSP = defs/refs/hover/rename/diagnostics/
 * code-actions/symbols yang AKURAT secara semantik (mengungguli AST untuk
 * pertanyaan lintas-file).
 */

// Registry server: bin (nama shim), args stdio, dan ekstensi → languageId.
const SERVERS = {
    typescript: {
        bins: ["typescript-language-server"], args: ["--stdio"],
        ext: { ts: "typescript", tsx: "typescriptreact", mts: "typescript", cts: "typescript",
               js: "javascript", jsx: "javascriptreact", mjs: "javascript", cjs: "javascript" }
    },
    python: { bins: ["pyright-langserver"], args: ["--stdio"], ext: { py: "python", pyi: "python" } },
    json:   { bins: ["vscode-json-language-server"], args: ["--stdio"], ext: { json: "json", jsonc: "jsonc" } },
    css:    { bins: ["vscode-css-language-server"], args: ["--stdio"], ext: { css: "css", scss: "scss", less: "less" } },
    html:   { bins: ["vscode-html-language-server"], args: ["--stdio"], ext: { html: "html", htm: "html" } },
    markdown: { bins: ["vscode-markdown-language-server"], args: ["--stdio"], ext: { md: "markdown", markdown: "markdown" } },
    yaml:   { bins: ["yaml-language-server"], args: ["--stdio"], ext: { yaml: "yaml", yml: "yaml" } },
    bash:   { bins: ["bash-language-server"], args: ["start"], ext: { sh: "shellscript", bash: "shellscript" } },
    // PowerShell (opsional, P3): butuh PowerShell Editor Services terpisah.
    powershell: { bins: ["pwsh-lsp"], args: [], ext: { ps1: "powershell", psm1: "powershell" }, optional: true }
};

// Ekstensi → nama server.
const EXT_SERVER = {};
for (const [name, cfg] of Object.entries(SERVERS)) for (const e of Object.keys(cfg.ext)) EXT_SERVER[e] = name;

// Legend kandidat untuk semantic tokens (dipakai bila server minta di client caps).
const SEM_TYPES = ["namespace","type","class","enum","interface","struct","typeParameter","parameter",
    "variable","property","enumMember","event","function","method","macro","keyword","modifier","comment",
    "string","number","regexp","operator","decorator"];
const SEM_MODS = ["declaration","definition","readonly","static","deprecated","abstract","async",
    "modification","documentation","defaultLibrary"];

let _npmPrefix;
function npmPrefix() {
    if (_npmPrefix !== undefined) return _npmPrefix;
    // Windows: shim ada langsung di prefix; POSIX: di prefix/bin.
    _npmPrefix = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "/usr/local";
    return _npmPrefix;
}

function resolveBin(name) {
    const win = process.platform === "win32";
    const candidates = win
        ? [path.join(npmPrefix(), `${name}.cmd`), path.join(npmPrefix(), name)]
        : [path.join(npmPrefix(), "bin", name), path.join(npmPrefix(), name)];
    for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* lanjut */ } }
    return null; // tak ketemu → biarkan pemanggil fallback
}

/**
 * Cari tsserver.js valid untuk typescript-language-server: workspace-local
 * dulu (paling tepat versi), lalu global npm. TS 7 (tsgo) tak punya
 * tsserver.js → dilewati. Balikan null bila tak ada (biarkan tsls coba
 * resolusi sendiri).
 */
function resolveTsServer(project) {
    const cands = [
        path.join(project, "node_modules", "typescript", "lib", "tsserver.js"),
        path.join(npmPrefix(), "node_modules", "typescript", "lib", "tsserver.js"),
        path.join(npmPrefix(), "node_modules", "vscode-langservers-extracted", "node_modules", "typescript", "lib", "tsserver.js")
    ];
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* lanjut */ } }
    return null;
}

const uri = (file) => pathToFileURL(path.resolve(file)).href;

/**
 * Kunci dokumen kanonik untuk mencocokkan diagnostics lintas-sumber:
 * server bisa memakai URI berbeda-encoding (mis. pyright `file:///c%3A/…`
 * vs klien `file:///C:/…`). Normalkan ke path sistem + lowercase di Windows.
 */
function docKey(uriOrPath) {
    let p;
    try { p = String(uriOrPath).startsWith("file:") ? fileURLToPath(uriOrPath) : path.resolve(uriOrPath); }
    catch { p = String(uriOrPath); }
    p = path.normalize(p);
    return process.platform === "win32" ? p.toLowerCase() : p;
}

// ---- satu language server hidup untuk (proyek, bahasa) -----------------

class LangServer {
    constructor(server, project) {
        this.server = server;               // nama (typescript/python/…)
        this.cfg = SERVERS[server];
        this.project = path.resolve(project);
        this.proc = null;
        this.rpc = null;
        this.caps = null;                   // kapabilitas server (deteksi)
        this.open = new Map();              // uri → version
        this.diagnostics = new Map();       // uri → Diagnostic[]
        this.restarts = 0;
        this._starting = null;
    }

    alive() { return !!(this.proc && this.proc.exitCode === null && !this.proc.killed); }

    async ensure() {
        if (this.alive() && this.rpc) return this;
        if (this._starting) return this._starting;
        this._starting = this._start().finally(() => { this._starting = null; });
        return this._starting;
    }

    async _start() {
        const bin = resolveBin(this.cfg.bins[0]);
        if (!bin) throw new Error(`Language server tak terpasang: ${this.cfg.bins[0]}`);
        const proc = spawn(bin, this.cfg.args, {
            cwd: this.project, windowsHide: true, shell: process.platform === "win32",
            stdio: ["pipe", "pipe", "pipe"]
        });
        proc.stderr.on("data", () => { /* buang; sebagian server cerewet */ });
        proc.on("exit", (code) => {
            telemetry.info(`[coding/lsp] ${this.server} exit(${code})`);
            this.caps = null; this.open.clear();
        });
        this.proc = proc;
        this.rpc = new RpcConnection(proc);
        this.rpc.on("notification", (method, params) => this._onNotify(method, params));

        const res = await this.rpc.request("initialize", {
            processId: process.pid,
            rootUri: uri(this.project),
            workspaceFolders: [{ uri: uri(this.project), name: path.basename(this.project) }],
            capabilities: {
                workspace: { workspaceFolders: true, configuration: true, symbol: { symbolKind: { valueSet: null } },
                    applyEdit: false, didChangeWatchedFiles: { dynamicRegistration: true } },
                textDocument: {
                    synchronization: { didSave: true, dynamicRegistration: false },
                    definition: { linkSupport: false }, references: {}, implementation: {}, typeDefinition: {},
                    hover: { contentFormat: ["markdown", "plaintext"] },
                    rename: { prepareSupport: true },
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix","refactor","refactor.extract","refactor.inline","refactor.rewrite","source"] } } },
                    publishDiagnostics: { relatedInformation: true },
                    completion: { completionItem: { snippetSupport: false } },
                    semanticTokens: { requests: { full: true }, tokenTypes: SEM_TYPES, tokenModifiers: SEM_MODS, formats: ["relative"] }
                }
            },
            initializationOptions: this._initOptions()
        }, { timeout: 45000 });

        this.caps = res?.capabilities || {};
        this.rpc.notify("initialized", {});
        telemetry.info(`[coding/lsp] ${this.server} siap @ ${this.project}`);
        return this;
    }

    /** initializationOptions khusus server (mis. tsserver.path utk TS). */
    _initOptions() {
        if (this.server === "typescript") {
            const tsserver = resolveTsServer(this.project);
            if (tsserver) return { tsserver: { path: tsserver } };
        }
        return {};
    }

    _onNotify(method, params) {
        if (method === "textDocument/publishDiagnostics" && params?.uri) {
            this.diagnostics.set(docKey(params.uri), params.diagnostics || []);
        }
    }

    _langId(file) {
        const ext = file.split(".").pop().toLowerCase();
        return this.cfg.ext[ext] || Object.values(this.cfg.ext)[0];
    }

    async openDoc(file) {
        await this.ensure();
        const u = uri(file);
        if (this.open.has(u)) return u;
        const text = fs.readFileSync(file, "utf8");
        this.rpc.notify("textDocument/didOpen", {
            textDocument: { uri: u, languageId: this._langId(file), version: 1, text }
        });
        this.open.set(u, 1);
        await new Promise(r => setTimeout(r, 350)); // beri server waktu indeks awal
        return u;
    }

    // ---- operasi LSP (posisi 0-based line/character) -----------------

    async definition(file, line, character) {
        const u = await this.openDoc(file);
        return this.rpc.request("textDocument/definition", { textDocument: { uri: u }, position: { line, character } });
    }
    async references(file, line, character, includeDeclaration = true) {
        const u = await this.openDoc(file);
        return this.rpc.request("textDocument/references", {
            textDocument: { uri: u }, position: { line, character }, context: { includeDeclaration }
        });
    }
    async hover(file, line, character) {
        const u = await this.openDoc(file);
        return this.rpc.request("textDocument/hover", { textDocument: { uri: u }, position: { line, character } });
    }
    async rename(file, line, character, newName) {
        const u = await this.openDoc(file);
        return this.rpc.request("textDocument/rename", { textDocument: { uri: u }, position: { line, character }, newName });
    }
    async documentSymbols(file) {
        const u = await this.openDoc(file);
        return this.rpc.request("textDocument/documentSymbol", { textDocument: { uri: u } });
    }
    async workspaceSymbols(query) {
        await this.ensure();
        return this.rpc.request("workspace/symbol", { query });
    }
    async codeActions(file, range, diagnostics = []) {
        const u = await this.openDoc(file);
        return this.rpc.request("textDocument/codeAction", {
            textDocument: { uri: u }, range, context: { diagnostics }
        });
    }
    async completion(file, line, character) {
        const u = await this.openDoc(file);
        return this.rpc.request("textDocument/completion", { textDocument: { uri: u }, position: { line, character } });
    }
    async semanticTokens(file) {
        if (!this.caps?.semanticTokensProvider) return { available: false, note: "server tak dukung semantic tokens" };
        const u = await this.openDoc(file);
        const legend = this.caps.semanticTokensProvider.legend || null;
        const data = await this.rpc.request("textDocument/semanticTokens/full", { textDocument: { uri: u } });
        return { available: true, legend, data: data?.data || [] };
    }

    /**
     * Diagnostics: server mem-publish berlapis (sering kosong dulu saat
     * masih menganalisis). Kembalikan segera bila ADA temuan; jika tidak,
     * tunggu sampai waitMs lalu balikan hasil terakhir (kosong = file bersih).
     */
    async getDiagnostics(file, { waitMs = 4000 } = {}) {
        await this.openDoc(file);
        const k = docKey(file);
        const t0 = Date.now();
        let last = this.diagnostics.get(k);
        while (Date.now() - t0 < waitMs) {
            const cur = this.diagnostics.get(k);
            if (cur && cur.length) return cur;              // temuan nyata → cukup
            if (cur) last = cur;
            await new Promise(r => setTimeout(r, 150));
        }
        return last || [];
    }

    async shutdown() {
        try { if (this.rpc) { await this.rpc.request("shutdown", null, { timeout: 3000 }).catch(() => {}); this.rpc.notify("exit"); } }
        catch { /* abaikan */ }
        try { this.rpc?.dispose(); this.proc?.kill(); } catch { /* abaikan */ }
    }
}

// ---- manager: cache multi-project + lifecycle --------------------------

class LSPManager {
    constructor() { this._clients = new Map(); } // key `${server}::${project}` → LangServer

    /** Nama server untuk sebuah file (via ekstensi). */
    serverFor(file) { return EXT_SERVER[String(file).split(".").pop().toLowerCase()] || null; }

    /** Apakah language server untuk file/bahasa ini TERPASANG (capability detection dasar). */
    available(fileOrServer) {
        const server = SERVERS[fileOrServer] ? fileOrServer : this.serverFor(fileOrServer);
        if (!server || SERVERS[server]?.optional && !resolveBin(SERVERS[server].bins[0])) return false;
        return !!(server && resolveBin(SERVERS[server].bins[0]));
    }

    /** Peta bahasa → terpasang? (untuk introspeksi/UI). */
    installed() {
        const out = {};
        for (const name of Object.keys(SERVERS)) out[name] = !!resolveBin(SERVERS[name].bins[0]);
        return out;
    }

    /** Get-or-spawn klien untuk (bahasa file, proyek) — workspace otomatis. */
    async client(file, project = process.cwd()) {
        const server = this.serverFor(file);
        if (!server) throw new Error(`Tak ada language server untuk: ${file}`);
        if (!this.available(server)) throw new Error(`Language server '${server}' belum terpasang.`);
        const key = `${server}::${path.resolve(project)}`;
        let c = this._clients.get(key);
        if (!c) { c = new LangServer(server, project); this._clients.set(key, c); }
        // Auto-restart bila mati (batasi agar tak loop tak henti).
        if (!c.alive() && c.restarts < 3 && c._starting == null && c.proc) { c.restarts++; }
        await c.ensure();
        return c;
    }

    /** Health check semua klien aktif. */
    health() {
        const out = [];
        for (const [key, c] of this._clients) out.push({ key, alive: c.alive(), restarts: c.restarts, caps: !!c.caps, openDocs: c.open.size });
        return out;
    }

    async restart(file, project = process.cwd()) {
        const key = `${this.serverFor(file)}::${path.resolve(project)}`;
        const c = this._clients.get(key);
        if (c) await c.shutdown();
        this._clients.delete(key);
        return this.client(file, project);
    }

    async shutdownAll() {
        for (const c of this._clients.values()) await c.shutdown();
        this._clients.clear();
    }

    /**
     * Fasad ringkas + FALLBACK: jalankan operasi LSP, atau kembalikan
     * { available:false, note } bila server tak terpasang — pemanggil lalu
     * memakai Tree-sitter/Serena. Semua posisi 0-based.
     */
    async op(name, file, args = [], { project = process.cwd() } = {}) {
        if (!this.available(file)) return { available: false, note: `LSP untuk ${path.basename(file)} tak tersedia — pakai Tree-sitter/Serena.` };
        try {
            const c = await this.client(file, project);
            const result = await c[name](file, ...args);
            return { available: true, result };
        } catch (e) {
            return { available: true, ok: false, error: e.message };
        }
    }
}

module.exports = new LSPManager();
module.exports.SERVERS = SERVERS;
