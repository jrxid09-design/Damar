const { AITool } = require("../ai/tools");
const brain = require("./CodingBrain");

/**
 * Tool AI Coding Brain — Aether memanggil "mesin internal" lewat sini.
 *
 * Fase 1: mesin GRAF (Graphify). Aturan (ditegakkan lewat deskripsi):
 * SEBELUM membuat patch, pahami dulu hubungan antar-file/simbol dengan
 * graf — jangan menebak. Hemat: satu query graf mengembalikan subgraf
 * terscope, jauh lebih kecil dari membaca banyak file.
 */
function codingTools() {

    const graph = brain.graph;

    return [

        new AITool({
            name: "code_graph_query",
            description:
                "Cari file/simbol RELEVAN untuk sebuah tugas lewat graph proyek (dependency/" +
                "call/import). Pakai ini DULU sebelum membaca file atau membuat patch, agar " +
                "tahu apa yang saling terhubung. Balikan = subgraf terscope (node + edge).",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "Pertanyaan bahasa alami, mis. 'di mana konektor OpenClaw dipakai?'." },
                    project: { type: "string", description: "Path root proyek (opsional; default proyek daemon)." }
                },
                required: ["question"]
            },
            execute: async ({ question, project }) => {
                if (!graph.hasGraph(project)) {
                    return { ok: false, note: "Proyek belum punya graph (graphify-out/graph.json). Bangun dulu: graphify extract/update." };
                }
                return { ok: true, result: await graph.query(question, { project }) };
            }
        }),

        new AITool({
            name: "code_graph_path",
            description:
                "Tampilkan JALUR hubungan antara dua simbol/konsep A→B (bagaimana keduanya " +
                "terkait via pemanggilan/impor). Pakai untuk memahami dampak sebuah perubahan.",
            parameters: {
                type: "object",
                properties: {
                    from: { type: "string", description: "Simbol/konsep asal." },
                    to: { type: "string", description: "Simbol/konsep tujuan." },
                    project: { type: "string", description: "Path root proyek (opsional)." }
                },
                required: ["from", "to"]
            },
            execute: async ({ from, to, project }) => ({ ok: true, result: await graph.path(from, to, { project }) })
        }),

        new AITool({
            name: "code_graph_explain",
            description:
                "Penjelasan terfokus sebuah konsep/simbol dari graph (definisi + tetangga " +
                "terpenting). Lebih ringkas dari membaca seluruh file.",
            parameters: {
                type: "object",
                properties: {
                    concept: { type: "string", description: "Nama simbol/konsep yang ingin dipahami." },
                    project: { type: "string", description: "Path root proyek (opsional)." }
                },
                required: ["concept"]
            },
            execute: async ({ concept, project }) => ({ ok: true, result: await graph.explain(concept, { project }) })
        }),

        new AITool({
            name: "code_graph_update",
            description:
                "Segarkan graph proyek setelah kode diubah (AST-only, tanpa biaya API). " +
                "Panggil setelah membuat patch agar analisis berikutnya akurat.",
            parameters: {
                type: "object",
                properties: { project: { type: "string", description: "Path root proyek (opsional)." } }
            },
            execute: async ({ project }) => { await graph.update(project); return { ok: true, updated: true }; }
        }),

        // ---- Mesin SIMBOL (Serena, Fase 2) ---------------------------

        new AITool({
            name: "code_symbol_index",
            description:
                "Bangun/segarkan cache SIMBOL proyek (Serena/LSP) agar navigasi simbol " +
                "cepat & akurat. Jalankan sekali per proyek (atau setelah perubahan besar) " +
                "sebelum mengandalkan analisis simbol.",
            parameters: {
                type: "object",
                properties: { project: { type: "string", description: "Path root proyek (opsional)." } }
            },
            execute: async ({ project }) => {
                if (!await brain.symbol.available()) return { ok: false, note: "Serena belum terpasang." };
                return brain.symbol.index(project);
            }
        }),

        new AITool({
            name: "code_symbol_health",
            description: "Diagnosa kesiapan proyek untuk analisis simbol (Serena health-check).",
            parameters: {
                type: "object",
                properties: { project: { type: "string", description: "Path root proyek (opsional)." } }
            },
            execute: async ({ project }) => {
                if (!await brain.symbol.available()) return { ok: false, note: "Serena belum terpasang." };
                return brain.symbol.healthCheck(project);
            }
        }),

        // ---- Mesin AST (Tree-sitter, Fase 3) -------------------------

        new AITool({
            name: "code_ast_outline",
            description:
                "Outline SIMBOL sebuah file/potongan kode dari AST Tree-sitter (kelas/fungsi/" +
                "method/interface + baris & kedalaman). Sumber kebenaran struktur kode — pakai " +
                "ini alih-alih menebak/regex saat perlu memahami isi satu file. Beri `file` " +
                "(path) ATAU `code`+`lang`.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string", description: "Path file (mis. src/x.js). Diprioritaskan." },
                    code: { type: "string", description: "Potongan kode langsung (butuh 'lang')." },
                    lang: { type: "string", description: "Bahasa/ekstensi untuk 'code' (js/ts/py/go/rs/…)." }
                }
            },
            execute: async ({ file, code, lang }) => {
                if (!await brain.ast.available()) return { ok: false, note: "Tree-sitter belum terpasang." };
                const r = file ? await brain.ast.symbolsOfFile(file)
                    : await brain.ast.symbols(String(code ?? ""), lang ?? "js");
                return { ok: true, ...r };
            }
        }),

        // ---- Fase PLANNING: investigasi berbudget --------------------

        new AITool({
            name: "code_plan",
            description:
                "MULAI dari sini untuk tugas koding non-sepele. Satu panggilan mengumpulkan dosir " +
                "terscope: pengalaman lampau + file relevan (Graphify) + outline simbol (LSP/Tree-" +
                "sitter), dedup & berbudget (maks 8 langkah) — HEMAT tool budget, cegah baca file " +
                "sama dua kali. Balikan juga saran branch, file yang mungkin disentuh, langkah " +
                "verifikasi yang tersedia, dan checklist workflow. Pakai SEBELUM membaca file manual.",
            parameters: {
                type: "object",
                properties: {
                    task: { type: "string", description: "Deskripsi tugas/gejala bug." },
                    project: { type: "string", description: "Root proyek (opsional)." },
                    budget: { type: "number", description: "Maks langkah investigasi (default 8)." },
                    seedFiles: { type: "array", items: { type: "string" }, description: "File awal yang diprioritaskan (opsional)." }
                },
                required: ["task"]
            },
            execute: async ({ task, project, budget, seedFiles }) =>
                brain.planner.plan(task, { project, budget, seedFiles: seedFiles || [] })
        }),

        // ---- Loop eksekusi: patcher + tester + bug-memory ------------

        new AITool({
            name: "code_recall_fixes",
            description:
                "INGAT perbaikan bug lampau yang mirip gejala INI sebelum investigasi baru " +
                "(hemat tool budget — jangan ulangi kerja). Balikan: Root Cause/Patch/File/" +
                "Lesson dari memori. Panggil paling awal saat menghadapi bug.",
            parameters: {
                type: "object",
                properties: { symptom: { type: "string", description: "Gejala/pesan error/tugas." } },
                required: ["symptom"]
            },
            execute: async ({ symptom }) => brain.bugMemory.recall(symptom)
        }),

        new AITool({
            name: "code_test",
            description:
                "Jalankan verifikasi proyek (lint+test dari package.json; skip yang tak ada). " +
                "Gerbang WAJIB setelah menambal — jangan anggap selesai sebelum ini hijau. " +
                "Balikan { ok, failed?, steps } berisi output untuk diagnosa.",
            parameters: {
                type: "object",
                properties: {
                    project: { type: "string", description: "Path root proyek (opsional)." },
                    steps: { type: "array", items: { type: "string" }, description: "Urutan script, default ['lint','test']." }
                }
            },
            execute: async ({ project, steps }) => brain.tester.verify(project, steps ? { steps } : undefined)
        }),

        new AITool({
            name: "code_check_syntax",
            description: "Cek sintaks satu file JS tanpa mengeksekusinya (node --check). Cepat, dipakai setelah edit.",
            parameters: {
                type: "object",
                properties: { file: { type: "string", description: "Path file .js/.cjs/.mjs." } },
                required: ["file"]
            },
            execute: async ({ file }) => brain.tester.check(file)
        }),

        new AITool({
            name: "code_branch",
            description:
                "Buat BRANCH git kerja SEBELUM menambal (patch aman & bisa dibuang). Wajib " +
                "sebelum mengubah kode pada tugas non-sepele.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Nama branch, mis. 'aether/fix-openclaw-404'." },
                    project: { type: "string", description: "Path root proyek (opsional)." }
                },
                required: ["name"]
            },
            execute: async ({ name, project }) => {
                if (!await brain.patcher.isRepo(project)) return { ok: false, note: "Bukan repo git." };
                return brain.patcher.createBranch(name, project);
            }
        }),

        new AITool({
            name: "code_commit",
            description: "Commit perubahan SETELAH test hijau (stage semua). Kembalikan hasil commit.",
            parameters: {
                type: "object",
                properties: {
                    message: { type: "string", description: "Pesan commit (imperatif, ringkas)." },
                    project: { type: "string", description: "Path root proyek (opsional)." }
                },
                required: ["message"]
            },
            execute: async ({ message, project }) => brain.patcher.commit(message, project)
        }),

        new AITool({
            name: "code_rollback",
            description:
                "ROLLBACK aman: buang perubahan belum-commit (kembalikan file ke HEAD) bila " +
                "test gagal. Bukan reset destruktif. Beri daftar file, atau kosong = semua.",
            parameters: {
                type: "object",
                properties: {
                    files: { type: "array", items: { type: "string" }, description: "File yang dikembalikan; kosong = semua." },
                    project: { type: "string", description: "Path root proyek (opsional)." }
                }
            },
            execute: async ({ files, project }) => brain.patcher.restore(files, project)
        }),

        // ---- Mesin LSP (Fase 4) — semantik akurat lintas-file ---------

        new AITool({
            name: "code_lsp_status",
            description:
                "Cek language server mana yang TERPASANG (ts/js, python, json, yaml, html, css, " +
                "markdown, bash) + health klien aktif. Pakai untuk tahu apakah analisis LSP " +
                "tersedia; bila tidak, Aether otomatis pakai Tree-sitter/Serena.",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ ok: true, installed: brain.lsp.installed(), health: brain.lsp.health() })
        }),

        new AITool({
            name: "code_definition",
            description:
                "Go to Definition (LSP): di mana simbol pada file:line:col DIDEFINISIKAN. Semantik " +
                "akurat lintas-file — pakai ini alih-alih menebak. line & col 1-based.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string" }, line: { type: "number" }, column: { type: "number" },
                    project: { type: "string", description: "Root proyek (opsional)." }
                },
                required: ["file", "line", "column"]
            },
            execute: async ({ file, line, column, project }) =>
                brain.lsp.op("definition", file, [line - 1, column - 1], { project })
        }),

        new AITool({
            name: "code_references",
            description:
                "Find References (LSP): semua tempat simbol pada file:line:col DIPAKAI. Wajib untuk " +
                "menilai dampak sebelum rename/patch (root-cause, bukan gejala). line & col 1-based.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string" }, line: { type: "number" }, column: { type: "number" },
                    includeDeclaration: { type: "boolean", description: "Sertakan deklarasi (default true)." },
                    project: { type: "string" }
                },
                required: ["file", "line", "column"]
            },
            execute: async ({ file, line, column, includeDeclaration = true, project }) =>
                brain.lsp.op("references", file, [line - 1, column - 1, includeDeclaration], { project })
        }),

        new AITool({
            name: "code_hover",
            description: "Hover (LSP): tipe/signature/dokumentasi simbol pada file:line:col. line & col 1-based.",
            parameters: {
                type: "object",
                properties: { file: { type: "string" }, line: { type: "number" }, column: { type: "number" }, project: { type: "string" } },
                required: ["file", "line", "column"]
            },
            execute: async ({ file, line, column, project }) =>
                brain.lsp.op("hover", file, [line - 1, column - 1], { project })
        }),

        new AITool({
            name: "code_rename_symbol",
            description:
                "Rename Symbol (LSP): hitung WorkspaceEdit untuk mengganti nama simbol di file:line:col " +
                "ke newName di SELURUH proyek (aman, sadar-scope). Kembalikan edit — terapkan lewat " +
                "patcher lalu test. line & col 1-based.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string" }, line: { type: "number" }, column: { type: "number" },
                    newName: { type: "string" }, project: { type: "string" }
                },
                required: ["file", "line", "column", "newName"]
            },
            execute: async ({ file, line, column, newName, project }) =>
                brain.lsp.op("rename", file, [line - 1, column - 1, newName], { project })
        }),

        new AITool({
            name: "code_diagnostics",
            description:
                "Diagnostics (LSP): error/warning compiler/linter untuk sebuah file (type error, " +
                "unresolved import, dsb). Pakai setelah patch untuk verifikasi cepat sebelum test.",
            parameters: {
                type: "object",
                properties: { file: { type: "string" }, project: { type: "string" } },
                required: ["file"]
            },
            execute: async ({ file, project }) => {
                if (/\.ps(m?1|d1)$/i.test(file)) return brain.powershell.analyze(file);   // PS → PSScriptAnalyzer
                return brain.lsp.op("getDiagnostics", file, [], { project });
            }
        }),

        new AITool({
            name: "code_ps_analyze",
            description:
                "Diagnostics/lint PowerShell (.ps1/.psm1) via PSScriptAnalyzer — aturan resmi PS " +
                "(Invoke-Expression, Write-Host, perbandingan $null, dsb). Pakai untuk memeriksa " +
                "skrip deploy/otomasi sebelum menjalankannya.",
            parameters: {
                type: "object",
                properties: { file: { type: "string", description: "Path file .ps1/.psm1." } },
                required: ["file"]
            },
            execute: async ({ file }) => brain.powershell.analyze(file)
        }),

        new AITool({
            name: "code_doc_symbols",
            description:
                "Document Symbols (LSP): outline simbol satu file. Bila LSP tak ada, Aether pakai " +
                "Tree-sitter otomatis (lewat brain.outline). Sumber ikut dilaporkan.",
            parameters: {
                type: "object",
                properties: { file: { type: "string" }, project: { type: "string" } },
                required: ["file"]
            },
            execute: async ({ file, project }) => ({ ok: true, ...(await brain.outline(file, { project })) })
        }),

        new AITool({
            name: "code_workspace_symbols",
            description: "Workspace Symbols (LSP): cari simbol berdasarkan nama di SELURUH proyek. Beri contoh file berbahasa target agar server tepat.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string" },
                    file: { type: "string", description: "Contoh file berbahasa target (mis. src/x.ts) utk memilih server." },
                    project: { type: "string" }
                },
                required: ["query", "file"]
            },
            execute: async ({ query, file, project }) => brain.lsp.op("workspaceSymbols", file, [query], { project })
        }),

        new AITool({
            name: "code_code_actions",
            description:
                "Code Actions (LSP): quick-fix/refactor yang ditawarkan server pada rentang file " +
                "(baris awal→akhir, 1-based). Sumber ide refactor otomatis (Fase 8).",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string" },
                    startLine: { type: "number" }, endLine: { type: "number" },
                    project: { type: "string" }
                },
                required: ["file", "startLine", "endLine"]
            },
            execute: async ({ file, startLine, endLine, project }) => {
                const range = { start: { line: startLine - 1, character: 0 }, end: { line: endLine - 1, character: 0 } };
                return brain.lsp.op("codeActions", file, [range, []], { project });
            }
        }),

        // ---- Refactoring OTONOM (Fase 8) — LSP-driven + verified ------

        new AITool({
            name: "code_refactor_preview",
            description:
                "DRY-RUN rename simbol: berapa berkas & edit terdampak (dihitung LSP, sadar-scope) " +
                "TANPA mengubah apa pun. Pakai untuk menilai dampak sebelum rename sungguhan. " +
                "line & col 1-based.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string" }, line: { type: "number" }, column: { type: "number" },
                    newName: { type: "string" }, project: { type: "string" }
                },
                required: ["file", "line", "column", "newName"]
            },
            execute: async ({ file, line, column, newName, project }) =>
                brain.refactor.previewRename(file, line - 1, column - 1, newName, { project })
        }),

        new AITool({
            name: "code_refactor_rename",
            description:
                "Rename simbol OTONOM lintas-proyek + TERVERIFIKASI: LSP hitung edit → branch git → " +
                "tulis → lint+test → commit bila hijau / ROLLBACK bila merah → segarkan graf. Cara " +
                "aman mengganti nama fungsi/kelas/variabel di seluruh proyek. line & col 1-based.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string" }, line: { type: "number" }, column: { type: "number" },
                    newName: { type: "string" },
                    project: { type: "string" },
                    verifySteps: { type: "array", items: { type: "string" }, description: "Urutan verifikasi, default ['lint','test']." }
                },
                required: ["file", "line", "column", "newName"]
            },
            execute: async ({ file, line, column, newName, project, verifySteps }) =>
                brain.refactor.renameSymbol({ file, line: line - 1, character: column - 1, newName, project, verifySteps })
        }),

        new AITool({
            name: "code_refactor_actions",
            description:
                "Daftar REFACTOR/quick-fix yang ditawarkan LSP pada rentang baris (extract/inline/" +
                "rewrite/source). Sumber ide refactoring otomatis. Baris 1-based.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" },
                    project: { type: "string" }
                },
                required: ["file", "startLine", "endLine"]
            },
            execute: async ({ file, startLine, endLine, project }) =>
                brain.refactor.actions(file, startLine - 1, endLine - 1, { project })
        }),

        new AITool({
            name: "code_refactor_apply_action",
            description:
                "Terapkan satu code action refactor (berdasarkan judul dari code_refactor_actions) " +
                "secara OTONOM+TERVERIFIKASI (branch→apply→test→commit/rollback). Hanya action " +
                "yang membawa edit langsung; yang berbasis command dilewati dgn catatan. Baris 1-based.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" },
                    title: { type: "string", description: "Judul action persis dari code_refactor_actions." },
                    project: { type: "string" },
                    verifySteps: { type: "array", items: { type: "string" } }
                },
                required: ["file", "startLine", "endLine", "title"]
            },
            execute: async ({ file, startLine, endLine, title, project, verifySteps }) =>
                brain.refactor.applyAction(file, startLine - 1, endLine - 1, title, { project, verifySteps })
        }),

        new AITool({
            name: "code_completion",
            description:
                "Completion (LSP): kandidat autocomplete pada file:line:col (member/simbol/keyword). " +
                "Opsional — berguna saat menyusun patch agar nama API tepat. line & col 1-based.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string" }, line: { type: "number" }, column: { type: "number" },
                    limit: { type: "number", description: "Batasi jumlah item (default 25)." },
                    project: { type: "string" }
                },
                required: ["file", "line", "column"]
            },
            execute: async ({ file, line, column, limit = 25, project }) => {
                const r = await brain.lsp.op("completion", file, [line - 1, column - 1], { project });
                if (!r.available || !r.result) return r;
                const items = Array.isArray(r.result) ? r.result : (r.result.items || []);
                return { available: true, count: items.length, items: items.slice(0, limit).map(i => ({ label: i.label, kind: i.kind, detail: i.detail })) };
            }
        }),

        new AITool({
            name: "code_semantic_tokens",
            description:
                "Semantic Tokens (LSP, jika server dukung): klasifikasi token semantik satu file " +
                "(legend + data terenkode relatif). Balikan { available:false } bila server tak dukung.",
            parameters: {
                type: "object",
                properties: { file: { type: "string" }, project: { type: "string" } },
                required: ["file"]
            },
            execute: async ({ file, project }) => {
                const r = await brain.lsp.op("semanticTokens", file, [], { project });
                return r.available ? r.result : r;   // ratakan nesting op→client
            }
        }),

        new AITool({
            name: "code_remember_fix",
            description:
                "SIMPAN pengalaman perbaikan setelah test hijau (Root Cause/Patch/File/Lesson) " +
                "agar bug serupa cepat selesai lain kali. Panggil di akhir setiap perbaikan.",
            parameters: {
                type: "object",
                properties: {
                    symptom: { type: "string", description: "Gejala awal." },
                    file: { type: "string", description: "File utama yang diubah." },
                    rootCause: { type: "string", description: "Akar masalah sebenarnya." },
                    patch: { type: "string", description: "Ringkas patch yang menyelesaikan." },
                    lesson: { type: "string", description: "Pelajaran agar tak terulang." }
                },
                required: ["rootCause", "lesson"]
            },
            execute: async (exp) => brain.bugMemory.record(exp)
        })

    ];
}

module.exports = { codingTools };
