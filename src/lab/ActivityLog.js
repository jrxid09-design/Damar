const { database, initialize } = require("../memory/db");

const telemetry = require("../services/telemetryService");

/**
 * ActivityLog — aliran kejadian Lab yang persisten & machine-readable.
 *
 * Setiap event ditulis ke lab_events (kebenaran — bisa direplay setelah
 * restart) DAN dipancarkan ke telemetry SSE (`lab:*`) untuk UI realtime
 * + orb agent di Console.
 */

const VOCAB = new Set([
    "project.created", "project.updated", "project.phase_changed", "project.archived",
    "mission.created", "mission.started", "mission.queued", "mission.blocked",
    "mission.waiting_user", "mission.verifying", "mission.completed",
    "mission.failed", "mission.cancelled", "mission.progress",
    "agent.started", "agent.completed", "agent.failed", "agent.status",
    "tool.started", "tool.completed", "tool.failed",
    "artifact.created", "decision.created",
    "experiment.started", "experiment.completed",
    "test.started", "test.completed", "test.passed", "test.failed",
    "memory.updated", "knowledge.updated"
]);

class ActivityLog {

    /**
     * Catat satu kejadian Lab.
     * @returns {object} event yang tersimpan
     */
    async record({ type, projectId = null, missionId = null, agentId = null, tool = null, payload = {} }) {

        await initialize();

        const event = {
            type,
            project_id: projectId,
            mission_id: missionId,
            agent_id: agentId,
            tool,
            payload: JSON.stringify(payload ?? {})
        };

        const res = await database.run(
            `INSERT INTO lab_events (type, project_id, mission_id, agent_id, tool, payload)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [event.type, event.project_id, event.mission_id, event.agent_id, event.tool, event.payload]
        );

        const stored = {
            id: res.lastID,
            ts: new Date().toISOString(),
            type: event.type,
            projectId: event.project_id,
            missionId: event.mission_id,
            agentId: event.agent_id,
            tool: event.tool,
            payload
        };

        // Pancarkan ke UI realtime (orb agent, mission control, activity).
        try {
            telemetry.publish(`lab:${type}`, stored);
        }
        catch { /* SSE opsional */ }

        return stored;

    }

    /** Kejadian terbaru — per project atau global. */
    async list({ projectId = null, missionId = null, limit = 80, afterId = 0 } = {}) {

        await initialize();

        const where = [];
        const params = [];

        if (projectId) { where.push("project_id = ?"); params.push(projectId); }
        if (missionId) { where.push("mission_id = ?"); params.push(missionId); }
        if (afterId) { where.push("id > ?"); params.push(afterId); }

        const sql = `
            SELECT * FROM lab_events
            ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY id DESC LIMIT ?
        `;

        const rows = await database.all(sql, [...params, limit]);

        return rows.map(hydrate);

    }

    vocabulary() {
        return [...VOCAB];
    }

}

function hydrate(row) {
    let payload = {};
    try { payload = JSON.parse(row.payload ?? "{}"); } catch { /* apa adanya */ }
    return {
        id: row.id, ts: row.ts, type: row.type,
        projectId: row.project_id, missionId: row.mission_id,
        agentId: row.agent_id, tool: row.tool,
        payload
    };
}

module.exports = new ActivityLog();
