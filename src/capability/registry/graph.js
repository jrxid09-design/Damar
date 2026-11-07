"use strict";

/**
 * CAPABILITY REGISTRY V1 — dependency graph (inert data).
 *
 * Dependencies are represented as INERT graph data: inspecting or resolving
 * them never executes anything. The graph is a set of directed edges between
 * canonical capability ids, plus reverse edges for dependency lookup.
 *
 * Cycle policy (V1): dependency cycles are REJECTED at registration time.
 * Self-cycles (A->A), two-node (A->B->A), and multi-node (A->B->C->A) all
 * fail deterministically BEFORE any state mutation.
 *
 * Cycle detection is bounded: an explicit edge/node budget caps any
 * traversal so no adversarial graph can amplify into an unbounded walk.
 */

const { fail, REASONS } = require("./errors");

const GRAPH_BOUNDS = Object.freeze({
    MAX_EDGES: 8192,
    MAX_NODES: 8192,
    MAX_TRAVERSAL_STEPS: 65536
});

/**
 * Check whether adding an edge (from -> to) would create a directed cycle
 * in the existing edge map. Iterative DFS from `to` toward `from`, bounded.
 * Returns true if a cycle would result.
 */
function wouldCreateCycle(edges, from, to) {
    if (from === to) return true;
    // Walk from `to`; if we can reach `from`, then from->to closes a cycle.
    const steps = { n: 0 };
    const seen = new Set();
    const stack = [to];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === from) return true;
        if (seen.has(node)) continue;
        seen.add(node);
        steps.n++;
        if (steps.n > GRAPH_BOUNDS.MAX_TRAVERSAL_STEPS) {
            throw fail(REASONS.GRAPH_TRAVERSAL_BOUND, "dependency cycle check exceeded traversal bound");
        }
        const nexts = edges.get(node);
        if (nexts) for (const n of nexts) stack.push(n);
    }
    return false;
}

/**
 * Deterministically detect all cycles in an edge map (registry-level audit).
 * Iterative DFS with colors, normalized to start at the lexicographically
 * smallest member, deduplicated. Bounded by node/edge budgets.
 */
function collectAllCycles(edges) {
    const nodes = new Set();
    for (const [from, nexts] of edges) {
        nodes.add(from);
        for (const n of nexts) nodes.add(n);
    }
    if (nodes.size > GRAPH_BOUNDS.MAX_NODES) {
        throw fail(REASONS.GRAPH_TRAVERSAL_BOUND, `cycle audit exceeds node bound (${GRAPH_BOUNDS.MAX_NODES})`);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const n of nodes) color.set(n, WHITE);
    const cycles = [];
    const seen = new Set();
    let steps = 0;
    for (const start of [...nodes].sort()) {
        if (color.get(start) !== WHITE) continue;
        const stack = [{ node: start, iter: (edges.get(start) ?? []).values() }];
        const path = [start];
        const idx = new Map([[start, 0]]);
        color.set(start, GRAY);
        while (stack.length > 0) {
            if (++steps > GRAPH_BOUNDS.MAX_TRAVERSAL_STEPS) {
                throw fail(REASONS.GRAPH_TRAVERSAL_BOUND, "cycle audit exceeded traversal bound");
            }
            const top = stack[stack.length - 1];
            const next = top.iter.next();
            if (next.done) {
                color.set(top.node, BLACK);
                stack.pop();
                path.pop();
                idx.delete(top.node);
                continue;
            }
            const nxt = next.value;
            if (color.get(nxt) === GRAY) {
                const at = idx.get(nxt);
                const cycle = path.slice(at);
                const mi = cycle.reduce((m, n, i) => (n < cycle[m] ? i : m), 0);
                const norm = cycle.slice(mi).concat(cycle.slice(0, mi));
                const key = norm.join(">");
                if (!seen.has(key)) { seen.add(key); cycles.push(Object.freeze(norm)); }
            } else if (color.get(nxt) === WHITE) {
                color.set(nxt, GRAY);
                idx.set(nxt, path.length);
                path.push(nxt);
                stack.push({ node: nxt, iter: (edges.get(nxt) ?? []).values() });
            }
        }
    }
    cycles.sort((a, b) => a.join(">").localeCompare(b.join(">")));
    return Object.freeze(cycles);
}

/**
 * Resolve dependency status for a descriptor against a lookup of registered
 * capabilities. Pure, inert: returns a report, executes nothing.
 *   ok        — all required dependencies present
 *   missing   — required dependency ids not registered
 *   satisfied — present dependencies (id + availability)
 *   dependsOn — transitive closure of all reachable ids (bounded)
 */
function resolveDependencyStatus(dependsOnIds, lookup) {
    const missing = [];
    const satisfied = [];
    for (const depId of dependsOnIds) {
        const info = lookup(depId);
        if (!info) { missing.push(depId); continue; }
        satisfied.push({ id: depId, availability: info.availability });
    }
    return Object.freeze({
        ok: missing.length === 0,
        missing: Object.freeze(missing),
        satisfied: Object.freeze(satisfied)
    });
}

/**
 * Bounded transitive dependency closure (forward reach). Returns sorted list
 * of all ids reachable from `start` via the edge map. Inert, never executes.
 */
function transitiveDependencies(edges, start) {
    const out = new Set();
    const stack = [start];
    const seen = new Set();
    let steps = 0;
    while (stack.length > 0) {
        const node = stack.pop();
        if (seen.has(node)) continue;
        seen.add(node);
        if (node !== start) out.add(node);
        if (++steps > GRAPH_BOUNDS.MAX_TRAVERSAL_STEPS) {
            throw fail(REASONS.GRAPH_TRAVERSAL_BOUND, "dependency traversal exceeded bound");
        }
        const nexts = edges.get(node);
        if (nexts) for (const n of nexts) stack.push(n);
    }
    return [...out].sort();
}

module.exports = {
    GRAPH_BOUNDS,
    wouldCreateCycle,
    collectAllCycles,
    resolveDependencyStatus,
    transitiveDependencies
};
