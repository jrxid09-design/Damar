const agentHub = require("./agentHub");
const telemetry = require("./telemetryService");

/**
 * Orkestrator multi-agent.
 *
 * Permintaan kompleks tidak dijawab satu tembakan, melainkan:
 *   1. RENCANA  — Damar-LLM memecah tugas jadi langkah, tiap
 *      langkah ditugaskan ke agent yang paling cocok.
 *   2. EKSEKUSI — tiap langkah dijalankan; hasil langkah sebelumnya
 *      diteruskan sebagai konteks ke langkah berikutnya.
 *   3. SINTESIS — Damar-LLM merangkum hasil jadi jawaban akhir.
 *
 * Setiap tahap memancarkan event supaya Console/WhatsApp bisa
 * menampilkan proses berpikirnya, bukan sekadar hasil akhir.
 */
class Orchestrator {

    async plan(request, agents, { exec = null } = {}) {

        const aiRuntime = require("./aiRuntimeService");

        const roster = agents
            .map(a => `- ${a.id} (${a.label}): ${a.description}`)
            .join("\n");

        const prompt =
            "Kamu perencana tugas untuk Damar. Pecah permintaan pengguna menjadi " +
            "langkah-langkah minimal, tiap langkah ditugaskan ke SATU agent.\n\n" +
            `Agent tersedia:\n${roster}\n\n` +
            "Aturan:\n" +
            "- Gunakan agent 'damar' untuk berpikir/menulis/menghitung/memori.\n" +
            "- Pandawa, lima spesialis Damar: puntadewa (tata kelola/" +
            "perencanaan), werkudara (keamanan), janaka (riset/intelijen), " +
            "nakula (rekayasa/operasi/perangkat), sadewa (memori/analisis/" +
            "kontinuitas).\n" +
            "- Pandawa adalah unit spesialis MILIK Damar, bukan asisten " +
            "terpisah: jawaban akhir tetap disintesis sebagai Damar.\n" +
            "- Kalau permintaannya sederhana, cukup SATU langkah 'damar'.\n" +
            "- Jawab HANYA JSON valid, tanpa penjelasan, format:\n" +
            '{"goal":"...","steps":[{"id":"s1","agent":"damar","task":"...","dependsOn":[]}]}\n\n' +
            `Permintaan pengguna: ${request}`;

        // N2 Round-2 + M-1: perencana memakai peran delegator. Identitas
        // hilang dari jalur model/eksternal = 'user' (least privilege);
        // 'system' hanya lewat grant internal eksplisit.
        // Restriction delegasi ikut via toCapabilitySet — malformed
        // fail-closed, string/Set menyempit; tidak pernah dilucuti.
        const A = require("../ai/tools/Authorization");
        const planSet = A.toCapabilitySet(exec?.capabilitySet);
        const response = await aiRuntime.chat({
            messages: [{ role: "user", content: prompt }],
            role: agentHub.delegatedRoleOf(exec),
            ...(planSet ? { capabilitySet: planSet } : {})
        });

        return this.parsePlan(response.content, request);

    }

    /** Ambil JSON plan dari keluaran model; jatuh ke rencana 1-langkah. */
    parsePlan(text, request) {

        const fallback = {
            goal: request,
            steps: [{ id: "s1", agent: "damar", task: request, dependsOn: [] }],
            fallback: true
        };

        if (!text) {
            return fallback;
        }

        // Buang pagar kode ```json ... ``` bila ada.
        const cleaned = String(text)
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();

        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");

        if (start === -1 || end === -1) {
            return fallback;
        }

        try {

            const plan = JSON.parse(cleaned.slice(start, end + 1));

            if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
                return fallback;
            }

            // Bersihkan & validasi tiap langkah.
            plan.steps = plan.steps
                .map((s, i) => ({
                    id: s.id ?? `s${i + 1}`,
                    agent: agentHub.get(s.agent) ? s.agent : "damar",
                    task: String(s.task ?? "").trim(),
                    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : []
                }))
                .filter(s => s.task);

            if (plan.steps.length === 0) {
                return fallback;
            }

            plan.goal = plan.goal ?? request;

            return plan;

        }

