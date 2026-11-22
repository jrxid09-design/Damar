const { database, initialize } = require("../memory/db");

const activity = require("./ActivityLog");

/**
 * ExperimentLab — investigasi terkontrol (§18): hipotesis, variabel,
 * method, runs, metrik, kesimpulan. Run dicatat apa adanya —
 * kegagalan eksperimen adalah data, bukan aib (§42).
 */

class ExperimentLab {

    async create({ projectId, hypothesis, objective = null, variables = {}, method = null, metrics = {} }) {

        await initialize();

        const id = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        await database.run(
            `INSERT INTO lab_experiments (id, project_id, hypothesis, objective, variables, method, metrics)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, projectId, hypothesis, objective,
             JSON.stringify(variables ?? {}), method, JSON.stringify(metrics ?? {})]
        );

        return this.get(id);

    }

    async get(id) {

        await initialize();

        const row = await database.get("SELECT * FROM lab_experiments WHERE id = ?", [id]);

        return row ? hydrate(row) : null;

    }

    async list({ projectId = null, limit = 100 } = {}) {

        await initialize();

        const rows = projectId
            ? await database.all("SELECT * FROM lab_experiments WHERE project_id=? ORDER BY updated_at DESC LIMIT ?", [projectId, limit])
            : await database.all("SELECT * FROM lab_experiments ORDER BY updated_at DESC LIMIT ?", [limit]);

        return rows.map(hydrate);

    }

    /** Mulai eksperimen → status running + event. */
    async start(id) {

        const exp = await this.get(id);
        if (!exp) throw new Error(`Eksperimen ${id} tidak ditemukan.`);

        await database.run(
            `UPDATE lab_experiments SET status='running', updated_at=datetime('now') WHERE id=?`, [id]
        );

        await activity.record({
            type: "experiment.started", projectId: exp.projectId,
            payload: { experimentId: id, hypothesis: exp.hypothesis }
        });

        return this.get(id);

    }

    /** Catat satu run + metrik hasil. */
    async addRun(id, { label = null, metrics = {}, notes = null } = {}) {

        const exp = await this.get(id);
        if (!exp) throw new Error(`Eksperimen ${id} tidak ditemukan.`);

        const runs = [...exp.runs, { at: new Date().toISOString(), label, metrics, notes, ok: metrics.failed == null }];

        await database.run(
            `UPDATE lab_experiments SET runs=?, updated_at=datetime('now') WHERE id=?`,
            [JSON.stringify(runs), id]
        );

        return this.get(id);

    }

    /** Selesaikan eksperimen dengan kesimpulan. */
    async complete(id, { conclusion, status = "completed", metrics = null } = {}) {

        const exp = await this.get(id);
        if (!exp) throw new Error(`Eksperimen ${id} tidak ditemukan.`);

        await database.run(
            `UPDATE lab_experiments SET conclusion=?, status=?, metrics=?, updated_at=datetime('now') WHERE id=?`,
            [conclusion, status, JSON.stringify(metrics ?? exp.metrics), id]
        );

        await activity.record({
            type: "experiment.completed", projectId: exp.projectId,
            payload: { experimentId: id, conclusion, status }
        });

        return this.get(id);

    }

}

function hydrate(row) {
    const parse = (t, f) => { try { return JSON.parse(t ?? "") ?? f; } catch { return f; } };
    return {
        id: row.id, projectId: row.project_id, hypothesis: row.hypothesis,
        objective: row.objective, variables: parse(row.variables, {}),
        method: row.method, metrics: parse(row.metrics, {}), runs: parse(row.runs, []),
        conclusion: row.conclusion, status: row.status,
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}

module.exports = new ExperimentLab();
