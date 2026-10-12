const ast = require("./ast/treeSitter");
const planner = require("./planner/Planner");
const bugMemory = require("./memory/bugMemory");
const review = require("./review/diffReviewer");

/**
 * The coding capability runtime is obtained from the Manager-owned surface
 * (src/manager/bootstrap.js) and never from a module of our own. That is what
 * makes the driver path canonical ownership instead of a second execution path:
 * the drivers are reachable only through the Manager-owned runtime.
 */
function codingRuntime() {
    return require("../manager/bootstrap").getCodingCapabilityRuntime();
}

/**
 * CodingBrain — pintu tunggal kemampuan software-engineering Damar.
 *
 * IW1: the software-engineering DRIVERS (graph/symbol/lsp/patcher/tester/
 * refactor/powershell) are no longer held here. They are owned by the
 * Manager-owned coding capability runtime and are reachable only through an
 * authorized capability call. The getters below return capability-backed
 * adapters that keep the same method surface, so a call site never selects the
 * handler: it requests a capability, and authority decides.
 *
 * Until the owner ratifies the coding capabilities, every one of those calls
 * returns a truthful denial (ownerRatificationRequired) and the driver is never
 * invoked.
 */

const isDenial = (v) => Boolean(v && typeof v === "object" && v.denied === true);

function deniedFrom(value, fallback) {
    return {
        ok: false,
        denied: true,
        ownerRatificationRequired: Boolean(value?.ownerRatificationRequired),
        capabilityId: value?.capabilityId ?? null,
        operation: value?.operation ?? null,
        reason: value?.reason ?? fallback,
        note: "Capability is registered but not owner-authorized; zero driver effect occurred."
    };
}

class CodingBrain {
    get graph() { return codingRuntime().adapter("graph"); }
    get symbol() { return codingRuntime().adapter("symbol"); }
    get lsp() { return codingRuntime().adapter("lsp"); }
    get patcher() { return codingRuntime().adapter("patcher"); }
    get tester() { return codingRuntime().adapter("tester"); }
    get refactor() { return codingRuntime().adapter("refactor"); }
    get powershell() { return codingRuntime().adapter("powershell"); }

    get ast() { return ast; }
    get bugMemory() { return bugMemory; }
    get planner() { return planner; }
    get review() { return review; }

    /**
     * Outline simbol satu file dgn urutan analisis Coding Brain: LSP dulu
     * (semantik akurat: documentSymbol), fallback ke Tree-sitter (AST) bila
     * language server tak terpasang. Balikan menyertakan sumbernya.
     */
    async outline(file, { project = process.cwd() } = {}) {
        if (/\.ps(m?1|d1)$/i.test(file)) {
            const powershell = this.powershell;
            const available = await powershell.available();
            if (available === true) {
                const r = await powershell.symbols(file);              // PS: AST bawaan (tanpa PSES)
                if (!isDenial(r) && (r.symbols?.length || r.source === "powershell-ast")) return r;
            }
        }
        const lsp = this.lsp;
        const lspAvailable = await lsp.available(file);
        if (lspAvailable === true) {
            const r = await lsp.op("documentSymbols", file, [], { project });
            if (!isDenial(r) && r.available && Array.isArray(r.result) && r.result.length) {
                return { source: "lsp", symbols: r.result };
            }
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
        const patcher = this.patcher;
        const tester = this.tester;

        const isRepo = await patcher.isRepo(project);
        if (isDenial(isRepo)) return deniedFrom(isRepo, "NOT_AUTHORIZED");
        if (!isRepo) return { ok: false, note: "Bukan repo git — tak bisa patch aman." };

        const base = await patcher.currentBranch(project);
        const created = await patcher.createBranch(branch || `damar/fix-${Date.now()}`, project);
        if (isDenial(created)) return deniedFrom(created, "NOT_AUTHORIZED");

        if (typeof applyPatch === "function") await applyPatch({ project, branch: created.branch });

        const verdict = await tester.verify(project, verifySteps ? { steps: verifySteps } : undefined);
        if (isDenial(verdict)) return deniedFrom(verdict, "NOT_AUTHORIZED");

        if (!verdict.ok) {
            const restored = await patcher.restore(["."], project);       // rollback aman
            return {
                ok: false,
                branch: created.branch,
                base,
                verdict,
                // Never claim a rollback that did not happen.
                rolledBack: !isDenial(restored) && restored?.ok === true
            };
        }

        const committed = await patcher.commit(`fix(damar): ${branch || "patch otomatis"}`, project);
        if (isDenial(committed)) return deniedFrom(committed, "NOT_AUTHORIZED");
        if (experience) await bugMemory.record(experience).catch(() => {});
        return { ok: true, branch: created.branch, base, verdict, committed };
    }

    /** Ringkas mesin mana yang siap dipakai (untuk introspeksi/UI). */
    async capabilities() {
        const [g, s, a] = await Promise.all([
            this.graph.available(),
            this.symbol.available(),
            ast.available()
        ]);
        const installed = await this.lsp.installed();
        const psAvailable = await this.powershell.available();

        const authorized = (v) => {
            if (isDenial(v)) return false;
            return Boolean(v);
        };
        const denialOf = (v) => (isDenial(v) ? { capabilityId: v.capabilityId, reason: v.reason } : null);

        const lspInstalled = isDenial(installed) ? null : installed;
        return {
            graph: authorized(g),        // Graphify        — Fase 1 ✔
            symbol: authorized(s),       // Serena (index)  — Fase 2 ✔
            lsp: isDenial(installed) ? false : Object.values(installed ?? {}).some(Boolean),
            lspServers: lspInstalled,                    // rincian per bahasa
            ast: authorized(a),          // Tree-sitter     — Fase 3 ✔
            patcher: true,   // git patcher     — loop eksekusi (capability-gated)
            tester: true,    // test runner     — loop eksekusi (capability-gated)
            refactor: true,  // refactoring otonom — Fase 8 (capability-gated)
            planner: true,   // fase planning (investigasi berbudget) ✔
            powershell: authorized(psAvailable),         // diagnostics PS (capability-gated)
            review: true,    // tinjauan diff mekanis sebelum commit ✔
            memory: true,    // MemoryEngine + bug memory ✔
            // Truthful authority state: presence is NOT authority.
            ownerRatificationRequired: [g, s, installed, psAvailable].some(isDenial),
            notAuthorized: [g, s, installed, psAvailable].map(denialOf).filter(Boolean)
        };
    }
}

module.exports = new CodingBrain();
