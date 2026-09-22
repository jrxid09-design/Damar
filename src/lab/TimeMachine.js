const fs = require("node:fs");
const path = require("node:path");

const { database, initialize } = require("../memory/db");

const activity = require("./ActivityLog");

/**
 * TimeMachine — snapshot non-destruktif (§23 MVP).
 *
 * Snapshot menyimpan REFERENSI keadaan (git commit, misi, artefak,
 * keputusan, memori), BUKAN rollback destruktif. Data model & timeline
 * dulu; pemulihan menyusul bila dibutuhkan.
 */

class TimeMachine {

    async snapshot({ projectId, label = null }) {

        await initialize();

        const project = await database.get("SELECT * FROM lab_projects WHERE id=?", [projectId]);
        if (!project) throw new Error(`Project ${projectId} tidak ditemukan.`);

        // Git commit saat ini (bila ada .git) — best effort, dibaca dari metadata
        // git (lihat readGitCommit), bukan dengan menjalankan proses.
        let gitCommit = null;
        try { gitCommit = readGitCommit(project.dir); }
        catch { /* bukan repo git — tetap snapshot */ }

        const [missions, artifacts, decisions] = await Promise.all([
            database.all("SELECT id, status, progress FROM lab_missions WHERE project_id=?", [projectId]),
            database.all("SELECT id FROM lab_artifacts WHERE project_id=?", [projectId]),
            database.all("SELECT id FROM lab_decisions WHERE project_id=?", [projectId])
        ]);

        const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        await database.run(
            `INSERT INTO lab_snapshots (id, project_id, label, git_commit, mission_states, artifact_ids, decision_ids, memory_refs)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, projectId, label, gitCommit,
             JSON.stringify(missions), JSON.stringify(artifacts.map(a => a.id)),
             JSON.stringify(decisions.map(d => d.id)), "[]"]
        );

        await activity.record({
            type: "project.updated", projectId,
            payload: { snapshot: id, label, gitCommit }
        });

        return this.get(id);

    }

    async get(id) {

        await initialize();

        const row = await database.get("SELECT * FROM lab_snapshots WHERE id=?", [id]);

        return row ? hydrate(row) : null;

    }

    async list(projectId, { limit = 30 } = {}) {

        await initialize();

        const rows = await database.all(
            "SELECT * FROM lab_snapshots WHERE project_id=? ORDER BY id DESC LIMIT ?",
            [projectId, limit]
        );

        return rows.map(hydrate);

    }

}

/**
 * Commit HEAD sebuah working tree, dibaca langsung dari metadata git.
 *
 * Sebelumnya ini `execSync("git rev-parse HEAD", { cwd })`: sebuah proses
 * dijalankan hanya untuk membaca satu referensi. Snapshot adalah operasi
 * BACA, jadi jalur yang benar bukan memberinya otoritas eksekusi,
 * melainkan berhenti mengeksekusi: `.git/HEAD` (atau file `gitdir:`,
 * untuk worktree/submodule) dibaca apa adanya.
 *
 * Best effort seperti sebelumnya: null bila bukan repo git, HEAD belum
 * punya commit, atau isinya tidak dikenali.
 */
function readGitCommit(dir) {

    const dotGit = path.join(dir, ".git");
    let gitDir = dotGit;

    try {
        if (!fs.statSync(dotGit).isDirectory()) {
            const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
            if (!pointer) return null;
            gitDir = path.resolve(dir, pointer[1].trim());
        }
    }
    catch {
        // Tanpa `.git`: direktori ini sendiri mungkin git dir (repo bare) —
        // `git rev-parse HEAD` dulu juga bekerja di sana.
        gitDir = dir;
    }

    let head;
    try { head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim(); }
    catch { return null; }

    const symbolic = /^ref:\s*(.+)$/.exec(head);
    if (!symbolic) return /^[0-9a-f]{40,64}$/.test(head) ? head : null;

    const ref = symbolic[1].trim();

    try {
        const direct = fs.readFileSync(path.join(gitDir, ref), "utf8").trim();
        if (direct) return direct;
    }
    catch { /* ref belum dilonggarkan — mungkin ada di packed-refs */ }

    try {
        for (const line of fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8").split("\n")) {
            if (line.startsWith("#") || line.startsWith("^")) continue;
            const [hash, name] = line.split(" ");
            if (name && name.trim() === ref) return hash.trim();
        }
    }
    catch { /* tidak ada packed-refs */ }

    return null;

}

function hydrate(row) {
    const parse = (t, f) => { try { return JSON.parse(t ?? "") ?? f; } catch { return f; } };
    return {
        id: row.id, projectId: row.project_id, label: row.label,
        gitCommit: row.git_commit,
        missionStates: parse(row.mission_states, []),
        artifactIds: parse(row.artifact_ids, []),
        decisionIds: parse(row.decision_ids, []),
        memoryRefs: parse(row.memory_refs, []),
        createdAt: row.created_at
    };
}

module.exports = new TimeMachine();
// Diekspor untuk pengujian langsung (lihat tests/wave8/legacy/labTimeMachineGitRead.test.js).
module.exports.readGitCommit = readGitCommit;
