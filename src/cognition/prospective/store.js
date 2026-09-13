"use strict";

/** W7-L4 PROSPECTIVE MEMORY — persistence tipis (DURABLE_LOCAL). Pola sama
 * dengan selfmodel/worldmodel/goals: snapshot penuh via getKv/putKv. */

const KV_KEY = "prospective.snapshot";

/**
 * Bug review independen (audit putaran-7, W7R7-P1-2): sama seperti
 * W7R7-P1-1 (goals) dan W7R5-P1-3 (worldmodel) -- reminder/expectation
 * yang dimuat ulang dari store JSON round-trip TIDAK PERNAH dibekukan,
 * jadi `payloadRef` (yang divalidasi ketat oleh validatePayloadRef saat
 * arm()) bisa disuntik capabilityId/authProof lewat mutasi pasca-restart,
 * lalu ikut terbawa ke WakeEvent berikutnya.
 */
function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

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
        reminders: new Map(Object.entries(raw.reminders ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        expectations: new Map(Object.entries(raw.expectations ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
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
