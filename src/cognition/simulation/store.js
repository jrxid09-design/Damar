"use strict";

/**
 * W8-L5 sandbox persistence -- the STRONGEST isolation class of any Wave8
 * lane: NEVER_REPLICATED, separate store, separate `sim_` id namespace.
 *
 * Structural isolation: this file imports NOTHING from worldmodel, goals,
 * the ACC journal (AccStore), or any other real-state owner -- there is no
 * code path here that could write into the real ACC journal even by
 * accident, because no reference to it exists anywhere in this module.
 * "Cross-store write rejection" is therefore true by construction, not
 * merely by a runtime check (though a runtime check is layered on top in
 * index.js's cross-store-write guard for defense in depth).
 *
 * Uses the SAME optional getKv/putKv shape every other lane's store.js
 * uses, but under a dedicated `sim_` prefixed key so a shared underlying KV
 * backend (if the caller passes the same physical store instance other
 * lanes use) still cannot collide with any other lane's key.
 */

const KV_KEY = "sim_simulation.snapshot";

// Sanitizer bersama lane ini (deskriptor-saja: menolak accessor, kunci
// berbahaya, fungsi/simbol, dan instance kelas). Dipakai ULANG alih-alih
// membuat salinan kedua di sini.
const { buildSafeSimValue } = require("./records");
const { REASONS, fail } = require("./errors");
const utilTypes = require("node:util").types;

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

function serialize({ runs, results, tokenLedger, invalidatedAssumptions }) {
    return {
        runs: Object.fromEntries(runs),
        results: Object.fromEntries(results),
        // Budget + invalidation history adalah state yang WAJIB bertahan
        // melintasi restart: bound "500k token/jam" adalah batas LAJU, jadi
        // meresetnya saat restart membuat sebuah operator bisa melampaui
        // batas itu hanya dengan me-restart (audit Wave8 L3/L5). Demikian pula
        // sebuah hasil yang sudah STALE_ASSUMPTIONS tidak boleh kembali
        // menjadi COMPLETE sesudah restart.
        budget: {
            tokenLedger: tokenLedger ? [...tokenLedger] : [],
            invalidatedAssumptions: invalidatedAssumptions ? [...invalidatedAssumptions] : []
        }
    };
}

/**
 * Baca riwayat anggaran tersimpan. Setiap entri divalidasi bentuknya (angka
 * finite) dan yang tidak sah DIBUANG -- snapshot rusak/hostil tidak boleh bisa
 * memalsukan konsumsi token maupun menyuntikkan asumsi yang tidak pernah
 * diinvalidasi. Bentuk yang tidak dikenal menghasilkan riwayat kosong.
 */
/**
 * Baca elemen array tersimpan TANPA `for...of` / `Symbol.iterator`.
 *
 * `for (const x of arr)` memanggil `arr[Symbol.iterator]`, yaitu `[[Get]]`
 * mentah pada kunci Symbol: snapshot hostil bisa memasang accessor di sana dan
 * kodenya berjalan sebelum validasi apa pun (audit Wave8 L3/L5). Iterasi di
 * sini memakai indeks numerik lewat deskriptor, persis seperti sanitizer lane.
 */
