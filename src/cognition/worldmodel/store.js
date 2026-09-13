"use strict";

/**
 * W7-L2 WORLD MODEL — persistence tipis (DURABLE_LOCAL, spec §12 "Store
 * unreadable -> start empty, worldModelColdStart: true"). Snapshot penuh
 * via KV yang sama dengan AccStore (`getKv`/`putKv`), sama seperti pola
 * `selfmodel/store.js`. Tanpa `store`, state hanya in-memory (didokumentasikan).
 */

const KV_KEY = "worldmodel.snapshot";

function serialize({ entities, relations, beliefs, hypotheses, contradictions }) {
    return {
        entities: Object.fromEntries(entities),
        relations: Object.fromEntries(relations),
        beliefs: Object.fromEntries(beliefs),
        hypotheses: Object.fromEntries(hypotheses),
        contradictions
    };
}

function deserialize(raw) {
    if (!raw || typeof raw !== "object") {
        return { entities: new Map(), relations: new Map(), beliefs: new Map(), hypotheses: new Map(), contradictions: [], coldStart: true };
    }
    return {
        entities: new Map(Object.entries(raw.entities ?? {})),
        relations: new Map(Object.entries(raw.relations ?? {})),
        beliefs: new Map(Object.entries(raw.beliefs ?? {})),
        hypotheses: new Map(Object.entries(raw.hypotheses ?? {})),
        contradictions: raw.contradictions ?? [],
        coldStart: false
    };
}

async function loadSnapshot(store) {
    if (!store || typeof store.getKv !== "function") {
        return { entities: new Map(), relations: new Map(), beliefs: new Map(), hypotheses: new Map(), contradictions: [], coldStart: true };
    }
    try {
        const raw = await store.getKv(KV_KEY);
        return deserialize(raw);
    } catch {
        return { entities: new Map(), relations: new Map(), beliefs: new Map(), hypotheses: new Map(), contradictions: [], coldStart: true };
    }
}

async function saveSnapshot(store, state) {
    if (!store || typeof store.putKv !== "function") return false;
    await store.putKv(KV_KEY, serialize(state));
    return true;
}

module.exports = { KV_KEY, loadSnapshot, saveSnapshot, serialize, deserialize };
