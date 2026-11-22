const { database, initialize } = require("../memory/db");

const activity = require("./ActivityLog");

/**
 * DecisionLog — catatan keputusan arsitektural (§21).
 * Mencegah Damar lupa MENGAPA sebuah keputusan diambil.
 */

class DecisionLog {

    async create({ projectId, missionId = null, question, options = [], chosen = null, reason = null, evidence = [], decisionMaker = "damar" }) {

        await initialize();

        const id = `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        await database.run(
            `INSERT INTO lab_decisions (id, project_id, mission_id, question, options, chosen, reason, evidence, decision_maker)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, projectId, missionId, question, JSON.stringify(options ?? []),
             chosen, reason, JSON.stringify(evidence ?? []), decisionMaker]
        );

        await activity.record({
            type: "decision.created", projectId, missionId,
            payload: { decisionId: id, question, chosen }
        });

        return this.get(id);

    }

    async get(id) {

        await initialize();

        const row = await database.get("SELECT * FROM lab_decisions WHERE id = ?", [id]);

        return row ? hydrate(row) : null;

    }

    async list({ projectId = null, missionId = null, limit = 100 } = {}) {

        await initialize();

        const where = [];
        const params = [];

        if (projectId) { where.push("project_id = ?"); params.push(projectId); }
        if (missionId) { where.push("mission_id = ?"); params.push(missionId); }

        const rows = await database.all(
            `SELECT * FROM lab_decisions ${where.length ? "WHERE " + where.join(" AND ") : ""}
             ORDER BY id DESC LIMIT ?`,
            [...params, limit]
        );

        return rows.map(hydrate);

    }

}

function hydrate(row) {
    const parse = (t, f) => { try { return JSON.parse(t ?? "") ?? f; } catch { return f; } };
    return {
        id: row.id, projectId: row.project_id, missionId: row.mission_id,
        question: row.question, options: parse(row.options, []),
        chosen: row.chosen, reason: row.reason, evidence: parse(row.evidence, []),
        decisionMaker: row.decision_maker, createdAt: row.created_at
    };
}

module.exports = new DecisionLog();
