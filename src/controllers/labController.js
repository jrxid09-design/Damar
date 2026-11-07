const fs = require("node:fs");
const path = require("node:path");

const response = require("../utils/response");

const pathPolicy = require("../core/safety/pathPolicy");
const telemetry = require("../services/telemetryService");

const lab = require("../lab/LabService");

/**
 * LabController — HTTP tipis untuk Damar Lab.
 * Semua logika di src/lab/*; controller hanya memvalidasi &
 * membungkus response (mengikat this sekali di bawah).
 */

class LabController {

    // ---- Projects -------------------------------------------------

    async projectsList(req, res, next) {
        try {
            const items = await lab.projects.list({ status: req.query.status ?? null });
            const withStats = await Promise.all(items.map(async p => ({ ...p, stats: await lab.projects.stats(p.id) })));
            return response.success(res, "Daftar project", { projects: withStats });
        }
        catch (error) { next(error); }
    }

    async projectCreate(req, res, next) {

        try {

            const { dir, title, goal, description, phase, config } = req.body ?? {};

            if (!dir) {
                return response.error(res, "Field 'dir' (path folder) wajib diisi.", 400);
            }

            try {
                pathPolicy.assertPathAllowed(dir, true);
            }
            catch (error) {
                return response.error(res, error.message, 403);
            }

            const abs = path.resolve(String(dir));

            if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });

            if (!fs.statSync(abs).isDirectory()) {
                return response.error(res, `"${abs}" bukan folder.`, 400);
            }

            const project = await lab.projects.create({
                dir: abs, title: title ?? path.basename(abs),
                goal, description, phase, config
            });

            telemetry.info(`[lab] project: ${project.title} (${abs})`);

