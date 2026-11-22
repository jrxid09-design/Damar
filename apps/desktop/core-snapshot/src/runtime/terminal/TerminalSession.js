const { EventEmitter } = require("node:events");

/**
 * Satu sesi terminal = descriptor imutabel + state runtime + pty handle.
 *
 * descriptor (Object.freeze): identitas & klasifikasi yang TAK berubah
 *   { id, owner, purpose, terminalType, createdBy, restartPolicy,
 *     persistent, target, shell, createdAt }
 * mutable: name (label; rename utk USER), status, pid, cwd, cols, rows, lastUsed
 *
 * Ring buffer scrollback membuat terminal BISA DIBAGI (klien baru /
 * AI read() memutar ulang layar). attach() memasang pty baru tanpa
 * membuang buffer → dipakai auto-restart (restartPolicy).
 *
 * Emit: "data"(string), "exit"(code)
 */

const MAX_BUFFER = 256 * 1024;

class TerminalSession extends EventEmitter {

    constructor({ descriptor, name, pty, cwd, cols, rows }) {
        super();
        this.descriptor = Object.freeze({ ...descriptor });
        this.name = name;                    // label (mutable, rename utk USER)
        this.cwd = cwd;
        this.cols = cols;
        this.rows = rows;
        this.status = "starting";
        this.exitCode = null;
        this.lastUsed = Date.now();

        this._chunks = [];
        this._bytes = 0;

        this.attach(pty);
    }

    /** Pasang (atau ganti) pty. Buffer scrollback dipertahankan. */
    attach(pty) {
        this.pty = pty;
        this.pid = pty.pid;
        this.status = "running";
        this.exitCode = null;
        pty.onData(d => this._onData(d));
        pty.onExit(e => {
            this.status = "exited";
            this.exitCode = e?.exitCode ?? 0;
            this.emit("exit", this.exitCode);
        });
    }

    get id() { return this.descriptor.id; }
    get terminalType() { return this.descriptor.terminalType; }
    isSystem() { return this.descriptor.terminalType === "SYSTEM"; }
    touch() { this.lastUsed = Date.now(); }

    _onData(data) {
        const buf = Buffer.from(data, "utf8");
        this._chunks.push(buf);
        this._bytes += buf.length;
        while (this._bytes > MAX_BUFFER && this._chunks.length > 1) {
            this._bytes -= this._chunks.shift().length;
        }
        this.emit("data", data);
    }

    write(data) {
        if (this.status === "running") this.pty.write(data);
        this.touch();
        return true;
    }

    signal(name) {
        this.touch();
        if (name === "SIGINT") return this.write("\x03");
        if (name === "EOF") return this.write("\x04");
        return this.kill(name);
    }

    resize(cols, rows) {
        this.cols = cols; this.rows = rows;
        try { this.pty.resize(cols, rows); } catch { /* mungkin sudah mati */ }
        return true;
    }

    read() {
        this.touch();
        return Buffer.concat(this._chunks).toString("utf8");
    }

    execute(command, { expect, timeoutMs = 15000 } = {}) {
        this.touch();
        return new Promise(resolve => {
            let out = "";
            let done = false;
            const re = expect ? (expect instanceof RegExp ? expect : new RegExp(expect, "i")) : null;
            const onData = d => { out += d; if (re && re.test(out)) finish(true); };
            const finish = matched => {
                if (done) return;
                done = true;
                this.off("data", onData);
                clearTimeout(timer);
                resolve({ output: out, matched });
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            this.on("data", onData);
            this.write(command.endsWith("\n") ? command : command + "\r");
        });
    }

    kill() {
        // JANGAN kirim nama sinyal: node-pty di Windows melempar
        // "Signals not supported on windows" secara asinkron (lolos
        // try/catch → crash). kill() tanpa argumen membunuh proses di
        // semua OS. Ctrl+C tetap lewat signal("SIGINT") → "\x03".
        try { this.pty.kill(); } catch { /* sudah mati */ }
        this.status = "exited";
        return true;
    }

    meta() {
        return {
            ...this.descriptor,
            name: this.name,
            cwd: this.cwd,
            pid: this.pid,
            status: this.status,
            exitCode: this.exitCode,
            cols: this.cols,
            rows: this.rows,
            lastUsed: new Date(this.lastUsed).toISOString()
        };
    }

}

module.exports = TerminalSession;
