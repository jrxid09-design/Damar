const fs = require("node:fs");
const path = require("node:path");

const response = require("../utils/response");

/**
 * GraphController — graf CODING dari graphify-out/graph.json.
 *
 * Graphify (AST) dipakai untuk navigasi struktur kode; endpoint ini
 * menyajikan subgraf ringan untuk visualisasi Memori → Graf Koding:
 * node disaring per file/simbol, link dibatasi, agar canvas tetap
 * responsif (graf penuh ±10k node).
 */
class GraphController {

    load() {
        if (this._graph && Date.now() - this._loadedAt < 60000) return this._graph;
        const file = path.join(process.cwd(), "graphify-out", "graph.json");
        this._graph = JSON.parse(fs.readFileSync(file, "utf8"));
        this._loadedAt = Date.now();
        return this._graph;
    }

    /** Ringkasan struktur: file → jumlah simbol, komunitas teratas. */
    async coding(req, res, next) {
        try {

            const g = this.load();
            const limit = Math.min(Number(req.query.limit ?? 160), 400);

            // Node kode (AST) — pilih yang paling "terhubung".
            const nodes = (g.nodes ?? []).filter(n => n.file_type === "code");

            const degree = new Map();
            for (const l of (g.links ?? [])) {
                degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
                degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
            }

            const top = nodes
                .map(n => ({ n, d: degree.get(n.id) ?? 0 }))
                .sort((a, b) => b.d - a.d)
                .slice(0, limit)
                .map(({ n, d }) => ({
                    id: n.id,
                    label: n.label,
                    file: n.source_file,
                    line: n.source_location,
                    degree: d
                }));

            const allowed = new Set(top.map(t => t.id));

            const links = (g.links ?? [])
                .filter(l => allowed.has(l.source) && allowed.has(l.target))
                .slice(0, limit * 2)
                .map(l => ({ source: l.source, target: l.target }));

            const files = [...new Set(top.map(t => t.file))].slice(0, 40);

            return response.success(res, "Graf koding (graphify)", {
                builtAt: g.built_at_commit ?? null,
                totalNodes: nodes.length,
                totalLinks: (g.links ?? []).length,
                nodes: top,
                links,
                files
            });

        }
        catch (error) {
            return response.error(res, `Graf tidak tersedia: ${error.message}`, 404);
        }
    }

}

const controller = new GraphController();
controller.coding = controller.coding.bind(controller);
module.exports = controller;
