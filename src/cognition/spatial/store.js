"use strict";

/**
 * W8-L3 persistence -- DURABLE_LOCAL scene graph, same thin KV pattern as
 * worldmodel/goals/prospective/selfmodel's store.js (getKv/putKv on the
 * shared AccStore-shaped `store`, "Store unreadable -> start empty").
 * Screen-geometry frames stay LOCAL_ONLY by construction (never included in
 * any replication path here -- REPLICATED_CONVERGENT physical scenes are an
 * explicitly disclosed open residual, see WAVE8_CONTRACTS_FROZEN.md L3's
 * persistence field; this store does not implement dstate merge itself).
 */

const KV_KEY = "spatial.snapshot";

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

function serialize({ frames, transforms, sceneNodes }) {
    return {
        frames: Object.fromEntries(frames),
        transforms: Object.fromEntries(transforms),
        sceneNodes: Object.fromEntries(sceneNodes)
    };
}

function deserialize(raw) {
    if (!raw || typeof raw !== "object") {
        return { frames: new Map(), transforms: new Map(), sceneNodes: new Map(), coldStart: true };
    }
    return {
        frames: new Map(Object.entries(raw.frames ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        transforms: new Map(Object.entries(raw.transforms ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        sceneNodes: new Map(Object.entries(raw.sceneNodes ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        coldStart: false
    };
}

async function loadSnapshot(store) {
    let hasGetKv;
    try {
        hasGetKv = !!store && typeof store.getKv === "function";
    } catch {
        hasGetKv = false;
    }
    if (!hasGetKv) {
        return { frames: new Map(), transforms: new Map(), sceneNodes: new Map(), coldStart: true };
    }
    try {
        return deserialize(await store.getKv(KV_KEY));
    } catch {
        return { frames: new Map(), transforms: new Map(), sceneNodes: new Map(), coldStart: true };
    }
}

async function saveSnapshot(store, state) {
    let hasPutKv;
    try {
        hasPutKv = !!store && typeof store.putKv === "function";
    } catch {
        hasPutKv = false;
    }
    if (!hasPutKv) return false;
    await store.putKv(KV_KEY, serialize(state));
    return true;
}

module.exports = { KV_KEY, loadSnapshot, saveSnapshot, serialize, deserialize };