        catch {
            return fallback;
        }

    }

    /**
     * Jalankan orkestrasi penuh.
     *
     * N2: `exec` = identitas eksekusi pemohon. Seluruh delegasi
     * (perencanaan + tiap langkah worker) mewarisi otoritas ini —
     * user TIDAK bisa mendapat privilege 'system' lewat delegasi.
     *
     * @param {string} request
     * @param {(event:object)=>void} [onEvent]
     * @param {{exec?:object}} [opts] exec = identitas delegator
     */
    async run(request, onEvent = () => {}, { exec = null } = {}) {

        const emit = (event) => {
            onEvent(event);
            telemetry.publish(`orchestrator:${event.type}`, event);
        };

        const agents = agentHub.describe();

        emit({ type: "planning" });

        let plan;

        try {
            plan = await this.plan(request, agents, { exec });
        }
        catch (error) {
            // Perencanaan gagal (mis. model tak tersedia) → langsung
            // satu langkah ke damar.
            plan = {
                goal: request,
                steps: [{ id: "s1", agent: "damar", task: request, dependsOn: [] }],
                fallback: true,
                planError: error.message
            };
        }

        emit({ type: "plan", plan });

        const outputs = {};
        const results = [];

        for (const step of plan.steps) {

            emit({ type: "step:start", step });

            // Sisipkan hasil langkah yang menjadi prasyarat.
            const context = (step.dependsOn ?? [])
                .map(id => outputs[id] ? `# Hasil ${id}:\n${outputs[id]}` : "")
                .filter(Boolean)
                .join("\n\n");

            const task = context ? `${step.task}\n\n${context}` : step.task;

            const result = await agentHub.run(step.agent, task, { exec });

            outputs[step.id] = result.ok
                ? result.output
                : `(gagal: ${result.error})`;

            results.push({ ...step, ...result });

            emit({
                type: "step:done",
                step,
                ok: result.ok,
                output: outputs[step.id],
                error: result.error ?? null
            });

        }

        // Satu langkah damar saja → outputnya sudah jawaban final.
        let final;

        if (plan.steps.length === 1 && plan.steps[0].agent === "damar" && results[0].ok) {
            final = results[0].output;
        }
        else {
            final = await this.synthesize(request, results, { exec });
        }

        emit({ type: "final", final, steps: results });

        return { goal: plan.goal, plan, steps: results, final };

    }

    // A-FINAL: giliran sintesis mewarisi identitas delegator —
    // restriction (capabilitySet) ikut, bukan hop pelucutan.
    async synthesize(request, results, { exec = null } = {}) {

        const aiRuntime = require("./aiRuntimeService");

        const transcript = results
            .map(r => `## ${r.id} — agent ${r.agent}${r.ok ? "" : " (GAGAL)"}\n${r.output ?? r.error}`)
            .join("\n\n");

        const prompt =
            "Rangkum hasil langkah-langkah berikut menjadi satu jawaban akhir yang " +
            "jelas untuk pengguna. Jangan sebut kata 'langkah' atau nama agent kecuali " +
            "relevan; cukup sampaikan hasilnya.\n\n" +
            `Permintaan awal: ${request}\n\n` +
            `Hasil:\n${transcript}`;

        try {
            const agentHub = require("./agentHub");
            const A = require("../ai/tools/Authorization");
            const synthSet = A.toCapabilitySet(exec?.capabilitySet);
            const response = await aiRuntime.chat({
                messages: [{ role: "user", content: prompt }],
                role: agentHub.delegatedRoleOf(exec),
                ...(synthSet ? { capabilitySet: synthSet } : {})
            });
            return response.content ?? transcript;
        }
        catch {
            // Sintesis gagal → sajikan gabungan mentah agar tetap berguna.
            return transcript;
        }

    }

}

module.exports = new Orchestrator();