function readPersistedArray(value, state) {
    if (!Array.isArray(value)) return null;
    if (utilTypes.isProxy(value)) {
        // Array.isArray(jahatProxy) === true, lalu setiap operasi reflektif di
        // bawah menjalankan trap pemanggil. Tidak ada pembacaan yang aman.
        state.degraded = true;
        return null;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const len = lengthDescriptor && !lengthDescriptor.get && !lengthDescriptor.set
        ? lengthDescriptor.value : -1;
    if (!Number.isInteger(len) || len < 0) {
        state.degraded = true;
        return null;
    }
    // Riwayat yang sangat panjang tidak boleh memblokir event loop; melewati
    // batas berarti riwayat tidak dapat diyakini lengkap -> fail closed.
    if (len > MAX_BUDGET_ENTRIES) {
        state.degraded = true;
        return null;
    }
    const out = [];
    for (let i = 0; i < len; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(value, i);
        if (!desc || desc.get || desc.set || !("value" in desc)) {
            // LUBANG atau elemen malformed: riwayat tidak lengkap, jadi
            // pemakaian token tidak dapat dihitung dengan benar. Sebelumnya
            // entri ini dilewati diam-diam, sehingga riwayat berlubang tampak
            // seperti riwayat kosong dan batas laju ter-reset (audit L3/L5).
            state.degraded = true;
            return null;
        }
        out.push(desc.value);
    }
    return out;
}

/**
 * Riwayat anggaran tersimpan. Bentuk yang TIDAK DIKENAL berarti state anggaran
 * tidak dapat dipulihkan -- itu WAJIB terlihat sebagai `degraded`, bukan diam-diam
 * menjadi riwayat kosong: memperlakukan riwayat yang tidak terbaca sebagai kosong
 * akan mereset batas 500k token/jam (dan bisa menghidupkan lagi hasil yang sudah
 * STALE_ASSUMPTIONS) hanya dengan merusak snapshot (audit Wave8 L3/L5).
 */
function readPersistedBudget(raw) {
    const budget = readSnapshotField(raw, "budget");
    const out = { tokenLedger: [], invalidatedAssumptions: [], degraded: false };
    if (budget === null || budget === undefined) {
        // Tidak ada state anggaran tersimpan sama sekali: cold start yang jujur,
        // bukan degradasi (tidak ada apa pun yang gagal dibaca).
        return out;
    }
    if (typeof budget !== "object" || Array.isArray(budget)) {
        out.degraded = true;
        return out;
    }
    const ledgerRaw = readSnapshotField(budget, "tokenLedger");
    const invalidatedRaw = readSnapshotField(budget, "invalidatedAssumptions");
    if (ledgerRaw !== undefined && !Array.isArray(ledgerRaw)) {
        out.degraded = true;
        return out;
    }
    if (invalidatedRaw !== undefined && !Array.isArray(invalidatedRaw)) {
        out.degraded = true;
        return out;
    }
    const entries = readPersistedArray(ledgerRaw, out);
    if (entries) {
        for (const entry of entries) {
            // Entri yang TIDAK berbentuk {atMs, tokens} yang sah berarti
            // riwayat tidak dapat dipercaya: pemakaian token bisa tampak lebih
            // kecil dari kenyataan. Dilewati diam-diam = gagal-buka, jadi ini
            // menandai degraded (audit L3/L5).
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                out.degraded = true;
                return out;
            }
            const atMs = readSnapshotField(entry, "atMs");
            const tokens = readSnapshotField(entry, "tokens");
            if (!Number.isFinite(atMs) || !Number.isFinite(tokens) || tokens < 0) {
                out.degraded = true;
                return out;
            }
            out.tokenLedger.push({ atMs, tokens });
        }
    }
    const refs = readPersistedArray(invalidatedRaw, out);
    if (refs) {
        for (const ref of refs) {
            if (typeof ref !== "string" || !ref) {
                out.degraded = true;
                return out;
            }
            out.invalidatedAssumptions.push(ref);
        }
    }
    return out;
}

function deserialize(raw) {
    if (!raw || typeof raw !== "object") {
        return {
            runs: new Map(), results: new Map(), coldStart: true,
            tokenLedger: [], invalidatedAssumptions: []
        };
    }
    const budget = readPersistedBudget(raw);
    return {
        runs: readPersistedCollection(raw, "runs"),
        results: readPersistedCollection(raw, "results"),
        tokenLedger: budget.tokenLedger,
        invalidatedAssumptions: budget.invalidatedAssumptions,
        // Riwayat anggaran yang tidak terbaca = degradasi yang WAJIB terlihat.
        degraded: budget.degraded,
        coldStart: false
    };
}

/**
 * Baca satu field snapshot lewat DESKRIPTOR. `raw.runs ?? {}` adalah `[[Get]]`
 * mentah: snapshot yang dipersistensi bisa membawa accessor hidup, sehingga
 * pembacaannya MENJALANKAN kode pihak lain (audit Wave8 L3/L5).
 */
