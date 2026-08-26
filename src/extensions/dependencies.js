"use strict";

/**
 * EXTENSION KERNEL V1 — deterministic dependency resolution.
 *
 * Pure functions over registry views. No mutation, no auto-enable: the
 * report is advisory state that enable() gates on explicitly.
 *
 * Detects:
 *   - missing required dependency (not registered)
 *   - disabled required dependency (registered but not ACTIVE)
 *   - version mismatch on declared range
 *   - cycles over ALL declared edges (required + optional), reported
 *     deterministically without wedging
 */

const { satisfiesRange } = require("./semver");
const { STATES, ACTIVE_STATES } = require("./lifecycle");
const { parseExtensionManifest } = require("./manifest");

function normalizeDescriptor(descriptor) {
    return descriptor && descriptor.dependencies && descriptor.id
        ? descriptor
        : parseExtensionManifest(descriptor);
}

/**
 * @param {object} descriptor  frozen manifest descriptor (or raw manifest)
 * @param {(idValue:string) => {exists:boolean, state?:string, version?:object}|null} lookupState
 */
function buildDependencyReport(descriptor, lookupState) {
    const desc = normalizeDescriptor(descriptor);
    const missing = [];
    const disabled = [];
    const versionMismatch = [];
    const satisfied = [];

    for (const dep of desc.dependencies) {
        const info = lookupState(dep.id);
        if (!info || !info.exists) {
            if (dep.optional) continue; // absent optional deps are simply noted by absence
            missing.push({ id: dep.id, versionRange: dep.versionRange });
            continue;
        }
        if (dep.versionRange) {
            let ok = false;
            try {
                ok = info.version ? satisfiesRange(info.version, dep.versionRange) : false;
            } catch {
                ok = false;
            }
            if (!ok) {
                if (dep.optional) continue;
                versionMismatch.push({ id: dep.id, versionRange: dep.versionRange, actual: info.version ? info.version.raw : null });
                continue;
            }
        }
        if (!ACTIVE_STATES.has(info.state)) {
            if (dep.optional) continue;
            disabled.push({ id: dep.id, state: info.state ?? "UNKNOWN" });
            continue;
        }
        satisfied.push({ id: dep.id, optional: dep.optional });
    }

    return Object.freeze({
        ok: missing.length === 0 && disabled.length === 0 && versionMismatch.length === 0,
        missing: Object.freeze(missing),
        disabled: Object.freeze(disabled),
        versionMismatch: Object.freeze(versionMismatch),
        satisfied: Object.freeze(satisfied),
        cycles: findCycles(desc)
    });
}

/**
 * Cycle detection across all declared dependency edges. Iterative DFS with
 * colors; cycles are normalized to start at their lexicographically smallest
 * member and deduplicated so output is deterministic.
 */
function findCycles(descriptorOrRaw) {
    const descriptor = normalizeDescriptor(descriptorOrRaw);
    const edges = new Map();
    const nodes = new Set();
    for (const dep of descriptor.dependencies) {
        nodes.add(descriptor.id.value);
        nodes.add(dep.id);
        if (!edges.has(descriptor.id.value)) edges.set(descriptor.id.value, []);
        edges.get(descriptor.id.value).push(dep.id);
    }

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const n of nodes) color.set(n, WHITE);

    const cycles = [];
    const seenCycles = new Set();

    for (const start of [...nodes].sort()) {
        if (color.get(start) !== WHITE) continue;
        const stack = [{ node: start, iter: (edges.get(start) ?? []).values() }];
        const path = [start];
        const indexInPath = new Map([[start, 0]]);
        color.set(start, GRAY);
        while (stack.length > 0) {
            const top = stack[stack.length - 1];
            const next = top.iter.next();
            if (next.done) {
                color.set(top.node, BLACK);
                stack.pop();
                path.pop();
                indexInPath.delete(top.node);
                continue;
            }
            const nxt = next.value;
            if (color.get(nxt) === GRAY) {
                const at = indexInPath.get(nxt);
                const cycle = path.slice(at); // cycle: nxt ... -> nxt
                const minIdx = cycle.reduce((mi, n, i) => (n < cycle[mi] ? i : mi), 0);
                const normalized = cycle.slice(minIdx).concat(cycle.slice(0, minIdx));
                const key = normalized.join(">");
                if (!seenCycles.has(key)) {
                    seenCycles.add(key);
                    cycles.push(Object.freeze(normalized));
                }
            } else if (color.get(nxt) === WHITE) {
                color.set(nxt, GRAY);
                indexInPath.set(nxt, path.length);
                path.push(nxt);
                stack.push({ node: nxt, iter: (edges.get(nxt) ?? []).values() });
            }
        }
    }
    cycles.sort((a, b) => a.join(">").localeCompare(b.join(">")));
    return Object.freeze(cycles);
}

/** Scan every registered extension for cycles (registry-level audit). */
function collectAllCycles(descriptorsById) {
    // Build a global edge map and run the same DFS once.
    const edges = new Map();
    const nodes = new Set();
    for (const [id, desc] of descriptorsById) {
        nodes.add(id);
        for (const dep of desc.dependencies) {
            nodes.add(dep.id);
            if (!edges.has(id)) edges.set(id, []);
            edges.get(id).push(dep.id);
        }
    }
    return runGlobalCycleScan(nodes, edges);
}

function runGlobalCycleScan(nodes, edges) {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const n of nodes) color.set(n, WHITE);
    const cycles = [];
    const seen = new Set();
    for (const start of [...nodes].sort()) {
        if (color.get(start) !== WHITE) continue;
        const stack = [{ node: start, iter: (edges.get(start) ?? []).values() }];
        const path = [start];
        const idx = new Map([[start, 0]]);
        color.set(start, GRAY);
        while (stack.length > 0) {
            const top = stack[stack.length - 1];
            const next = top.iter.next();
            if (next.done) {
                color.set(top.node, BLACK);
                stack.pop(); path.pop(); idx.delete(top.node);
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
                idx.set(nxt, path.length); path.push(nxt);
                stack.push({ node: nxt, iter: (edges.get(nxt) ?? []).values() });
            }
        }
    }
    cycles.sort((a, b) => a.join(">").localeCompare(b.join(">")));
    return Object.freeze(cycles);
}

function makeLookupFromMap(recordsById) {
    return (idValue) => recordsById.get(idValue) ?? null;
}

module.exports = { buildDependencyReport, findCycles, collectAllCycles, makeLookupFromMap, STATES };
