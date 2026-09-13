"use strict";

/** W7-L3 GOALS — persistence tipis (DURABLE_LOCAL, spec §7). Pola sama
 * dengan selfmodel/store.js dan worldmodel/store.js: snapshot penuh via
 * getKv/putKv milik AccStore. */

const KV_KEY = "goals.snapshot";

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
        goals: new Map(Object.entries(raw.goals ?? {})),
        commitments: new Map(Object.entries(raw.commitments ?? {})),
        plans: new Map(Object.entries(raw.plans ?? {})),
        tasks: new Map(Object.entries(raw.tasks ?? {}))
    };
}

async function loadSnapshot(store) {
    if (!store || typeof store.getKv !== "function") {
        return { goals: new Map(), commitments: new Map(), plans: new Map(), tasks: new Map() };
    }
    try {
        return deserialize(await store.getKv(KV_KEY));
    } catch {
        return { goals: new Map(), commitments: new Map(), plans: new Map(), tasks: new Map() };
    }
}

async function saveSnapshot(store, state) {
    if (!store || typeof store.putKv !== "function") return false;
    await store.putKv(KV_KEY, serialize(state));
    return true;
}

module.exports = { KV_KEY, loadSnapshot, saveSnapshot, serialize, deserialize };
