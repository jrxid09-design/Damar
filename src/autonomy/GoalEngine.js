const { database, initialize } = require("../memory/db");

const toolBus = require("./ToolBus");
const capabilities = require("./CapabilityRegistry");
const skillFactory = require("./SkillFactory");
const healing = require("./SelfHealingEngine");
const modelRouter = require("./ModelRouter");
const checkpoints = require("./CheckpointSystem");

const telemetry = require("../services/telemetryService");

/**
 * GOAL ENGINE + AUTONOMY LOOP (§16-§19, §56 Definition of Done).
 *
 * Tujuan bahasa alami → objek terstruktur (§50) → loop persisten:
 *
 *   OBSERVE (env+registry) → THINK (klasifikasi model) → PLAN
 *   → ACT (ToolBus, misi Lab bila ada project) → OBSERVE RESULT
 *   → EVALUATE (kriteria sukses) → ADAPT (pulihkan/substitusi/buat
 *   kapabilitas) → ACT AGAIN — sampai:
 *
 *   SUCCESS | IMPOSSIBLE | POLICY BLOCK | HUMAN DECISION §16.
 *
 * Satu tool gagal TIDAK menghentikan tujuan (§16). Loop berjalan
 * dengan batas iterasi sumber daya, interruptible via status pause.
 */

const MAX_ITERATIONS = 8;          // batas adaptasi per tujuan
const MAX_SKILL_CREATIONS = 3;     // cegah pembuatan skill liar

const PROMPT_PLAN = (goal) =>
    `Kamu perencana otonom Damar. Tujuan: "${goal.title}"\n` +
    (goal.description ? `Deskripsi: ${goal.description}\n` : "") +
    "Susun rencana JSON: {\"steps\":[{\"n\":1,\"action\":\"...\",\"tool\":null,\"successWhen\":\"...\"}]}\n" +
    "Aturan: action = tugas konkret yang DISELESAIKAN TOOL (bukan 'laporkan ke pengguna' — laporan dibuat setelah loop). " +
    "Pilih langkah SEMINIMAL mungkin (idealnya 1-2). tool = nama tool bila jelas (boleh null — akan dicari otomatis). " +
    "successWhen = kondisi objektif pada HASIL tool. Jawab HANYA JSON.";

const PROMPT_EVALUATE = (goal, step, outcome) => {
    // Serialisasi hasil yang AMAN: objek → JSON (bukan "[object Object]").
    let hasil = outcome.error ?? "";
    if (outcome.result != null) {
        try { hasil = typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result); }
        catch { hasil = String(outcome.result); }
    }
    return `Evaluasi langkah otonom. Tujuan: "${goal.title}".\n` +
        `Langkah: ${step.action}\nHasil: ${JSON.stringify(hasil).slice(0, 1200)}\n` +
        "Apakah langkah ini mencapai: " + (step.successWhen ?? "kemajuan menuju tujuan") +
        "? Jawab JSON {\"verdict\":\"pass|fail|impossible\",\"note\":\"...\"}";
};

const PROMPT_SKILL_SPEC = (goal, step, finding) =>
    `Damar butuh kapabilitas baru. Kebutuhan: "${step.action}" (konteks tujuan: "${goal.title}").\n` +
    (finding?.note ? `Catatan: ${finding.note}\n` : "") +
    "Susun SPESIFIKASI skill JSON dengan bentuk: " +
    '{"id":"kebab-case","name":"Judul","description":"... (min 20 kata)",' +
    '"tool_name":"camelCase","parameters":{"param1":{"type":"string","description":"...","required":true}},' +
    '"code":"..."}\n' +
    "Isi 'code' dengan modul Node.js murni bentuk: module.exports = class Tool { constructor(){ this.name='NAMA_TOOL'; this.description='...'; this.parameters={...}; } async execute(args){ /* implementasi */ return {ok:true, hasil:...}; } }\n" +
    "Kode HARUS: Node.js murni (hanya modul bawaan node:), TANPA npm eksternal, return objek JSON-able, selesai < 10 detik. Jawab HANYA JSON.";

class GoalEngine {

