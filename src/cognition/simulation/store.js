"use strict";

/**
 * W8-L5 sandbox persistence -- the STRONGEST isolation class of any Wave8
 * lane: NEVER_REPLICATED, separate store, separate `sim_` id namespace.
 *
 * Structural isolation: this file imports NOTHING from worldmodel, goals,
 * the ACC journal (AccStore), or any other real-state owner -- there is no
 * code path here that could write into the real ACC journal even by
 * accident, because no reference to it exists anywhere in this module.
 * "Cross-store write rejection" is therefore true by construction, not
 * merely by a runtime check (though a runtime check is layered on top in
 * index.js's cross-store-write guard for defense in depth).
 *
 * Uses the SAME optional getKv/putKv shape every other lane's store.js
 * uses, but under a dedicated `sim_` prefixed key so a shared underlying KV
 * backend (if the caller passes the same physical store instance other
 * lanes use) still cannot collide with any other lane's key.
 */

const KV_KEY = "sim_simulation.snapshot";

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

function serialize({ runs, results }) {
    return { runs: Object.fromEntries(runs), results: Object.fromEntries(results) };
}

function deserialize(raw) {
    if (!raw || typeof raw !== "object") {
        return { runs: new Map(), results: new Map(), coldStart: true };
    }
    return {
        runs: new Map(Object.entries(raw.runs ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        results: new Map(Object.entries(raw.results ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
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
    if (!hasGetKv) return { runs: new Map(), results: new Map(), coldStart: true };
    try {
        return deserialize(await store.getKv(KV_KEY));
    } catch {
        return { runs: new Map(), results: new Map(), coldStart: true };
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
