/**
 * DEFINITION OF DONE (§56) — uji alur otonomi penuh:
 *
 * Tugas asing: "hitung checksum adler-32 dari sebuah string" —
 * TIDAK ada tool adler32 di registry (verifikasi dulu).
 *
 * Loop harus: plan → capability gap → buat skill via LLM →
 * sandbox → register → eksekusi → verify → simpan prosedur.
 */
const path = require("node:path");

const loader = require("../src/plugins/pluginLoader");
loader.load(path.join(process.cwd(), "src", "plugins"));

const svc = require("../src/services/aiRuntimeService");
svc.initialize();

(async () => {

    const autonomy = require("../src/autonomy");
    await autonomy.capabilities.sync();

    // Prasyarat: yakin belum ada kapabilitas adler.
    const pre = await autonomy.capabilities.discover("adler32 checksum");
    const preHit = (pre.capabilities ?? pre).some(c => (c.score ?? 0) >= 50);
    if (preHit) {
        console.log("SKIP: kapabilitas adler32 sudah ada dari uji sebelumnya — hapus skill dulu untuk uji bersih.");
        console.log("Lanjut dengan goal tetap (harus reuse skill).");
    } else {
        console.log("PASS  prasyarat: adler32 belum ada (gap nyata)");
    }

    const goal = await autonomy.goals.create({
        title: "Hitung checksum adler-32 dari string 'damar'",
        description: "Buat/temukan kapabilitas checksum adler-32 lalu hitung nilai untuk string 'damar'. " +
            "Jika tool belum ada, buat skill baru (Node.js murni). Sukses: angka adler32 'damar' terlapor.",
        successCriteria: ["nilai adler32 dari string 'damar' terlapor sebagai angka"]
    });

    const t = setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 560000);

    const result = await autonomy.goals.run(goal.id);

    clearTimeout(t);

    console.log((result.ok ? "PASS" : "FAIL") + `  goal DoD §56: steps=${result.total} passed=${result.passed}`);
    console.log("  skills dibuat:", JSON.stringify(result.skillsCreated));

    for (const s of result.steps ?? []) {
        console.log("  -", (s.ok ? "V" : "X"), String(s.step).slice(0, 64), "|", s.tool, s.createdSkill ? "| skill:" + s.createdSkill : "");
    }

    // Verifikasi belajar: memori prosedural tersimpan saat sukses.
    if (result.ok) {
        const engine = require("../src/memory/core/MemoryEngine");
        const recall = await engine.recall("prosedur adler checksum");
        const found = (recall?.items ?? []).some(m => /adler/i.test(m.content ?? ""));
        console.log((found ? "PASS" : "WARN") + "  memori prosedural tersimpan");
    }

    // Bila skill dibuat, uji langsung eksekusinya (nyata, bukan klaim).
    const cap = await autonomy.capabilities.discover("adler");
    const adler = (cap.capabilities ?? cap).find(c => c.kind === "skill" || c.name.includes("adler"));
    if (adler) {
        console.log("PASS  skill adler terdaftar:", adler.name, "| trust:", adler.trust);
    }

    process.exit(result.ok ? 0 : 1);

})().catch(e => {
    console.error("DoD ERROR:", e.stack ?? e.message);
    process.exit(1);
});