            return response.success(res, "Project siap", { project }, 201);

        }
        catch (error) { next(error); }
    }

    async projectGet(req, res, next) {
        try {
            const project = await lab.projects.get(req.params.id);
            if (!project) return response.error(res, "Project tidak ditemukan.", 404);
            const [stats, timeline] = await Promise.all([
                lab.projects.stats(project.id),
                lab.projects.timeline(project.id)
            ]);
            return response.success(res, "Project", { project, stats, timeline });
        }
        catch (error) { next(error); }
    }

    /** Buka folder project di VS Code (mempermudah pengerjaan manual). */
    async projectOpenVSCode(req, res, next) {
        try {
            const project = await lab.projects.get(req.params.id);
            if (!project) return response.error(res, "Project tidak ditemukan.", 404);
            if (!project.dir) return response.error(res, "Project tak punya folder kerja.", 400);

            const { spawn } = require("node:child_process");
            const path = require("node:path");
            const fs = require("node:fs");

            let executable = "code";

            if (process.platform === "win32") {
                const localAppData = process.env.LOCALAPPDATA;

                const codeExe = localAppData
                    ? path.join(
                        localAppData,
                        "Programs",
                        "Microsoft VS Code",
                        "Code.exe"
                    )
                    : null;

                if (!codeExe || !fs.existsSync(codeExe)) {
                    return response.error(
                        res,
                        "VS Code tidak ditemukan.",
                        500
                    );
                }

                executable = codeExe;
            }

            const child = spawn(executable, [project.dir], {
                detached: true,
                stdio: "ignore",
                shell: false,
                windowsHide: true
            });
            child.on("error", () => { /* 'code' tak ada di PATH → diabaikan */ });
            child.unref();

            return response.success(res, "VS Code dibuka", { dir: project.dir });
        }
        catch (error) { next(error); }
    }

    async projectUpdate(req, res, next) {
        try {
            const project = await lab.projects.update(req.params.id, req.body ?? {});
            return response.success(res, "Project diperbarui", { project });
        }
        catch (error) { next(error); }
    }

    async projectPhase(req, res, next) {
        try {
            const project = await lab.projects.setPhase(req.params.id, req.body?.phase);
            return response.success(res, "Fase berubah", { project });
        }
        catch (error) {
            return response.error(res, error.message, 409);
        }
    }

    async projectRemove(req, res, next) {
        try {
            // Lepas dari daftar lab: archive, bukan delete fisik.
            const project = await lab.projects.update(req.params.id, { status: "archived" });
            return response.success(res, "Project diarsipkan", { project });
        }
        catch (error) { next(error); }
    }

    /** Isi folder project — intip cepat (sandbox folder project). */
    async projectBrowse(req, res, next) {

        try {

            const project = await lab.projects.get(req.params.id);
            if (!project) return response.error(res, "Project tidak ditemukan.", 404);

            const rel = String(req.query.path ?? "");
            const target = path.resolve(project.dir, rel);

            if (!target.startsWith(path.resolve(project.dir))) {
                return response.error(res, "Di luar folder project.", 403);
            }

            const entries = fs.readdirSync(target, { withFileTypes: true })
                .filter(e => !e.name.startsWith("."))
                .map(e => ({
                    name: e.name,
                    dir: e.isDirectory(),
                    size: e.isDirectory() ? null : safeSize(path.join(target, e.name))
                }))
                .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
                .slice(0, 200);

            return response.success(res, "Isi folder", { dir: target, entries });

        }
        catch (error) { next(error); }
    }

    async projectTimeline(req, res, next) {
        try {
            const timeline = await lab.projects.timeline(req.params.id, { limit: Number(req.query.limit ?? 60) });
            return response.success(res, "Timeline", { timeline });
        }
        catch (error) { next(error); }
    }

    // ---- Missions -------------------------------------------------

    async missionsList(req, res, next) {
        try {
            const items = await lab.missions.list({
                projectId: req.query.project ?? null,
                status: req.query.status ?? null
            });
            return response.success(res, "Daftar misi", { missions: items });
        }
        catch (error) { next(error); }
    }

    async missionCreate(req, res, next) {
        try {
            const { projectId, title, objective, priority, ownerAgent } = req.body ?? {};
            if (!projectId || !title) {
                return response.error(res, "projectId & title wajib.", 400);
            }
            const mission = await lab.missions.create({ projectId, title, objective, priority, ownerAgent });
            return response.success(res, "Misi dibuat", { mission }, 201);
        }
        catch (error) { next(error); }
    }

    async missionGet(req, res, next) {
        try {
            const mission = await lab.missions.get(req.params.id);
            if (!mission) return response.error(res, "Misi tidak ditemukan.", 404);
            return response.success(res, "Misi", { mission });
        }
        catch (error) { next(error); }
    }

    async missionRun(req, res, next) {
        try {
            // N2 Round-3: inisiator HTTP mewarisi otoritasnya ke misi.
            const result = await lab.missions.run(req.params.id, { actor: req.body?.actor ?? "user", exec: req.authIdentity ?? null });
            return response.success(res, "Misi selesai", result);
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    /**
     * TERAPKAN hasil misi ke Damar utama.
     *
     * Tanpa ini Lab jadi ruangan tertutup: misi selesai, laporannya
     * bagus, lalu berhenti di sana — Damar yang melayani Console,
     * WhatsApp, Telegram, dan CLI tidak tahu apa pun tentangnya, dan
     * pemiliknya harus menceritakan ulang. Empat sasaran, sesuai apa
     * yang sebenarnya ingin dilakukan dengan sebuah temuan:
     *
     *   memory   — jadikan pengetahuan Damar (berlaku di semua kanal)
     *   beranda  — tampilkan sekarang sebagai popup di dashboard
     *   followup — ubah temuan jadi misi berikutnya yang bisa dijalankan
     *   code     — teruskan ke opencode agar patch-nya benar-benar ditulis
     */
    async missionApply(req, res, next) {

        try {

            const target = String(req.body?.target ?? "").toLowerCase();
            const mission = await lab.missions.get(req.params.id);

            if (!mission) {
                return response.error(res, "Misi tidak ditemukan.", 404);
            }

            const hasil = String(mission.result ?? "").trim();

            if (!hasil) {
                return response.error(
                    res,
                    "Misi ini belum punya hasil yang bisa diterapkan — jalankan dulu.",
                    400
                );
            }

            const judul = mission.title ?? mission.id;

            if (target === "memory") {

                const ingatan = await lab.memory.remember(mission.projectId, {
                    type: "fact",
                    content: `[Lab · ${judul}] ${hasil}`
                });

                // Hasil panjang juga masuk knowledge supaya bisa dicari
                // per bagian, bukan cuma sebagai satu kepingan memori.
                let dokumen = null;
                if (hasil.length > 400) {
                    dokumen = await lab.memory
                        .ingestKnowledge(mission.projectId, {
                            text: hasil,
                            title: `Laporan misi: ${judul}`
                        })
                        .catch(() => null);
                }

                return response.success(res, "Hasil masuk memori Damar", {
                    memory: ingatan, document: dokumen
                });

            }

            if (target === "beranda") {

                // Jalur yang sama dengan foto & pemutar lagu: renderer
                // sudah mendengarkan damar:present dan membuka popup.
                telemetry.publish("damar:present", {
                    kind: "text",
                    title: `Hasil misi: ${judul}`,
                    text: hasil,
                    caption: `Laboratorium · ${mission.projectId}`
                });

                return response.success(res, "Ditampilkan di Beranda", { shown: true });

            }

            if (target === "followup") {

                const lanjutan = await lab.missions.create({
                    projectId: mission.projectId,
                    title: `Tindak lanjut: ${judul}`,
                    objective:
                        `Tindak lanjuti temuan misi sebelumnya (${mission.id}).\n\n` +
                        `TEMUAN:\n${hasil}\n\n` +
                        `Kerjakan langkah nyata yang diperlukan, bukan meringkas ulang temuannya.`,
                    ownerAgent: mission.ownerAgent
                });

                return response.success(res, "Misi lanjutan dibuat", { mission: lanjutan }, 201);

            }

            if (target === "code") {

                const instruksi = String(req.body?.instruction ?? "").trim()
                    || `Terapkan temuan berikut ke kode di folder project. ` +
                       `Tulis perubahannya, jangan hanya menjelaskan.\n\n${hasil}`;

                const hasilKode = await lab.missions.resume(mission.id, instruksi);

                return response.success(res, "Diteruskan ke opencode", { result: hasilKode });

            }

            return response.error(
                res,
                "Sasaran tidak dikenal. Pilih: memory, beranda, followup, atau code.",
                400
            );

        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    async missionTransition(req, res, next) {
        try {
            const mission = await lab.missions.transition(
                req.params.id,
                req.body?.status,
                { reason: req.body?.reason, actor: req.body?.actor ?? "user" }
            );
            return response.success(res, "Status misi berubah", { mission });
        }
        catch (error) {
            return response.error(res, error.message, 409);
        }
    }

    async missionResume(req, res, next) {
        try {
            const result = await lab.missions.resume(req.params.id, req.body?.instruction ?? "", { exec: req.authIdentity ?? null });
            return response.success(res, "Lanjutan misi", result);
        }
        catch (error) { next(error); }
    }

    // ---- Activity / status / instruments ---------------------------

    async activityList(req, res, next) {
        try {
            const events = await lab.activity.list({
                projectId: req.query.project ?? null,
                missionId: req.query.mission ?? null,
                limit: Number(req.query.limit ?? 80),
                afterId: Number(req.query.after ?? 0)
            });
            return response.success(res, "Aktivitas", { events });
        }
        catch (error) { next(error); }
    }

    async agentsBoard(req, res, next) {
        try {
            const agentHub = require("../services/agentHub");
            const roster = agentHub.describe().map(a => ({
                id: a.id, label: a.label, kind: a.kind,
                description: a.description, skills: a.skills,
                status: lab.statusBoard.get(a.id)
            }));
            return response.success(res, "Papan agent", { agents: roster, states: lab.statusBoard.states() });
        }
        catch (error) { next(error); }
    }

    async instrumentsList(req, res, next) {
        try {
            const catalog = await lab.instruments.catalog();
            return response.success(res, "Instrumen", { instruments: catalog });
        }
        catch (error) { next(error); }
    }

    // ---- Artifacts / decisions / experiments / tests ----------------

    async artifactsList(req, res, next) {
        try {
            const items = await lab.artifacts.list({
                projectId: req.query.project ?? null,
                missionId: req.query.mission ?? null
            });
            return response.success(res, "Artefak", { artifacts: items });
        }
        catch (error) { next(error); }
    }

    async artifactCreate(req, res, next) {
        try {
            const a = await lab.artifacts.create(req.body ?? {});
            return response.success(res, "Artefak dibuat", { artifact: a }, 201);
        }
        catch (error) { next(error); }
    }

    async decisionsList(req, res, next) {
        try {
            const items = await lab.decisions.list({
                projectId: req.query.project ?? null,
                missionId: req.query.mission ?? null
            });
            return response.success(res, "Keputusan", { decisions: items });
        }
        catch (error) { next(error); }
    }

    async decisionCreate(req, res, next) {
        try {
            const d = await lab.decisions.create(req.body ?? {});
            return response.success(res, "Keputusan dicatat", { decision: d }, 201);
        }
        catch (error) { next(error); }
    }

    async experimentsList(req, res, next) {
        try {
            const items = await lab.experiments.list({ projectId: req.query.project ?? null });
            return response.success(res, "Eksperimen", { experiments: items });
        }
        catch (error) { next(error); }
    }

    async experimentCreate(req, res, next) {
        try {
            const e = await lab.experiments.create(req.body ?? {});
            return response.success(res, "Eksperimen dibuat", { experiment: e }, 201);
        }
        catch (error) { next(error); }
    }

    async experimentRun(req, res, next) {
        try {
            let exp = await lab.experiments.start(req.params.id);
            // Run eksperimen dieksekusi sebagai misi di project terkait.
            const mission = await lab.missions.create({
                projectId: exp.projectId,
                title: `Eksperimen: ${exp.hypothesis.slice(0, 60)}`,
                objective: exp.objective ?? exp.hypothesis
            });
            await lab.missions.transition(mission.id, "QUEUED");
            const runResult = await lab.missions.run(mission.id, { exec: req.authIdentity ?? null });
            exp = await lab.experiments.complete(req.params.id, {
                conclusion: String(runResult?.final ?? "").slice(0, 2000),
                metrics: { missionId: mission.id }
            });
            return response.success(res, "Eksperimen selesai", { experiment: exp, mission: runResult.mission });
        }
        catch (error) { next(error); }
    }

    async testRun(req, res, next) {
        try {
            const t = await lab.testChamber.run({
                projectId: req.body?.projectId ?? req.query.project,
                missionId: req.body?.missionId ?? null,
                category: req.body?.category ?? "unit"
            });
            return response.success(res, t.ok ? "Test lulus" : "Test gagal", t, t.ok ? 200 : 200);
        }
        catch (error) { next(error); }
    }

    // ---- Memory / knowledge / snapshots -----------------------------

    async memoryRemember(req, res, next) {
        try {
            const saved = await lab.memory.remember(req.params.id, req.body ?? {});
            return response.success(res, "Memori project tersimpan", { memory: saved }, 201);
        }
        catch (error) { next(error); }
    }

    async memoryRecall(req, res, next) {
        try {
            const r = await lab.memory.recall(req.params.id, req.query.q ?? "", { limit: Number(req.query.limit ?? 6) });
            return response.success(res, "Recall project", r);
        }
        catch (error) { next(error); }
    }

    async memorySummary(req, res, next) {
        try {
            const s = await lab.memory.summary(req.params.id);
            return response.success(res, "Memori & knowledge project", s);
        }
        catch (error) { next(error); }
    }

    async knowledgeIngest(req, res, next) {
        try {
            const doc = await lab.memory.ingestKnowledge(req.params.id, req.body ?? {});
            return response.success(res, "Knowledge masuk", { document: doc }, 201);
        }
        catch (error) { next(error); }
    }

    async snapshotCreate(req, res, next) {
        try {
            const snap = await lab.snapshots.snapshot({
                projectId: req.params.id, label: req.body?.label
            });
            return response.success(res, "Snapshot dibuat", { snapshot: snap }, 201);
        }
        catch (error) { next(error); }
    }

    async snapshotsList(req, res, next) {
        try {
            const items = await lab.snapshots.list(req.params.id);
            return response.success(res, "Snapshots", { snapshots: items });
        }
        catch (error) { next(error); }
    }

}

function safeSize(file) {
    try { return fs.statSync(file).size; }
    catch { return null; }
}

// Express memanggil handler lepas — ikat this sekali.
const controller = new LabController();

for (const name of Object.getOwnPropertyNames(LabController.prototype)) {
    if (name !== "constructor" && typeof controller[name] === "function") {
        controller[name] = controller[name].bind(controller);
    }
}

module.exports = controller;
