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
const { makeFrame, makeTransform, makeSceneNode, readSpecFields, requireStringId, canonicalRegionKey, buildSafeSpatialValue } = require("./records");
const { loadSnapshot, saveSnapshot } = require("./store");
const { freshnessBand } = require("../../mataDewa/spatial/epistemic");

// Bands other than "fresh"/"aging" are treated as stale for blocking
// purposes -- "unknown never means clear" extends to "stale never means
// clear either" (audit round 1, AUDL3-P1-1).
const NON_BLOCKING_BANDS = new Set(["fresh", "aging"]);

function sceneNodeKey(frameId, region) {
    return `${frameId}::${canonicalRegionKey(region)}`;
}

async function createSpatialModel({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS, auditLedger = null } = {}) {
    try {
        bounds = sanitizeBounds(BOUNDS, bounds);
    } catch {
        bounds = BOUNDS;
    }

    // Audit hook (contract L3: "frame registration, transform changes,
    // occupancy CONTRADICTIONS are audited"; and "overflow evicts STALE
    // regions first (never live/fresh ones), audited"). Kegagalan audit TIDAK
    // PERNAH menggagalkan operasi yang diaudit -- pola yang sama dengan lane
    // Wave7 lainnya.
    function audit(eventType, fields) {
        try {
            if (auditLedger && typeof auditLedger.append === "function") {
                const result = auditLedger.append(Object.freeze({
                    eventType, source: "acc.spatial", outcome: "ok",
                    metadata: Object.freeze({ lane: "W8-L3", ...fields })
                }));
                // Hook audit bisa ASYNC dan menolak; penolakan yang tidak
                // ditangani dapat menghentikan proses Node, sehingga kegagalan
                // audit berubah menjadi kegagalan lane (audit Wave8 L3/L5).
                if (result && typeof result.then === "function") {
                    Promise.resolve(result).catch(() => {});
                }
            }
        } catch { /* audit failure never blocks the lane */ }
    }

    const snapshot = await loadSnapshot(store);
    const frames = snapshot.frames;
    const transforms = snapshot.transforms;
    const sceneNodes = snapshot.sceneNodes;
    const coldStart = snapshot.coldStart;
    if (snapshot.degraded) {
        audit("cognition.spatial.store_unreadable", { reason: "store-unreadable-or-hostile" });
    }

    // Bug-class awareness (this session's own Wave7 audit history, rounds
    // 71-73): a reloaded snapshot persisted under a larger bound must be
    // compacted to the ACTIVE bound at construction, before any record is
    // exposed -- not just at insert time.
    //
    // Bug review independen (audit round 1, Codex, AUDL3-P1-2): transforms
    // MUST be compacted BEFORE frames -- a frame still referenced by a live
    // transform can never be evicted, so compacting frames first (while
    // over-bound transforms still hold references) stalls frame compaction
    // early and leaves the frame collection over its active bound. Reversed
    // order.
    {
        const maxTransforms = Math.max(0, Math.trunc(bounds.MAX_TRANSFORMS));
        while (transforms.size > maxTransforms) {
            let victimId = null, victimAt = Infinity;
            for (const t of transforms.values()) {
                if (t.registeredAt < victimAt) { victimAt = t.registeredAt; victimId = t.transformId; }
            }
            if (!victimId) break;
            transforms.delete(victimId);
        }
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
            // Bug review independen (audit round 2, Codex, AUDL3-P1-1):
            // mengevict frame TANPA mengevict scene node yang menunjuk ke
            // frame itu membuat geometri yatim tetap queryable sebagai KNOWN
            // -- getScene()/queryOccupancy() melaporkan occupancy untuk frame
            // yang sudah tidak ada, melanggar konsistensi snapshot dan bisa
            // meloloskan precondition fisik pakai geometri basi.
            for (const [k, n] of [...sceneNodes]) {
                if (n.frameId === victimId) sceneNodes.delete(k);
            }
        }
        const maxNodes = Math.max(0, Math.trunc(bounds.MAX_SCENE_NODES));
        while (sceneNodes.size > maxNodes) {
            // evict-stale-first: prefer UNKNOWN/CONTESTED, oldest updatedAtMs, never live/fresh KNOWN nodes if a stale one exists.
            // Memakai CLOCK YANG DISUNTIKKAN, bukan Date.now(): jam dinding
            // membuat klasifikasi stale bergantung pada waktu nyata alih-alih
            // waktu lane, sehingga hasilnya tidak deterministik di test
            // (audit Wave8 L3/L5).
            const compactionNowMs = now();
            let victimKey = null, victimAt = Infinity, foundStale = false;
            for (const [k, n] of sceneNodes) {
                const isStale = !NON_BLOCKING_BANDS.has(freshnessBand(n.updatedAtMs, {}, compactionNowMs));
                if (foundStale && !isStale) continue;
                if (isStale && !foundStale) { foundStale = true; victimAt = Infinity; }
                if (n.updatedAtMs < victimAt) { victimAt = n.updatedAtMs; victimKey = k; }
            }
            if (!victimKey) break;
            sceneNodes.delete(victimKey);
            // Eviction saat restart juga diaudit, sama seperti eviction saat
            // insert (audit Wave8 L3/L5).
            audit("cognition.spatial.scene_node_evicted", { nodeId: victimKey, reason: "restart-compaction" });
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

    // Persisted maps are untrusted input. Reconcile them before any public
    // query can observe geometry: orphan frames/nodes, incoherent map keys,
    // invalid timestamps, and malformed transforms are fail-closed.
    for (const [id, frame] of [...frames]) {
        if (!frame || frame.frameId !== id || typeof frame.frameId !== "string" ||
            !Number.isFinite(frame.registeredAt) || frame.registeredAt > now()) frames.delete(id);
    }
    for (const [id, transform] of [...transforms]) {
        if (!transform || transform.transformId !== id || typeof transform.fromFrameId !== "string" ||
            typeof transform.toFrameId !== "string" || !frames.has(transform.fromFrameId) ||
            !frames.has(transform.toFrameId) || !Number.isFinite(transform.registeredAt)) transforms.delete(id);
    }
    for (const [key, node] of [...sceneNodes]) {
        let coherent = false;
        try { coherent = node && node.frameId && frames.has(node.frameId) &&
            key === sceneNodeKey(node.frameId, node.region) && Number.isFinite(node.updatedAtMs) &&
            node.updatedAtMs <= now() && Array.isArray(node.observationRefs); } catch { coherent = false; }
        if (!coherent) sceneNodes.delete(key);
    }

    function registerFrame(spec) {
        const { frameId, kind, ref, source } = readSpecFields(spec, ["frameId", "kind", "ref", "source"]);
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
                // AUDL3-P1-1 sibling: evicting a frame at insert-time must
                // also evict any scene node it owns, same as the
                // construction-time compaction fix above.
                for (const [k, n] of [...sceneNodes]) {
                    if (n.frameId === victimId) sceneNodes.delete(k);
                }
            }
        }
        frames.set(frame.frameId, frame);
        // Frame registration is audited (contract L3 verification hooks).
        audit(existing ? "cognition.spatial.frame_updated" : "cognition.spatial.frame_registered",
            { frameId: frame.frameId, kind: frame.kind });
        return frame;
    }

    function wouldCreateCycle(fromFrameId, toFrameId, ignoreTransformId = null) {
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
                if (t.transformId === ignoreTransformId) continue;
                if (t.fromFrameId === cur) stack.push(t.toFrameId);
            }
        }
        return false;
    }

    function registerTransform(spec) {
        const { transformId, fromFrameId, toFrameId, data } = readSpecFields(spec, ["transformId", "fromFrameId", "toFrameId", "data"]);
        if (!frames.has(fromFrameId)) fail(REASONS.UNKNOWN_FRAME, `fromFrameId '${typeof fromFrameId === "string" ? fromFrameId : typeof fromFrameId}' belum terdaftar`);
        if (!frames.has(toFrameId)) fail(REASONS.UNKNOWN_FRAME, `toFrameId '${typeof toFrameId === "string" ? toFrameId : typeof toFrameId}' belum terdaftar`);
        const existing = transforms.get(transformId);
        if (wouldCreateCycle(fromFrameId, toFrameId, existing?.transformId ?? null)) {
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
                audit("cognition.spatial.transform_evicted", { transformId: victimId, reason: "overflow" });
            }
        }
        transforms.set(transform.transformId, transform);
        // Transform changes are audited (contract L3 verification hooks).
        audit(existing ? "cognition.spatial.transform_changed" : "cognition.spatial.transform_registered",
            { transformId: transform.transformId, fromFrameId: transform.fromFrameId, toFrameId: transform.toFrameId });
        return transform;
    }

    /** Reports occupancy for a region as observed by one observationRef. Disagreement -> CONTESTED (blocks), never silently picked. */
    function reportOccupancy(spec) {
        const { frameId, region, state, observationRef } = readSpecFields(spec, ["frameId", "region", "state", "observationRef"]);
        requireStringId(frameId, "frameId");
        if (!frames.has(frameId)) fail(REASONS.UNKNOWN_FRAME, `frameId '${frameId}' belum terdaftar`);
        if (typeof observationRef !== "string" || !observationRef) fail(REASONS.INVALID_RECORD, "observationRef wajib string");
        const key = sceneNodeKey(frameId, region);
        const existing = sceneNodes.get(key);
        let nextState = state;
        let refs = [observationRef];
        if (existing) {
            const alreadyKnown = existing.observationRefs.includes(observationRef);
            refs = alreadyKnown ? [...existing.observationRefs] : [...existing.observationRefs, observationRef];
            if (existing.state !== "CONTESTED" && existing.state !== state) {
                // Kontes = PERSELISIHAN ANTAR-SUMBER (kontrak L3). Sumber yang
                // merevisi klaimnya sendiri adalah revisi, bukan kontes --
                // menandainya CONTESTED akan mengunci region secara permanen
                // hanya karena satu sensor memperbarui bacaannya (audit L3
                // putaran 5, P2). Hanya sumber BERBEDA yang mengunci.
                const differentSourceDisagrees = existing.observationRefs.some(r => r !== observationRef);
                nextState = differentSourceDisagrees ? "CONTESTED" : state;
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
                    const isStale = !NON_BLOCKING_BANDS.has(freshnessBand(n.updatedAtMs, {}, now()));
                    if (foundStale && !isStale) continue;
                    if (isStale && !foundStale) { foundStale = true; victimAt = Infinity; }
                    if (n.updatedAtMs < victimAt) { victimAt = n.updatedAtMs; victimKey = k; }
                }
                if (!victimKey) {
                    if (maxNodes === 0) return node;
                    fail(REASONS.BOUND_EXCEEDED, `retensi scene node melebihi batas (${maxNodes})`);
                }
                sceneNodes.delete(victimKey);
                audit("cognition.spatial.scene_node_evicted", { nodeId: victimKey, reason: "overflow" });
            }
        }
        sceneNodes.set(node.nodeId, node);
        // Occupancy CONTRADICTIONS are audited (contract L3 verification
        // hooks) -- dua sumber yang berselisih mengunci region jadi CONTESTED
        // dan itu harus terlihat.
        if (nextState === "CONTESTED" && existing && existing.state !== "CONTESTED") {
            audit("cognition.spatial.occupancy_contradiction", {
                nodeId: node.nodeId, frameId, from: existing.state, to: nextState
            });
        }
        return node;
    }

    /**
     * UNKNOWN NEVER MEANS CLEAR: no node for a region -> blocked:true.
     * Bug review independen (audit round 1, Codex, AUDL3-P1-1): a KNOWN
     * node whose freshness band has decayed to "stale"/"expired" reported
     * blocked:false purely because `state === "KNOWN"` -- staleness never
     * fed into the blocking decision at all. Stale/expired KNOWN claims now
     * block too, same as UNKNOWN/CONTESTED -- "stale never means clear
     * either."
     */
    function queryOccupancy(spec) {
        const { frameId, region } = readSpecFields(spec, ["frameId", "region"]);
        requireStringId(frameId, "frameId");
        const key = sceneNodeKey(frameId, region);
        const node = sceneNodes.get(key);
        if (!node) return Object.freeze({ state: "UNKNOWN", blocked: true, freshnessMs: null, band: "unknown", provenance: Object.freeze([]) });
        const nowMs = now();
        const freshnessMs = nowMs - node.updatedAtMs;
        const band = freshnessBand(node.updatedAtMs, {}, nowMs);
        const blocked = node.state !== "KNOWN" || !NON_BLOCKING_BANDS.has(band);
        return Object.freeze({
            state: node.state,
            blocked,
            freshnessMs,
            band,
            provenance: node.observationRefs
        });
    }

    /** Sequence of hops; blocked if ANY hop is unknown/contested/stale. Bounded path length -- never a runaway traversal. */
    function queryReachability(spec) {
        const { frameId, path } = readSpecFields(spec, ["frameId", "path"]);
        requireStringId(frameId, "frameId");
        // Bug review independen (audit round 2, Codex, AUDL3-P2-1): `[...path]`
        // adalah spread biasa -- iterator/index [[Get]] yang mengeksekusi
        // accessor pada elemen manapun SEBELUM sanitasi apa pun berjalan.
        // Disaring sekali lewat buildSafeSpatialValue (descriptor-based,
        // sekarang juga memvalidasi properti non-indeks per AUDL3-P2-2),
        // bukan spread mentah.
        let hops;
        if (path === null || path === undefined) {
            hops = [];
        } else {
            let isArray;
            try {
                isArray = Array.isArray(path);
            } catch {
                fail(REASONS.INVALID_RECORD, "path tidak dapat diverifikasi dengan aman, ditolak");
            }
            if (!isArray) fail(REASONS.INVALID_RECORD, "path wajib array");
            hops = buildSafeSpatialValue(path);
        }
        const maxPath = Math.max(0, Math.trunc(bounds.MAX_REACHABILITY_PATH_LENGTH));
        if (hops.length > maxPath) fail(REASONS.BOUND_EXCEEDED, `panjang path reachability melebihi batas (${maxPath})`);
        const provenance = [];
        const freshness = [];
        for (let i = 0; i < hops.length; i++) {
            const result = queryOccupancy({ frameId, region: hops[i] });
            provenance.push(...result.provenance);
            freshness.push({ freshnessMs: result.freshnessMs, band: result.band });
            if (result.blocked) {
                return Object.freeze({ reachable: false, blockedAtIndex: i, blockedState: result.state,
                    provenance: Object.freeze(provenance), freshness: Object.freeze(freshness) });
            }
        }
        return Object.freeze({ reachable: true, blockedAtIndex: -1, blockedState: null,
            provenance: Object.freeze(provenance), freshness: Object.freeze(freshness) });
    }

    /** Returns the frame plus the ordered chain of transformIds connecting fromFrameId to toFrameId, or null if unreachable. Bounded BFS. */
    function resolveFrame(fromFrameId, toFrameId) {
        requireStringId(fromFrameId, "frameId");
        const frame = frames.get(fromFrameId);
        if (!frame) fail(REASONS.UNKNOWN_FRAME, `frameId '${fromFrameId}' belum terdaftar`);
        if (toFrameId === undefined || toFrameId === null) return Object.freeze({ frame, path: Object.freeze([]) });
        requireStringId(toFrameId, "toFrameId");
        if (!frames.has(toFrameId)) fail(REASONS.UNKNOWN_FRAME, `toFrameId '${toFrameId}' belum terdaftar`);
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

module.exports = { createSpatialModel, BOUNDS, SCHEMA_VERSION };
