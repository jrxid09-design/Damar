const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const telemetry = require("../../services/telemetryService");

const pexec = promisify(execFile);
const OPTS = { windowsHide: true, maxBuffer: 32 * 1024 * 1024 };
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NODE = process.execPath;

/**
 * testRunner — gerbang verifikasi patch (Coding Brain).
 *
 * Urutan self-healing: check (syntax) → lint → test. Berhenti di kegagalan
 * pertama dan kembalikan output agar bisa di-rollback. OS-aware (npm.cmd di
 * Windows). Hanya menjalankan script yang MEMANG ada di package.json —
 * tak mengarang perintah.
 */
function readScripts(project) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
        return pkg.scripts || {};
    } catch { return {}; }
}

class TestRunner {

    /** Script yang tersedia (test/lint/build) untuk introspeksi/planner. */
    detect(project = process.cwd()) {
        const s = readScripts(project);
        return { test: !!s.test, lint: !!s.lint, build: !!s.build, scripts: Object.keys(s) };
    }

    /** Cek sintaks satu file JS/TS tanpa mengeksekusinya (cepat, aman). */
    async check(file) {
        const ext = path.extname(file).toLowerCase();
        if (![".js", ".cjs", ".mjs"].includes(ext)) {
            return { ok: true, step: "check", skipped: `node --check hanya JS (bukan ${ext})` };
        }
        try {
            await pexec(NODE, ["--check", file], { ...OPTS, timeout: 30000 });
            return { ok: true, step: "check", file };
        } catch (e) {
            return { ok: false, step: "check", file, output: (e.stderr || e.message || "").slice(-4000) };
        }
    }

    async runScript(name, project = process.cwd(), { timeout = 300000 } = {}) {
        if (!readScripts(project)[name]) return { ok: true, step: name, skipped: `script '${name}' tak ada` };
        telemetry.info(`[coding/test] npm run ${name}`);
        try {
            // `npm run` menjalankan skrip dari package.json — isinya
            // dapat berubah, termasuk oleh Damar sendiri. Proses anak
            // TIDAK boleh mewarisi rahasia (§38): tanpa ini, satu baris
            // di skrip test cukup untuk membaca DAMAR_TOKEN dan kunci
            // API dari environment.
            const sandbox = require("../../core/safety/codeSandbox");
            const { stdout, stderr } = await pexec(
                NPM,
                ["run", "--silent", name],
                { ...OPTS, ...sandbox.options({ cwd: project, timeout }) }
            );
            return { ok: true, step: name, output: (stdout || stderr || "").slice(-4000) };
        } catch (e) {
            return { ok: false, step: name, output: [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").slice(-6000) };
        }
    }

    lint(project = process.cwd()) { return this.runScript("lint", project); }
    test(project = process.cwd()) { return this.runScript("test", project); }

    /**
     * Verifikasi berlapis: lint → test (skip yang tak ada). Berhenti di
     * kegagalan pertama. Kembalian: { ok, steps:[…], failed?:step }.
     */
    async verify(project = process.cwd(), { steps = ["lint", "test"] } = {}) {
        const results = [];
        for (const name of steps) {
            const r = await this.runScript(name, project);
            results.push(r);
            if (!r.ok) return { ok: false, failed: name, steps: results };
        }
        return { ok: true, steps: results };
    }

}

module.exports = new TestRunner();
