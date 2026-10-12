"use strict";

/** W7-L3 GOALS — persistence tipis (DURABLE_LOCAL, spec §7). Pola sama
 * dengan selfmodel/store.js dan worldmodel/store.js: snapshot penuh via
 * getKv/putKv milik AccStore. */

const KV_KEY = "goals.snapshot";

/**
 * Bug review independen (audit putaran-7, W7R7-P1-1): rekaman in-memory
 * (goal/commitment/plan/task) sudah beku lewat makeGoal/makeCommitment/
 * makePlan/makeTask, tapi deserialize() TIDAK PERNAH membekukan ulang hasil
 * muat dari store yang benar-benar round-trip JSON (mis. sqlite) --
 * `ownerApproval` bisa dipalsukan lewat mutasi pasca-restart, melewati
 * gerbang persetujuan. Kelas bug yang sama seperti W7R5-P1-3 (worldmodel),
 * belum dimigrasikan ke goals.
 */
function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

function serialize({ goals, commitments, plans, tasks }) {
    return {
        goals: Object.fromEntries(goals),
        commitments: Object.fromEntries(commitments),
        plans: Object.fromEntries(plans),
        tasks: Object.fromEntries(tasks)
    };
}

function deserialize(raw) {
    if (!raw || typeof raw !== "object") {
        return { goals: new Map(), commitments: new Map(), plans: new Map(), tasks: new Map() };
    }
    return {
        goals: new Map(Object.entries(raw.goals ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        commitments: new Map(Object.entries(raw.commitments ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        plans: new Map(Object.entries(raw.plans ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        tasks: new Map(Object.entries(raw.tasks ?? {}).map(([k, v]) => [k, deepFreeze(v)]))
    };
}

// Bug review independen (audit putaran-52, W7R52-P2-2): sibling langsung
// dari worldmodel/store.js -- `typeof store.getKv/.putKv` raw-throw untuk
// Proxy yang di-revoke, sebelum sempat jatuh ke default coldStart aman.
async function loadSnapshot(store) {
    let hasGetKv;
    try {
        hasGetKv = !!store && typeof store.getKv === "function";
    } catch {
        hasGetKv = false;
    }
    if (!hasGetKv) {
        return { goals: new Map(), commitments: new Map(), plans: new Map(), tasks: new Map() };
    }
    try {
        return deserialize(await store.getKv(KV_KEY));
    } catch {
        return { goals: new Map(), commitments: new Map(), plans: new Map(), tasks: new Map() };
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
