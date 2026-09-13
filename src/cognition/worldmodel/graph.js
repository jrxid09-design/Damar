"use strict";

/**
 * W7-L2 WORLD MODEL — operasi graf situasi (spec §10). Setiap traversal
 * dibatasi eksplisit; melebihi batas mengembalikan hasil parsial dengan
 * `truncated: true`, TIDAK PERNAH walk tak terbatas (WM-A7).
 */

const { BOUNDS } = require("./bounds");
const { REASONS, fail } = require("./errors");

function adjacency(relations, entityId) {
    const out = [];
    for (const r of relations.values()) {
        if (r.from === entityId) out.push({ neighborId: r.to, relation: r });
        else if (!r.directed && r.to === entityId) out.push({ neighborId: r.from, relation: r });
    }
    return out;
}

function neighbors(state, entityId, kinds = null, depth = 1) {
    // Bug review independen (audit putaran-22, F-2): `budget` di subgraph()
    // dijaga (putaran-20) tapi `kinds` di FUNGSI SAMA-KELAS ini tidak --
    // `kinds` bukan array/null meledakkan `.includes()` jadi TypeError
    // mentah.
    if (kinds !== null && kinds !== undefined && !Array.isArray(kinds)) {
        fail(REASONS.INVALID_RECORD, "kinds wajib array atau null");
    }
    // Bug review independen (audit putaran-24, AUD24-P2-5): default
    // parameter `depth = 1` hanya berlaku untuk `undefined` -- `depth:
    // null` eksplisit lolos lalu `Math.min(null, MAX)` menjadi 0, membuat
    // traversal diam-diam TIDAK BERJALAN SAMA SEKALI (jawaban kosong yang
    // salah, bukan error ATAU default WM-A7 yang didokumentasikan).
    // Bug review independen (audit putaran-25, AUD25-P2-3): putaran-24
    // hanya menjaga null/non-finite -- `depth: -1` lolos lalu
    // `Math.min(-1, MAX)` = -1, membuat loop `d < boundedDepth` tidak
    // pernah berjalan (traversal diam-diam kosong), sama seperti kasus null.
    if (depth === undefined || depth === null || !Number.isFinite(depth) || depth < 0) depth = 1;
    const boundedDepth = Math.min(depth, BOUNDS.NEIGHBORS_MAX_DEPTH);
    const visited = new Set([entityId]);
    let frontier = [entityId];
    let truncated = depth > BOUNDS.NEIGHBORS_MAX_DEPTH;
    const result = new Set();

    for (let d = 0; d < boundedDepth; d++) {
        const next = [];
        for (const id of frontier) {
            const edges = adjacency(state.relations, id);
            const limited = edges.slice(0, BOUNDS.NEIGHBORS_MAX_FANOUT);
            if (edges.length > BOUNDS.NEIGHBORS_MAX_FANOUT) truncated = true;
            for (const { neighborId, relation } of limited) {
                if (kinds && !kinds.includes(relation.kind)) continue;
                if (!visited.has(neighborId)) {
                    visited.add(neighborId);
                    result.add(neighborId);
                    next.push(neighborId);
                }
            }
        }
        frontier = next;
    }

    return {
        entities: [...result].map(id => state.entities.get(id)).filter(Boolean),
        truncated
    };
}

