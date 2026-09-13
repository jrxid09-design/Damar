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

async function loadSuccessWindows(store) {
    if (!store || typeof store.getKv !== "function") return new Map();
    const raw = await store.getKv(KV_KEY);
    if (!raw || typeof raw !== "object") return new Map();
    return new Map(Object.entries(raw));
}

async function saveSuccessWindows(store, successWindows) {
    if (!store || typeof store.putKv !== "function") return false;
    await store.putKv(KV_KEY, Object.fromEntries(successWindows));
    return true;
}

module.exports = { KV_KEY, loadSuccessWindows, saveSuccessWindows };
