const agentHub = require("./agentHub");
const telemetry = require("./telemetryService");

/**
 * Orkestrator multi-agent (gaya Hermes-agent).
 *
 * Permintaan kompleks tidak dijawab satu tembakan, melainkan:
 *   1. RENCANA  — Aether-LLM memecah tugas jadi langkah, tiap
 *      langkah ditugaskan ke agent yang paling cocok.
 *   2. EKSEKUSI — tiap langkah dijalankan; hasil langkah sebelumnya
 *      diteruskan sebagai konteks ke langkah berikutnya.
 *   3. SINTESIS — Aether-LLM merangkum hasil jadi jawaban akhir.
 *
 * Setiap tahap memancarkan event supaya Console/WhatsApp bisa
 * menampilkan proses berpikirnya, bukan sekadar hasil akhir.
 */
class Orchestrator {

    async plan(request, agents) {

        const aiRuntime = require("./aiRuntimeService");

        const roster = agents
            .map(a => `- ${a.id} (${a.label}): ${a.description}`)
            .join("\n");

        const prompt =
            "Kamu perencana tugas untuk Aether. Pecah permintaan pengguna menjadi " +
            "langkah-langkah minimal, tiap langkah ditugaskan ke SATU agent.\n\n" +
            `Agent tersedia:\n${roster}\n\n` +
            "Aturan:\n" +
            "- Gunakan agent 'aether' untuk berpikir/menulis/menghitung/memori.\n" +
            "- Gunakan 'openclaw' HANYA untuk aksi di aplikasi/desktop.\n" +
            "- Gunakan 'hermes' untuk tugas agentik yang lebih cocok didelegasikan.\n" +
            "- Anak buah Aether: vanta (riset/analisis), forge (coding), " +
            "nexus (sistem/infra), sera (vision), echo (suara), cipher (keamanan), " +
            "atlas (otomatisasi), mira (memori), pulse (monitoring), lumen (antarmuka).\n" +
            "- Kalau permintaannya sederhana, cukup SATU langkah 'aether'.\n" +
            "- Jawab HANYA JSON valid, tanpa penjelasan, format:\n" +
            '{"goal":"...","steps":[{"id":"s1","agent":"aether","task":"...","dependsOn":[]}]}\n\n' +
            `Permintaan pengguna: ${request}`;

        const response = await aiRuntime.chat({
            messages: [{ role: "user", content: prompt }]
        });

        return this.parsePlan(response.content, request);

    }

    /** Ambil JSON plan dari keluaran model; jatuh ke rencana 1-langkah. */
    parsePlan(text, request) {

        const fallback = {
            goal: request,
            steps: [{ id: "s1", agent: "aether", task: request, dependsOn: [] }],
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
                    agent: agentHub.get(s.agent) ? s.agent : "aether",
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
     * @param {string} request
     * @param {(event:object)=>void} [onEvent]
     */
    async run(request, onEvent = () => {}) {

        const emit = (event) => {
            onEvent(event);
            telemetry.publish(`orchestrator:${event.type}`, event);
        };

        const agents = agentHub.describe();

        emit({ type: "planning" });

        let plan;

        try {
            plan = await this.plan(request, agents);
        }
        catch (error) {
            // Perencanaan gagal (mis. model tak tersedia) → langsung
            // satu langkah ke aether.
            plan = {
                goal: request,
                steps: [{ id: "s1", agent: "aether", task: request, dependsOn: [] }],
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

            const result = await agentHub.run(step.agent, task);

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

        // Satu langkah aether saja → outputnya sudah jawaban final.
        let final;

        if (plan.steps.length === 1 && plan.steps[0].agent === "aether" && results[0].ok) {
            final = results[0].output;
        }
        else {
            final = await this.synthesize(request, results);
        }

        emit({ type: "final", final, steps: results });

        return { goal: plan.goal, plan, steps: results, final };

    }

    async synthesize(request, results) {

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
            const response = await aiRuntime.chat({
                messages: [{ role: "user", content: prompt }]
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
