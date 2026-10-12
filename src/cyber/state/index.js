"use strict";

/**
 * DCD CYBER STATE PLANE — security knowledge graph (projection).
 *
 * The cyber world model is a PROJECTION over the canonical substrate,
 * not a fourth world model (DC-80 / recon §4.2). Entities and their
 * confidence/freshness/contradiction state are journal-derived records.
 * The graph is a materialised projection; caches are disposable.
 * CACHE != TRUTH (I-97). COGNITIVE_PROJECTION != CANONICAL_HISTORY.
 *
 * Invariants enforced here:
 *   DC-04: NO_SECOND_REPLAY_SYSTEM — journal is store of record
 *   DC-07: NO_DIRECT_EXPLOIT_TO_EXECUTION — executable === false on all edges
 *   DC-52: NO_FULL_GRAPH_REBUILD_FOR_LOCAL_CHANGE
 *   DC-58: NO_UNBOUNDED_GRAPH_TRAVERSAL — depth/topK bounded at query time
 *   DC-80: CYBER_STATE_IS_A_PROJECTION_NOT_A_FOURTH_WORLD_MODEL
 *   DC-83: NO_SECOND_CAPABILITY_REGISTRY
 */

const contracts = require("../contracts");
const {
    GRAPH_ENTITIES, GRAPH_RELATIONS, EDGE_STATES, edgeRank,
    planPathQuery, DCD_FORBIDDEN_TIERS, ALLOWED_TIERS, EPISTEMIC_CLASSES,
} = contracts;

const VALID_ENTITY_KINDS = Object.freeze(new Set(GRAPH_ENTITIES));
const VALID_RELATION_KINDS = Object.freeze(new Set(GRAPH_RELATIONS));
const VALID_EDGE_STATES = Object.freeze(new Set(EDGE_STATES));

/**
 * Create an in-memory cyber graph projection.
 * Returns { upsertEntity, upsertEdge, getEntity, query, size, reset }.
 *
 * Null-prototype internal maps prevent prototype-pollution via
 * caller-supplied entity/relation keys.
 */
function createCyberStateProjection() {
    const entities = Object.create(null);
    const edges = Object.create(null); // "src\x00rel\x00dst" → edge

    function upsertEntity(entity) {
        const { entityId, kind, observedAt, tier, epistemicClass, ttlMs } = entity || {};
        if (typeof entityId !== "string" || !entityId) throw new Error("entityId required");
        if (!VALID_ENTITY_KINDS.has(kind)) throw new Error(`unknown entity kind '${kind}'`);
        if (!Number.isFinite(observedAt)) throw new Error("observedAt must be finite epoch-ms");
        // DC-08/DC-61: only ALLOWED_TIERS may enter the DCD projection
        if (tier && !ALLOWED_TIERS.includes(tier)) throw new Error(`DCD projection cannot carry tier '${tier}' (not in ALLOWED_TIERS; DC-08/DC-61)`);
        if (epistemicClass && !EPISTEMIC_CLASSES.includes(epistemicClass)) throw new Error(`unknown epistemicClass '${epistemicClass}'`);
        if (epistemicClass === "VERIFIED") throw new Error("DCD cannot record VERIFIED epistemicClass in graph (DC-61)");

        const e = Object.freeze({
            entityId,
            kind,
            tier:          tier || "T7",
            epistemicClass: epistemicClass || "INFERRED",
            observedAt,
            ttlMs:  typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : 86_400_000,
            updatedAt: Date.now(),
        });
        entities[entityId] = e;
        return e;
    }

    function upsertEdge(src, relation, dst, state, evidence) {
        if (!VALID_RELATION_KINDS.has(relation)) throw new Error(`unknown relation '${relation}'`);
        if (!VALID_EDGE_STATES.has(state)) throw new Error(`unknown edge state '${state}'`);
        if (typeof src !== "string" || !src) throw new Error("src must be non-empty string");
        if (typeof dst !== "string" || !dst) throw new Error("dst must be non-empty string");

        // DC-07 / DC-28: executable === false on every edge — no direct exploit-to-execution
        const key = `${src}\x00${relation}\x00${dst}`;
        const edge = Object.freeze({
            src, relation, dst, state,
            executable: false,
            evidence: Array.isArray(evidence)
                ? Object.freeze(evidence.filter(e => typeof e === "string" && e))
                : Object.freeze([]),
            rank: edgeRank(state),
            updatedAt: Date.now(),
        });
        edges[key] = edge;
        return edge;
    }

    function getEntity(entityId) {
        return entities[entityId] || null;
    }

    /**
     * Bounded path query. Refuses depth/topK/scope overages with a reason
     * (DC-58: NO_UNBOUNDED_GRAPH_TRAVERSAL; DC-151: A_BOUND_IS_REFUSED_NOT_CLAMPED).
     */
    /**
     * Bounded reachability query within an asset scope.
     * Returns all edge-paths whose src is within the scope, up to topK, up to maxDepth hops.
     */
    function query(params) {
        const qResult = planPathQuery(params);
        if (!qResult.ok) return { ok: false, reason: qResult.reason, paths: [] };

        const { assetScope, maxDepth, topK } = qResult.plan;
        const paths = [];
        const visited = new Set();
        const scopeSet = new Set(assetScope);

        for (const seed of assetScope) {
            if (paths.length >= topK) break;
            const queue = [[seed, [seed]]];
            visited.add(seed);

            while (queue.length && paths.length < topK) {
                const [node, path] = queue.shift();
                if (path.length > maxDepth + 1) continue;

                for (const key of Object.keys(edges)) {
                    const edge = edges[key];
                    if (edge.src !== node) continue;
                    const next = edge.dst;
                    // DC-58 / asset-scope: only traverse within declared scope
                    if (!scopeSet.has(next)) continue;
                    const newPath = [...path, next];
                    paths.push(Object.freeze(newPath));
                    if (paths.length >= topK) break;
                    if (!visited.has(next) && newPath.length <= maxDepth) {
                        visited.add(next);
                        queue.push([next, newPath]);
                    }
                }
            }
        }
        return { ok: true, paths: Object.freeze(paths), reason: null };
    }

    function size() {
        return {
            entities: Object.keys(entities).length,
            edges:    Object.keys(edges).length,
        };
    }

    function reset() {
        for (const k of Object.keys(entities)) delete entities[k];
        for (const k of Object.keys(edges)) delete edges[k];
    }

    return Object.freeze({ upsertEntity, upsertEdge, getEntity, query, size, reset });
}

module.exports = Object.freeze({
    createCyberStateProjection,
    VALID_ENTITY_KINDS,
    VALID_RELATION_KINDS,
    VALID_EDGE_STATES,
});
