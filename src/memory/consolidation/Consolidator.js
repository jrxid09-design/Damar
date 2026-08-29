const stm = require("../stm/WorkingSet");
const types = require("../core/types");

/**
 * Consolidator (subsistem 6) — memadatkan STM menjadi kandidat LTM.
 *
 * Default hemat kuota: ringkasan heuristik dari buffer percakapan (tanpa
 * LLM). Ekstraksi fakta yang lebih kaya (preferensi/identitas/semantik)
 * bersifat OPSIONAL — pemanggil boleh menyuntik `extractor(text)` berbasis
 * LLM. Ceiling: heuristik hanya meringkas; ekstraksi fakta butuh extractor.
 *
 * Routing tier:
 *   auto → langsung di-commit via engine.remember (mis. conversation).
 *   ask  → dikembalikan sebagai `pending` (belum disimpan). Subsistem 7
 *          (Governance) akan mengubah pending menjadi PROPOSAL.
 */

const SUMMARY_MAX = 800;

class Consolidator {

    /** Pure: rangkai entri buffer jadi satu ringkasan pendek. */
    _summarize(entries = [], maxChars = SUMMARY_MAX) {
        const lines = entries
            .filter(e => e && e.text && e.text.trim())
            .map(e => `${e.role ? e.role + ": " : ""}${e.text.trim()}`);
        let out = lines.join("\n");
        if (out.length > maxChars) out = out.slice(0, maxChars - 1) + "…";
        return out;
    }

    async consolidate(scope, { engine, ctx = {}, extractor = null } = {}) {
        if (!engine) engine = require("../core/MemoryEngine");

        const summary = this._summarize(stm.get(scope, "conversation"));
        const candidates = [];
        if (summary.trim()) {
            candidates.push({ type: "conversation", content: `Ringkasan percakapan (${scope}): ${summary}` });
        }
        if (typeof extractor === "function") {
            const facts = (await extractor(stm.summarizeInput(scope))) || [];
            for (const f of facts) {
                if (f && f.content) candidates.push({ type: f.type || "semantic", content: f.content });
            }
        }

        // Kebijakan pemilik: semua tier langsung commit — Damar
        // mengatur memorinya sendiri tanpa gerbang persetujuan.
        const committed = [];
        for (const c of candidates) {
            const saved = await engine.remember(
                c.content, { type: c.type },
                engine.context({ writer: ctx.writer || "consolidator", scope })
            );
            committed.push(saved);
        }
        return { committed, pending: [] };
    }

}

module.exports = new Consolidator();
