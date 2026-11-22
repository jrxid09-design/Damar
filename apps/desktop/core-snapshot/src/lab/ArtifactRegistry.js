const { database, initialize } = require("../memory/db");

const activity = require("./ActivityLog");

/**
 * ArtifactRegistry — output penting dengan PROVENANCE (§20).
 * Setiap artefak tahu: siapa membuat, misi apa, sumber/tool apa,
 * keputusan & eksperimen terkait.
 */

class ArtifactRegistry {

    async create({ projectId, missionId = null, agentId = null, kind, name, path = null, uri = null, summary = null, provenance = {} }) {

        await initialize();

        const id = `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        await database.run(
            `INSERT INTO lab_artifacts (id, project_id, mission_id, agent_id, kind, name, path, uri, summary, provenance)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, projectId, missionId, agentId, kind, name, path, uri, summary, JSON.stringify(provenance ?? {})]
        );

        await activity.record({
            type: "artifact.created", projectId, missionId, agentId,
            payload: { artifactId: id, kind, name }
        });

        return this.get(id);

    }

    async get(id) {

        await initialize();

        const row = await database.get("SELECT * FROM lab_artifacts WHERE id = ?", [id]);

        return row ? hydrate(row) : null;

    }

    async list({ projectId = null, missionId = null, kind = null, limit = 100 } = {}) {

        await initialize();

        const where = [];
        const params = [];

        if (projectId) { where.push("project_id = ?"); params.push(projectId); }
        if (missionId) { where.push("mission_id = ?"); params.push(missionId); }
        if (kind) { where.push("kind = ?"); params.push(kind); }

        const rows = await database.all(
            `SELECT * FROM lab_artifacts ${where.length ? "WHERE " + where.join(" AND ") : ""}
             ORDER BY id DESC LIMIT ?`,
            [...params, limit]
        );

        return rows.map(hydrate);

    }

}

function hydrate(row) {
    let provenance = {};
    try { provenance = JSON.parse(row.provenance ?? "{}"); } catch { /* ok */ }
    return {
        id: row.id, projectId: row.project_id, missionId: row.mission_id,
        agentId: row.agent_id, kind: row.kind, name: row.name,
        path: row.path, uri: row.uri, summary: row.summary,
        provenance, createdAt: row.created_at
    };
}

module.exports = new ArtifactRegistry();
