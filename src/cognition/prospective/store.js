"use strict";

/** W7-L4 PROSPECTIVE MEMORY — persistence tipis (DURABLE_LOCAL). Pola sama
 * dengan selfmodel/worldmodel/goals: snapshot penuh via getKv/putKv. */

const KV_KEY = "prospective.snapshot";

function serialize({ reminders, expectations, firedOccurrenceIds }) {
    return {
        reminders: Object.fromEntries(reminders),
        expectations: Object.fromEntries(expectations),
        firedOccurrenceIds: [...firedOccurrenceIds]
    };
}

function deserialize(raw) {
    if (!raw || typeof raw !== "object") {
        return { reminders: new Map(), expectations: new Map(), firedOccurrenceIds: new Set() };
    }
    return {
        reminders: new Map(Object.entries(raw.reminders ?? {})),
        expectations: new Map(Object.entries(raw.expectations ?? {})),
        firedOccurrenceIds: new Set(raw.firedOccurrenceIds ?? [])
    };
}

async function loadSnapshot(store) {
    if (!store || typeof store.getKv !== "function") {
        return { reminders: new Map(), expectations: new Map(), firedOccurrenceIds: new Set() };
    }
    try {
        return deserialize(await store.getKv(KV_KEY));
    } catch {
        return { reminders: new Map(), expectations: new Map(), firedOccurrenceIds: new Set() };
    }
}

async function saveSnapshot(store, state) {
    if (!store || typeof store.putKv !== "function") return false;
    await store.putKv(KV_KEY, serialize(state));
    return true;
}

module.exports = { KV_KEY, loadSnapshot, saveSnapshot, serialize, deserialize };
