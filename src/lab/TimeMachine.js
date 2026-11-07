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

        // Git commit saat ini (bila ada .git) — best effort.
        let gitCommit = null;
        try {
            const { execSync } = require("node:child_process");
            gitCommit = execSync("git rev-parse HEAD", { cwd: project.dir, stdio: ["ignore", "pipe", "ignore"] })
                .toString().trim();
        }
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
