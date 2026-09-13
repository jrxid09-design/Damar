"use strict";

/**
 * W7-L1 SELF-MODEL — persistence tipis untuk successWindow (DURABLE_LOCAL,
 * spec §6 "Restart semantics"). TIDAK PERNAH menyimpan/menyegarkan
 * availability sebagai fresh — itu satu-satunya sumber untuk SM-A8.
 *
 * Memakai bentuk KV yang sama dengan AccStore (`getKv`/`putKv`) supaya
 * lane ini bisa berbagi store dengan ContinuityCore bila diberikan, tanpa
 * mewajibkannya — tanpa `store`, successWindow hanya in-memory (didokumentasikan,
 * bukan pelanggaran diam-diam terhadap DURABLE_LOCAL).
 */

const KV_KEY = "selfmodel.successWindows";

/**
 * Proaktif (pola yang sama seperti W7R7-P1-1/P1-2, worldmodel/store.js
 * putaran-5): successWindow yang dimuat ulang dari store JSON round-trip
 * TIDAK PERNAH dibekukan -- pemanggil bisa memutasi attempts/successes
 * pasca-restart untuk memalsukan selfBelief/confidence. Dibekukan sebelum
 * lane lain menemukan lubang yang sama.
 */
function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

async function loadSuccessWindows(store) {
    if (!store || typeof store.getKv !== "function") return new Map();
    // Bug review independen (audit putaran-15, AUD15-P2-2): tidak seperti
    // worldmodel/goals/prospective's store.js (semua membungkus getKv dalam
    // try/catch, "Store unreadable -> start empty"), pembacaan di sini
    // TIDAK dijaga -- satu baris KV yang rusak (mis. JSON korup) menolak
    // seluruh createSelfModel(), yang lalu menggagalkan komposisi L7 penuh
    // (longhorizon membuat selfmodel duluan) alih-alih hanya mendegradasi
    // L1 ke successWindow kosong.
    try {
        const raw = await store.getKv(KV_KEY);
        if (!raw || typeof raw !== "object") return new Map();
        return new Map(Object.entries(raw).map(([k, v]) => [k, deepFreeze(v)]));
    } catch {
        return new Map();
    }
}

async function saveSuccessWindows(store, successWindows) {
    if (!store || typeof store.putKv !== "function") return false;
    await store.putKv(KV_KEY, Object.fromEntries(successWindows));
    return true;
}

module.exports = { KV_KEY, loadSuccessWindows, saveSuccessWindows };
