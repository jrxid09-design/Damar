const fs = require("node:fs");
const { fileURLToPath } = require("node:url");
const lsp = require("../lsp/LSPManager");
const graph = require("../graph/graphifyAdapter");

/**
 * Refactorer — refactoring OTONOM & terverifikasi (Coding Brain, Fase 8).
 *
 * Sumber kebenaran perubahan = LSP (rename sadar-scope / code actions), BUKAN
 * find-replace teks. Alur aman selalu lewat loop eksekusi CodingBrain.runFix:
 *   branch → terapkan WorkspaceEdit → verify (lint+test) → commit bila hijau /
 *   rollback bila merah → segarkan graf. Bila language server tak ada →
 *   { available:false } (Aether tak menebak refactor tanpa jaminan semantik).
 *
 * Posisi API ini 0-based (native LSP); tool AI mengonversi dari 1-based.
 */

// Konversi Position LSP → offset karakter (UTF-16, cocok utk identifier).
function offsetAt(text, pos) {
    let line = 0, i = 0;
    while (line < pos.line && i < text.length) {
        const nl = text.indexOf("\n", i);
        if (nl < 0) { i = text.length; break; }
        i = nl + 1; line++;
    }
    return i + pos.character;
}

// Terapkan TextEdit[] ke satu berkas (urut mundur agar offset tak bergeser).
function applyEdits(text, edits) {
    const withOff = edits.map(e => ({ s: offsetAt(text, e.range.start), e: offsetAt(text, e.range.end), t: e.newText }));
    withOff.sort((a, b) => b.s - a.s || b.e - a.e);
    let out = text;
    for (const ed of withOff) out = out.slice(0, ed.s) + ed.t + out.slice(ed.e);
    return out;
}

class Refactorer {

    /** Normalkan WorkspaceEdit (changes / documentChanges) → Map<fsPath, TextEdit[]>. */
    collectChanges(edit) {
        const map = new Map();
        const push = (uri, edits) => {
            let p; try { p = fileURLToPath(uri); } catch { p = uri; }
            map.set(p, (map.get(p) || []).concat(edits || []));
        };
        if (edit?.changes) for (const [uri, edits] of Object.entries(edit.changes)) push(uri, edits);
        if (edit?.documentChanges) for (const dc of edit.documentChanges) {
            if (dc.textDocument && dc.edits) push(dc.textDocument.uri, dc.edits);   // abaikan create/rename/delete-file
        }
        return map;
    }

    /** Tulis WorkspaceEdit ke disk. Kembalikan berkas yang diubah. */
    async applyWorkspaceEdit(edit) {
        const map = this.collectChanges(edit);
        const files = [];
        for (const [file, edits] of map) {
            const before = fs.readFileSync(file, "utf8");
            fs.writeFileSync(file, applyEdits(before, edits), "utf8");
            files.push(file);
        }
        return { files, count: files.length };
    }

    /** DRY-RUN rename: berapa berkas/edit terdampak, tanpa mengubah apa pun. */
    async previewRename(file, line, character, newName, { project = process.cwd() } = {}) {
        const r = await lsp.op("rename", file, [line, character, newName], { project });
        if (!r.available) return { available: false, note: r.note };
        if (r.ok === false) return { ok: false, error: r.error };
        const edit = r.result;
        if (!edit || (!edit.changes && !edit.documentChanges)) {
            return { ok: false, note: "Server tak memberi edit — posisi mungkin bukan simbol yang bisa di-rename." };
        }
        const map = this.collectChanges(edit);
        return { ok: true, edit, files: [...map.keys()], edits: [...map.values()].reduce((n, a) => n + a.length, 0) };
    }

    /**
     * Rename simbol OTONOM lintas-proyek: preview (LSP) → branch → tulis edit →
     * verify → commit/rollback → segarkan graf. Aman: gagal test = rollback.
     */
    async renameSymbol({ file, line, character, newName, project = process.cwd(), verifySteps } = {}) {
        const pv = await this.previewRename(file, line, character, newName, { project });
        if (!pv.ok) return pv;

        const brain = require("../CodingBrain");                       // lazy: hindari siklus require
        const res = await brain.runFix({
            project,
            branch: `aether/refactor-rename-${newName}-${Date.now() % 100000}`,
            applyPatch: async () => { await this.applyWorkspaceEdit(pv.edit); },
            verifySteps
        });
        if (res.ok) await graph.update(project).catch(() => {});
        return { ...res, rename: { newName, files: pv.files, edits: pv.edits } };
    }

    /** Daftar refactor/quick-fix (code actions) yang ditawarkan LSP utk rentang. */
    async actions(file, startLine, endLine, { project = process.cwd() } = {}) {
        const range = { start: { line: startLine, character: 0 }, end: { line: endLine, character: 0 } };
        const r = await lsp.op("codeActions", file, [range, []], { project });
        if (!r.available) return r;
        const list = (r.result || []).filter(a => /refactor|source|quickfix/.test(a.kind || ""));
        return { available: true, actions: list.map(a => ({ title: a.title, kind: a.kind, hasEdit: !!a.edit, command: !!a.command })) };
    }

    /** Terapkan satu code action (yang membawa edit langsung) secara otonom+verified. */
    async applyAction(file, startLine, endLine, title, { project = process.cwd(), verifySteps } = {}) {
        const range = { start: { line: startLine, character: 0 }, end: { line: endLine, character: 0 } };
        const r = await lsp.op("codeActions", file, [range, []], { project });
        if (!r.available) return r;
        const act = (r.result || []).find(a => a.title === title);
        if (!act) return { ok: false, note: `Code action '${title}' tak ditemukan pada rentang itu.` };
        if (!act.edit) return { ok: false, note: `'${title}' berbasis command (executeCommand) — belum didukung; pilih action yang punya edit langsung.` };

        const brain = require("../CodingBrain");
        const res = await brain.runFix({
            project, branch: `aether/refactor-${Date.now() % 100000}`,
            applyPatch: async () => { await this.applyWorkspaceEdit(act.edit); },
            verifySteps
        });
        if (res.ok) await graph.update(project).catch(() => {});
        return { ...res, action: title };
    }

}

module.exports = new Refactorer();
