const CapabilityIndex = require("./CapabilityIndex");
const SchemaMinimizer = require("./SchemaMinimizer");

/**
 * TOOL_SEARCH — satu-satunya tool yang perlu dilihat model ketika
 * kemampuan yang diminta tidak ada di daftarnya.
 *
 * Model TIDAK menerima seluruh katalog. Ia mencari dengan kata
 * kunci, menerima direktori ringkas (nama + deskripsi pendek +
 * risiko), lalu runtime yang MENGUNGKAPKAN schema tool terpilih
 * pada putaran berikutnya (lihat RuntimeExecutor.disclose).
 *
 * Pencarian deterministik di atas index kapabilitas — bukan LLM.
 */

function createToolSearchTool({ getTools = null } = {}) {

    const AITool = require("./AITool");

    return new AITool({
        name: "tool_search",
        description:
            "Cari tool/kemampuan Aether yang tidak terlihat di daftarmu saat ini. " +
            "Pakai bila permintaan pengguna butuh kemampuan yang belum kamu lihat. " +
            "Hasilnya direktori kandidat; panggil tool yang cocok setelah ini.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Kebutuhan dalam kata kunci, mis. 'analisis kamera depan'."
                },
                limit: {
                    type: "integer",
                    description: "Maksimal hasil (default 8, maks 20)."
                }
            },
            required: ["query"]
        },
        meta: {
            capabilities: ["tool-discovery", "meta"],
            keywords: ["cari tool", "kemampuan", "capability", "search tools"],
            domain: "meta",
            risk: "low",
            sideEffects: false,
            readOnly: true
        },
        execute: async ({ query, limit }, ctx = {}) => {

            if (!getTools) {
                return { error: { code: "EXECUTION_ERROR", message: "registry tidak tersedia" } };
            }

            // INVARIANT E: discovery hanya atas universe yang BOLEH
            // dilihat identitas pemanggil — gerbang disklosur yang sama
            // dengan Pipeline & deferred disclosure. Nama/deskripsi/risk
            // tool tak berhak tidak pernah keluar dari sini.
            const Authorization = require("./Authorization");

            const eligible = Authorization.disclosureFilter(
                getTools() ?? [],
                ctx?.exec ?? {}
            );

            // Jangan merekomendasikan dirinya sendiri.
            const pool = eligible.filter(t => t.name !== "tool_search");

            const records = CapabilityIndex.build(pool);

            const hits = require("./Retriever")
                .retrieve(records, { message: String(query ?? "") })
                .slice(0, Math.min(Math.max(Number(limit) || 8, 1), 20));

            return {
                query: String(query ?? ""),
                found: hits.length,
                directory: hits.map(h => ({
                    name: h.record.name,
                    description: SchemaMinimizer.trim(h.record.description, 100),
                    risk: h.record.risk,
                    source: h.record.source
                })),
                note: "Panggil salah satu nama di atas; Aether akan melampirkan schema-nya."
            };

        }
    });

}

module.exports = { createToolSearchTool };

