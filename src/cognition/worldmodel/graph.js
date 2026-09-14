"use strict";

/**
 * W7-L2 WORLD MODEL — operasi graf situasi (spec §10). Setiap traversal
 * dibatasi eksplisit; melebihi batas mengembalikan hasil parsial dengan
 * `truncated: true`, TIDAK PERNAH walk tak terbatas (WM-A7).
 */

const { BOUNDS } = require("./bounds");
const { REASONS, fail } = require("./errors");

function adjacency(relations, entityId) {
    const out = [];
    for (const r of relations.values()) {
        if (r.from === entityId) out.push({ neighborId: r.to, relation: r });
        else if (!r.directed && r.to === entityId) out.push({ neighborId: r.from, relation: r });
    }
    return out;
}

function neighbors(state, entityId, kinds = null, depth = 1) {
    // Bug review independen (audit putaran-22, F-2): `budget` di subgraph()
    // dijaga (putaran-20) tapi `kinds` di FUNGSI SAMA-KELAS ini tidak --
    // `kinds` bukan array/null meledakkan `.includes()` jadi TypeError
    // mentah.
    if (kinds !== null && kinds !== undefined && !Array.isArray(kinds)) {
        fail(REASONS.INVALID_RECORD, "kinds wajib array atau null");
    }
    // Bug review independen (audit putaran-24, AUD24-P2-5): default
    // parameter `depth = 1` hanya berlaku untuk `undefined` -- `depth:
    // null` eksplisit lolos lalu `Math.min(null, MAX)` menjadi 0, membuat
    // traversal diam-diam TIDAK BERJALAN SAMA SEKALI (jawaban kosong yang
    // salah, bukan error ATAU default WM-A7 yang didokumentasikan).
    // Bug review independen (audit putaran-25, AUD25-P2-3): putaran-24
    // hanya menjaga null/non-finite -- `depth: -1` lolos lalu
    // `Math.min(-1, MAX)` = -1, membuat loop `d < boundedDepth` tidak
    // pernah berjalan (traversal diam-diam kosong), sama seperti kasus null.
    if (depth === undefined || depth === null || !Number.isFinite(depth) || depth < 0) depth = 1;
    const boundedDepth = Math.min(depth, BOUNDS.NEIGHBORS_MAX_DEPTH);
    const visited = new Set([entityId]);
    let frontier = [entityId];
    let truncated = depth > BOUNDS.NEIGHBORS_MAX_DEPTH;
    const result = new Set();

    for (let d = 0; d < boundedDepth; d++) {
        const next = [];
        for (const id of frontier) {
            const edges = adjacency(state.relations, id);
            const limited = edges.slice(0, BOUNDS.NEIGHBORS_MAX_FANOUT);
            if (edges.length > BOUNDS.NEIGHBORS_MAX_FANOUT) truncated = true;
            for (const { neighborId, relation } of limited) {
                if (kinds && !kinds.includes(relation.kind)) continue;
                if (!visited.has(neighborId)) {
                    visited.add(neighborId);
                    result.add(neighborId);
                    next.push(neighborId);
                }
            }
        }
        frontier = next;
    }

    return {
        entities: [...result].map(id => state.entities.get(id)).filter(Boolean),
        truncated
    };
}

