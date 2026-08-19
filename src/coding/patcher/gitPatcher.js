const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const telemetry = require("../../services/telemetryService");

const pexec = promisify(execFile);
const OPTS = { timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };

/**
 * gitPatcher — jaring pengaman perubahan kode (Coding Brain).
 *
 * Patch kecil + aman: kerja di BRANCH, commit bila lulus test, RESTORE
 * (buang perubahan file) bila gagal. Tidak pakai reset --hard destruktif
 * sebagai default. Semua operasi bergulir di root proyek.
 */
async function git(args, project) {
    const { stdout } = await pexec("git", args, { ...OPTS, cwd: project });
    return stdout.trim();
}

class GitPatcher {

    async isRepo(project = process.cwd()) {
        try { await git(["rev-parse", "--is-inside-work-tree"], project); return true; }
        catch { return false; }
    }

    async currentBranch(project = process.cwd()) { return git(["rev-parse", "--abbrev-ref", "HEAD"], project); }

    /** Perubahan belum-commit (porcelain). */
    async status(project = process.cwd()) { return git(["status", "--porcelain"], project); }

    async diff(project = process.cwd(), { staged = false } = {}) {
        return git(staged ? ["diff", "--staged"] : ["diff"], project);
    }

    /** Buat branch kerja untuk sebuah tugas (aman; tak menyentuh main). */
    async createBranch(name, project = process.cwd()) {
        const safe = String(name).trim().replace(/[^\w./-]+/g, "-").slice(0, 80) || `aether/${Date.now()}`;
        await git(["checkout", "-b", safe], project);
        telemetry.info(`[coding/patch] branch: ${safe}`);
        return { branch: safe };
    }

    /** Commit perubahan (stage semua secara default). */
    async commit(message, project = process.cwd(), { all = true } = {}) {
        if (all) await git(["add", "-A"], project);
        try {
            const out = await git(["commit", "-m", String(message || "chore: perubahan Aether")], project);
            return { committed: true, out };
        }
        catch (e) { return { committed: false, out: e.message }; }
    }

    /**
     * ROLLBACK aman: buang perubahan belum-commit pada file tertentu (atau
     * semua). Bukan reset --hard — hanya mengembalikan file ke HEAD.
     */
    async restore(files = ["."], project = process.cwd()) {

        const list = Array.isArray(files) && files.length ? files : ["."];

        // Kegagalan git dulu ditelan (`.catch(() => {})`) lalu hasilnya
        // tetap `{ restored: [...] }` — rollback yang gagal total
        // terbaca berhasil, dan itu justru dipanggil saat test merah:
        // tepat ketika laporan palsu paling berbahaya.
        try {
            await git(["checkout", "--", ...list], project);
        }
        catch (error) {
            telemetry.warn(`[coding/patch] restore GAGAL: ${error.message}`);
            return { restored: [], ok: false, error: error.message };
        }

        telemetry.info(`[coding/patch] restore: ${list.join(" ")}`);

        return { restored: list, ok: true };

    }

}

module.exports = new GitPatcher();
