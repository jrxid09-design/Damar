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

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Pseudo-ref yang memang privat per-worktree; sisanya (refs/heads/*, refs/tags/*, ...)
// tinggal di common dir.
const WORKTREE_PRIVATE_REF = /^refs\/(?:bisect|worktree|rewritten)\//;

// git sendiri berhenti pada rantai symbolic ref yang lebih dalam dari ini
// ("too many levels of symbolic refs"), jadi batasnya disamakan: rantai yang
// git tolak harus menghasilkan null di sini juga, bukan hash yang lebih benar
// daripada git.
const MAX_REF_DEPTH = 4;

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

    // Worktree tertaut (`git worktree add`): HEAD tinggal di direktori worktree,
    // tetapi ref-nya tinggal di COMMON dir yang ditunjuk berkas `commondir`.
    // Tanpa ini snapshot dari worktree kehilangan commit-nya.
    let commonDir = gitDir;
    try {
        const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
        if (common) commonDir = path.resolve(gitDir, common);
    }
    catch { /* repo biasa/bare: ref memang ada di git dir itu sendiri */ }

    let head;
    try { head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim(); }
    catch { return null; }

    const symbolic = /^ref:\s*(.+)$/.exec(head);
    if (!symbolic) return HASH.test(head) ? head : null;

    // HEAD boleh menunjuk symbolic ref yang menunjuk symbolic ref lagi.
    let ref = symbolic[1].trim();
    for (let hop = 0; hop < MAX_REF_DEPTH; hop++) {
        const value = readRef(gitDir, commonDir, ref);
        if (value === null) return null;
        const deeper = /^ref:\s*(.+)$/.exec(value);
        // Ada tetapi bukan hash: git pun gagal di sini, dan dulu hasilnya null.
        if (!deeper) return HASH.test(value) ? value : null;
        ref = deeper[1].trim();
    }

    return null;
}

/**
 * Isi sebuah ref — berkas longgar lebih dulu, lalu `packed-refs` — atau null.
 *
 * Ref biasa (`refs/heads/*`, `refs/tags/*`, ...) dicari HANYA di common dir:
 * git tidak pernah menyelesaikannya di direktori privat worktree, dan berkas
 * sisa di sana (mis. dari restore) akan memenangkan ref yang sebenarnya.
 *
 * Ref privat worktree (`refs/bisect|worktree|rewritten/*`) hanya dibaca
 * longgar di direktori privat worktree itu sendiri. Diukur dengan git 2.55:
 * pada linked worktree, ref privat yang hanya ada di common dir TIDAK
 * diselesaikan git, jadi tidak ada fallback ke sana.
 */
function readRef(gitDir, commonDir, ref) {
    const bases = commonDir !== gitDir && !WORKTREE_PRIVATE_REF.test(ref) ? [commonDir] : [gitDir];

    for (const base of bases) {
        try { return fs.readFileSync(path.join(base, ref), "utf8").trim(); }
        catch { /* belum dilonggarkan di sini — mungkin hanya ada di packed-refs */ }
    }

    for (const base of bases) {
        // `packed-refs` hanya diakui git di common dir. `git pack-refs --all`
        // membiarkan ref privat tetap longgar, jadi berkas di direktori privat
        // worktree tidak pernah dibaca git dan tidak boleh dipercaya di sini.
        if (base !== commonDir) continue;
        try {
            for (const line of fs.readFileSync(path.join(base, "packed-refs"), "utf8").split("\n")) {
                if (line.startsWith("#") || line.startsWith("^")) continue;
                // Tanpa dirapikan: baris yang rusak (CRLF, spasi ekstra) ditolak
                // git seluruhnya, jadi memperbaikinya di sini berarti menerima
                // ref yang git sendiri tidak mau selesaikan.
                const [hash, name] = line.split(" ");
                if (name === ref && HASH.test(hash)) return hash;
            }
        }
        catch { /* tidak ada packed-refs di sini */ }
    }

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
