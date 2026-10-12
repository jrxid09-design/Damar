const toolBus = require("./ToolBus");
const capabilities = require("./CapabilityRegistry");

const { database, initialize } = require("../memory/db");

/**
 * SELF-HEALING ENGINE (§12 + §33) — kegagalan = input, bukan henti.
 *
 * ERROR → KLASIFIKASI → STRATEGI:
 *   transient     → retry (backoff) → naikkan retries
 *   permission    → laporkan batas (bukan sembunyikan) → gagal jujur
 *                   (termasuk penolakan jalur-kanonik ToolBus: batas
 *                   otoritas TIDAK bisa dipulihkan, tidak disubstitusi,
 *                   tidak dieskalasi ke forge)
 *   dependency    → cek capability registry → sarankan paket/install
 *   implementation→ SUBSTITUSI tool lain (§34) → jika tetap gagal:
 *                   eskalasi SkillFactory (buat kapabilitas pengganti)
 *   environment   → EnvironmentModel cek (disk penuh? offline?)
 *   unknown       → satu substitusi → eskalasi
 *
 * Semua keputusan dicatat ke autonomy_log (decision/reason/result —
 * §32, tanpa chain-of-thought).
 */

const CLASSIFIERS = [
    { id: "transient",     test: /timeout|etimedout|econnreset|rate.?limit|503|502|busy|temporarily/i },
    { id: "permission",    test: /ditolang|ditolak|forbidden|403|401|tidak diizinkan|not allowed|sandbox/i },
    { id: "dependency",    test: /cannot find module|module not found|command not found|missing|dependen/i },
    { id: "environment",   test: /enospc|disk|out of memory|offline|network|fetch failed|dns/i },
    { id: "implementation",test: /typeerror|referenceerror|syntax|invalid|undefined is not|crash|exception/i }
];

class SelfHealingEngine {

    /** Klasifikasi error → kelas pemulihan (§33). */
    classify(error) {

        const message = String(error?.message ?? error ?? "");

        for (const c of CLASSIFIERS) {
            if (c.test.test(message)) return c.id;
        }

        return "unknown";

    }