function subgraph(state, seeds = [], depth = 2, budget = { nodes: 512, bytes: 262144 }) {
    // Bug review independen (audit putaran-22, F-2): sibling `budget`
    // dijaga (putaran-20) tapi `seeds` tidak -- `seeds: null` eksplisit
    // meledakkan `new Set(seeds)`/`[...seeds]` jadi TypeError mentah
    // ("seeds is not iterable"), asimetri elemen-vs-kontainer yang sama
    // dengan AUD21-P2-1.
    // Bug review independen (audit putaran-42, W7R42-P2-3): sebuah Proxy
    // yang sudah di-revoke melempar TypeError MENTAH pada `Array.isArray`
    // (trap `[[IsArray]]`, yang butuh `getPrototypeOf`) -- dibungkus
    // try/catch supaya kegagalan APA PUN di sini gagal tertutup, bukan
    // crash keluar dari API publik ini.
    if (seeds === undefined || seeds === null) seeds = [];
    else {
        let isSeedsArray;
        try {
            isSeedsArray = Array.isArray(seeds);
        } catch {
            fail(REASONS.INVALID_RECORD, "seeds tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (!isSeedsArray) fail(REASONS.INVALID_RECORD, "seeds wajib array");
    }
    // Bug review independen (audit putaran-24, AUD24-P2-5): `depth: null`
    // eksplisit lolos default parameter lalu `Math.min(null, MAX)` = 0,
    // membuat traversal diam-diam tidak berjalan (jawaban kosong salah).
    // Bug review independen (audit putaran-25, AUD25-P2-3): negatif lolos
    // guard null/non-finite putaran-24, sama-sama membuat traversal diam-diam kosong.
    if (depth === undefined || depth === null || !Number.isFinite(depth) || depth < 0) depth = 2;
    // Bug review independen (audit putaran-20, AUD20-P2-2): default parameter
    // hanya berlaku untuk `undefined` -- `budget: null` eksplisit lolos lalu
    // meledakkan `budget.nodes`/`budget.bytes` jadi TypeError mentah.
    // Bug review independen (audit putaran-34, AUD34-ADV-5): `budget.nodes`/
    // `budget.bytes` dulu dibaca berkali-kali -- sekali di guard tipe ini,
    // lagi untuk `maxNodes`/`maxBytes` di bawah, lagi setiap iterasi
    // traversal, lagi di cek byte -- sebuah accessor budget bisa lolos
    // guard dengan nilai sah lalu berubah DI TENGAH traversal, membuat
    // batas efektif tidak konsisten. `nodes`/`ms` dibaca SEKALI SAJA
    // masing-masing (SEBELUM divalidasi) ke lokal; validasi dan seluruh
    // traversal di bawah memakai lokal itu saja.
    let maxNodes = budget?.nodes;
    let maxBytes = budget?.bytes;
    if (!budget || typeof budget !== "object" || !Number.isFinite(maxNodes) || !Number.isFinite(maxBytes)) {
        maxNodes = 512;
        maxBytes = 262144;
    }
    const boundedDepth = Math.min(depth, BOUNDS.NEIGHBORS_MAX_DEPTH);
    // Bug review independen (audit putaran-41, AUD41-P2-1): `Array.isArray(seeds)`
    // di atas hanya menjaga KONTAINERnya -- `new Set(seeds)`/`[...seeds]`
    // di bawah tetap mengonsumsi `seeds` lewat protokol iterator
    // (`Symbol.iterator`), yang lolos dari guard Array.isArray untuk
    // sebuah array/Proxy dengan `Symbol.iterator` yang ADA tapi bukan
    // function, meledakkan TypeError mentah dari API publik ini. Dibaca
    // lewat loop indeks eksplisit (sama seperti buildSafeArray) yang
    // tidak pernah menyentuh Symbol.iterator sama sekali; `nodeIds`/
    // `frontier` lalu dibangun dari salinan array POLOS ini.
    // Bug review independen (audit putaran-42, W7R42-P2-1/W7R42-P2-3):
    // `seeds.length` bisa melempar mentah (getter `length` yang
    // melempar, atau Proxy yang di-revoke ANTARA cek Array.isArray di
    // atas dan baris ini) dan bisa berupa NaN/Infinity/pecahan/negatif
    // (Proxy panjang palsu) -- dibungkus try/catch dan divalidasi
    // sebagai integer terhingga non-negatif sebelum dipakai di loop.
    let seedsLen;
    try {
        seedsLen = seeds.length;
    } catch {
        fail(REASONS.INVALID_RECORD, "seeds tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!Number.isInteger(seedsLen) || seedsLen < 0) {
        fail(REASONS.INVALID_RECORD, "seeds.length tidak sah");
    }
    const seedList = [];
    for (let i = 0; i < seedsLen; i++) seedList.push(seeds[i]);
    const nodeIds = new Set(seedList);
    let frontier = seedList.slice();
    let truncated = false;

    for (let d = 0; d < boundedDepth && nodeIds.size < maxNodes; d++) {
        const next = [];
        for (const id of frontier) {
            const edges = adjacency(state.relations, id).slice(0, BOUNDS.NEIGHBORS_MAX_FANOUT);
            for (const { neighborId } of edges) {
                if (nodeIds.size >= maxNodes) { truncated = true; break; }
                if (!nodeIds.has(neighborId)) { nodeIds.add(neighborId); next.push(neighborId); }
            }
        }
        frontier = next;
    }

    const entities = [...nodeIds].map(id => state.entities.get(id)).filter(Boolean);
    const relations = [...state.relations.values()]
        .filter(r => nodeIds.has(r.from) && nodeIds.has(r.to));

    let payload = { entities, relations };
    if (Buffer.byteLength(JSON.stringify(payload)) > maxBytes) {
        truncated = true;
        const half = Math.max(1, Math.floor(entities.length / 2));
        payload = { entities: entities.slice(0, half), relations: relations.slice(0, half) };
    }

    return { ...payload, truncated };
}

function path(state, from, to, maxDepth = 5) {
    // Bug review independen (audit putaran-24, AUD24-P2-5): `maxDepth:
    // null` eksplisit lolos default parameter lalu `Math.min(null, MAX)`
    // = 0, membuat path() diam-diam melapor "tidak ditemukan" (truncated:
    // true) alih-alih benar-benar mencari sampai PATH_MAX_DEPTH.
    // Bug review independen (audit putaran-25, AUD25-P2-3): negatif lolos
    // guard null/non-finite putaran-24, membuat path() diam-diam melapor
    // "tidak ditemukan" walau path sebenarnya ada.
    if (maxDepth === undefined || maxDepth === null || !Number.isFinite(maxDepth) || maxDepth < 0) maxDepth = 5;
    const boundedDepth = Math.min(maxDepth, BOUNDS.PATH_MAX_DEPTH);
    if (from === to) return { path: [from], truncated: false };

    const visited = new Set([from]);
    let frontier = [[from]];

    for (let d = 0; d < boundedDepth; d++) {
        const next = [];
        for (const chain of frontier) {
            const tail = chain[chain.length - 1];
            for (const { neighborId } of adjacency(state.relations, tail).slice(0, BOUNDS.NEIGHBORS_MAX_FANOUT)) {
                if (neighborId === to) return { path: [...chain, neighborId], truncated: false };
                if (!visited.has(neighborId)) {
                    visited.add(neighborId);
                    next.push([...chain, neighborId]);
                }
            }
        }
        frontier = next;
        if (frontier.length === 0) break;
    }

    return { path: null, truncated: true };
}

function entitiesByKind(state, kind, limit = 256) {
    // Bug review independen (audit putaran-24, AUD24-P2-5): `limit: null`
    // eksplisit lolos default parameter lalu `Math.min(null, MAX)` = 0,
    // membuat hasil diam-diam kosong DAN truncated:true walau entitas
    // yang cocok memang ada.
    // Bug review independen (audit putaran-25, AUD25-P2-3): putaran-24
    // hanya menjaga null/non-finite -- `limit: -1` lolos lalu
    // `Math.min(-1, MAX)` = -1, dan `.slice(0, -1)` MEMBUANG elemen
    // terakhir alih-alih membatasi, jadi `entitiesByKind("d", -1)` bisa
    // mengembalikan LEBIH BANYAK dari ENTITIES_BY_KIND_LIMIT (melanggar
    // batas yang justru mau ditegakkan). Dinormalisasi ke default untuk
    // negatif, DAN batas bawah 0 dipaksakan sebagai jaring pengaman kedua.
    if (limit === undefined || limit === null || !Number.isFinite(limit) || limit < 0) limit = 256;
    const boundedLimit = Math.max(0, Math.min(limit, BOUNDS.ENTITIES_BY_KIND_LIMIT));
    const all = [...state.entities.values()].filter(e => e.entityKind === kind);
    return { entities: all.slice(0, boundedLimit), truncated: all.length > boundedLimit };
}

module.exports = { neighbors, subgraph, path, entitiesByKind };
