"use strict";

/**
 * W8-L3 SPATIAL, SCENE AND ENVIRONMENT MODEL.
 *
 * ACC subdomain `src/cognition/spatial/**`, new -- builds on
 * `src/mataDewa/spatial/**` primitives (epistemic freshness bands reused
 * below), does not re-derive them.
 *
 * SPATIAL ESTIMATE != AUTHORITY. L3 never moves anything and never
 * authorizes motion; it only answers occupancy/reachability queries that a
 * caller (eventually L4/Authority, via L6) consults before acting.
 *
 * Contract: C:\Workspace\Damar-audit-evidence\wave7-10\wave8-recon\WAVE8_CONTRACTS_FROZEN.md
 * "## W8-L3 -- Spatial / Scene Model". Baseline SHA f397ce4.
 */

const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { sanitizeBounds } = require("../core/bounds");
const { laws } = require("./laws");
const { makeFrame, makeTransform, makeSceneNode, OCCUPANCY_STATES } = require("./records");
const { loadSnapshot, saveSnapshot } = require("./store");
const { freshnessBand } = require("../../mataDewa/spatial/epistemic");

function regionKey(region) {
    try {
        return JSON.stringify(region ?? null);
    } catch {
        fail(REASONS.INVALID_RECORD, "region tidak dapat diverifikasi dengan aman, ditolak");
    }
}

function sceneNodeKey(frameId, region) {
    return `${frameId}::${regionKey(region)}`;
}

