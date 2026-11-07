const engine = require("../../memory/core/MemoryEngine");

/**
 * bugMemory — pengalaman bug Coding Brain (Fase 5, loop eksekusi).
 *
 * Setiap bug yang BERHASIL diperbaiki disimpan: Root Cause / Patch / File /
 * Lesson. Disimpan sebagai memori operasional agen (tipe "skills" =
 * auto-commit, bukan proposal ask-tier) lewat MemoryEngine — jadi memori
 * milik Damar Core & bisa di-recall sebelum menambal bug serupa.
 *
 * Alur: recall(gejala) SEBELUM investigasi → hemat tool budget; record()
 * SETELAH test hijau.
 */
class BugMemory {

    /** Simpan satu pengalaman perbaikan (dipanggil setelah test lulus). */
    async record({ rootCause, patch, file, lesson, symptom } = {}) {
        const content = [
            symptom && `Gejala: ${symptom}`,
            file && `File: ${file}`,
            rootCause && `Root cause: ${rootCause}`,
            patch && `Patch: ${patch}`,
            lesson && `Lesson: ${lesson}`
        ].filter(Boolean).join("\n");
        if (!content) return { ok: false, note: "kosong" };

        const res = await engine.remember(
            content,
            { type: "skills", entities: file ? [file] : [], metadata: { kind: "bugfix", file: file || null } },
            engine.context({ writer: "coding-brain" })
        );
        return { ok: true, id: res?.id ?? res?.memoryId ?? null };
    }

    /** Ingat perbaikan lampau yang mirip gejala/tugas (sebelum menambal). */
    async recall(symptom, { limit = 5 } = {}) {
        const r = await engine.recall(symptom, { limit });
        const items = Array.isArray(r) ? r : (r?.items || r?.results || []);
        const hits = items.filter(it => (it.metadata?.kind || it.meta?.kind) === "bugfix");
        return { ok: true, count: hits.length, experiences: (hits.length ? hits : items).slice(0, limit) };
    }

}

module.exports = new BugMemory();