function readSnapshotField(raw, key) {
    // Proxy pada snapshot: setiap operasi reflektif (termasuk
    // getOwnPropertyDescriptor di bawah) menjalankan trap milik pemanggil, jadi
    // tidak ada pembacaan yang aman (audit L3/L5).
    try {
        if (raw !== null && typeof raw === "object" && utilTypes.isProxy(raw)) {
            throw new Error("snapshot tidak boleh berupa Proxy");
        }
    } catch (err) {
        throw err instanceof Error && /Proxy/.test(err.message)
            ? err
            : new Error("snapshot tidak dapat dibaca dengan aman");
    }
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
 * start empty"). Data simulasi TIDAK PERNAH boleh diam-diam menjadi tepercaya,
 * jadi memulai kosong adalah arah yang aman (SIMULATION != REALITY).
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
        out.set(name, deepFreeze(buildSafeSimValue(desc.value)));
    }
    return out;
}

/**
 * Kata kerja TULIS milik pemilik state NYATA (AccStore: jurnal, snapshot,
 * prediksi, pengalaman, komitmen, epoch substrat). Sebuah store simulasi
 * TIDAK PERNAH membutuhkannya -- hanya `getKv`/`putKv`.
 *
 * Kehadiran salah satunya adalah bukti positif bahwa yang diserahkan adalah
 * store NYATA, sehingga penulisan simulasi ke sana akan mengontaminasi state
 * nyata dan HARUS ditolak (kontrak L5: "cross-store writes ... are REJECTED at
 * the store boundary"; "every store-boundary rejection is audited as a
 * would-be contamination attempt"). Deteksi lewat kata kerja NYATA -- bukan
 * lewat penanda opt-in -- supaya test double biasa ({getKv, putKv}) tetap sah
 * dan tidak ada tes yang perlu dilemahkan.
 */
const REAL_STORE_WRITE_VERBS = Object.freeze([
    "appendEvent", "saveSnapshot", "upsertPrediction", "upsertExperience",
    "upsertCommitment", "upsertSubstrateEpoch", "upsertBelief", "appendJournal"
]);

/**
 * Batas jumlah entri riwayat anggaran yang akan dipulihkan.
 *
 * Riwayat sepanjang ini (jauh di atas apa pun yang bisa dihasilkan dalam satu
 * jam pada batas token) tidak masuk akal, dan membaca array raksasa secara
 * sinkron bisa memblokir event loop (audit Wave8 L3/L5). Melewati batas =
 * riwayat tidak dapat diyakini lengkap, jadi fail closed, bukan dipotong diam-diam.
 */
const MAX_BUDGET_ENTRIES = 100_000;

/**
 * Tolak store milik lane NYATA. Melempar SimulationError
 * CROSS_STORE_WRITE_REJECTED (gagal-tutup, ditolak mentah) sehingga pemanggil
 * tidak pernah bisa menulis state simulasi ke backend nyata/replikasi.
 */