function subgraph(state, seeds = [], depth = 2, budget = { nodes: 512, bytes: 262144 }) {
    // Bug review independen (audit putaran-22, F-2): sibling `budget`
    // dijaga (putaran-20) tapi `seeds` tidak -- `seeds: null` eksplisit
    // meledakkan `new Set(seeds)`/`[...seeds]` jadi TypeError mentah
    // ("seeds is not iterable"), asimetri elemen-vs-kontainer yang sama
    // dengan AUD21-P2-1.
    if (seeds === undefined || seeds === null) seeds = [];
    else if (!Array.isArray(seeds)) fail(REASONS.INVALID_RECORD, "seeds wajib array");
    // Bug review independen (audit putaran-24, AUD24-P2-5): `depth: null`
    // eksplisit lolos default parameter lalu `Math.min(null, MAX)` = 0,
    // membuat traversal diam-diam tidak berjalan (jawaban kosong salah).
    // Bug review independen (audit putaran-25, AUD25-P2-3): negatif lolos
    // guard null/non-finite putaran-24, sama-sama membuat traversal diam-diam kosong.
    if (depth === undefined || depth === null || !Number.isFinite(depth) || depth < 0) depth = 2;
    // Bug review independen (audit putaran-20, AUD20-P2-2): default parameter
    // hanya berlaku untuk `undefined` -- `budget: null` eksplisit lolos lalu
    // meledakkan `budget.nodes`/`budget.bytes` jadi TypeError mentah.
    if (!budget || typeof budget !== "object" ||
        !Number.isFinite(budget.nodes) || !Number.isFinite(budget.bytes)) {
        budget = { nodes: 512, bytes: 262144 };
    }
    const boundedDepth = Math.min(depth, BOUNDS.NEIGHBORS_MAX_DEPTH);
    const nodeIds = new Set(seeds);
    let frontier = [...seeds];
    let truncated = false;

    for (let d = 0; d < boundedDepth && nodeIds.size < budget.nodes; d++) {
        const next = [];
        for (const id of frontier) {
            const edges = adjacency(state.relations, id).slice(0, BOUNDS.NEIGHBORS_MAX_FANOUT);
            for (const { neighborId } of edges) {
                if (nodeIds.size >= budget.nodes) { truncated = true; break; }
                if (!nodeIds.has(neighborId)) { nodeIds.add(neighborId); next.push(neighborId); }
            }
        }
        frontier = next;
    }

    const entities = [...nodeIds].map(id => state.entities.get(id)).filter(Boolean);
    const relations = [...state.relations.values()]
        .filter(r => nodeIds.has(r.from) && nodeIds.has(r.to));

    let payload = { entities, relations };
    if (Buffer.byteLength(JSON.stringify(payload)) > budget.bytes) {
        truncated = true;
        const half = Math.max(1, Math.floor(entities.length / 2));
        payload = { entities: entities.slice(0, half), relations: relations.slice(0, half) };
    }

    return { ...payload, truncated };
}

function path(state, from, to, maxDepth = 5) {
    // Bug review independen (audit putaran-24, AUD24-P2-5): `maxDepth:
    // null` eksplisit lolos default parameter lalu `Math.min(null, MAX)`
    // = 0, membuat path() diam-diam melapor "tidak ditemukan" (truncated:
    // true) alih-alih benar-benar mencari sampai PATH_MAX_DEPTH.
    // Bug review independen (audit putaran-25, AUD25-P2-3): negatif lolos
    // guard null/non-finite putaran-24, membuat path() diam-diam melapor
    // "tidak ditemukan" walau path sebenarnya ada.
    if (maxDepth === undefined || maxDepth === null || !Number.isFinite(maxDepth) || maxDepth < 0) maxDepth = 5;
    const boundedDepth = Math.min(maxDepth, BOUNDS.PATH_MAX_DEPTH);
    if (from === to) return { path: [from], truncated: false };

    const visited = new Set([from]);
    let frontier = [[from]];

    for (let d = 0; d < boundedDepth; d++) {
        const next = [];
        for (const chain of frontier) {
            const tail = chain[chain.length - 1];
            for (const { neighborId } of adjacency(state.relations, tail).slice(0, BOUNDS.NEIGHBORS_MAX_FANOUT)) {
                if (neighborId === to) return { path: [...chain, neighborId], truncated: false };
                if (!visited.has(neighborId)) {
                    visited.add(neighborId);
                    next.push([...chain, neighborId]);
                }
            }
        }
        frontier = next;
        if (frontier.length === 0) break;
    }

    return { path: null, truncated: true };
}

function entitiesByKind(state, kind, limit = 256) {
    // Bug review independen (audit putaran-24, AUD24-P2-5): `limit: null`
    // eksplisit lolos default parameter lalu `Math.min(null, MAX)` = 0,
    // membuat hasil diam-diam kosong DAN truncated:true walau entitas
    // yang cocok memang ada.
    // Bug review independen (audit putaran-25, AUD25-P2-3): putaran-24
    // hanya menjaga null/non-finite -- `limit: -1` lolos lalu
    // `Math.min(-1, MAX)` = -1, dan `.slice(0, -1)` MEMBUANG elemen
    // terakhir alih-alih membatasi, jadi `entitiesByKind("d", -1)` bisa
    // mengembalikan LEBIH BANYAK dari ENTITIES_BY_KIND_LIMIT (melanggar
    // batas yang justru mau ditegakkan). Dinormalisasi ke default untuk
    // negatif, DAN batas bawah 0 dipaksakan sebagai jaring pengaman kedua.
    if (limit === undefined || limit === null || !Number.isFinite(limit) || limit < 0) limit = 256;
    const boundedLimit = Math.max(0, Math.min(limit, BOUNDS.ENTITIES_BY_KIND_LIMIT));
    const all = [...state.entities.values()].filter(e => e.entityKind === kind);
    return { entities: all.slice(0, boundedLimit), truncated: all.length > boundedLimit };
}

module.exports = { neighbors, subgraph, path, entitiesByKind };