async function createSpatialModel({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS } = {}) {
    try {
        bounds = sanitizeBounds(BOUNDS, bounds);
    } catch {
        bounds = BOUNDS;
    }

    const snapshot = await loadSnapshot(store);
    const frames = snapshot.frames;
    const transforms = snapshot.transforms;
    const sceneNodes = snapshot.sceneNodes;
    const coldStart = snapshot.coldStart;

    // Bug-class awareness (this session's own Wave7 audit history, rounds
    // 71-73): a reloaded snapshot persisted under a larger bound must be
    // compacted to the ACTIVE bound at construction, before any record is
    // exposed -- not just at insert time.
    {
        const maxFrames = Math.max(0, Math.trunc(bounds.MAX_FRAMES));
        while (frames.size > maxFrames) {
            let victimId = null, victimAt = Infinity;
            for (const f of frames.values()) {
                const referenced = [...transforms.values()].some(t => t.fromFrameId === f.frameId || t.toFrameId === f.frameId);
                if (referenced) continue;
                if (f.registeredAt < victimAt) { victimAt = f.registeredAt; victimId = f.frameId; }
            }
            if (!victimId) break;
            frames.delete(victimId);
        }
        const maxTransforms = Math.max(0, Math.trunc(bounds.MAX_TRANSFORMS));
        while (transforms.size > maxTransforms) {
            let victimId = null, victimAt = Infinity;
            for (const t of transforms.values()) {
                if (t.registeredAt < victimAt) { victimAt = t.registeredAt; victimId = t.transformId; }
            }
            if (!victimId) break;
            transforms.delete(victimId);
        }
        const maxNodes = Math.max(0, Math.trunc(bounds.MAX_SCENE_NODES));
        while (sceneNodes.size > maxNodes) {
            // evict-stale-first: prefer UNKNOWN/CONTESTED, oldest updatedAtMs, never live/fresh KNOWN nodes if a stale one exists
            let victimKey = null, victimAt = Infinity, foundStale = false;
            for (const [k, n] of sceneNodes) {
                const isStale = n.state !== "KNOWN";
                if (foundStale && !isStale) continue;
                if (isStale && !foundStale) { foundStale = true; victimAt = Infinity; }
                if (n.updatedAtMs < victimAt) { victimAt = n.updatedAtMs; victimKey = k; }
            }
            if (!victimKey) break;
            sceneNodes.delete(victimKey);
        }
    }

    function now() {
        let candidate;
        try {
            candidate = typeof clock?.nowMs === "function" ? clock.nowMs() : undefined;
        } catch {
            candidate = undefined;
        }
        return Number.isFinite(candidate) ? candidate : Date.now();
    }

    function registerFrame(spec) {
        let frameId, kind, ref, source;
        try {
            ({ frameId, kind, ref, source } = spec || {});
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        const existing = frames.get(frameId);
        const frame = makeFrame({ frameId, kind, ref, source, nowMs: now() }, bounds);
        if (!existing) {
            const maxFrames = Math.max(0, Math.trunc(bounds.MAX_FRAMES));
            while (frames.size >= maxFrames) {
                let victimId = null, victimAt = Infinity;
                for (const f of frames.values()) {
                    if (f.frameId === frame.frameId) continue;
                    const referenced = [...transforms.values()].some(t => t.fromFrameId === f.frameId || t.toFrameId === f.frameId);
                    if (referenced) continue;
                    if (f.registeredAt < victimAt) { victimAt = f.registeredAt; victimId = f.frameId; }
                }
                if (!victimId) {
                    if (maxFrames === 0) return frame; // cap 0: never stored, report the built record as-is
                    fail(REASONS.BOUND_EXCEEDED, `retensi frame melebihi batas (${maxFrames}) dan tidak ada frame tak-terpakai untuk dievict`);
                }
                frames.delete(victimId);
            }
        }
        frames.set(frame.frameId, frame);
        return frame;
    }

    function wouldCreateCycle(fromFrameId, toFrameId) {
        // Would adding fromFrameId -> toFrameId let toFrameId reach fromFrameId already? DFS from toFrameId.
        const stack = [toFrameId];
        const seen = new Set();
        let steps = 0;
        const maxSteps = Math.max(0, Math.trunc(bounds.MAX_TRANSFORMS)) + 1;
        while (stack.length) {
            if (++steps > maxSteps) return true; // pathological graph -- fail closed as a cycle
            const cur = stack.pop();
            if (cur === fromFrameId) return true;
            if (seen.has(cur)) continue;
            seen.add(cur);
            for (const t of transforms.values()) {
                if (t.fromFrameId === cur) stack.push(t.toFrameId);
            }
        }
        return false;
    }

    function registerTransform(spec) {
        let transformId, fromFrameId, toFrameId, data;
        try {
            ({ transformId, fromFrameId, toFrameId, data } = spec || {});
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (!frames.has(fromFrameId)) fail(REASONS.UNKNOWN_FRAME, `fromFrameId '${typeof fromFrameId === "string" ? fromFrameId : typeof fromFrameId}' belum terdaftar`);
        if (!frames.has(toFrameId)) fail(REASONS.UNKNOWN_FRAME, `toFrameId '${typeof toFrameId === "string" ? toFrameId : typeof toFrameId}' belum terdaftar`);
        const existing = transforms.get(transformId);
        if (!existing && wouldCreateCycle(fromFrameId, toFrameId)) {
            fail(REASONS.TRANSFORM_CYCLE_REJECTED, "transform ditolak: akan membentuk siklus pada graf frame");
        }
        const transform = makeTransform({ transformId, fromFrameId, toFrameId, data, nowMs: now() }, bounds);
        if (!existing) {
            const maxTransforms = Math.max(0, Math.trunc(bounds.MAX_TRANSFORMS));
            while (transforms.size >= maxTransforms) {
                let victimId = null, victimAt = Infinity;
                for (const t of transforms.values()) {
                    if (t.transformId === transform.transformId) continue;
                    if (t.registeredAt < victimAt) { victimAt = t.registeredAt; victimId = t.transformId; }
                }
                if (!victimId) {
                    if (maxTransforms === 0) return transform;
                    fail(REASONS.BOUND_EXCEEDED, `retensi transform melebihi batas (${maxTransforms})`);
                }
                transforms.delete(victimId);
            }
        }
        transforms.set(transform.transformId, transform);
        return transform;
    }

    /** Reports occupancy for a region as observed by one observationRef. Disagreement -> CONTESTED (blocks), never silently picked. */
    function reportOccupancy(spec) {
        let frameId, region, state, observationRef;
        try {
            ({ frameId, region, state, observationRef } = spec || {});
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (!frames.has(frameId)) fail(REASONS.UNKNOWN_FRAME, `frameId '${typeof frameId === "string" ? frameId : typeof frameId}' belum terdaftar`);
        if (typeof observationRef !== "string" || !observationRef) fail(REASONS.INVALID_RECORD, "observationRef wajib string");
        const key = sceneNodeKey(frameId, region);
        const existing = sceneNodes.get(key);
        let nextState = state;
        let refs = [observationRef];
        if (existing) {
            refs = existing.observationRefs.includes(observationRef) ? [...existing.observationRefs] : [...existing.observationRefs, observationRef];
            if (existing.state !== "CONTESTED" && existing.state !== state) {
                nextState = "CONTESTED"; // two sources disagreeing -> BLOCKS, never arbitrarily picks one
            } else if (existing.state === "CONTESTED") {
                nextState = "CONTESTED"; // once contested, stays contested until an explicit resolve (out of this lane's scope)
            }
        }
        const node = makeSceneNode({ nodeId: key, frameId, region, state: nextState, observationRefs: refs, updatedAtMs: now() }, bounds);
        if (!existing) {
            const maxNodes = Math.max(0, Math.trunc(bounds.MAX_SCENE_NODES));
            while (sceneNodes.size >= maxNodes) {
                let victimKey = null, victimAt = Infinity, foundStale = false;
                for (const [k, n] of sceneNodes) {
                    if (k === node.nodeId) continue;
                    const isStale = n.state !== "KNOWN";
                    if (foundStale && !isStale) continue;
                    if (isStale && !foundStale) { foundStale = true; victimAt = Infinity; }
                    if (n.updatedAtMs < victimAt) { victimAt = n.updatedAtMs; victimKey = k; }
                }
                if (!victimKey) {
                    if (maxNodes === 0) return node;
                    fail(REASONS.BOUND_EXCEEDED, `retensi scene node melebihi batas (${maxNodes})`);
                }
                sceneNodes.delete(victimKey);
            }
        }
        sceneNodes.set(node.nodeId, node);
        return node;
    }

    /** UNKNOWN NEVER MEANS CLEAR: no node for a region -> blocked:true, state:"UNKNOWN". */
    function queryOccupancy({ frameId, region } = {}) {
        const key = sceneNodeKey(frameId, region);
        const node = sceneNodes.get(key);
        if (!node) return Object.freeze({ state: "UNKNOWN", blocked: true, freshnessMs: null, provenance: Object.freeze([]) });
        const freshnessMs = now() - node.updatedAtMs;
        return Object.freeze({
            state: node.state,
            blocked: node.state !== "KNOWN",
            freshnessMs,
            band: freshnessBand(node.updatedAtMs, {}, now()),
            provenance: node.observationRefs
        });
    }

    /** Sequence of hops; blocked if ANY hop is unknown/contested. Bounded path length -- never a runaway traversal. */
    function queryReachability({ frameId, path } = {}) {
        let hops;
        try {
            hops = Array.isArray(path) ? [...path] : [];
        } catch {
            fail(REASONS.INVALID_RECORD, "path tidak dapat diverifikasi dengan aman, ditolak");
        }
        const maxPath = Math.max(0, Math.trunc(bounds.MAX_REACHABILITY_PATH_LENGTH));
        if (hops.length > maxPath) fail(REASONS.BOUND_EXCEEDED, `panjang path reachability melebihi batas (${maxPath})`);
        for (let i = 0; i < hops.length; i++) {
            const result = queryOccupancy({ frameId, region: hops[i] });
            if (result.blocked) {
                return Object.freeze({ reachable: false, blockedAtIndex: i, blockedState: result.state });
            }
        }
        return Object.freeze({ reachable: true, blockedAtIndex: -1, blockedState: null });
    }

    /** Returns the frame plus the ordered chain of transformIds connecting fromFrameId to toFrameId, or null if unreachable. Bounded BFS. */
    function resolveFrame(fromFrameId, toFrameId) {
        const frame = frames.get(fromFrameId);
        if (!frame) fail(REASONS.UNKNOWN_FRAME, `frameId '${typeof fromFrameId === "string" ? fromFrameId : typeof fromFrameId}' belum terdaftar`);
        if (toFrameId === undefined || toFrameId === null) return Object.freeze({ frame, path: Object.freeze([]) });
        if (!frames.has(toFrameId)) fail(REASONS.UNKNOWN_FRAME, `toFrameId '${typeof toFrameId === "string" ? toFrameId : typeof toFrameId}' belum terdaftar`);
        const maxSteps = Math.max(0, Math.trunc(bounds.MAX_TRANSFORMS)) + 1;
        const queue = [[fromFrameId, []]];
        const seen = new Set([fromFrameId]);
        let steps = 0;
        while (queue.length) {
            if (++steps > maxSteps) break;
            const [cur, chain] = queue.shift();
            if (cur === toFrameId) return Object.freeze({ frame, path: Object.freeze(chain) });
            for (const t of transforms.values()) {
                if (t.fromFrameId === cur && !seen.has(t.toFrameId)) {
                    seen.add(t.toFrameId);
                    queue.push([t.toFrameId, [...chain, t.transformId]]);
                }
            }
        }
        return null;
    }

    function getScene() {
        return Object.freeze({
            frames: Object.freeze([...frames.values()]),
            transforms: Object.freeze([...transforms.values()]),
            sceneNodes: Object.freeze([...sceneNodes.values()])
        });
    }

    function framesSize() { return frames.size; }
    function transformsSize() { return transforms.size; }
    function sceneNodesSize() { return sceneNodes.size; }

    async function persist() {
        return saveSnapshot(store, { frames, transforms, sceneNodes });
    }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        spatialColdStart: coldStart,
        registerFrame, registerTransform, reportOccupancy,
        queryOccupancy, queryReachability, resolveFrame, getScene,
        framesSize, transformsSize, sceneNodesSize,
        persist, laws, bounds
    });
}

module.exports = { createSpatialModel, BOUNDS, SCHEMA_VERSION, OCCUPANCY_STATES };
