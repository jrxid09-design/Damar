const { database, initialize } = require("../memory/db");

const activity = require("./ActivityLog");
const projects = require("./ProjectEngine");

/**
 * MissionEngine — misi: tujuan konkret di dalam project (§6-§7).
 *
 * State machine DETERMINISTIK di runtime (bukan prompt):
 *
 *   PLANNING → QUEUED → RUNNING → VERIFYING → COMPLETED
 *                       │  ↑                    ↑
 *                       │  └── (replan)         │
 *                       ├──→ BLOCKED ──(unblock)┘
 *                       ├──→ WAITING_USER ──(resume)
 *                       ├──→ FAILED
 *                       └──→ CANCELLED (dari state apa pun aktif)
 *
 * Eksekusi mendelegasikan ke orchestrator yang SUDAH ADA
 * (plan → step → final) — Lab tidak membuat runtime paralel (§42).
 * Progress dihitung dari tasks, bukan diklaim agent (§42 anti-fake).
 */

const STATES = ["PLANNING", "QUEUED", "RUNNING", "BLOCKED", "WAITING_USER", "VERIFYING", "COMPLETED", "FAILED", "CANCELLED"];

const TRANSITIONS = {
    PLANNING: ["QUEUED", "CANCELLED"],
    QUEUED: ["RUNNING", "CANCELLED", "PLANNING"],
    RUNNING: ["BLOCKED", "WAITING_USER", "VERIFYING", "FAILED", "CANCELLED"],
    BLOCKED: ["RUNNING", "PLANNING", "CANCELLED"],
    WAITING_USER: ["RUNNING", "CANCELLED"],
    VERIFYING: ["COMPLETED", "FAILED", "RUNNING", "CANCELLED"],
    COMPLETED: [],
    FAILED: ["PLANNING", "CANCELLED"],
    CANCELLED: []
};

class MissionEngine {