function checkStoreIsolation(store) {
    if (!store || typeof store !== "object") return;
    // Proxy ditolak lebih dulu: setiap introspeksi pada Proxy menjalankan trap
    // milik pemanggil, jadi tidak ada pemeriksaan yang benar-benar aman di sini.
    try {
        if (utilTypes.isProxy(store)) {
            throw fail(REASONS.CROSS_STORE_WRITE_REJECTED,
                "store simulasi tidak boleh berupa Proxy");
        }
    } catch (err) {
        if (err && err.reason) throw err;
    }
    // Seluruh RANTAI PROTOTIPE ditelusuri TANPA batas kedalaman, sampai
    // `null`: batas kedalaman apa pun adalah bypass yang bisa dipakai
    // (kedalaman 33 lolos dari batas 32 sebelumnya), sedangkan rantai
    // prototipe yang sah selalu berakhir. Setiap tingkat dibaca lewat
    // DESKRIPTOR, bukan `store[verb]`; Proxy pada tingkat mana pun ditolak
    // karena trap-nya akan berjalan saat diintrospeksi (audit Wave8 L3/L5).
    const seenLevels = new Set();
    for (const verb of REAL_STORE_WRITE_VERBS) {
        let level = store;
        while (level && typeof level === "object") {
            if (level === Object.prototype || level === Function.prototype) break;
            if (seenLevels.has(level)) break;
            seenLevels.add(level);
            if (utilTypes.isProxy(level)) {
                throw fail(REASONS.CROSS_STORE_WRITE_REJECTED,
                    "store simulasi tidak boleh menyembunyikan Proxy pada rantai prototipenya");
            }
            let desc;
            try {
                desc = Object.getOwnPropertyDescriptor(level, verb);
            } catch {
                // Tingkat yang tidak dapat diintrospeksi diperlakukan mencurigakan.
                throw fail(REASONS.CROSS_STORE_WRITE_REJECTED,
                    "store simulasi tidak dapat diintrospeksi dengan aman");
            }
            if (desc) {
                const present = desc.get || desc.set ? true : typeof desc.value === "function";
                if (present) {
                    throw fail(REASONS.CROSS_STORE_WRITE_REJECTED,
                        `store simulasi tidak boleh berupa store state nyata (mengekspos '${verb}')`);
                }
                // Ditemukan sebagai data non-fungsi pada tingkat ini: tidak perlu
                // menelusuri lebih dalam untuk kata kerja ini.
                break;
            }
            try {
                level = Object.getPrototypeOf(level);
            } catch {
                break;
            }
        }
    }
}

/**
 * Resolve `getKv`/`putKv` lewat DESKRIPTOR di sepanjang rantai prototipe.
 *
 * `typeof store.getKv === "function"` adalah `[[Get]]` mentah: store yang
 * memasang getter di sana menjalankan kode pemanggil sebelum validasi apa pun,
 * jadi batas "tanpa eksekusi kode" tidak benar-benar berlaku (audit L3/L5).
 * Mengembalikan undefined bila propertinya accessor, bukan fungsi, atau tidak
 * ada -- dalam semua kasus itu store tidak dapat dipakai secara aman.
 */
function resolveStoreMethod(store, name) {
    let level = store;
    const seen = new Set();
    while (level && typeof level === "object") {
        if (level === Object.prototype || level === Function.prototype) break;
        if (seen.has(level)) break;
        seen.add(level);
        if (utilTypes.isProxy(level)) return undefined;
        let desc;
        try {
            desc = Object.getOwnPropertyDescriptor(level, name);
        } catch {
            return undefined;
        }
        if (desc) {
            if (desc.get || desc.set) return undefined;   // accessor: mengeksekusi kode
            return typeof desc.value === "function" ? desc.value : undefined;
        }
        try {
            level = Object.getPrototypeOf(level);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

async function loadSnapshot(store) {
    // Baca dari store NYATA juga merupakan pelanggaran batas: snapshot nyata
    // tidak boleh masuk ke sandbox simulasi (SIMULATION != REALITY).
    checkStoreIsolation(store);
    const getKv = resolveStoreMethod(store, "getKv");
    if (!getKv) {
        return { runs: new Map(), results: new Map(), coldStart: true, tokenLedger: [], invalidatedAssumptions: [] };
    }
    try {
        return deserialize(await getKv.call(store, KV_KEY));
    } catch {
        // Snapshot tidak terbaca / membawa materi berbahaya: mulai kosong.
        // Konsumen membedakan ini lewat `coldStart` dan mencatatnya ke audit.
        return { runs: new Map(), results: new Map(), coldStart: true, degraded: true, tokenLedger: [], invalidatedAssumptions: [] };
    }
}

async function saveSnapshot(store, state) {
    checkStoreIsolation(store);
    const putKv = resolveStoreMethod(store, "putKv");
    if (!putKv) return false;
    await putKv.call(store, KV_KEY, serialize(state));
    return true;
}

module.exports = { KV_KEY, loadSnapshot, saveSnapshot, serialize, deserialize, checkStoreIsolation, REAL_STORE_WRITE_VERBS };
