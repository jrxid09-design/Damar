const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const telemetry = require("../../services/telemetryService");

const pexec = promisify(execFile);

/**
 * serenaAdapter — mesin SIMBOL internal Aether (Coding Brain, Fase 2).
 *
 * Serena bekerja lewat MCP/HTTP-server, bukan invoke tool satu-kali. Yang
 * bisa dipakai daemon langsung & deterministik = CLI `serena project`:
 *   - index        : bangun cache simbol (LSP) sebuah proyek → prasyarat
 *                    navigasi simbol yang cepat.
 *   - healthCheck  : diagnosa kesiapan proyek untuk Serena.
 * Query simbol LIVE (find_symbol/references/rename) paling andal lewat LSP
 * (Fase 4); project-server Serena (HTTP) opsional dan bisa diplug via
 * queryServer() bila dijalankan (`serena start-project-server`).
 *
 * Degradasi anggun bila serena belum terpasang.
 */

let _bin;
function resolveBin() {
    if (_bin !== undefined) return _bin;
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const exe = process.platform === "win32" ? "serena.exe" : "serena";
    const known = [path.join(home, ".local", "bin", exe)];
    for (const c of known) { try { if (fs.existsSync(c)) { _bin = c; return c; } } catch { /* lanjut */ } }
    _bin = "serena";
    return _bin;
}

const OPTS = { timeout: 240000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };

class SerenaAdapter {

    get bin() { return resolveBin(); }

    async available() {
        try { await pexec(this.bin, ["--version"], { ...OPTS, timeout: 10000 }); return true; }
        catch { return false; }
    }

    /** Bangun cache simbol (LSP) proyek — prasyarat navigasi simbol cepat. */
    async index(project = process.cwd()) {
        telemetry.info(`[coding/symbol] serena index: ${project}`);
        const { stdout, stderr } = await pexec(this.bin, ["project", "index", project], OPTS);
        return { ok: true, log: (stdout || stderr || "").slice(-2000) };
    }

    /** Diagnosa kesiapan proyek untuk Serena. */
    async healthCheck(project = process.cwd()) {
        const { stdout, stderr } = await pexec(this.bin, ["project", "health-check", project], { ...OPTS, timeout: 60000 });
        return { ok: true, report: (stdout || stderr || "").slice(-2000) };
    }

    /**
     * Query ke Serena project-server HTTP (opsional; harus dijalankan
     * terpisah: `serena start-project-server`). Endpoint/port dikonfigurasi
     * lewat env AETHER_SERENA_URL. Best-effort; kontrak HTTP dikunci saat
     * server dipakai.
     */
    async queryServer(pathname, body = {}) {
        const base = process.env.AETHER_SERENA_URL;
        if (!base) throw new Error("Project-server Serena tak dikonfigurasi (set AETHER_SERENA_URL & jalankan `serena start-project-server`).");
        const res = await fetch(`${base.replace(/\/+$/, "")}${pathname}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) throw new Error(`Serena project-server ${res.status}`);
        return res.json();
    }

}

module.exports = new SerenaAdapter();
