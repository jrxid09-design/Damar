const graph = require("./graph/graphifyAdapter");
const symbol = require("./symbol/serenaAdapter");
const lsp = require("./lsp/LSPManager");
const ast = require("./ast/treeSitter");
const planner = require("./planner/Planner");
const patcher = require("./patcher/gitPatcher");
const tester = require("./tester/testRunner");
const bugMemory = require("./memory/bugMemory");
const refactor = require("./refactor/Refactorer");
const powershell = require("./analyzer/powershell");

/**
 * CodingBrain — pintu tunggal kemampuan software-engineering Aether.
 *
 * Aether (orchestrator) tetap otak utama; CodingBrain menyatukan "mesin
 * internal" (Graphify/Serena/Tree-sitter/LSP/Memory) di balik satu facade
 * modular. Diisi bertahap:
 *   graph    (Graphify)     — hubungan antar-file/simbol   ✔ Fase 1
 *   symbol   (Serena)       — cari/rename/refs             ⏳ Fase 2
 *   ast      (Tree-sitter)  — sumber kebenaran AST         ⏳ Fase 3
 *   lsp                     — defs/refs/diagnostics        ⏳ Fase 4
 *   memory   (MemoryEngine) — pengalaman bug + arsitektur  ⏳ Fase 5
 *   planner/patcher/tester                                 ⏳ Fase 6-8
 */
class CodingBrain {
    get graph() { return graph; }
    get symbol() { return symbol; }
    get lsp() { return lsp; }
    get ast() { return ast; }
    get patcher() { return patcher; }
    get tester() { return tester; }
    get bugMemory() { return bugMemory; }
    get refactor() { return refactor; }
    get planner() { return planner; }
    get powershell() { return powershell; }

    /**
     * Outline simbol satu file dgn urutan analisis Coding Brain: LSP dulu
     * (semantik akurat: documentSymbol), fallback ke Tree-sitter (AST) bila
     * language server tak terpasang. Balikan menyertakan sumbernya.
     */
    async outline(file, { project = process.cwd() } = {}) {
        if (/\.ps(m?1|d1)$/i.test(file) && powershell.available()) {
            const r = await powershell.symbols(file);              // PS: AST bawaan (tanpa PSES)
            if (r.symbols?.length || r.source === "powershell-ast") return r;
        }
        if (lsp.available(file)) {
            const r = await lsp.op("documentSymbols", file, [], { project });
            if (r.available && Array.isArray(r.result) && r.result.length) return { source: "lsp", symbols: r.result };
        }
        try {
            if (await ast.available()) {
                const r = await ast.symbolsOfFile(file);      // throw bila grammar tak ada (mis. .md)
                return { source: "tree-sitter", ...r };
            }
        } catch { /* bahasa tak didukung AST → none */ }
        return { source: "none", symbols: [], note: "Tak ada outline (LSP kosong & Tree-sitter tak dukung bahasa ini)." };
    }

    /**
     * Loop eksekusi self-healing: branch → (penambal AI mengedit) → verify
     * (lint+test) → commit bila hijau / restore bila merah → catat
     * pengalaman. `applyPatch` = callback async yang melakukan edit file
     * (mis. lewat tool Edit/Write); dijalankan di dalam branch aman.
     */
    async runFix({ project = process.cwd(), branch, applyPatch, verifySteps, experience } = {}) {
        if (!await patcher.isRepo(project)) return { ok: false, note: "Bukan repo git — tak bisa patch aman." };
        const base = await patcher.currentBranch(project);
        const created = await patcher.createBranch(branch || `aether/fix-${Date.now()}`, project);

        if (typeof applyPatch === "function") await applyPatch({ project, branch: created.branch });

        const verdict = await tester.verify(project, verifySteps ? { steps: verifySteps } : undefined);
        if (!verdict.ok) {
            await patcher.restore(["."], project);                       // rollback aman
            return { ok: false, branch: created.branch, base, verdict, rolledBack: true };
        }

        const committed = await patcher.commit(`fix(aether): ${branch || "patch otomatis"}`, project);
        if (experience) await bugMemory.record(experience).catch(() => {});
        return { ok: true, branch: created.branch, base, verdict, committed };
    }

    /** Ringkas mesin mana yang siap dipakai (untuk introspeksi/UI). */
    async capabilities() {
        const [g, s, a] = await Promise.all([graph.available(), symbol.available(), ast.available()]);
        const installed = lsp.installed();
        return {
            graph: g,        // Graphify        — Fase 1 ✔
            symbol: s,       // Serena (index)  — Fase 2 ✔
            lsp: Object.values(installed).some(Boolean), // Fase 4 ✔ (≥1 server)
            lspServers: installed,                       // rincian per bahasa
            ast: a,          // Tree-sitter     — Fase 3 ✔
            patcher: true,   // git patcher     — loop eksekusi ✔
            tester: true,    // test runner     — loop eksekusi ✔
            refactor: true,  // refactoring otonom — Fase 8 ✔
            planner: true,   // fase planning (investigasi berbudget) ✔
            powershell: powershell.available(), // diagnostics PS (PSScriptAnalyzer)
            memory: true     // MemoryEngine + bug memory ✔
        };
    }
}

module.exports = new CodingBrain();
