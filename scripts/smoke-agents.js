/**
 * Smoke test: AgentHub + profil tool per-agent + opencode_run + Forge→OpenCode.
 * Jalankan: node scripts/smoke-agents.js
 */
const path = require("node:path");

async function main() {

    const results = [];
    const check = (name, ok, detail = "") => {
        results.push({ name, ok, detail });
        console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
    };

    // Muat registry seperti daemon.
    const loader = require("../src/plugins/pluginLoader");
    loader.load(path.join(process.cwd(), "src", "plugins"));

    const svc = require("../src/services/aiRuntimeService");
    svc.initialize();

    // --- 1. Registry & profil tool per agent --------------------
    const all = svc.tools();
    check("registry AI terpasang", all.length > 100, `${all.length} tool`);

    const { toolsForWorker, knownWorkers } = require("../src/agent/agentTools");
    let semuaLengkap = true;
    const ringkas = [];
    for (const w of knownWorkers()) {
        const t = toolsForWorker(all, w, []);
        ringkas.push(`${w}:${t.length}`);
        if (t.length < 5) { semuaLengkap = false; }
    }
    check("profil tool 10 worker", semuaLengkap, ringkas.join(" "));

    // RA3-03: Janaka (kanonik engineering) WAJIB punya opencode_run; Nakula (kanonik data/analitik) TIDAK.
    const nakulaTools = toolsForWorker(all, "nakula", []).map(t => t.name);
const janakaTools = toolsForWorker(all, "janaka", []).map(t => t.name);
check("janaka punya opencode_run", janakaTools.includes("opencode_run"));
    check("nakula TIDAK punya opencode_run (kanonik: data/analitik, bukan engineering)", !nakulaTools.includes("opencode_run"));

    // --- 2. AgentHub.get / health -------------------------------
    const agentHub = require("../src/services/agentHub");
    const nakula = agentHub.get("nakula");
    check("agentHub.get('nakula')", nakula?.kind === "worker", nakula?.label);

    const health = await agentHub.health();
    check("agentHub.health()", health.length === 13, `${health.length} agent`);

    // --- 3. runWorker dengan tool nyata (sadewa → system_health) --
    try {
        const r = await agentHub.run("sadewa", "Jawab HANYA dengan kata: PULSE-OK (tanpa memanggil tool).");
        check("agentHub.run(sadewa)", r.ok === true, JSON.stringify(r.output ?? "").slice(0, 60));
    }
    catch (e) {
        check("agentHub.run(sadewa)", false, e.message);
    }

    // --- 4. opencode_run end-to-end ------------------------------
    try {
        const oc = all.find(t => t.name === "opencode_run");
        check("tool opencode_run terdaftar", !!oc);
        const r = await oc.execute({
            instruction: "Lihat package.json di root proyek. Jawab HANYA JSON: {\"name\":\"...\",\"version\":\"...\"}",
            purpose: "smoke-test",
            fresh: true
        });
        const parsed = JSON.parse(r.output?.match(/\{[^}]+\}/)?.[0] ?? "{}");
        check("opencode_run membaca package.json", r.ok && parsed.name === "damar",
            `name=${parsed.name} v${parsed.version}`);
    }
    catch (e) {
        check("opencode_run membaca package.json", false, e.message);
    }

    // --- 5. Janaka → mendelegasikan coding ke opencode ------------
    try {
        const r = await agentHub.run("janaka",
            "Pakai tool opencode_run untuk membaca package.json proyek ini, lalu jawab satu baris: nama dan versi proyek.");
        const ok = r.ok && /damar/i.test(r.output ?? "");
        check("Janaka → opencode_run", ok, JSON.stringify(r.output ?? "").slice(0, 80));
    }
    catch (e) {
        check("Janaka → opencode_run", false, e.message);
    }

    // --- 6. Memori: tulis langsung tanpa proposal ----------------
    try {
        const engine = require("../src/memory/core/MemoryEngine");
        const r = await engine.remember(
            `smoke-test memori langsung ${new Date().toISOString()}`,
            { type: "semantic" },
            { writer: "smoke-test" }
        );
        const langsungCommit = !!r?.id && !r?.proposal;
        check("memori commit langsung (tanpa proposal)", langsungCommit, `id=${r?.id ?? "?"}`);
    }
    catch (e) {
        check("memori commit langsung (tanpa proposal)", false, e.message);
    }

    // --- 7. Endpoint upload memoryController ---------------------
    try {
        const ctl = require("../src/controllers/memoryController");
        check("endpoint upload tersedia", typeof ctl.upload === "function");
    }
    catch (e) {
        check("endpoint upload tersedia", false, e.message);
    }

    // --- Ringkasan ------------------------------------------------
    const pass = results.filter(r => r.ok).length;
    console.log(`\n${pass}/${results.length} PASS`);
    process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => {
    console.error("SMOKE ERROR:", e.stack ?? e.message);
    process.exit(1);
});
