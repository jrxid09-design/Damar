"use strict";

/**
 * W7-L2 WORLD MODEL — persistence tipis (DURABLE_LOCAL, spec §12 "Store
 * unreadable -> start empty, worldModelColdStart: true"). Snapshot penuh
 * via KV yang sama dengan AccStore (`getKv`/`putKv`), sama seperti pola
 * `selfmodel/store.js`. Tanpa `store`, state hanya in-memory (didokumentasikan).
 */

const KV_KEY = "worldmodel.snapshot";

/**
 * Bug review independen (audit putaran-5, W7R5-P1-3): pembekuan value/
 * subject di applyRevision hanya melindungi belief yang lahir DALAM sesi
 * proses ini. Belief yang dimuat ulang dari store yang benar-benar
 * melakukan round-trip JSON (mis. backend sqlite) TIDAK PERNAH dibekukan
 * ulang -- query() lalu mengembalikan `value`/`supportedBy` yang bisa
 * dimutasi pemanggil, menulis ulang state kanonik pasca-restart. Store
 * memori (referensi langsung) sudah aman (objek belief yang sama sudah
 * beku dari sesi sebelumnya); freeze ulang di sini idempoten/tidak
 * berbahaya untuk kasus itu.
 */
function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

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
    // Bug review independen (audit putaran-8, W7R8-P1-1): putaran-5 hanya
    // membekukan `beliefs` -- entities/relations/hypotheses/contradictions
    // tetap dimuat mentah, jadi entitasByKind/neighbors/subgraph/
    // openContradictions() pasca-restart bisa dimutasi pemanggil (topologi
    // dipalsukan, kuota per-sumber dilewati, kontradiksi ditutup tanpa
    // ruleId). SEMUA koleksi sekarang dibekukan, bukan hanya beliefs.
    return {
        entities: new Map(Object.entries(raw.entities ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        relations: new Map(Object.entries(raw.relations ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        beliefs: new Map(Object.entries(raw.beliefs ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        hypotheses: new Map(Object.entries(raw.hypotheses ?? {}).map(([k, v]) => [k, deepFreeze(v)])),
        contradictions: (raw.contradictions ?? []).map(c => deepFreeze(c)),
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