    /**
     * Pulihkan eksekusi tool yang gagal.
     *
     * N2-FINAL — INVARIAN OTORITAS:
     *   - `ctx.exec` = identitas inisiator yang sampai ke pemulihan
     *     (transitif dari GoalEngine dsb.) → DIWARISI; pemulihan tidak
     *     pernah melebihinya.
     *   - `ctx.internal === true` HANYA boleh diset batas runtime
     *     otonom positif-teridentifikasi (watchdog/pulse/dream timer)
     *     yang memanggil metode ini langsung — parameter fungsi
     *     in-process, tak bisa berasal dari arg model/tool/HTTP.
     *   - Grant 'system' dibuat HANYA oleh titik kanonik
     *     Authorization.resolveDelegator — bukan di sini.
     *
     * @param {object} ctx { tool, args, error, goalId?, exec?, internal?, requirement? }
     * @returns strategi yang dijalankan + hasil akhir
     */
    async recover(ctx) {

        const { tool, args = {}, error, goalId = null, action = null,
                exec = null, internal = false, capabilitySet = null } = ctx;

        const { resolveDelegator } = require("../ai/tools/Authorization");
        let delegator = resolveDelegator(exec ?? null, internal === true, `heal:${goalId ?? "?"}`);

        // C-F/A-FINAL + M-1 CLOSURE: capability set terbatas menempel
        // pada delegasi — dinormalisasi & dibekukan lewat Authorization.
        // Dulu gerbangnya Array.isArray + length>0: bentuk non-array
        // LENYAP (fail-open M-1), dan array kosong ("terkunci penuh")
        // ikut terlucuti menjadi tanpa-batas. Kini toCapabilitySet:
        // malformed → throw; hadir (termasuk kosong) → SELALU menempel.
        if (capabilitySet !== undefined && capabilitySet !== null) {
            const inherited = require("../ai/tools/Authorization")
                .toCapabilitySet(capabilitySet);
            if (delegator) {
                delegator = { ...delegator, capabilitySet: inherited };
            }
            else if (!internal) {
                // Restriction tanpa delegator & tanpa batas otonom:
                // bawa sebagai pembawa restriction murni (least-privilege).
                delegator = resolveDelegator(
                    { capabilitySet: inherited }, false, `heal:${goalId ?? "?"}`);
            }
        }

        const klass = this.classify(error);
        const attempts = [];
        let outcome = { ok: false, error: String(error?.message ?? error) };

        await this.log(goalId, "recover",
            `pulihkan ${tool} (klasifikasi: ${klass})`,
            String(error?.message ?? error).slice(0, 160), [], false);

        // BATAS OTORITAS keluar LEBIH DULU: penolakan tidak boleh masuk jalur
        // alternatif apa pun (agent-retry, retry agresif, substitusi, forge).
        // Tanpa cabang awal ini, kegagalan `agent:*` yang ditolak otorisasi
        // menjalankan ulang agent SEBELUM strategi permission ditegakkan.
        if (klass === "permission") {
            attempts.push({ strategy: "report-authority-limit" });
            const limited = {
                ok: false,
                error: String(error?.message ?? error),
                authorityLimit: true
            };
            await this.log(goalId, "recover-result",
                `pemulihan ${tool} → gagal (batas otorisasi)`, "report-authority-limit", attempts, false);
            return { klass, attempts, outcome: limited };
        }

        // Jalur AGENT: gagal bukan karena tool — jalankan ulang agent
        // dengan instruksi lebih ketat (satu kali), bukan lewat ToolBus.
        if (String(tool ?? "").startsWith("agent:")) {
            try {
                const agentHub = require("../services/agentHub");
                const agentId = tool.slice(6) || "damar";
                // Delegasi mewarisi inisiator ATAU grant kanonik dari
                // batas otonom — tidak pernah diciptakan di sini.
                const res = await agentHub.run(agentId,
                    `${action ?? args?.task ?? "tugas"}\n\nPENTING: pastikan eksekusi benar-benar berhasil dan laporkan HASIL NYATA (bukan niat).`,
                    { exec: delegator });
                outcome = { ok: res.ok, result: res.output, error: res.error };
                attempts.push({ strategy: "agent-retry", ok: res.ok });
            }
            catch (e) {
                attempts.push({ strategy: "agent-retry", ok: false, error: e.message });
            }
            if (outcome.ok) {
                await this.log(goalId, "recover-result", `pemulihan ${tool} → berhasil`, "agent-retry", attempts, true);
                return { klass, attempts, outcome };
            }
        }

        switch (klass) {

            case "transient": {
                // Retry agresif dengan backoff lebih panjang.
                // M3/CLOSURE: identitas delegasi (exec/capabilitySet)
                // IKUT pada pengajuan ulang — pemulihan bukan hop pelucutan.
                // P1-3: ToolBus tidak mengeksekusi (W8). Jika tool ada di
                // capabilitySet delegator, eksekusi langsung ke ToolRegistry.
                const capSet = delegator?.capabilitySet ?? null;
                const { capSetWithin, canonicalCapabilityId, assertExecution } = require("../ai/tools/Authorization");
                if (Array.isArray(capSet) && capSetWithin(tool, capSet)) {
                    const canonId = canonicalCapabilityId(tool);
                    const { ToolRegistry } = require("../core/tools");
                    try {
                        // P1-D-FIX: assertExecution enforces role + capabilitySet
                        // authority before reaching ToolRegistry. capabilitySet is
                        // a restriction, not an authority grant — both checks required.
                        assertExecution(canonId, delegator);
                        const result = await ToolRegistry.execute(canonId, args, { exec: delegator });
                        // P1-E-FIX: derive ok from result — ToolRegistry can return
                        // { ok: false } without throwing; treat that as failure.
                        outcome = result?.ok === false
                            ? { ok: false, error: result?.error ?? "tool returned failure", result }
                            : { ok: true, result };
                    }
                    catch (e) { outcome = { ok: false, error: e.message }; }
                } else {
                    outcome = await toolBus.execute({
                        name: tool, args, timeoutMs: 90000, retries: 3,
                        context: { goal: goalId, exec: delegator }
                    });
                }
                attempts.push({ strategy: "retry-aggressive", ok: outcome.ok });
                break;
            }

            case "dependency": {
                // Sarankan paket/bahan yang kurang lewat registry.
                const requirement = ctx.requirement ?? tool;
                const discovery = await capabilities.discover(requirement, { limit: 5 });
                attempts.push({
                    strategy: "dependency-analysis",
                    found: discovery.capabilities ?? discovery,
                    packages: discovery.packages ?? []
                });
                outcome = {
                    ok: false,
                    error: `dependensi hilang untuk ${tool}`,
                    remediation: {
                        packages: discovery.packages ?? [],
                        capabilities: (discovery.capabilities ?? []).map(c => c.name)
                    }
                };
                break;
            }

            case "environment": {
                const env = await this.environmentSnapshot();
                attempts.push({ strategy: "environment-check", env });
                outcome = {
                    ok: false,
                    error: String(error?.message ?? error),
                    environment: env
                };
                break;
            }

            case "implementation":
            case "unknown":
            default: {
                // Substitusi ekstra. Sejak remediasi jalur-kedua W8 ToolBus
                // tidak mengeksekusi apa pun, jadi jalur ini berakhir pada
                // penolakan fail-closed dan indikasi kebutuhan kapabilitas
                // kanonik — bukan eksekusi lewat jalur alternatif.
                // M3/CLOSURE: identitas delegasi ikut juga di jalur
                // substitusi — tool pengganti tunduk pada restriction
                // yang sama, bukan lebih luas.
                outcome = await toolBus.execute({
                    name: tool, args, timeoutMs: 60000, retries: 1, allowSubstitute: true,
                    context: { goal: goalId, exec: delegator }
                });
                attempts.push({ strategy: "substitute", ok: outcome.ok, via: outcome.via });

                // Masih gagal → indikasikan pembuatan kapabilitas pengganti.
                if (!outcome.ok) {
                    // Eskalasi forge tetap ditandai, TAPI tidak ada eksekusi
                    // jalur alternatif: probe SkillFactory fail-closed sampai
                    // kapabilitas kanonik terdaftar (lihat SkillFactory.probe).
                    outcome.escalateToFactory = true;
                    attempts.push({ strategy: "escalate-skill-factory" });
                }
                break;
            }

        }

        await this.log(goalId, "recover-result",
            `pemulihan ${tool} → ${outcome.ok ? "berhasil" : "gagal"}`,
            attempts.map(a => a.strategy).join(" → "),
            attempts, outcome.ok);

        return { klass, attempts, outcome };

    }

    async environmentSnapshot() {

        const os = require("node:os");
        const fs = require("node:fs");

        const mem = { freeGb: +(os.freemem() / 1e9).toFixed(1), totalGb: +(os.totalmem() / 1e9).toFixed(1) };
        const load = os.loadavg?.()[0] ?? 0;

        let diskFreeGb = null;
        try {
            const stat = fs.statfsSync ? fs.statfsSync(process.cwd()) : null;
            if (stat) diskFreeGb = +((stat.bavail * stat.bsize) / 1e9).toFixed(1);
        }
        catch { /* tak tersedia */ }

        return {
            memory: mem,
            load,
            diskFreeGb,
            platform: os.platform(),
            uptimeH: +(os.uptime() / 3600).toFixed(1)
        };

    }

    async log(goalId, action, decision, reason, evidence = [], ok = null) {
        await initialize();
        await database.run(
            `INSERT INTO autonomy_log (goal_id, action, decision, reason, evidence, ok)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [goalId, action, decision, reason, JSON.stringify(evidence), ok === null ? null : ok ? 1 : 0]
        );
    }

}

module.exports = new SelfHealingEngine();
