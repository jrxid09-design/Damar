const store = require("../stores/MemoryStore");
const governor = require("../governance/Governor");

/**
 * PatternMiner (subsistem 10) — Self-Improvement.
 *
 * Menambang memori episodik untuk pola berulang, lalu MENGUSULKAN
 * (bukan menyimpan) prosedur/otomasi. SELALU proposal lewat Governor —
 * tak pernah otomatis. Pengguna yang memutuskan.
 *
 * Heuristik: tanda-tangan teks (angka dinormalkan) dikelompokkan; grup
 * dengan kemunculan >= ambang jadi kandidat. Ceiling: heuristik dangkal;
 * penambangan urutan/temporal yang lebih kaya bisa menyusul.
 */

const MIN_OCCURRENCE = 3;

class PatternMiner {

    _signature(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/\d+/g, "#")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
    }

    /** Pure: kelompokkan item jadi pola berulang. */
    _mine(items = [], min = MIN_OCCURRENCE) {
        const groups = new Map();
        for (const m of items) {
            const sig = this._signature(m.summary || m.content);
            if (!sig) continue;
            if (!groups.has(sig)) groups.set(sig, { sig, count: 0, sample: m.content });
            groups.get(sig).count++;
        }
        return [...groups.values()]
            .filter(g => g.count >= min)
            .sort((a, b) => b.count - a.count);
    }

    async suggest({ min = MIN_OCCURRENCE, limit = 500 } = {}) {
        const { items } = await store.list({ type: "episodic", limit });
        const patterns = this._mine(items, min);

        // Hindari usul ganda: lewati pola yang sudah punya proposal pending.
        const pendingSigs = new Set(
            (await governor.pending()).map(p => p.payload?.metadata?.pattern).filter(Boolean)
        );

        const proposals = [];
        for (const p of patterns) {
            if (pendingSigs.has(p.sig)) continue;
            const content =
                `Pola berulang terdeteksi (${p.count}×): "${p.sample}". ` +
                `Pertimbangkan menjadikannya prosedur atau otomasi.`;
            const r = await governor.propose({
                kind: "memory",
                payload: {
                    content, type: "procedural", source: "self-improve", importance: 0.5,
                    metadata: { memoryType: "procedural", pattern: p.sig, occurrences: p.count }
                },
                memoryType: "procedural", writer: "self-improve", role: "superadmin",
                reason: `Terdeteksi ${p.count} kejadian serupa.`
            });
            proposals.push(r.proposal);
        }
        return { patterns: patterns.length, proposals };
    }

}

module.exports = new PatternMiner();
