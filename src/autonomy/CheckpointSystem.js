const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { database, initialize } = require("../memory/db");

/**
 * CHECKPOINT SYSTEM (§31) — titik pemulihan sebelum perubahan signifikan.
 *
 * create → execute → validate → commit | restore.
 * Snapshot NON-DESTRUKTIF: git commit / salinan berkas / config copy.
 * Restore eksplisit — tidak pernah rollback diam-diam (§55).
 */

class CheckpointSystem {

    /**
     * Buat checkpoint.
     * @param {object} opts { scope: 'git'|'fs'|'config', target, label }
     * git  → commit otomatis di branch (bila repo)
     * fs   → salin berkas/folder ke .aether-checkpoints/
     * config → salin berkas config
     */
    async create({ scope, target, label = null }) {

        await initialize();

        const id = `ckp-${Date.now().toString(36)}`;
        let snapshot = {};

        if (scope === "git") {

            const dir = target ?? process.cwd();

            try {
                snapshot.commit = execSync("git rev-parse HEAD", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
                snapshot.branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
                // Commit pekerjaan berjalan agar ada titik pulih yang jelas.
                try {
                    execSync('git add -A && git diff --cached --quiet || git commit -m "checkpoint: aether (otomatis)" --no-verify', { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
                    snapshot.commit = execSync("git rev-parse HEAD", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
                }
                catch { /* tak ada perubahan */ }
            }
            catch {
                throw new Error(`${dir} bukan repositori git — pakai scope 'fs'.`);
            }

        }
        else if (scope === "fs" || scope === "config") {

            const abs = path.resolve(target);

            if (!fs.existsSync(abs)) {
                throw new Error(`target tidak ada: ${abs}`);
            }

            const store = path.join(process.cwd(), "data", "checkpoints", id);
            fs.mkdirSync(store, { recursive: true });

            if (fs.statSync(abs).isDirectory()) {
                fs.cpSync(abs, path.join(store, path.basename(abs)), { recursive: true });
            }
            else {
                fs.copyFileSync(abs, path.join(store, path.basename(abs)));
            }

            snapshot.backupPath = store;
            snapshot.original = abs;

        }
        else {
            throw new Error(`scope checkpoint tidak dikenal: ${scope}`);
        }

        await database.run(
            `INSERT INTO checkpoints (id, scope, target, label, snapshot) VALUES (?, ?, ?, ?, ?)`,
            [id, scope, target ?? process.cwd(), label, JSON.stringify(snapshot)]
        );

        return { id, scope, target, label, snapshot };

    }

    /** Pulihkan ke checkpoint (eksplisit, tercatat). */
    async restore(id) {

        await initialize();

        const row = await database.get("SELECT * FROM checkpoints WHERE id = ?", [id]);

        if (!row) throw new Error(`checkpoint ${id} tidak ditemukan.`);

        const snapshot = JSON.parse(row.snapshot ?? "{}");

        if (row.scope === "git" && snapshot.commit) {
            execSync(`git checkout ${snapshot.commit}`, {
                cwd: row.target, stdio: ["ignore", "pipe", "ignore"]
            });
        }
        else if (snapshot.backupPath && snapshot.original) {
            fs.cpSync(snapshot.backupPath, snapshot.original, { recursive: true });
        }
        else {
            throw new Error("snapshot tidak punya jalur pemulihan.");
        }

        return { restored: id, snapshot };

    }

    async list({ target = null, limit = 30 } = {}) {

        await initialize();

        const rows = target
            ? await database.all("SELECT * FROM checkpoints WHERE target = ? ORDER BY id DESC LIMIT ?", [target, limit])
            : await database.all("SELECT * FROM checkpoints ORDER BY id DESC LIMIT ?", [limit]);

        return rows.map(r => ({
            id: r.id, scope: r.scope, target: r.target, label: r.label,
            snapshot: JSON.parse(r.snapshot ?? "{}"), createdAt: r.created_at
        }));

    }

}

module.exports = new CheckpointSystem();
