/**
 * Smoke test runtime otonom Damar.
 * Jalankan: node scripts/smoke-autonomy.js
 */
const path = require("node:path");

const loader = require("../src/plugins/pluginLoader");
loader.load(path.join(process.cwd(), "src", "plugins"));

const svc = require("../src/services/aiRuntimeService");
svc.initialize();

(async () => {

    const autonomy = require("../src/autonomy");
    const results = [];
    const check = (name, ok, detail = "") => {
        results.push({ name, ok });
        console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
    };

    // 1. Registry sync
    await autonomy.capabilities.sync();
    const kinds = {};
    for (const c of await autonomy.capabilities.list({ limit: 500 })) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    check("capability registry sync", (kinds.tool ?? 0) > 100 && (kinds.agent ?? 0) === 13,
        `tool=${kinds.tool} skill=${kinds.skill} agent=${kinds.agent}`);

    // 2. Discovery berlapis + paket
    const d = await autonomy.capabilities.discover("parse pdf");
    check("discovery + saran paket", Array.isArray(d.packages) && d.packages.includes("pdf-parse"));

    // 3. Gap analysis (kebutuhan asing)
    const gap = await autonomy.skillFactory.analyzeGap("parse format log proprietary nanosauza");
    check("gap analysis asing", gap.gap === true);

    // 4. SkillFactory: buat + sandbox
    const code = [
        "module.exports = class Tool {",
        "  constructor(){",
        '    this.name = "nanoLogParse";',
        '    this.description = "parse nanosauza log";',
        '    this.parameters = { lines: { type: "string", required: true } };',
        "  }",
        "  async execute(a){",
        '    const rows = String(a.lines || "").split("\\n").filter(Boolean).map(l => {',
        '      const p = l.split("|");',
        "      return { ts: p[0], level: p[1], msg: p.slice(2).join(\"|\") };",
        "    });",
        "    return { ok: true, count: rows.length, rows };",
        "  }",
        "}"
    ].join("\n");

    const created = await autonomy.skillFactory.create(
        {
            id: "nano-log-parser",
            name: "NanoLog Parser",
            description: "Parser log proprietary nanosauza: baris TS|LEVEL|MSG menjadi struktur JSON untuk analisis cepat.",
            tool_name: "nanoLogParse",
            parameters: { lines: { type: "string", description: "Log mentah", required: true } },
            code
        },
        { temporary: true, sampleArgs: { lines: "2026-08-16T10:00:00|INFO|sistem hidup" } }
    );
    check("skill factory: buat + sandbox",
        created.capability?.name === "nano-log-parser" && created.sandbox?.ok === true,
        `sandbox rows=${JSON.stringify(created.sandbox?.result?.rows ?? []).slice(0, 60)}`);

    // 5. Cegah duplikat
    const dupe = await autonomy.skillFactory.create(
        { id: "nano-log-parser", name: "x", description: "dupe cek duplicate prevention", tool_name: "x", code: "module.exports=class{T(){}}", parameters: {} },
        { temporary: true }
    );
    check("skill factory: anti-duplikat", dupe.reused === true);

    // 6. Checkpoint fs + list
    const ck = await autonomy.checkpoints.create({ scope: "fs", target: "package.json", label: "smoke-autonomy" });
    const cks = await autonomy.checkpoints.list();
    check("checkpoint fs", ck.id && cks.some(c => c.id === ck.id));

    // 7. ModelRouter
    const r1 = autonomy.modelRouter.route("perbaiki bug di kode fungsi login");
    const r2 = autonomy.modelRouter.route("jam berapa sekarang");
    check("model router klasifikasi", r1.taskClass === "coding" && r2.taskClass === "fast",
        `${r1.taskClass}/${r2.taskClass}`);

    // 8. EnvironmentModel
    const env = await autonomy.environment.strategy();
    check("environment model", env.environment.memory.usedPercent > 0 && typeof env.environment.network.online === "boolean");

    // 9. SelfHealing klasifikasi
    check("self-healing klasifikasi",
        autonomy.healing.classify(new Error("connect ETIMEDOUT")) === "transient" &&
        autonomy.healing.classify(new Error("Cannot find module foo")) === "dependency");

    // 10. ToolBus tahan-gagal + substitusi tercatat
    const bus = autonomy.toolBus;
    const rExec = await bus.execute({ name: "system.time.currentTime", args: {}, timeoutMs: 10000 });
    const rMiss = await bus.execute({ name: "tool-hantu", args: {} });
    check("toolbus exec + not-found jujur", rExec.ok === true && rMiss.ok === false);

    // 11. Goal engine: tujuan mini end-to-end (task yang bisa dipenuhi tool ada)
    const goal = await autonomy.goals.create({
        title: "Cek waktu lokal saat ini via tool",
        description: "Uji loop otonom mini",
        successCriteria: ["waktu terlapor"]
    });
    const gr = await autonomy.goals.run(goal.id);
    check("goal engine loop mini", gr.ok === true && gr.total >= 1,
        `steps=${gr.total} passed=${gr.passed}`);

    // 12. Autonomy log terisi
    const { database } = require("../src/memory/db");
    const logs = await database.all("SELECT COUNT(*) n FROM autonomy_log");
    check("autonomy log", (logs[0]?.n ?? 0) > 0, `${logs[0]?.n} entri`);

    const pass = results.filter(r => r.ok).length;
    console.log(`\n${pass}/${results.length} PASS`);
    process.exit(pass === results.length ? 0 : 1);

})().catch(e => {
    console.error("SMOKE ERROR:", e.stack ?? e.message);
    process.exit(1);
});
