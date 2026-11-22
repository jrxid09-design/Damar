const { EventEmitter } = require("node:events");

/**
 * RpcConnection — codec JSON-RPC 2.0 di atas stdio sebuah language server
 * (LSP base protocol: header `Content-Length` + body JSON UTF-8).
 *
 * Bukan sekadar wrapper: menangani framing dua-arah, korelasi id untuk
 * request klien, DAN membalas request server→klien (configuration/
 * registerCapability/progress) dengan default aman supaya server tak
 * menggantung. Emit 'notification' untuk pesan tanpa id (mis. diagnostics).
 */
class RpcConnection extends EventEmitter {

    constructor(proc) {
        super();
        this.proc = proc;
        this._id = 0;
        this._pending = new Map();
        this._buf = Buffer.alloc(0);
        this._contentLen = -1;
        this._disposed = false;

        proc.stdout.on("data", (chunk) => this._onData(chunk));
        proc.on("exit", () => this._failAll(new Error("language server exit")));
    }

    // ---- kirim -------------------------------------------------------

    _send(msg) {
        if (this._disposed || !this.proc.stdin.writable) return;
        const json = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
        this.proc.stdin.write(`Content-Length: ${json.length}\r\n\r\n`);
        this.proc.stdin.write(json);
    }

    request(method, params, { timeout = 30000 } = {}) {
        const id = ++this._id;
        this._send({ id, method, params });
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`LSP timeout: ${method}`));
            }, timeout);
            this._pending.set(id, { resolve, reject, t });
        });
    }

    notify(method, params) { this._send({ method, params }); }

    respond(id, result, error) {
        this._send(error ? { id, error } : { id, result: result ?? null });
    }

    // ---- terima ------------------------------------------------------

    _onData(chunk) {
        this._buf = Buffer.concat([this._buf, chunk]);
        for (;;) {
            if (this._contentLen < 0) {
                const sep = this._buf.indexOf("\r\n\r\n");
                if (sep < 0) return;
                const header = this._buf.slice(0, sep).toString("ascii");
                const m = /content-length:\s*(\d+)/i.exec(header);
                this._contentLen = m ? Number(m[1]) : 0;
                this._buf = this._buf.slice(sep + 4);
            }
            if (this._buf.length < this._contentLen) return;
            const body = this._buf.slice(0, this._contentLen).toString("utf8");
            this._buf = this._buf.slice(this._contentLen);
            this._contentLen = -1;
            let msg; try { msg = JSON.parse(body); } catch { continue; }
            this._dispatch(msg);
        }
    }

    _dispatch(msg) {
        // Balasan atas request klien.
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
            const p = this._pending.get(msg.id);
            if (!p) return;
            this._pending.delete(msg.id);
            clearTimeout(p.t);
            return msg.error ? p.reject(Object.assign(new Error(msg.error.message || "LSP error"), { data: msg.error })) : p.resolve(msg.result);
        }
        // Request server→klien: balas default aman agar tak menggantung.
        if (msg.id !== undefined && msg.method) {
            return this.respond(msg.id, this._serverRequestDefault(msg.method, msg.params));
        }
        // Notifikasi (tanpa id).
        if (msg.method) this.emit("notification", msg.method, msg.params);
    }

    _serverRequestDefault(method, params) {
        switch (method) {
            case "workspace/configuration":
                return (params?.items || [null]).map(() => null);   // pakai default server
            case "workspace/applyEdit":
                return { applied: false };                          // edit dikelola patcher, bukan LSP
            case "client/registerCapability":
            case "client/unregisterCapability":
            case "window/workDoneProgress/create":
            case "workspace/semanticTokens/refresh":
            case "workspace/diagnostic/refresh":
            case "workspace/codeLens/refresh":
            case "workspace/inlayHint/refresh":
            case "window/showMessageRequest":
            default:
                return null;
        }
    }

    _failAll(err) {
        for (const { reject, t } of this._pending.values()) { clearTimeout(t); reject(err); }
        this._pending.clear();
    }

    dispose() {
        this._disposed = true;
        this._failAll(new Error("connection disposed"));
    }
}

module.exports = { RpcConnection };
