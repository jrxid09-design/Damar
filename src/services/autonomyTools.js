const { AITool } = require("../ai/tools");

const autonomy = require("../autonomy");

const telemetry = require("./telemetryService");

/**
 * AI TOOLS OTONOMI — antarmuka terstruktur model → runtime otonom.
 *
 * Model tidak perlu tahu detail implementasi; ia memanggil:
 *   goal_run          → jalankan tujuan otonom penuh (loop §17)
 *   capability_search → discovery kapabilitas (§36) sebelum buat baru
 *   skill_build       → pabrik skill utk gap (§4-§5, sandbox otomatis)
 *   tool_exec         → eksekusi tahan-gagal via ToolBus (§7/§33)
 *   env_scan          → environment model + strategi sumber daya (§42)
 *   checkpoint        → titik pemulihan sebelum aksi signifikan (§31)
 */

function autonomyTools() {

    return [

        new AITool({
            name: "goal_run",
            description:
                "Jalankan TUJUAN OTONOM sampai tuntas: Aether menyusun rencana, memilih tool/agent, " +
                "mengeksekusi, memverifikasi, memulihkan kegagalan, dan MENCIPATAKAN kapabilitas baru " +
                "bila belum ada (skill factory + sandbox). Pakai untuk tugas berlapis/tak dikenal — " +
                "bukan untuk pertanyaan biasa. Kembalikan laporan langkah ketika selesai.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Tujuan ringkas (satu kalimat)." },
                    description: { type: "string", description: "Detail/konteks tujuan (opsional)." },
                    success_criteria: {
                        type: "array",
                        description: "Cara memverifikasi sukses (teks bebas)."
                    },
                    project_id: { type: "string", description: "ID Lab project bila terikat proyek (opsional)." }
                },
                required: ["title"]
            },
            // N2 Round-3: identitas inisiator (dari ToolExecutor —
            // BUKAN arg model) mewarisi ke seluruh loop otonom.
            // goal_run TIDAK PERNAH menciptakan/meneruskan grant internal;
            // field yang didestructure hanya schema parameters di atas,
            // sehingga tidak ada jalur pemalsuan internalGrant via args.
            execute: async ({ title, description, success_criteria, project_id }, ctx) => {

                telemetry.publish("autonomy:goal_requested", {
                    title,
                    initiatorRole: ctx?.exec?.role ?? "user"
                });

                const goal = await autonomy.goals.create({
                    title, description,
                    successCriteria: Array.isArray(success_criteria) ? success_criteria : [],
                    projectId: project_id ?? null
                });

                const result = await autonomy.goals.run(goal.id, { exec: ctx?.exec ?? null });

                return {
                    ok: result.ok,
                    goalId: goal.id,
                    passed: result.passed,
                    total: result.total,
                    steps: (result.steps ?? []).map(s => ({
                        step: s.step, tool: s.tool, ok: s.ok,
                        verdict: s.verdict, note: s.note,
                        createdSkill: s.createdSkill ?? null
                    })),
                    skillsCreated: result.skillsCreated ?? []
                };

            }
        }),

        new AITool({
            name: "capability_search",
            description:
                "Cari kapabilitas yang SUDAH ada (tool/skill/agent/model) untuk sebuah kebutuhan — " +
                "WAJIB dipakai sebelum membuat skill baru agar tidak duplikat. Juga menyarankan " +
                "paket yang bisa dipasang bila tak ada kapabilitas cocok.",
            parameters: {
                type: "object",
                properties: {
                    requirement: { type: "string", description: "Kebutuhan dalam kata kunci, mis. 'parse pdf'." }
                },
                required: ["requirement"]
            },
            execute: async ({ requirement }) => {
                const d = await autonomy.capabilities.discover(requirement, { limit: 10 });
                return {
                    found: (d.capabilities ?? d).map(c => ({
                        id: c.id, name: c.name, kind: c.kind,
                        description: String(c.description ?? "").slice(0, 120),
                        trust: c.trust, used: c.usageCount, score: c.score ?? null
                    })),
                    installablePackages: d.packages ?? [],
                    gap: Array.isArray(d.capabilities) ? !(d.capabilities.some(c => (c.score ?? 0) >= 50)) : true
                };
            }
        }),

        new AITool({
            name: "skill_build",
            description:
                "PABRIK SKILL: buat kapabilitas baru saat capability_search menyatakan gap. " +
                "Spesifikasi diuji di SANDBOX sebelum terdaftar; skill sementara otomatis kedaluwarsa " +
                "kecuali terbukti lalu dipromosikan. Kode HARUS Node.js murni tanpa dependensi npm.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Id kebab-case, mis. 'parse-ini-config'." },
                    name: { type: "string", description: "Nama tampilan." },
                    description: { type: "string", description: "Masalah yang diselesaikan (jelas & spesifik)." },
                    tool_name: { type: "string", description: "Nama fungsi camelCase." },
                    parameters: {
                        type: "object",
                        description: "Peta { param: { type, description, required } }."
                    },
                    code: { type: "string", description: "module.exports = class { async execute(args){} }" },
                    sample_args: { type: "object", description: "Argumen contoh untuk uji sandbox." },
                    permanent: { type: "boolean", description: "Langsung permanen (default: sementara)." }
                },
                required: ["id", "tool_name", "description", "code"]
            },
            execute: async (spec) => {

                const created = await autonomy.skillFactory.create(
                    spec,
                    {
                        temporary: !spec.permanent,
                        sampleArgs: spec.sample_args ?? null
                    }
                );

                return {
                    reused: created.reused ?? false,
                    skill: created.capability?.name ?? spec.id,
                    sandbox: created.sandbox ?? null,
                    activated: created.activated ?? false
                };

            }
        }),

        new AITool({
            name: "tool_exec",
            description:
                "Eksekusi tool apa pun lewat TOOLBUS tahan-gagal: validasi argumen, timeout, " +
                "retry error transien, substitusi tool alternatif bila utama gagal, dan pencatatan " +
                "reliabilitas. Pakai bila butuh ketahanan ekstra; panggilan tool biasa tetap boleh.",
            parameters: {
                type: "object",
                properties: {
                    tool: { type: "string", description: "Nama tool terdaftar." },
                    args: { type: "object", description: "Argumen tool." },
                    timeout_ms: { type: "number", description: "Batas (default 60s)." },
                    retries: { type: "number", description: "Retry error transien (default 1)." }
                },
                required: ["tool"]
            },
            // C1: identitas pemanggil diteruskan apa adanya (ctx.exec dari
            // ToolExecutor). Wrapper TIDAK menciptakan otoritas — target
            // aktual tetap diotorisasi dengan identitas asli, dan
            // delegasi hanya bisa menyempitkan.
            execute: async ({ tool, args = {}, timeout_ms, retries }, ctx = {}) => {
                const r = await autonomy.toolBus.execute({
                    context: { exec: ctx?.exec ?? null },
                    name: tool, args,
                    timeoutMs: timeout_ms ?? 60000,
                    retries: retries ?? 1
                });
                return {
                    ok: r.ok, tool: r.tool, via: r.via ?? null,
                    result: r.result, error: r.error,
                    attempts: r.attempts, durationMs: r.durationMs
                };
            }
        }),

        new AITool({
            name: "env_scan",
            description:
                "Pindai lingkungan host: memori, disk, jaringan, beban — plus SARAN STRATEGI " +
                "eksekusi (§ kesadaran sumber daya). Pakai sebelum tugas berat atau bila ragu " +
                "ketersediaan resource.",
            parameters: { type: "object", properties: {} },
            execute: async () => autonomy.environment.strategy()
        }),

        new AITool({
            name: "checkpoint",
            description:
                "Buat checkpoint pemulihan SEBELUM perubahan signifikan (git commit otomatis / " +
                "salinan berkas / salinan config). Bila perubahan gagal, pemulihan eksplisit " +
                "tersedia. scope: git | fs | config.",
            parameters: {
                type: "object",
                properties: {
                    scope: { type: "string", enum: ["git", "fs", "config"], description: "Jenis checkpoint." },
                    target: { type: "string", description: "Path folder/berkas (git: folder repo)." },
                    label: { type: "string", description: "Label singkat." }
                },
                required: ["scope", "target"]
            },
            execute: async ({ scope, target, label }) =>
                autonomy.checkpoints.create({ scope, target, label })
        })

    ];

}

module.exports = { autonomyTools };
