const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const telemetry = require("../../services/telemetryService");

const pexec = promisify(execFile);

/**
 * graphifyAdapter — mesin GRAF internal Aether (Coding Brain).
 *
 * Membungkus CLI graphify (bukan menulis ulang): dependency/call/import/
 * architecture graph. Aether wajib memahami hubungan antar-file lewat ini
 * SEBELUM membuat patch. Degradasi anggun bila graphify belum terpasang.
 *
 * graphify sering TIDAK di PATH (uv tool di ~/.local/bin), jadi di-resolve
 * dari lokasi umum dulu — sama seperti resolusi smartctl/gsudo.
 */

let _bin;
function resolveBin() {
    if (_bin !== undefined) return _bin;
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const exe = process.platform === "win32" ? "graphify.exe" : "graphify";
    const known = [
        path.join(home, ".local", "bin", exe),
        path.join(home, "AppData", "Local", "Programs", "graphify", exe)
    ];
    for (const c of known) { try { if (fs.existsSync(c)) { _bin = c; return c; } } catch { /* lanjut */ } }
    _bin = "graphify";   // fallback: andalkan PATH
    return _bin;
}

const OPTS = { timeout: 90000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };

class GraphifyAdapter {

    get bin() { return resolveBin(); }

    /** Apakah graphify bisa dipanggil. */
    async available() {
        try { await pexec(this.bin, ["--version"], { ...OPTS, timeout: 8000 }); return true; }
        catch { return false; }
    }

    /** Apakah project sudah punya graph terbangun. */
    hasGraph(project = process.cwd()) {
        try { return fs.existsSync(path.join(project, "graphify-out", "graph.json")); }
        catch { return false; }
    }

    async _run(args, project) {
        const { stdout } = await pexec(this.bin, args, { ...OPTS, cwd: project });
        return stdout;
    }

    /** Subgraf terkait sebuah pertanyaan (paling sering dipakai untuk cari file relevan). */
    async query(question, { project = process.cwd(), budget = null } = {}) {
        if (!question) throw new Error("query butuh pertanyaan.");
        const args = ["query", String(question)];
        if (budget) args.push("--budget", String(budget));
        return this._run(args, project);
    }

    /** Jalur hubungan antara dua simbol/konsep A→B. */
    async path(a, b, { project = process.cwd() } = {}) {
        return this._run(["path", String(a), String(b)], project);
    }

    /** Penjelasan terfokus sebuah konsep/simbol. */
    async explain(concept, { project = process.cwd() } = {}) {
        return this._run(["explain", String(concept)], project);
    }

    /** Segarkan graph setelah kode berubah (AST-only, tanpa biaya API). */
    async update(project = process.cwd()) {
        telemetry.info(`[coding/graph] update graphify: ${project}`);
        return this._run(["update", "."], project);
    }

}

module.exports = new GraphifyAdapter();