    /**
     * Terjemahkan niat alami → goal terstruktur (§50) + simpan.
     */
    async create({ title, description = null, priority = "normal", successCriteria = [], constraints = [], projectId = null, schedule = null }) {

        await initialize();

        const id = `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

        await database.run(
            `INSERT INTO goals (id, title, description, priority, success_criteria, constraints, project_id, schedule)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, title, description, priority,
             JSON.stringify(successCriteria ?? []), JSON.stringify(constraints ?? []),
             projectId, schedule]
        );

        await this.log(id, "goal.created", `tujuan dibuat: ${title}`, `prioritas ${priority}`, [], true);

        return this.get(id);

    }

    async get(id) {

        await initialize();

        const row = await database.get("SELECT * FROM goals WHERE id = ?", [id]);
        return row ? hydrate(row) : null;

    }

    async list({ status = null, limit = 50 } = {}) {

        await initialize();

        const rows = status
            ? await database.all("SELECT * FROM goals WHERE status=? ORDER BY updated_at DESC LIMIT ?", [status, limit])
            : await database.all("SELECT * FROM goals ORDER BY updated_at DESC LIMIT ?", [limit]);

        return rows.map(hydrate);

    }

    /**
     * N2-FINAL — derivasi delegasi tujuan HANYA lewat titik kanonik.
     * `internal` tidak pernah bisa berasal dari arg model/tool.
     */
    resolveDelegator(exec, internal = false) {
        const { resolveDelegator } = require("../ai/tools/Authorization");
        return resolveDelegator(exec, internal === true, "goal");
    }

    /** Peran giliran LLM (planner/evaluator/spec) untuk satu delegasi. */
    turnRole(delegator) {
        const agentHub = require("../services/agentHub");
        return agentHub.delegatedRoleOf(delegator);
    }

    /** A-FINAL + M-1: restriction delegasi ikut ke SETIAP giliran LLM
     *  internal (planner/evaluator/spec) — giliran penalar pun tidak boleh
     *  kehilangan capabilitySet. Normalisasi via toCapabilitySet: bentuk
     *  tak dikenal fail-closed, id string/Set ikut sebagai narrowing —
     *  tidak ada lagi jalur pelucutan diam-diam. */
    turnRestrictions(delegator) {
        const { toCapabilitySet } = require("../ai/tools/Authorization");
        const set = toCapabilitySet(delegator?.capabilitySet);
        return set ? { capabilitySet: set } : {};
    }

    /**
     * LOOP OTONOM — jalankan tujuan sampai selesai/batas.
     * Mengembalikan hasil akhir; state tersimpan di DB (§34 persist).
     *
     * N2 Round-3 — INVARIAN DELEGI:
     *   effective delegated authority <= initiator authority.
     * `exec` = identitas INISIATOR (manusia/model) yang mewarisi ke
     * seluruh delegasi. `internal:true` HANYA boleh diset oleh kode
     * runtime tepercaya (scheduler/pulse/self-healing) yang memanggil
     * metode ini langsung — TIDAK pernah lewat arg tool/model: jalur
     * goal_run tidak meneruskan field apa pun selain exec inisiatornya,
     * sehingga grant tidak bisa dipalsukan lewat argumen model.
     */
    async run(goalId, { actor = "user", budgetMs = null, onProgress = null, exec = null, internal = false } = {}) {

        const goal = await this.get(goalId);
        if (!goal) throw new Error(`tujuan ${goalId} tidak ditemukan.`);

        // Identitas delegasi untuk SELURUH loop ini. Inisiator nyata
        // selalu menang; grant internal hanya dari pemanggil tepercaya
        // yang secara eksplisit menandai dirinya.
        const delegator = this.resolveDelegator(exec, internal === true);

        if (goal.status === "paused") {
            return { ok: false, error: "tujuan dijeda — lanjutkan dulu." };
        }

        // BATAS WAKTU TOTAL (§17 interruptible).
        //
        // Tiap lapis punya timeout sendiri (plan 60s, tool 120s×retry,
        // evaluate 45s, sub-agent bermenit-menit) dikali sampai 8
        // iterasi — satu tujuan bisa menggiling puluhan menit tanpa
        // pagar atas. Deadline ini memberi jaminan keras: loop berhenti
        // bersih begitu anggaran habis, apa pun yang sedang lambat.
        const budget = Number(budgetMs ?? process.env.DAMAR_GOAL_BUDGET_MS ?? 180000);
        const deadline = Date.now() + budget;
        const remaining = () => Math.max(0, deadline - Date.now());

        // PROGRESS observable (§32).
        //
        // Loop sudah menulis ke autonomy_log & telemetry, tetapi
        // pemanggil berdiri sendiri (skrip, panel) tak punya cara
        // melihat SAMPAI MANA tanpa mengintip basis data. Callback ini
        // memancarkan tiap fase; default no-op menjaga pemanggil lama.
        const emit = (phase, detail) => {
            try { telemetry.publish("autonomy:goal_progress", { goalId, phase, detail, remainingMs: remaining() }); }
            catch { /* progres tak boleh menjatuhkan loop */ }
            try { onProgress?.({ phase, detail, remainingMs: remaining() }); }
            catch { /* pemanggil boleh melempar; kita tidak ikut jatuh */ }
        };

        // Status → active.
        await this.setStatus(goalId, "active");

        telemetry.publish("autonomy:goal_started", { goalId, title: goal.title });
        emit("start", { title: goal.title, budgetMs: budget });

        // 1. OBSERVE — segarkan peta kapabilitas + lingkungan.
        emit("observe", "sinkron kapabilitas + lingkungan");
        await capabilities.sync();
        const env = await healing.environmentSnapshot();
        await this.log(goalId, "observe", "sinkron kapabilitas + lingkungan",
            `${(await capabilities.list({ alive: true })).length} kapabilitas aktif`, env, true);

        // 2. THINK — rute model untuk perencanaan.
        const route = modelRouter.route(`${goal.title} ${goal.description ?? ""}`);
        emit("think", `model route: ${route.model ?? "default"}`);
        await this.log(goalId, "think", `model route: ${route.model ?? "default"}`, route.why, [route], true);

        // 3. PLAN — dekomposisi via LLM (fallback: rencana 1 langkah).
        emit("plan", "menyusun rencana");
        const plan = await this.plan(goal, route, delegator);

        let steps = plan.steps ?? [];
        emit("plan_ready", { steps: steps.length });
        const results = [];
        let skillCreations = 0;
        let iteration = 0;
        let stoppedByBudget = false;

        // 4. ACT ↔ EVALUATE ↔ ADAPT per langkah.
        for (const step of steps) {

            iteration++;

            if (iteration > MAX_ITERATIONS) {
                await this.log(goalId, "act", "batas iterasi tercapai", "berhenti demi sumber daya (§16)", [], false);
                results.push({ step: step.action, ok: false, stopped: "iteration-limit" });
                break;
            }

            // Anggaran habis → berhenti bersih sebelum memulai langkah
            // baru yang bisa menahan bermenit-menit lagi.
            if (remaining() <= 0) {
                await this.log(goalId, "act", "batas waktu tercapai", "berhenti demi anggaran (§17)", [], false);
                results.push({ step: step.action, ok: false, stopped: "budget" });
                stoppedByBudget = true;
                break;
            }

            emit("step", { n: iteration, action: String(step.action).slice(0, 80), tool: step.tool ?? null });

            let outcome = await this.act(goal, step, null, remaining(), delegator);

            // Kegagalan → pemulihan berlapis (§33-34) → kapabilitas baru (§51).
            let recoveries = 0;

            while (!outcome.ok && recoveries < 2) {

                recoveries++;

                const recovery = await healing.recover({
                    tool: outcome.tool,
                    args: outcome.args,
                    error: outcome.error,
                    goalId,
                    action: step.action,
                    requirement: step.action,
                    // N2-FINAL: pemulihan transitif mewarisi inisiator
                    // tujuan — tidak pernah naik ke 'system' di sini.
                    exec: delegator
                });

                outcome = recovery.outcome.ok
                    ? { ok: true, tool: recovery.outcome.tool, result: recovery.outcome.result, via: recovery.outcome.via }
                    : outcome;

                if (outcome.ok) break;

                // Eskalasi: buat kapabilitas yang hilang (SkillFactory).
                if (recovery.outcome.escalateToFactory && skillCreations < MAX_SKILL_CREATIONS) {

                    skillCreations++;

                    const creation = await this.createCapability(goal, step, delegator);

                    if (creation?.capability?.meta?.sandboxOk) {
                        // Skill baru lulus sandbox — coba jalankan step
                        // dengan nama tool AKTUAL hasil load (meta.toolNames),
                        // bukan nama spec (bisa berbeda).
                        const names = creation.capability.meta.toolNames
                            ?? (creation.capability.meta.toolName
                                ? [`${creation.capability.name}.${creation.capability.meta.toolName}`]
                                : []);
                        for (const name of names) {
                            outcome = await this.act(goal, step, name, null, delegator);
                            if (outcome.ok) {
                                outcome.createdSkill = creation.capability.name;
                                break;
                            }
                        }
                    }

                }
                else if (recovery.outcome.escalateToFactory) {
                    await this.log(goalId, "act", "batas pembuatan skill", "§16 lanjut tanpa kapabilitas baru", [], false);
                    break;
                }

            }

            // EVALUATE — verifikasi hasil langkah (bukan percaya kata agent §19 spec Lab).
            const evaluation = outcome.ok
                ? await this.evaluate(goal, step, outcome, delegator)
                : { verdict: "fail", note: outcome.error ?? "langkah gagal" };

            results.push({
                step: step.action,
                tool: outcome.tool ?? null,
                via: outcome.via ?? null,
                createdSkill: outcome.createdSkill ?? null,
                ok: evaluation.verdict === "pass",
                verdict: evaluation.verdict,
                note: evaluation.note,
                result: outcome.result ?? null
            });

            await this.log(goalId, "verify",
                `langkah "${String(step.action).slice(0, 60)}" → ${evaluation.verdict}`,
                String(evaluation.note ?? "").slice(0, 160),
                [evaluation], evaluation.verdict === "pass");

            emit("verdict", { n: iteration, verdict: evaluation.verdict });

            if (evaluation.verdict === "impossible") {
                await this.setStatus(goalId, "impossible", evaluation.note);
                break;
            }

        }

        // 5. Hasil akhir.
        const passed = results.filter(r => r.ok).length;
        const allOk = results.length > 0 && passed === results.length;

        const final = {
            goal: goal.title,
            steps: results,
            passed,
            total: results.length,
            skillsCreated: results.filter(r => r.createdSkill).map(r => r.createdSkill),
            environment: env
        };

        await database.run(
            `UPDATE goals SET iterations = iterations + ?, last_result = ?, status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`,
            [iteration, JSON.stringify(final).slice(0, 6000),
             allOk ? "completed" : (results.some(r => r.verdict === "impossible") ? "impossible" : "failed"),
             allOk ? null : `${passed}/${results.length} langkah lulus`,
             goalId]
        );

        telemetry.publish("autonomy:goal_finished", { goalId, ok: allOk, passed, total: results.length });

        // §21: solusi sukses → memori prosedural.
        if (allOk) {
            await this.rememberProcedure(goal, final);
        }

        return { ok: allOk, ...final, goal: await this.get(goalId) };

    }

    /** SATU AKSI: pilih tool bila belum ada → eksekusi via ToolBus.
     * `delegator` = identitas inisiator tujuan (N2 Round-3). */
    async act(goal, step, forcedTool = null, remainingMs = null, delegator = null) {

        let tool = forcedTool ?? step.tool ?? null;
        let args = step.args ?? {};

        // Tool tak ter-resolve → coba map nama polos ke tool terdaftar
        // (skill forge hidup sebagai "pluginId.toolName").
        if (tool && !toolBus.resolve(tool)) {
            const mapped = this.mapToolName(tool);
            if (mapped) tool = mapped;
            else tool = null;   // jangan eksekusi nama hantu
        }

        // Tool belum ditentukan → discovery dari registry.
        if (!tool) {
            const found = await this.findToolFor(step.action);
            if (found) {
                tool = found;
                await this.log(goal.id, "act", `tool ditemukan: ${tool}`, `untuk "${String(step.action).slice(0, 60)}"`, [], true);
            }
        }

        // Masih tidak ada tool → eksekusi via agent worker (agentHub)
        // yang memilih sendiri dari profil domainnya.
        if (!tool) {
            return await this.runViaAgent(goal, step, delegator);
        }

        // Argumen minimal: tugas sebagai instruksi generik.
        if (!Object.keys(args).length) {
            args = guessArgs(tool, step.action);
            // Perintah terminal tak terekstrak → jangan tebak; pakai agent.
            if (args?.command === null) {
                return await this.runViaAgent(goal, step, delegator);
            }
        }

        // Timeout tool tidak boleh melampaui sisa anggaran tujuan —
        // kalau tidak, satu tool 120s bisa menembus deadline yang
        // seharusnya sudah menghentikan loop.
        const toolTimeout = remainingMs != null
            ? Math.max(5000, Math.min(120000, remainingMs))
            : 120000;

        const res = await toolBus.execute({
            name: tool, args, timeoutMs: toolTimeout, retries: 1, context: { goal: goal.id }
        });

        // Catat usage → trust (§39).
        await capabilities.recordUsage(`tool:${tool}`, { ok: res.ok, ms: res.durationMs, error: res.error });

        return {
            ok: res.ok,
            tool, args,
            result: res.result,
            error: res.error,
            via: res.via
        };

    }

    /** Cari tool untuk sebuah action (registry → heuristic nama). */
    async findToolFor(action) {

        const a = String(action ?? "").toLowerCase();

        // Peta heuristik bahasa → tool umum (bukan daftar tertutup —
        // registry discovery tetap jalur utama).
        const hints = [
            [/waktu|jam|tanggal|date|time/, "system.time.currentTime"],
            [/baca|read|lihat file/, "filesystem.readFile"],
            [/tulis|write|buat file/, "filesystem.writeFile"],
            [/daftar|list folder/, "filesystem.listDirectory"],
            [/test|uji/, "code_test"],
            [/commit/, "code_commit"],
            [/kamera|cctv/, "see_camera"],
            [/kesehatan|health|monitor/, "system_health"],
            [/cari di web|riset|browsing/, "browse"],
            [/ingat|memori/, "memory_remember"],
            [/kode|coding|implement/, "opencode_run"]
        ];

        for (const [re, name] of hints) {
            if (re.test(a)) {
                const exists = toolBus.resolve(name) ?? toolBus.resolve(name.split(".").pop());
                if (exists) return exists.kind === "ai" ? name : name;
            }
        }

        // Registry discovery dengan kata kunci action.
        const d = await capabilities.discover(a.split(/\s+/).slice(0, 3).join(" "), { limit: 3 });
        const best = (d.capabilities ?? d)[0];
        if (best?.kind === "tool") return best.name;

        // Pencarian SEMANTIK ke seluruh tool termuat (§36/§51).
        //
        // Tanpa ini, tugas yang tidak kebetulan cocok dengan salah satu
        // hint hardcoded langsung jatuh ke agent yang model-loop lalu
        // lambat/timeout — persis "fixed-capability thinking" yang §2
        // larang. Di sini setiap tool dinilai dari tumpang-tindih kata
        // tugas dengan nama + deskripsinya; yang paling cocok dipakai
        // langsung. Ini yang membuat tool-finding bekerja untuk tugas
        // yang belum pernah ada aturannya.
        const kata = new Set(a.split(/[^a-z0-9]+/).filter(w => w.length >= 3));

        if (kata.size) {
            let terbaik = null, skor = 0;
            for (const t of toolBus.discover()) {
                const nama = String(t.name ?? "").toLowerCase();
                const desk = String(t.description ?? "").toLowerCase();
                let s = 0;
                for (const w of kata) {
                    if (nama.includes(w)) s += 3;      // nama tool = sinyal kuat
                    else if (desk.includes(w)) s += 1; // deskripsi = sinyal lemah
                }
                if (s > skor) { skor = s; terbaik = t.name; }
            }
            // Ambang: minimal satu kecocokan nama, atau dua deskripsi.
            if (terbaik && skor >= 2) return terbaik;
        }

        return null;

    }

    /** Jalankan langkah via agent specialist (agentHub worker). */
    async runViaAgent(goal, step, delegator = null) {

        try {

            const agentHub = require("../services/agentHub");
            const agent = this.pickAgent(step.action);

            // N2 Round-3 — INVARIAN: worker mewarisi inisiator tujuan.
            // TIDAK ada grant di sini: tujuan yang berawal dari
            // manusia/model mendelegasikan dengan otoritas inisiator.
            // Grant internal hanya lahir di run() bila pemanggil
            // runtime tepercaya menandai `internal:true`.
            const res = await agentHub.run(agent,
                `[Tujuan: ${goal.title}]\nTugas: ${step.action}\n` +
                `Sukses bila: ${step.successWhen ?? "tugas tuntas"}. Gunakan tool yang tersedia.`,
                { exec: delegator });

            await capabilities.recordUsage(`agent:${agent}`, { ok: res.ok, ms: 0, error: res.error });

            return {
                ok: res.ok,
                tool: `agent:${agent}`,
                args: { task: step.action },
                result: res.output,
                error: res.error
            };

        }
        catch (error) {
            return { ok: false, tool: "agent:?", error: error.message };
        }

    }

    /**
     * Map nama tool polos (dari plan LLM / skill baru) ke nama
     * terdaftar: "adler32Checksum" → "adler32-checksum.adler32Checksum".
     */
    mapToolName(name) {

        for (const t of toolBus.discover()) {
            // id plugin penuh "plugin.tool" berakhiran nama itu.
            if (t.name.endsWith("." + name) || t.name.endsWith("__" + name)) {
                return t.name;
            }
        }

        // AI tool polos.
        if (toolBus.resolve(name)) return name;

        return null;

    }

    pickAgent(action) {

        const a = String(action ?? "").toLowerCase();

        if (/kode|code|implement|bug|test/.test(a)) return "nakula";
        if (/riset|research|cari|analisis/.test(a)) return "janaka";
        if (/sistem|server|docker|proses|jaringan/.test(a)) return "nakula";
        if (/kamera|gambar|visual/.test(a)) return "nakula";
        if (/memori|ingat/.test(a)) return "sadewa";
        if (/monitor|pantau|log/.test(a)) return "sadewa";
        if (/keamanan|audit/.test(a)) return "werkudara";

        return "damar";

    }

    /** PLAN — LLM menyusun, runtime memvalidasi bentuknya. */
    async plan(goal, route, delegator = null) {

        const aiRuntime = require("../services/aiRuntimeService");

        try {

            const res = await Promise.race([
                aiRuntime.chat({
                    // N2-FINAL: giliran planner mewarisi otoritas inisiator.
                    role: this.turnRole(delegator),
                    ...this.turnRestrictions(delegator),
                    messages: [{ role: "user", content: PROMPT_PLAN(goal) }],
                    ...(route.model ? { model: route.model } : {})
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("plan timeout")), 60000))
            ]);

            const parsed = extractJson(res.content);

            if (Array.isArray(parsed?.steps) && parsed.steps.length) {
                // Validasi + normalisasi deterministik.
                parsed.steps = parsed.steps.slice(0, 5).map((s, i) => ({
                    n: i + 1,
                    action: String(s.action ?? `langkah ${i + 1}`).slice(0, 300),
                    tool: s.tool && toolBus.resolve(s.tool) ? s.tool : null,
                    successWhen: s.successWhen ?? null
                }));
                await database.run(
                    `UPDATE goals SET plan = ?, updated_at = datetime('now') WHERE id = ?`,
                    [JSON.stringify({ steps: parsed.steps, route: route.model ?? "default" }), goal.id]
                );
                return parsed;
            }

        }
        catch { /* fallback di bawah */ }

        // Fallback: satu langkah — tujuan langsung via agent terbaik.
        return {
            steps: [{
                n: 1, action: goal.title, tool: null,
                successWhen: goal.successCriteria?.[0] ?? "tugas menghasilkan hasil yang bermanfaat"
            }]
        };

    }

    /** EVALUATE — model menilai hasil vs kriteria (ringkas, §32). */
    async evaluate(goal, step, outcome, delegator = null) {

        const aiRuntime = require("../services/aiRuntimeService");

        try {

            const res = await Promise.race([
                aiRuntime.chat({
                    // N2-FINAL: evaluator mewarisi inisiator, bukan system.
                    role: this.turnRole(delegator),
                    ...this.turnRestrictions(delegator),
                    messages: [{ role: "user", content: PROMPT_EVALUATE(goal, step, outcome) }]
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("eval timeout")), 45000))
            ]);

            const parsed = extractJson(res.content);
            if (["pass", "fail", "impossible"].includes(parsed?.verdict)) {
                return { verdict: parsed.verdict, note: String(parsed.note ?? "").slice(0, 200) };
            }

        }
        catch { /* fallback heuristik di bawah */ }

        // Heuristik deterministik: hasil berisi & informatif = pass.
        const raw = outcome.result;

        if (raw == null) {
            return { verdict: "fail", note: "hasil kosong/tidak tersedia" };
        }

        let text = "";

        if (typeof raw === "string") text = raw;
        else {
            try { text = JSON.stringify(raw); }
            catch { text = String(raw); }
        }

        // Objek kembali dari tool umumnya bermakna bila berisi medan.
        const informative = text.length > 4 &&
            !/^\[object .+\]$/.test(text) &&
            !/^\s*(\{\}|\[\]|null|false|0)\s*$/.test(text);

        // Teks jawaban agent yang mengeluh = belum tuntas.
        const sour = /tidak bisa|tidak dapat|gagal|cannot|unable|maaf/i.test(text.slice(0, 200));

        return {
            verdict: informative && !sour ? "pass" : "fail",
            note: informative ? "hasil informatif (heuristik)" : "hasil tidak informatif"
        };

    }

    /**
     * §51 ZERO-SHOT: buat kapabilitas yang hilang untuk sebuah langkah.
     * LLM menyusun spec; SkillFactory memvalidasi + sandbox + register.
     */
    async createCapability(goal, step, delegator = null) {

        try {

            // Cegah duplikat dulu (§36).
            const gap = await skillFactory.analyzeGap(step.action);
            if (!gap.gap) {
                await this.log(goal.id, "create_skill", "gap tertutup kapabilitas ada",
                    (gap.found[0]?.name ?? "?"), gap.found.slice(0, 3), true);
                return { capability: { meta: { sandboxOk: false } }, reused: true, gap };
            }

            // Spesifikasi skill — TIGA jalur berurutan (budget ketat
            // per jalur agar total tetap responsif):
            //   1. LLM langsung (60s) — cukup bila provider sehat
            //   2. agent damar (90s) — jalur chat + fallback provider
            //   3. opencode_run (10 menit) — model coding, paling andal
            //      untuk kode panjang (§14: tugas koding → model koding)
            let spec = null;

            try {
                const aiRuntime = require("../services/aiRuntimeService");
                const res = await Promise.race([
                    aiRuntime.chat({
                        // N2-FINAL: skill-spec mewarisi inisiator tujuan.
                        role: this.turnRole(delegator),
                        ...this.turnRestrictions(delegator),
                        messages: [{ role: "user", content: PROMPT_SKILL_SPEC(goal, step, gap.found[0]) }]
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("skill-spec timeout")), 60000))
                ]);
                spec = extractJson(res.content);
                if (spec?.id) await this.log(goal.id, "create_skill", "spec via LLM langsung", spec.id, [], true);
            }
            catch { /* jalur 2 */ }

            if (!spec?.id) {
                spec = await this.specViaAgent(goal, step, delegator);
                if (spec?.id) await this.log(goal.id, "create_skill", "spec via agent", spec.id, [], true);
            }

            if (!spec?.id) {
                await this.log(goal.id, "create_skill", "spesifikasi via opencode…", "jalur 3 (model coding)", [], null);
                spec = await this.specViaOpenCode(goal, step);
            }

            if (!spec?.id) {
                await this.log(goal.id, "create_skill", "spec tidak bisa disusun", "LLM, agent, & opencode gagal", [], false);
                return null;
            }

            // Uji sandbox dengan argumen contoh dari parameter required.
            const sample = {};
            for (const [k, p] of Object.entries(spec.parameters ?? {})) {
                if (p?.required) sample[k] = sampleValue(k, p);
            }

            const created = await skillFactory.create(spec, { temporary: true, sampleArgs: Object.keys(sample).length ? sample : null });

            return created;

        }
        catch (error) {
            await this.log(goal.id, "create_skill", "pembuatan kapabilitas gagal", error.message, [], false);
            return null;
        }

    }

    /** Spesifikasi skill via agent damar (fallback bila LLM langsung lambat). */
    async specViaAgent(goal, step, delegator = null) {

        try {

            const agentHub = require("../services/agentHub");

            // N2 Round-3 — invarian delegasi: warisi inisiator tujuan,
            // jangan pernah menciptakan grant di jalur turunan ini.
            const res = await Promise.race([
                agentHub.run("damar", PROMPT_SKILL_SPEC(goal, step, null),
                    { exec: delegator }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("agent-spec timeout")), 90000))
            ]);

            if (res?.ok) {
                const spec = extractJson(res.output);
                return spec?.id ? spec : null;
            }

        }
        catch { /* jalur berikutnya */ }

        return null;

    }

    /**
     * Spesifikasi skill via opencode (model coding) — paling andal
     * untuk kode panjang. Instruksi menulis file spec JSON ke disk,
     * lalu dibaca kembali (tak bergantung parsing chat panjang).
     */
    async specViaOpenCode(goal, step) {

        const fs = require("node:fs");
        const path = require("node:path");

        const outFile = path.join(process.cwd(), "data", "autonomy-spec.json");

        try {

            const { runOpenCode } = require("../services/opencodeTools");

            const res = await runOpenCode({
                instruction:
                    PROMPT_SKILL_SPEC(goal, step, null) +
                    `\nTulis hasil JSON TEPAT ke berkas ${outFile} (timpa isinya). Hanya itu — jangan ubah berkas lain.`,
                purpose: "autonomy-spec",
                fresh: true
            });

            if (!res?.ok || !fs.existsSync(outFile)) return null;

            const spec = JSON.parse(fs.readFileSync(outFile, "utf8"));
            fs.rmSync(outFile, { force: true });

            return spec?.id ? spec : null;

        }
        catch {
            try { fs.rmSync(outFile, { force: true }); } catch { /* abaikan */ }
            return null;
        }

    }

    /** §21 EXPERIENCE → SKILL: prosedur sukses jadi memori prosedural. */
    async rememberProcedure(goal, final) {

        try {

            const engine = require("../memory/core/MemoryEngine");

            const steps = final.steps.map(s => `${s.step} → ${s.tool ?? "agent"}${s.createdSkill ? ` (skill baru: ${s.createdSkill})` : ""} [ok]`).join("; ");

            await engine.remember(
                `Prosedur sukses untuk "${goal.title}": ${steps}`,
                { type: "procedural", importance: 0.8, metadata: { autonomy: true, goalId: goal.id } },
                { writer: "autonomy" }
            );

            // Skill sementara yang terbukti pada tujuan sukses → promosi.
            for (const name of final.skillsCreated ?? []) {
                try { await skillFactory.promote(name); } catch { /* opsional */ }
            }

        }
        catch { /* memori opsional */ }

    }

    async setStatus(id, status, note = null) {

        await database.run(
            `UPDATE goals SET status = ?, error = coalesce(?, error), updated_at = datetime('now') WHERE id = ?`,
            [status, status === "failed" || status === "impossible" ? note : null, id]
        );

        if (status === "paused" || status === "completed" || status === "failed" || status === "impossible") {
            telemetry.publish("autonomy:goal_status", { goalId: id, status });
        }

    }

    /** Kontrol manusia (§44) — di luar LLM, langsung DB. */
    async pause(id) { return this.setStatus(id, "paused", "dijeda manusia"); }
    async resume(id) { return this.setStatus(id, "active", null); }
    async cancel(id) { return this.setStatus(id, "failed", "dibatalkan manusia"); }

    async log(goalId, action, decision, reason, evidence = [], ok = null) {

        await initialize();

        await database.run(
            `INSERT INTO autonomy_log (goal_id, action, decision, reason, evidence, ok)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [goalId, action, decision, reason, JSON.stringify(evidence ?? []), ok === null ? null : ok ? 1 : 0]
        );

    }

}

// ---------------------------------------------------------------- util

function hydrate(row) {
    const parse = (t, f) => { try { return JSON.parse(t ?? "") ?? f; } catch { return f; } };
    return {
        id: row.id, title: row.title, description: row.description,
        status: row.status, priority: row.priority, schedule: row.schedule,
        successCriteria: parse(row.success_criteria, []),
        constraints: parse(row.constraints, []),
        plan: parse(row.plan, {}),
        context: parse(row.context, {}),
        iterations: row.iterations, lastResult: parse(row.last_result, null),
        error: row.error, projectId: row.project_id,
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function extractJson(text) {

    if (!text) return null;

    const cleaned = String(text)
        .replace(/```json/gi, "").replace(/```/g, "")
        .trim();

    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) return null;

    try { return JSON.parse(cleaned.slice(start, end + 1)); }
    catch {

        // Coba perbaiki JSON rusak ringan (koma buntut).
        try { return JSON.parse(cleaned.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1")); }
        catch { return null; }

    }

}

/** Argumen masuk akal untuk tool umum dari teks action. */
function guessArgs(tool, action) {

    const tail = String(tool).split(/__|\./).pop();

    if (/^(browse|get)$/.test(tail)) return { url: firstUrl(action) ?? `https://duckduckgo.com/?q=${encodeURIComponent(action)}`, prompt: action };
    if (tail === "readFile") return { path: firstPath(action) ?? "package.json" };
    if (tail === "writeFile") return { path: "damar-output.md", content: action };
    if (tail === "listDirectory") return { path: firstPath(action) ?? "." };
    if (tail === "terminal_run") return { purpose: "autonomy", command: extractCommand(action) };
    if (tail === "terminal_read") return { purpose: "autonomy" };
    if (tail === "opencode_run") return { instruction: action, purpose: "autonomy" };
    if (tail === "code_test") return { scope: firstPath(action) };
    if (tail === "system_health") return {};
    if (tail === "see_camera") return { camera: firstWord(firstPath(action)) ?? undefined };
    if (tail === "memory_remember") return { content: action };
    if (tail === "currentTime") return {};

    // Umum: kirim action sebagai parameter pertama yang mungkin.
    return { input: action, text: action, query: action, instruction: action };

}

/**
 * Ekstrak perintah terminal aktual dari kalimat langkah.
 * "Jalankan perintah `date` di terminal" → "date".
 * Tanpa perintah eksplisit → null (jangan kirim kalimat ke shell!).
 */
function extractCommand(action) {

    const s = String(action ?? "");

    // Skrip inline (node -e / python -c) — jangan kirim mentah ke shell:
    // quoting PowerShell rapuh. Sinyal bahwa langkah ini lebih cocok
    // dijalankan agent (yang bisa menulis berkas/loop tool).
    if (/(-e\s+["'`]|-c\s+["'`])/i.test(s) && s.length > 60) {
        return null;
    }

    // Perintah dalam backtick atau kutip.
    const quoted = s.match(/[`'"]((?:npm|node|git|docker|python|pip|dir|ls|cd|type|cat|echo|Get-Date|Get-|Set-|date|whoami|ipconfig|ping|curl|wget)[^`'"]*)[`'"]/i);
    if (quoted) return quoted[1].trim();

    // Perintah telanjang paling awal.
    const bare = s.match(/\b(npm (?:run|install|test)[^\s]*|node \S+|git (?:status|log|diff|branch)[^\s]*|docker \S+|python \S+|pip \S+|Get-Date|date|whoami|ipconfig|ping \S+)\b/i);
    if (bare) return bare[1];

    return null;

}

function firstUrl(s) {
    const m = String(s ?? "").match(/https?:\/\/\S+/);
    return m?.[0];
}

function firstPath(s) {
    const m = String(s ?? "").match(/[A-Za-z0-9_.\\/:-]+\.(?:js|json|md|txt|py|sql|csv|yml|yaml|html|css)\b/);
    return m?.[0];
}

function firstWord(s) {
    return String(s ?? "").trim().split(/\s+/)[0] || null;
}

function sampleValue(key, p) {
    const d = String(p?.description ?? "").toLowerCase();
    if (/url|link/.test(d) || /url/.test(key)) return "https://example.com";
    if (/path|file/.test(d) || /path|file/.test(key)) return "./contoh.txt";
    if (p?.type === "number") return 1;
    return "contoh";
}

module.exports = new GoalEngine();