    async create({ projectId, title, objective, priority = 3, ownerAgent = null }) {

        await initialize();

        const project = await projects.get(projectId);
        if (!project) throw new Error(`Project ${projectId} tidak ditemukan.`);

        const id = `msn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        await database.run(
            `INSERT INTO lab_missions (id, project_id, title, objective, priority, owner_agent, opencode_dir)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, projectId, title, objective, priority, ownerAgent, project.dir]
        );

        await activity.record({
            type: "mission.created", projectId, missionId: id,
            payload: { title, objective, priority, ownerAgent }
        });

        return this.get(id);

    }

    async get(id) {

        await initialize();

        const row = await database.get("SELECT * FROM lab_missions WHERE id = ?", [id]);

        if (!row) return null;

        const mission = hydrate(row);
        mission.tasks = await this.tasks(id);
        mission.progress = computeProgress(mission.tasks);
        return mission;

    }

    async list({ projectId = null, status = null, limit = 50 } = {}) {

        await initialize();

        const where = [];
        const params = [];

        if (projectId) { where.push("project_id = ?"); params.push(projectId); }
        if (status) { where.push("status = ?"); params.push(status); }

        const rows = await database.all(
            `SELECT * FROM lab_missions ${where.length ? "WHERE " + where.join(" AND ") : ""}
             ORDER BY updated_at DESC LIMIT ?`,
            [...params, limit]
        );

        return rows.map(hydrate);

    }

    async tasks(missionId) {

        const rows = await database.all(
            "SELECT * FROM lab_tasks WHERE mission_id = ? ORDER BY created_at ASC, id ASC",
            [missionId]
        );

        return rows.map(t => ({
            id: t.id, missionId: t.mission_id, title: t.title, agent: t.agent,
            status: t.status, output: t.output,
            toolTrace: safeJson(t.tool_trace, []),
            createdAt: t.created_at, updatedAt: t.updated_at
        }));

    }

    /**
     * Transisi status misi — satu-satunya jalur mengubah status.
     * Transisi ilegal melempar error + event (dicatat, bukan ditelan §31).
     */
    async transition(id, next, { reason = null, actor = "aether" } = {}) {

        await initialize();

        const row = await database.get("SELECT status FROM lab_missions WHERE id = ?", [id]);
        if (!row) throw new Error(`Misi ${id} tidak ditemukan.`);

        const from = row.status;
        const to = String(next ?? "").toUpperCase();

        if (!STATES.includes(to)) {
            throw new Error(`Status misi tidak dikenal: ${next}`);
        }

        if (from === to) return this.get(id);

        if (!TRANSITIONS[from]?.includes(to)) {
            await activity.record({
                type: "mission.failed", missionId: id,
                payload: { invalidTransition: true, from, to, reason }
            });
            throw new Error(`Transisi misi ${from} → ${to} tidak valid. Dari ${from}: ${(TRANSITIONS[from] ?? []).join(", ") || "—"}`);
        }

        await database.run(
            `UPDATE lab_missions SET status=?, error=?, updated_at=datetime('now') WHERE id=?`,
            [to, to === "FAILED" ? (reason ?? row.error) : null, id]
        );

        const eventType =
            to === "RUNNING" ? "mission.started"
            : to === "QUEUED" ? "mission.queued"
            : to === "BLOCKED" ? "mission.blocked"
            : to === "WAITING_USER" ? "mission.waiting_user"
            : to === "VERIFYING" ? "mission.verifying"
            : to === "COMPLETED" ? "mission.completed"
            : to === "FAILED" ? "mission.failed"
            : to === "CANCELLED" ? "mission.cancelled"
            : null;

        const mission = await this.get(id);

        if (eventType) {
            await activity.record({
                type: eventType, projectId: mission.projectId, missionId: id,
                payload: { from, to, reason, actor, progress: mission.progress }
            });
        }

        return mission;

    }

    /**
     * JALANKAN misi: delegasi penuh ke orchestrator yang ada, dengan
     * konteks project (fase → afinitas agent) disuntik sebagai
     * constraint planner. Aether bebas menugaskan siapa pun; tabel
     * fase hanya memandu preferensi, bukan membatasi.
     */
    async run(id, { actor = "user", exec = null } = {}) {

        const mission = await this.get(id);
        if (!mission) throw new Error(`Misi ${id} tidak ditemukan.`);

        const project = await projects.get(mission.projectId);

        // PLANNING/QUEUED/FAILED → RUNNING dulu (transisi valid).
        if (["PLANNING", "QUEUED"].includes(mission.status)) {
            if (mission.status === "PLANNING") await this.transition(id, "QUEUED", { actor });
            await this.transition(id, "RUNNING", { actor });
        }
        else if (mission.status !== "RUNNING" && mission.status !== "BLOCKED" && mission.status !== "WAITING_USER") {
            throw new Error(`Misi ${mission.status} tidak bisa dijalankan.`);
        }

        const orchestrator = require("../services/orchestrator");

        const preferAgents = projects.agentsForPhase(project.phase);

        const contextual =
            `[LAB — misi ${id} "${mission.title}"]\n` +
            `Objective: ${mission.objective ?? mission.title}\n` +
            `Project: ${project.title} (fase ${project.phase}) — folder kerja: ${project.dir}\n` +
            `Semua operasi berkas/terminal/koding di dalam folder project.\n` +
            `Agent yang cocok untuk fase ${project.phase}: ${preferAgents.join(", ")} — pilih paling sesuai, boleh lintas bila perlu.\n` +
            `Untuk menulis/mengubah kode, delegasikan ke opencode via opencode_run (dir=${project.dir}).\n` +
            `Setelah langkah selesai, laporkan artefak yang dihasilkan (file/repo/laporan).`;

        // Task tracking: satu task per langkah plan.
        const onEvent = async (event) => {

            if (event.type === "plan") {

                const plan = event.plan ?? {};
                const steps = plan.steps ?? [];

                // Reset tasks lama (re-run) lalu buat task per langkah.
                await database.run("DELETE FROM lab_tasks WHERE mission_id = ?", [id]);

                for (const step of steps) {
                    const tid = `tsk-${id}-${step.id}`;
                    await database.run(
                        `INSERT INTO lab_tasks (id, mission_id, title, agent, status) VALUES (?, ?, ?, ?, 'pending')`,
                        [tid, id, step.task, step.agent]
                    );
                }

                await this.touch(id, { plan });

            }
            else if (event.type === "step:start") {
                const tid = `tsk-${id}-${event.step.id}`;
                await database.run(
                    `UPDATE lab_tasks SET status='running', updated_at=datetime('now') WHERE id=?`, [tid]
                );
                await activity.record({
                    type: "agent.started", projectId: mission.projectId, missionId: id,
                    agentId: event.step.agent, payload: { task: event.step.task }
                });
                await this.recomputeProgress(id);
            }
            else if (event.type === "step:done") {
                const tid = `tsk-${id}-${event.step.id}`;
                await database.run(
                    `UPDATE lab_tasks SET status=?, output=?, updated_at=datetime('now') WHERE id=?`,
                    [event.ok ? "done" : "failed", truncate(String(event.output ?? event.error ?? "")), tid]
                );
                await activity.record({
                    type: event.ok ? "agent.completed" : "agent.failed",
                    projectId: mission.projectId, missionId: id,
                    agentId: event.step.agent,
                    payload: { task: event.step.task, error: event.ok ? null : event.error }
                });
                await this.recomputeProgress(id);
            }

        };

        let result;

        try {

            // N2 Round-3 — INVARIAN DELEGI: misi berawal dari
            // inisiator nyata (API/console) → warisi otoritasnya.
            // Tidak ada grant di sini; grant internal hanya untuk
            // pemanggil runtime yang benar-benar otonom.
            result = await orchestrator.run(contextual, onEvent, { exec });

        }
        catch (error) {

            await activity.record({
                type: "mission.failed", projectId: mission.projectId, missionId: id,
                payload: { reason: error.message }
            });

            await database.run(
                `UPDATE lab_missions SET status='FAILED', error=?, updated_at=datetime('now') WHERE id=?`,
                [error.message, id]
            );

            throw error;

        }

        // JAMIN KODE BENAR-BENAR DITULIS.
        //
        // Dulu run() hanya mengorkestrasi agent yang MENYARANKAN opencode
        // tapi kerap berhenti di analisa — hasilnya "project" tanpa satu
        // pun file. Kini bila fase project sudah masuk tahap membangun
        // (PROTOTYPE ke atas) ATAU objektifnya jelas meminta membangun
        // (integrasi/buat/implement/kode/aplikasi/tool/fitur), opencode
        // DIJALANKAN LANGSUNG di folder project — menulis file sungguhan.
        const CODING_PHASES = new Set(["PROTOTYPE", "IMPLEMENTATION", "TESTING", "RELEASE"]);
        const buildIntent = /buat|bikin|integrasi|integrate|implement|kode|coding|code|aplikasi|\bapp\b|tool|fitur|feature|build|develop|program|script|scrape|bot|dashboard|website|situs/i
            .test(`${mission.objective ?? ""} ${mission.title ?? ""}`);

        if (project.dir && (CODING_PHASES.has(project.phase) || buildIntent)) {
            try {
                const { runOpenCode } = require("../services/opencodeTools");
                const oc = await runOpenCode({
                    instruction:
                        `${mission.objective ?? mission.title}. ` +
                        `Tulis/ubah kode yang diperlukan DI FOLDER INI: buat file, struktur, dan implementasi nyata ` +
                        `(bukan sekadar rencana). Setelah selesai, ringkas file yang dibuat/diubah.`,
                    dir: project.dir,
                    purpose: `lab-${mission.projectId}`
                });
                result.final = `${result.final ?? ""}\n\n— OpenCode (${oc.ok ? "berhasil menulis kode" : "gagal"}) —\n${String(oc.output ?? "").slice(0, 2000)}`;
                await activity.record({
                    type: oc.ok ? "agent.completed" : "agent.failed",
                    projectId: mission.projectId, missionId: id, agentId: "opencode",
                    payload: { task: "tulis kode nyata (opencode)", error: oc.ok ? null : "opencode gagal" }
                });
            }
            catch (error) {
                result.final = `${result.final ?? ""}\n\n— OpenCode gagal dijalankan: ${error.message}`;
            }
        }

        // Simpan HASILNYA sebelum transisi apa pun.
        await this.saveResult(id, result.final);

        // Semua langkah OK → VERIFYING (verifikasi ringan: hasil final ada).
        const allOk = (result.steps ?? []).every(s => s.ok !== false);

        if (allOk) {
            await this.transition(id, "VERIFYING", { reason: "semua langkah selesai" });
            await this.transition(id, "COMPLETED", { reason: "hasil final terverifikasi tersedia" });
        }
        else {
            await this.transition(id, "FAILED", { reason: "ada langkah gagal" });
        }

        // Laporan misi terdaftar sebagai artefak. Prompt sudah meminta
        // agent "laporkan artefak yang dihasilkan", tetapi tidak ada
        // satu pun kode yang mencatatnya — jadi panel Artefak tetap
        // kosong betapa pun banyak misi dijalankan.
        await this.recordReport(id, mission.projectId, result);

        // Simpan sesi opencode yang terpakai misi ini (§12) bila ada.
        await this.captureOpenCodeSession(id, mission.projectId);

        return { ...result, mission: await this.get(id) };

    }

    /** Simpan jawaban akhir misi. */
    async saveResult(id, final) {

        const teks = String(final ?? "").trim();

        if (!teks) return;

        await database.run(
            `UPDATE lab_missions SET result=?, result_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
            [truncate(teks, 20000), id]
        );

    }

    /**
     * Catat laporan misi sebagai artefak, berikut berkas yang tersentuh.
     *
     * Kegagalan di sini tidak boleh menjatuhkan misi yang sudah selesai:
     * artefak adalah catatan, bukan syarat keberhasilan.
     */
    async recordReport(missionId, projectId, result) {

        try {

            const artifacts = require("./ArtifactRegistry");
            const mission = await this.get(missionId);

            const langkah = (result.steps ?? []).length;
            const gagal = (result.steps ?? []).filter(s => s.ok === false).length;

            await artifacts.create({
                projectId,
                missionId,
                agentId: mission?.ownerAgent ?? null,
                kind: "report",
                name: `Laporan: ${mission?.title ?? missionId}`,
                summary: truncate(String(result.final ?? "").trim(), 1200) || "Misi selesai tanpa ringkasan.",
                provenance: {
                    source: "mission",
                    steps: langkah,
                    failed: gagal,
                    agents: [...new Set((result.steps ?? []).map(s => s.step?.agent ?? s.agent).filter(Boolean))]
                }
            });

        }
        catch { /* artefak bersifat catatan, bukan syarat */ }

    }

    /** Progress deterministik dari tasks — 0..1. */
    async recomputeProgress(id) {

        const tasks = await this.tasks(id);

        if (!tasks.length) return 0;

        const done = tasks.filter(t => t.status === "done" || t.status === "skipped").length;
        const failed = tasks.filter(t => t.status === "failed").length;

        const progress = (done + failed) / tasks.length;

        await database.run(
            `UPDATE lab_missions SET progress=?, updated_at=datetime('now') WHERE id=?`,
            [progress, id]
        );

        await activity.record({
            type: "mission.progress", missionId: id,
            payload: { progress, done, failed, total: tasks.length }
        });

        return progress;

    }

    /**
     * Sesi OpenCode misi (§12): ambil sesi terbaru dari opencodeTools
     * in-memory bila misi ini memakainya, simpan agar lanjutan misi
     * tidak membuat sesi baru.
     */
    async captureOpenCodeSession(missionId, projectId) {
        try {
            const { sessions } = require("../services/opencodeTools");
            if (!sessions) return;
            const project = await projects.get(projectId);
            // cari sesi terbaru yang dir-nya cocok project
            let latest = null;
            for (const [key, sessionId] of sessions.entries()) {
                if (project && key.includes(project.dir.replace(/\\/g, "/"))) latest = sessionId;
            }
            if (latest) {
                await database.run(
                    `UPDATE lab_missions SET opencode_session=?, updated_at=datetime('now') WHERE id=?`,
                    [latest, missionId]
                );
            }
        }
        catch { /* opencodeTools opsional */ }
    }

    /** Lanjutkan misi di sesi OpenCode yang sama (§12). */
    async resume(id, instruction, { actor = "user", exec = null } = {}) {

        const mission = await this.get(id);
        if (!mission) throw new Error(`Misi ${id} tidak ditemukan.`);

        if (!mission.opencodeSession) {
            // fallback: jalankan jalur misi normal
            return this.run(id, { actor, exec });
        }

        const { runOpenCode } = require("../services/opencodeTools");

        const result = await runOpenCode({
            instruction: `[Lanjutan misi ${id}: ${mission.title}]\n${instruction}`,
            purpose: `lab-${id}`,
            dir: mission.opencodeDir ?? mission.projectDir,
            agent: undefined,
            fresh: false
        });

        await activity.record({
            type: "tool.completed", projectId: mission.projectId, missionId: id,
            agentId: "forge", tool: "opencode_run",
            payload: { ok: result.ok, resume: true }
        });

        return result;

    }

    async touch(id, patch = {}) {

        const fields = [];
        const params = [];

        if (patch.plan !== undefined) { fields.push("plan=?"); params.push(JSON.stringify(patch.plan)); }
        if (patch.opencodeSession !== undefined) { fields.push("opencode_session=?"); params.push(patch.opencodeSession); }

        if (!fields.length) return;

        params.push(id);
        await database.run(
            `UPDATE lab_missions SET ${fields.join(", ")}, updated_at=datetime('now') WHERE id=?`, params
        );

    }

    states() {
        return { list: STATES, transitions: TRANSITIONS };
    }

}

function computeProgress(tasks) {
    if (!tasks.length) return 0;
    const settled = tasks.filter(t => ["done", "failed", "skipped"].includes(t.status)).length;
    return settled / tasks.length;
}

function hydrate(row) {
    return {
        id: row.id, projectId: row.project_id, title: row.title,
        objective: row.objective, status: row.status, priority: row.priority,
        ownerAgent: row.owner_agent,
        plan: safeJson(row.plan, {}),
        progress: row.progress ?? 0,
        result: row.result ?? null,
        resultAt: row.result_at ?? null,
        opencodeSession: row.opencode_session,
        opencodeDir: row.opencode_dir, opencodeBranch: row.opencode_branch,
        error: row.error,
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function safeJson(text, fallback) {
    try { return JSON.parse(text ?? "") ?? fallback; }
    catch { return fallback; }
}

function truncate(s, n = 4000) {
    return s.length > n ? s.slice(0, n) + "…" : s;
}

module.exports = new MissionEngine();
