const memory = require("../services/MemoryService");
const edges = require("../graph/EdgeStore");

/**
 * Retriever (subsistem 5) — satu jalur ambil-konteks yang MENGGABUNGKAN
 * recall hibrida (kata kunci + entitas + vektor, sudah ada di
 * RecallService) dengan perluasan Knowledge Graph.
 *
 * Tak menduplikasi peringkat recall; hanya menambah lapisan graf:
 * dari entitas pada memori yang terpanggil, tarik sisi hidup di
 * sekitarnya sebagai konteks relasional. Inilah yang belum dilakukan
 * pipeline recall sendirian.
 */
class Retriever {

    async retrieve(query, { limit = 8, expand = true, graphLimit = 8, ...recallOpts } = {}) {
        const recall = await memory.recall(query, { limit, ...recallOpts });
        const items = recall.items || [];

        if (!expand || !items.length) {
            return { query: recall.query, items, edges: [], strategies: recall.strategies || [] };
        }

        // Simpul benih = nama entitas pada memori yang terpanggil.
        const seeds = new Set();
        for (const m of items) {
            for (const e of (m.entities || [])) if (e?.name) seeds.add(e.name);
        }

        const seen = new Set();
        const related = [];
        for (const node of seeds) {
            for (const edge of await edges.neighbors(node, { limit: graphLimit })) {
                const key = `${edge.subject}|${edge.predicate}|${edge.object}`;
                if (seen.has(key)) continue;
                seen.add(key);
                related.push(edge);
            }
        }

        return {
            query: recall.query,
            items,
            edges: related,
            strategies: [...(recall.strategies || []), ...(related.length ? ["graph"] : [])]
        };
    }

}

module.exports = new Retriever();
