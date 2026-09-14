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
    // Bug review independen (audit putaran-43, W7R43-P2-5): sibling
    // langsung dari `subgraph`'s `seeds` (round-42 hanya menutup itu) --
    // Proxy yang di-revoke melempar TypeError mentah pada `Array.isArray(kinds)`.
    // Bug review independen (audit putaran-44, W7R44-P2-3): `Array.isArray`
    // hanya membuktikan IDENTITAS-nya array -- `kinds.includes(...)` di
    // bawah tetap [[Get]] BIASA (baca length + indeks), jadi sebuah Proxy
    // array-like dengan trap `get` yang melempar tetap raw-throw walau
    // sudah lolos guard ini. `kinds` disalin SEKALI ke array polos lewat
    // descriptor (menolak properti accessor) SEBELUM traversal, dan
    // `.includes()` di bawah dipakai pada SALINAN itu, tidak pernah pada
    // `kinds` milik pemanggil.
    let safeKinds = null;
    if (kinds !== null && kinds !== undefined) {
        let isKindsArray;
        try {
            isKindsArray = Array.isArray(kinds);
        } catch {
            fail(REASONS.INVALID_RECORD, "kinds tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (!isKindsArray) fail(REASONS.INVALID_RECORD, "kinds wajib array atau null");
        let kindsLen;
        try {
            kindsLen = kinds.length;
        } catch {
            fail(REASONS.INVALID_RECORD, "kinds tidak dapat diverifikasi dengan aman, ditolak");
        }
        // Bug review independen (audit putaran-49, W7R49-P2-1): guard ini
        // memvalidasi integer/non-negatif TAPI TIDAK PERNAH membatasi
        // ATASNYA -- Proxy array-like yang memalsukan `length` besar
        // (sampai 2^32-1) tanpa pernah benar-benar menyimpan elemennya
        // memaksa loop indeks di bawah berjalan jutaan kali, DoS CPU/memori
        // trivial satu panggilan. Setiap sanitizer saudara (buildSafeArray,
        // buildSafeBeliefValue, dst.) sudah punya langit-langit
        // MAX_*_ARRAY_LENGTH -- ditambahkan di sini juga, dipakai ulang
        // BOUNDS.MAX_VALUE_ARRAY_LENGTH milik lane yang sama.
        if (!Number.isInteger(kindsLen) || kindsLen < 0 || kindsLen > BOUNDS.MAX_VALUE_ARRAY_LENGTH) {
            fail(REASONS.INVALID_RECORD, "kinds.length tidak sah atau melebihi batas");
        }
        safeKinds = [];
        for (let i = 0; i < kindsLen; i++) {
            let desc;
            try {
                desc = Object.getOwnPropertyDescriptor(kinds, i);
            } catch {
                fail(REASONS.INVALID_RECORD, "kinds tidak dapat diverifikasi dengan aman, ditolak");
            }
            if (!desc || desc.get || desc.set) {
                fail(REASONS.INVALID_RECORD, `kinds tidak boleh membawa properti accessor: '${i}'`);
            }
            safeKinds.push(desc.value);
        }
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
                if (safeKinds && !safeKinds.includes(relation.kind)) continue;
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
    // Bug review independen (audit putaran-45, W7R45-P2-5): `?.` cuma
    // melindungi dari null/undefined, BUKAN dari Proxy yang di-revoke
    // (tetap truthy/typeof "object") -- `budget?.nodes`/`budget?.bytes`
    // tetap [[Get]] mentah terhadapnya. Diperlakukan SAMA seperti budget
    // malformed lain di guard bawah (jatuh ke default), bukan penolakan
    // baru -- konsisten dengan kontrak fungsi ini yang sudah ada.
    let maxNodes, maxBytes;
    try {
        maxNodes = budget?.nodes;
        maxBytes = budget?.bytes;
    } catch {
        maxNodes = undefined;
        maxBytes = undefined;
    }
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
    // Bug review independen (audit putaran-49, W7R49-P2-1): sibling
    // langsung dari `neighbors`'s `kindsLen` (kelas yang sama) -- guard
    // ini memvalidasi integer/non-negatif tapi tidak pernah membatasi
    // atasnya, membuka DoS trivial lewat length Proxy yang dipalsukan.
    if (!Number.isInteger(seedsLen) || seedsLen < 0 || seedsLen > BOUNDS.MAX_VALUE_ARRAY_LENGTH) {
        fail(REASONS.INVALID_RECORD, "seeds.length tidak sah atau melebihi batas");
    }
    // Bug review independen (audit putaran-44, W7R44-P2-3): `Array.isArray`
    // hanya membuktikan IDENTITAS-nya array -- tidak menetralkan trap
    // `get` milik Proxy. `seeds[i]` di sini masih [[Get]] BIASA, jadi
    // sebuah Proxy array-like dengan trap `get` yang melempar tetap
    // raw-throw di sini walau sudah lolos guard Array.isArray/length di
    // atas. Dibaca lewat descriptor (sama seperti sanitizer lain di basis
    // kode ini), menolak properti accessor, tidak pernah `value[i]` mentah.
    const seedList = [];
    for (let i = 0; i < seedsLen; i++) {
        let desc;
        try {
            desc = Object.getOwnPropertyDescriptor(seeds, i);
        } catch {
            fail(REASONS.INVALID_RECORD, "seeds tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (!desc || desc.get || desc.set) {
            fail(REASONS.INVALID_RECORD, `seeds tidak boleh membawa properti accessor: '${i}'`);
        }
        seedList.push(desc.value);
    }
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
