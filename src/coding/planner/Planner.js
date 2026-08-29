const graph = require("../graph/graphifyAdapter");
const bugMemory = require("../memory/bugMemory");
const tester = require("../tester/testRunner");

/**
 * Planner — fase PLANNING Coding Brain (melengkapi arsitektur modular).
 *
 * Mengumpulkan konteks berbudget SEBELUM menambal, dgn urutan resmi:
 *   pengalaman (bugMemory) → Graphify (file relevan) → LSP/Tree-sitter
 *   (outline simbol). Deterministik (tanpa panggilan AI): satu panggilan
 *   `code_plan` memberi agen "dosir" terscope → menghemat TOOL BUDGET
 *   (maks 8) dan mencegah membaca file yang sama dua kali.
 */

// Parse keluaran `graphify query`: baris `NODE <name> [src=<path> loc=L<n> ...]`.
function parseNodes(out) {
    const nodes = [];
    const re = /^NODE\s+(.+?)\s+\[src=([^\s\]]+)\s+loc=L(\d+)/gm;
    let m;
    while ((m = re.exec(out)) !== null) nodes.push({ name: m[1], file: m[2], line: Number(m[3]) });
    return nodes;
}

// File unik terurut relevansi (kemunculan pertama menang).
function relevantFiles(nodes) {
    const seen = new Map();
    for (const n of nodes) if (!seen.has(n.file)) seen.set(n.file, { file: n.file, line: n.line });
    return [...seen.values()];
}

function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

class Planner {

    /**
     * Kumpulkan dosir konteks untuk sebuah tugas. `budget` = maksimum langkah
     * investigasi (recall+query+tiap outline). `seedFiles` diprioritaskan.
     */
    async investigate(task, { project = process.cwd(), budget = 8, seedFiles = [] } = {}) {
        const brain = require("../CodingBrain");                 // lazy: hindari siklus require
        const notes = [];
        let used = 0;
        const seen = new Set();                                  // dedup: jangan outline file dua kali

        // 1) Pengalaman lampau (hemat: sering sudah menjawab akar masalah).
        let experiences = [];
        try { const r = await bugMemory.recall(task); experiences = r.experiences || []; used++; }
        catch { notes.push("recall pengalaman gagal (non-fatal)."); }

        // 2) Graphify → file relevan (subgraf terscope).
        let nodes = [];
        if (graph.hasGraph(project)) {
            try { nodes = parseNodes(await graph.query(task, { project })); used++; }
            catch (e) { notes.push(`graph query gagal: ${e.message}`); }
        } else {
            notes.push("Proyek belum punya graph (graphify-out/graph.json) — lewati langkah graf.");
        }

        // 3) Outline simbol file kandidat (seed dulu, lalu dari graf), sampai budget habis.
        const candidates = [...seedFiles.map(f => ({ file: f, line: 1 })), ...relevantFiles(nodes)];
        const files = [];
        for (const c of candidates) {
            if (used >= budget) { notes.push(`Budget ${budget} habis — ${candidates.length - files.length} file kandidat belum di-outline.`); break; }
            if (seen.has(c.file)) continue;
            seen.add(c.file);
            try {
                const o = await brain.outline(c.file, { project });
                files.push({ file: c.file, line: c.line, source: o.source, symbols: o.symbols || [] });
                used++;
            } catch (e) {
                files.push({ file: c.file, line: c.line, source: "error", error: e.message });
                used++;
            }
        }

        return {
            task, project,
            budget: { max: budget, used },
            experiences,
            relevantFiles: relevantFiles(nodes).map(f => f.file),
            files,
            graphNodes: nodes.slice(0, 20),
            notes
        };
    }

    /**
     * Rencana lengkap: dosir + saran langkah deterministik (branch, file yang
     * mungkin disentuh, langkah verifikasi yang TERSEDIA, checklist workflow).
     */
    async plan(task, opts = {}) {
        const dossier = await this.investigate(task, opts);
        const project = dossier.project;
        const det = tester.detect(project);
        const verifySteps = ["lint", "test"].filter(s => det[s]);

        return {
            dossier,
            suggestion: {
                branch: `damar/${slug(task)}`,
                filesToTouch: dossier.files.slice(0, 5).map(f => f.file),
                verifySteps: verifySteps.length ? verifySteps : ["(tak ada script lint/test — verifikasi manual/check sintaks)"],
                checklist: [
                    "Pahami dosir & pengalaman lampau di atas (jangan ulangi investigasi).",
                    "Buat branch (code_branch) sebelum mengubah kode.",
                    "Patch kecil & terfokus pada file relevan; gunakan LSP (defs/refs) untuk menilai dampak.",
                    "Verifikasi (code_test / code_diagnostics); rollback (code_rollback) bila merah.",
                    "Commit (code_commit) bila hijau; simpan pengalaman (code_remember_fix)."
                ]
            }
        };
    }

}

module.exports = new Planner();
