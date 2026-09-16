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

// Sanitizer bersama lane ini (deskriptor-saja: menolak accessor, kunci
// berbahaya, fungsi/simbol, dan instance kelas). Dipakai ULANG alih-alih
// membuat salinan kedua di sini.
const { buildSafeSpatialValue } = require("./records");

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

/**
 * Baca satu field snapshot lewat DESKRIPTOR. `raw.frames ?? {}` adalah
 * `[[Get]]` mentah: snapshot yang dipersistensi bisa membawa accessor hidup,
 * sehingga pembacaannya MENJALANKAN kode pihak lain (audit Wave8 L3/L5).
 */
function readSnapshotField(raw, key) {
    let desc;
    try {
        desc = Object.getOwnPropertyDescriptor(raw, key);
    } catch {
        throw new Error("snapshot tidak dapat dibaca dengan aman");
    }
    if (!desc) return undefined;
    if (desc.get || desc.set) throw new Error("snapshot tidak boleh membawa accessor");
    return desc.value;
}

/**
 * Muat satu koleksi tersimpan secara aman: nama kunci dibaca sebagai nama
 * saja, lalu NILAI tiap kunci lewat deskriptor dan lewat sanitizer bersama
 * lane. `Object.entries` tidak boleh dipakai di sini karena ia melakukan
 * `[[Get]]` pada setiap nilai -- persis jalur eksekusi yang ditutup di sini.
 *
 * Catatan fail-closed: satu entri hostil membuat `deserialize` melempar, dan
 * `loadSnapshot` sudah menangkapnya menjadi cold start ("store unreadable ->
 * start empty"). Snapshot yang membawa accessor memang tidak layak dipercaya,
 * jadi memulai kosong adalah arah yang aman.
 */
function readPersistedCollection(raw, key) {
    const container = readSnapshotField(raw, key);
    if (container === null || container === undefined) return new Map();
    if (typeof container !== "object" || Array.isArray(container)) return new Map();
    let names;
    try {
        names = Object.keys(container);
    } catch {
        throw new Error("snapshot tidak dapat dibaca dengan aman");
    }
    const out = new Map();
    for (const name of names) {
        let desc;
        try {
            desc = Object.getOwnPropertyDescriptor(container, name);
        } catch {
            throw new Error("snapshot tidak dapat dibaca dengan aman");
        }
        if (!desc) continue;
        if (desc.get || desc.set) throw new Error("snapshot tidak boleh membawa accessor");
        out.set(name, deepFreeze(buildSafeSpatialValue(desc.value)));
    }
    return out;
}

function deserialize(raw) {
    if (!raw || typeof raw !== "object") {
        return { frames: new Map(), transforms: new Map(), sceneNodes: new Map(), coldStart: true };
    }
    return {
        frames: readPersistedCollection(raw, "frames"),
        transforms: readPersistedCollection(raw, "transforms"),
        sceneNodes: readPersistedCollection(raw, "sceneNodes"),
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
        // Snapshot tidak terbaca / membawa materi berbahaya (accessor,
        // __proto__, fungsi): mulai kosong dan tandai `degraded` supaya
        // konsumen bisa mencatatnya ke audit alih-alih diam-diam menganggap
        // scene-nya memang kosong.
        return { frames: new Map(), transforms: new Map(), sceneNodes: new Map(), coldStart: true, degraded: true };
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
