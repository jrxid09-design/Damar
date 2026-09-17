"use strict";

/**
 * W8-L1 lifecycle-trust state — PRIVATE state module for `BodySchema`.
 *
 * Kepercayaan lifecycle TIDAK BOLEH dibaca lewat metode publik yang bisa
 * ditimpa: jembatan yang memanggil `body.isBeingDelivered(...)` dapat ditipu
 * hanya dengan mengganti metode itu, dan menghapusnya membuat pemanggil jatuh
 * ke penanda modul-global sehingga event milik instance LAIN diterima (audit
 * 31a8770).
 *
 * Modul ini adalah rumah TUNGGAL bagi state tersebut. Ia sengaja dipisah dari
 * `BodySchema.js` supaya permukaan ekspor kelas itu tetap seperti semula
 * (`BodySchema, newerWins, presenceWins`) dan oracle kepercayaan tidak ikut
 * menjadi bagian dari API kelas (audit 5520019). State-nya sendiri tetap tidak
 * dapat dipalsukan: hanya `markCommitted`/`beginDelivery` di bawah yang
 * menulis, dan keduanya hanya dipanggil dari dalam `BodySchema`.
 */

/** Instance milik kelas BodySchema. */
const BODY_INSTANCES = new WeakSet();
/** State kepercayaan per-instance. */
const TRUST_STATE = new WeakMap();

/** Daftarkan sebuah instance dan state kepercayaannya (dipanggil constructor). */
function registerBodyInstance(instance, state) {
    TRUST_STATE.set(instance, state);
    BODY_INSTANCES.add(instance);
    return state;
}

/** Buat wadah state kepercayaan yang kosong. */
function createTrustState() {
    return {
        committedEvents: new WeakSet(),
        deliveringEvents: new WeakSet(),
        commitSequences: new WeakMap(),
        deliverySeq: null,
        commitSeqCounter: 0
    };
}

/** Apakah `candidate` dibuat oleh kelas BodySchema. */
function isBodySchemaInstance(candidate) {
    return candidate !== null
        && (typeof candidate === "object" || typeof candidate === "function")
        && BODY_INSTANCES.has(candidate);
}

/**
 * Bukti lifecycle milik instance, dibaca dari state privat modul.
 * Mengembalikan null untuk objek yang bukan instance BodySchema, sehingga
 * pemanggil dapat membedakan "double tanpa API" dari "instance asli".
 */
function lifecycleTrustOf(candidate, event) {
    if (!BODY_INSTANCES.has(candidate)) return null;
    const state = TRUST_STATE.get(candidate);
    if (!state) return null;
    const usable = event !== null && (typeof event === "object" || typeof event === "function");
    return Object.freeze({
        wasCommitted: usable && state.committedEvents.has(event),
        isBeingDelivered: usable && state.deliveringEvents.has(event),
        commitSequence: usable ? state.commitSequences.get(event) : undefined,
        deliverySequence: state.deliverySeq
    });
}

/** State kepercayaan sebuah instance, untuk dipakai BodySchema sendiri. */
function trustStateOf(instance) {
    return TRUST_STATE.get(instance) ?? null;
}

module.exports = Object.freeze({
    createTrustState,
    registerBodyInstance,
    trustStateOf,
    isBodySchemaInstance,
    lifecycleTrustOf
});
