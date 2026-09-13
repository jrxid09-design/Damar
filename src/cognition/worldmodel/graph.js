"use strict";

/**
 * W7-L2 WORLD MODEL — operasi graf situasi (spec §10). Setiap traversal
 * dibatasi eksplisit; melebihi batas mengembalikan hasil parsial dengan
 * `truncated: true`, TIDAK PERNAH walk tak terbatas (WM-A7).
 */

const { BOUNDS } = require("./bounds");

function adjacency(relations, entityId) {
    const out = [];
    for (const r of relations.values()) {
        if (r.from === entityId) out.push({ neighborId: r.to, relation: r });
        else if (!r.directed && r.to === entityId) out.push({ neighborId: r.from, relation: r });
    }
    return out;
}

function neighbors(state, entityId, kinds = null, depth = 1) {
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
    const boundedLimit = Math.min(limit, BOUNDS.ENTITIES_BY_KIND_LIMIT);
    const all = [...state.entities.values()].filter(e => e.entityKind === kind);
    return { entities: all.slice(0, boundedLimit), truncated: all.length > boundedLimit };
}

module.exports = { neighbors, subgraph, path, entitiesByKind };
