const { database, initialize } = require("../memory/db");

const activity = require("./ActivityLog");

/**
 * ProjectEngine — siklus hidup project Lab.
 *
 * Project = lingkungan eksperimen persisten (§4): identitas, tujuan,
 * fase (§5), konfigurasi. Fase punya validator transisi deterministik
 * dan tabel afinitas agent yang dipakai MissionEngine untuk routing.
 */

const PHASES = ["IDEA", "RESEARCH", "DESIGN", "PROTOTYPE", "IMPLEMENTATION", "TESTING", "VALIDATION", "RELEASE", "MAINTENANCE"];

/** Transisi fase yang masuk akal (maju 1-3 langkah, atau mundur untuk revisi). */
const PHASE_FLOW = {
    IDEA: ["RESEARCH", "DESIGN"],
    RESEARCH: ["DESIGN", "PROTOTYPE", "IDEA"],
    DESIGN: ["PROTOTYPE", "IMPLEMENTATION", "RESEARCH"],
    PROTOTYPE: ["IMPLEMENTATION", "TESTING", "DESIGN"],
    IMPLEMENTATION: ["TESTING", "VALIDATION", "PROTOTYPE"],
    TESTING: ["VALIDATION", "IMPLEMENTATION", "RELEASE"],
    VALIDATION: ["RELEASE", "TESTING", "IMPLEMENTATION"],
    RELEASE: ["MAINTENANCE", "VALIDATION"],
    MAINTENANCE: ["TESTING", "IMPLEMENTATION"]
};

/** Afinitas agent per fase (§5) — constraint deterministik untuk planner. */
const PHASE_AGENTS = {
    IDEA: ["aether", "vanta", "mira"],
    RESEARCH: ["vanta", "mira", "aether"],
    DESIGN: ["aether", "forge", "vanta"],
    PROTOTYPE: ["forge", "nexus", "aether"],
    IMPLEMENTATION: ["forge", "nexus", "atlas"],
    TESTING: ["forge", "pulse", "cipher"],
    VALIDATION: ["pulse", "cipher", "aether"],
    RELEASE: ["nexus", "forge", "lumen"],
    MAINTENANCE: ["pulse", "nexus", "cipher"]
};

class ProjectEngine {

    async create({ dir, title, goal = null, description = null, phase = "IDEA", config = {} }) {

        await initialize();

        const id = `prj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        await database.run(
            `INSERT INTO lab_projects (id, dir, title, goal, description, phase, config)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, dir, title ?? dir, goal, description, PHASES.includes(phase) ? phase : "IDEA", JSON.stringify(config ?? {})]
        );

        await activity.record({ type: "project.created", projectId: id, payload: { title, dir, phase } });

        return this.get(id);

    }

    async get(id) {

        await initialize();

        const row = await database.get("SELECT * FROM lab_projects WHERE id = ?", [id]);

        return row ? hydrate(row) : null;

    }

    async list({ status = null } = {}) {

        await initialize();

        const rows = status
            ? await database.all("SELECT * FROM lab_projects WHERE status = ? ORDER BY updated_at DESC", [status])
            : await database.all("SELECT * FROM lab_projects ORDER BY updated_at DESC");

        return rows.map(hydrate);

    }

    async update(id, patch = {}) {

        await initialize();

        const current = await this.get(id);
        if (!current) throw new Error(`Project ${id} tidak ditemukan.`);

        const next = {
            title: patch.title ?? current.title,
            goal: patch.goal ?? current.goal,
            description: patch.description ?? current.description,
            status: patch.status ?? current.status,
            config: JSON.stringify({ ...current.config, ...(patch.config ?? {}) })
        };

        await database.run(
            `UPDATE lab_projects SET title=?, goal=?, description=?, status=?, config=?, updated_at=datetime('now') WHERE id=?`,
            [next.title, next.goal, next.description, next.status, next.config, id]
        );

        await activity.record({ type: "project.updated", projectId: id, payload: { fields: Object.keys(patch) } });

        return this.get(id);

    }

    /**
     * Transisi fase dengan validator deterministik (§5).
     * Transisi ilegal DITOLAK dan dicatat — bukan ditelan.
     */
    async setPhase(id, phase) {

        const key = String(phase ?? "").toUpperCase();

        if (!PHASES.includes(key)) {
            throw new Error(`Fase tidak dikenal: ${phase}. Valid: ${PHASES.join(", ")}`);
        }

        const project = await this.get(id);
        if (!project) throw new Error(`Project ${id} tidak ditemukan.`);

        if (project.phase === key) return project;

        if (!PHASE_FLOW[project.phase]?.includes(key)) {
            await activity.record({
                type: "project.phase_changed", projectId: id,
                payload: { from: project.phase, to: key, rejected: true }
            });
            throw new Error(`Transisi fase ${project.phase} → ${key} tidak valid. Dari ${project.phase}: ${PHASE_FLOW[project.phase].join(", ")}`);
        }

        await database.run(
            `UPDATE lab_projects SET phase=?, updated_at=datetime('now') WHERE id=?`,
            [key, id]
        );

        await activity.record({
            type: "project.phase_changed", projectId: id,
            payload: { from: project.phase, to: key }
        });

        return this.get(id);

    }

    /** Agent yang cocok untuk fase proyek (constraint routing §25). */
    agentsForPhase(phase) {
        return PHASE_AGENTS[String(phase ?? "IDEA").toUpperCase()] ?? PHASE_AGENTS.IDEA;
    }

    phases() {
        return { list: PHASES, flow: PHASE_FLOW, agents: PHASE_AGENTS };
    }

    /** Ringkasan isi project: missions/artifacts/decisions counts. */
    async stats(id) {

        await initialize();

        const [missions, artifacts, decisions, experiments, events] = await Promise.all([
            database.get("SELECT COUNT(*) n FROM lab_missions WHERE project_id=?", [id]),
            database.get("SELECT COUNT(*) n FROM lab_artifacts WHERE project_id=?", [id]),
            database.get("SELECT COUNT(*) n FROM lab_decisions WHERE project_id=?", [id]),
            database.get("SELECT COUNT(*) n FROM lab_experiments WHERE project_id=?", [id]),
            database.get("SELECT COUNT(*) n FROM lab_events WHERE project_id=?", [id])
        ]);

        return {
            missions: missions?.n ?? 0,
            artifacts: artifacts?.n ?? 0,
            decisions: decisions?.n ?? 0,
            experiments: experiments?.n ?? 0,
            events: events?.n ?? 0
        };

    }

    /** Timeline project: kejadian penting terbaru (§22). */
    async timeline(id, { limit = 60 } = {}) {

        await initialize();

        const rows = await database.all(
            `SELECT * FROM lab_events
             WHERE project_id=? AND type IN (
                'mission.created','mission.started','mission.completed','mission.failed',
                'project.phase_changed','decision.created','artifact.created',
                'experiment.started','experiment.completed','test.completed','test.failed'
             )
             ORDER BY id DESC LIMIT ?`,
            [id, limit]
        );

        return rows.map(r => {
            let payload = {};
            try { payload = JSON.parse(r.payload ?? "{}"); } catch { /* ok */ }
            return { id: r.id, ts: r.ts, type: r.type, missionId: r.mission_id, payload };
        });

    }

}

function hydrate(row) {
    let config = {};
    try { config = JSON.parse(row.config ?? "{}"); } catch { /* ok */ }
    return {
        id: row.id, dir: row.dir, title: row.title, goal: row.goal,
        description: row.description, status: row.status, phase: row.phase,
        config, createdAt: row.created_at, updatedAt: row.updated_at
    };
}

module.exports = new ProjectEngine();
