"use strict";

/** W7-L6 METACOGNITION — pembangun record (spec §3). */

const { REASONS, fail, MetacogError } = require("./errors");
const { BOUNDS: VALUE_BOUNDS } = require("./bounds");
const { sanitizeEvidenceQuality, confidenceFromSafe } = require("./confidence");

const DANGEROUS_VALUE_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

// Bug review independen (audit putaran-40, AUD40-ADV-1): perbaikan
// putaran-39 (AUD39-P2-2) mengganti `.map` (melewati lubang array sparse)
// dengan `Array.from`, yang MENGONSULTASIKAN `Symbol.iterator` -- sebuah
// array dengan `Symbol.iterator` yang ADA tapi bukan function (atau
// sebuah Proxy yang trap iterator-nya melempar) meledakkan TypeError
// mentah dari `Array.from` itu sendiri. Loop indeks eksplisit mengunjungi
// SETIAP indeks (termasuk lubang, sebagai `undefined`) tanpa pernah
// menyentuh `Symbol.iterator` sama sekali.
// Bug review independen (audit putaran-41, AUD41-P2-2, regresi
// diperkenalkan kandidat putaran-40): loop di atas dulu membaca
// `arr.length` di KONDISI loop -- dievaluasi ULANG setiap iterasi. Proxy
// dengan getter `length` yang TERUS BERTAMBAH membuat loop TIDAK PERNAH
// berhenti (DoS). `length` sekarang di-cache SEKALI ke lokal.
// Bug review independen (audit putaran-42, W7R42-P2-2/W7R42-ADV-1): `len`
// di-cache tapi tidak pernah divalidasi -- Proxy dengan getter `length`
// yang mengembalikan `Infinity` membuat loop TIDAK PERNAH berhenti (DoS).
// `length` sekarang divalidasi sebagai integer terhingga non-negatif dan
// dibatasi eksplisit sebelum loop dimulai.
// Bug review independen (audit putaran-43, W7R43-ADV-1): `65536` adalah
// konstanta arbitrer independen dari batas lane manapun -- dipakai kembali
// `VALUE_BOUNDS.MAX_VALUE_ARRAY_LENGTH` (batas yang sudah dipakai
// buildSafeCognitiveCopy untuk array bersarang di lane yang SAMA) supaya
// konsisten, bukan generik. Findings/proposals TETAP boleh melebihi
// MAX_FINDINGS_PER_REVIEW/MAX_PROPOSALS_PER_REVIEW di sini secara sengaja
// (lihat boundedFindings/boundedProposals di bawah -- disortir-lalu-dipotong
// ke prioritas tertinggi, bukan ditolak) -- 1024 adalah langit-langit
// keamanan yang jauh lebih tinggi dari itu, bukan batas tampilan.
const MAX_SAFE_ARRAY_LENGTH = VALUE_BOUNDS.MAX_VALUE_ARRAY_LENGTH;
function buildSafeArray(arr, mapFn) {
    // Bug review independen (audit putaran-53, AUD53-P2-1): sibling
    // langsung dari goals/records.js's buildSafeArray -- `arr.length`/
    // `arr[i]` adalah [[Get]] mentah, raw-throw untuk Proxy dengan trap
    // yang melempar. Dibungkus try/catch TERPISAH dari `mapFn` -- error
    // domain dari validasi elemen tidak pernah ditangkap di sini.
    let len;
    try {
        len = arr.length;
    } catch {
        fail(REASONS.INVALID_RECORD, "panjang array tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!Number.isInteger(len) || len < 0 || len > MAX_SAFE_ARRAY_LENGTH) {
        fail(REASONS.INVALID_RECORD, "panjang array tidak sah atau melebihi batas");
    }
    const out = [];
    for (let i = 0; i < len; i++) {
        let element;
        try {
            element = arr[i];
        } catch {
            fail(REASONS.INVALID_RECORD, `elemen array pada indeks '${i}' tidak dapat diverifikasi dengan aman, ditolak`);
        }
        out.push(mapFn(element, i));
    }
    return out;
}

// Bug review independen (audit putaran-31, AUD31-P2-5; putaran-32,
// AUD32-P2-5): perbaikan putaran-31 (`deepFreeze({...f})`) memang
// membekukan lapis dalam, tapi lewat `value[key]` -- itu MEMANGGIL
// accessor getter milik pemanggil, dan Object.freeze tidak menghapus
// accessor itu, jadi review tersimpan tetap punya getter HIDUP yang
// mengeksekusi kode pemanggil setiap kali dibaca (kelas yang sama dengan
// AUD10-P2-3/AUD24-P2-3 -- eksekusi getter pemanggil). Diganti sanitizer
// yang membangun SALINAN POLOS baru: baca selalu lewat
// getOwnPropertyDescriptor (bukan `value[key]`), tolak descriptor
// accessor (get/set) dan function/Symbol/kunci berbahaya, dibatasi
// kedalaman/anggaran node (pola sama seperti buildSafeBeliefValue di
// worldmodel/buildSafePayloadRef di prospective) -- accessor pemanggil
// tidak pernah tersentuh sama sekali, apalagi dipanggil.
// Bug review independen (audit putaran-65, Codex, AUD65-P2-1, eskalasi
// dari item yang diungkap-tapi-tidak-diperbaiki putaran-64): fungsi ini
// membaca `VALUE_BOUNDS` modul (default TETAP) langsung, bukan `bounds`
// yang sudah disanitasi per-instance -- override pemanggil (mis.
// MAX_VALUE_NODES:0) diam-diam diabaikan sepenuhnya, dibuktikan lewat
// reproduksi nyata (createMetacognition({bounds:{MAX_VALUE_NODES:0}})
// tetap menerima satu finding). Parameter `bounds` ditambahkan (default
// ke VALUE_BOUNDS modul untuk kompatibilitas mundur).
function buildSafeCognitiveCopy(value, depth = 0, stack, budget, bounds = VALUE_BOUNDS) {
    if (!stack) stack = new WeakSet();
    if (!budget) budget = { count: 0 };
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "function") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak boleh membawa fungsi (termasuk toJSON)");
    if (t === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak boleh membawa Symbol");
    // Bug review independen (audit putaran-33, AUD33-P2-5): sanitizer ini
    // ditulis meniru buildSafeBeliefValue/buildSafePayloadRef tapi lupa dua
    // cabang penolakannya -- BigInt (meledakkan JSON.stringify/aritmetika
    // mentah di pemanggil, mis. sort comparator makeReview di bawah) dan
    // angka non-finite (NaN/Infinity, kelas yang sama dengan sweep
    // AUD30-ADV-1/AUD31-ADV-1/AUD32-P2-4 yang belum menjangkau sanitizer
    // baru ini).
    if (t === "bigint") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak boleh membawa BigInt");
    if (t === "number" && !Number.isFinite(value)) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak boleh berupa angka non-finite (NaN/Infinity)");
    }
    if (t !== "object") return value;
    if (depth > bounds.MAX_VALUE_SCAN_DEPTH) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "struktur terlalu dalam untuk diverifikasi dengan aman, ditolak");
    }
    if (stack.has(value)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "struktur siklik terdeteksi");
    budget.count += 1;
    if (budget.count > bounds.MAX_VALUE_NODES) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "jumlah node melebihi batas");
    }
    // Bug review independen (audit putaran-43, W7R43-P2-3/W7R43-P2-7):
    // `Array.isArray`/`Object.getPrototypeOf`/`Reflect.ownKeys` di bawah
    // adalah operasi dasar terhadap `value` yang belum tepercaya -- di
    // KEDALAMAN MANAPUN lewat rekursi -- sebuah Proxy yang di-revoke
    // melempar TypeError MENTAH pada operasi ini, keluar dari
    // `openReview()`/`assess()` publik. Seluruh cabang array/objek
    // dibungkus try/catch; MetacogError (termasuk hasil rekursi anak)
    // diteruskan apa adanya, kegagalan APA PUN lainnya gagal tertutup.
    try {
        if (Array.isArray(value)) {
            // Bug review independen (audit putaran-42, W7R42-P2-1): `value.length`
            // dulu dibaca SEKALI untuk cek batas ini, lalu dibaca ULANG di
            // KONDISI loop di bawah setiap iterasi -- Proxy dengan getter
            // `length` yang terus bertambah membuat loop TIDAK PERNAH berhenti
            // (DoS). `length` di-cache SEKALI ke lokal dan divalidasi sebagai
            // integer terhingga non-negatif SEBELUM dipakai di mana pun.
            const len = value.length;
            if (!Number.isInteger(len) || len < 0 || len > bounds.MAX_VALUE_ARRAY_LENGTH) {
                fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "panjang array melebihi batas atau tidak sah");
            }
            const arrProto = Object.getPrototypeOf(value);
            if (arrProto !== Array.prototype && arrProto !== null) {
                fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "array dengan prototype non-standar ditolak");
            }
            stack.add(value);
            const out = [];
            try {
                for (let i = 0; i < len; i++) {
                    const desc = Object.getOwnPropertyDescriptor(value, i);
                    if (!desc || desc.get || desc.set) {
                        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `tidak boleh membawa properti accessor: '${i}'`);
                    }
                    out[i] = buildSafeCognitiveCopy(desc.value, depth + 1, stack, budget, bounds);
                }
            } finally {
                stack.delete(value);
            }
            return Object.freeze(out);
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak boleh berupa instance kelas (kontrak data murni)");
        }
        // Bug review independen (audit putaran-44, W7R44-P2-4): cabang ini
        // tidak pernah punya batas jumlah kunci seperti keempat sanitizer
        // saudaranya -- objek datar dengan puluhan ribu kunci primitif
        // diproses tanpa batas (budget.count cuma bertambah untuk node
        // KOMPOSIT, bukan per kunci). `keys` di-cache SEKALI dan divalidasi
        // sebelum loop, sama seperti cabang array di atas.
        const keys = Reflect.ownKeys(value);
        if (keys.length > bounds.MAX_VALUE_KEYS) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "jumlah kunci melebihi batas");
        }
        stack.add(value);
        const out = {};
        try {
            for (const key of keys) {
                if (typeof key === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak boleh membawa kunci Symbol");
                if (DANGEROUS_VALUE_KEYS.includes(key)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `kunci berbahaya ditolak: '${key}'`);
                const desc = Object.getOwnPropertyDescriptor(value, key);
                if (!desc || desc.get || desc.set) {
                    fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `tidak boleh membawa properti accessor: '${String(key)}'`);
                }
                if (!desc.enumerable) continue;
                const built = buildSafeCognitiveCopy(desc.value, depth + 1, stack, budget, bounds);
                if (built !== undefined) out[key] = built;
            }
        } finally {
            stack.delete(value);
        }
        return Object.freeze(out);
    } catch (err) {
        // Bug review independen (audit putaran-44, W7R44-P2-1): `err
        // instanceof MetacogError` memanggil [[GetPrototypeOf]] pada
        // `err` -- sebuah Proxy yang sengaja dilempar dengan trap
        // `getPrototypeOf` yang melempar membuat guard fail-closed ini
        // SENDIRI jadi permukaan raw-throw. Dibungkus try/catch; kegagalan
        // pemeriksaan ini dianggap BUKAN MetacogError.
        let isDomainError = false;
        try {
            isDomainError = err instanceof MetacogError;
        } catch {
            isDomainError = false;
        }
        if (isDomainError) throw err;
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak dapat diverifikasi dengan aman, ditolak");
    }
}

const TRIGGERS = new Set(["CONTRADICTION", "EXPECTATION_VIOLATED", "REPEATED_FAILURE", "LOW_CONFIDENCE_ACTION", "OWNER_CHALLENGE", "SCHEDULED"]);
const PROPOSAL_KINDS = new Set(["REPLAN", "PROBE", "ASK_OWNER", "LOWER_CONFIDENCE", "ABANDON_GOAL", "OPEN_CONTRADICTION", "RECALIBRATE"]);

/** §5: proposal kognitif-murni boleh diterapkan tanpa Authority; sisanya normal governed. */
const COGNITIVE_ONLY_PROPOSALS = new Set(["LOWER_CONFIDENCE", "OPEN_CONTRADICTION", "PROBE"]);

function makeAssessment({ assessmentId, subjectRef, claim, evidenceQuality, nowMs, calibrationRef = null, bounds = VALUE_BOUNDS }) {
    if (typeof assessmentId !== "string" || !assessmentId) fail(REASONS.INVALID_RECORD, "assessmentId wajib string");
    // Bug review independen (audit putaran-30, AUD30-P2-3): evidenceQuality
    // dulu dibaca DUA KALI secara independen -- sekali di dalam
    // computeConfidence (untuk basis/value) dan sekali lagi di sini
    // (`{...evidenceQuality}` untuk arsip tersimpan). evidenceQuality
    // stateful bisa memberi nilai valid pada baca pertama (basis:
    // VERIFIED_EVIDENCE) lalu nilai lain pada baca kedua (evidenceQuality
    // tersimpan bilang verifiedCount:0) -- assessment yang disimpan
    // BERTENTANGAN dengan confidence yang disertifikasinya (pelanggaran
    // MC-1/MC-2). Disaring SEKALI di sini; value/basis dan salinan
    // tersimpan berasal dari snapshot yang SAMA persis.
    const safeEvidenceQuality = sanitizeEvidenceQuality(evidenceQuality);
    const { value, basis } = confidenceFromSafe(safeEvidenceQuality, nowMs);
    // Bug review independen (audit putaran-32, AUD32-ADV-1): sibling dari
    // AUD31-P2-5 dalam berkas yang sama -- `Object.freeze({...subjectRef})`
    // hanya satu lapis DAN membaca lewat spread (memanggil accessor
    // pemanggil); diganti buildSafeCognitiveCopy yang sudah membekukan
    // dalam dan tidak pernah memanggil accessor.
    // Bug review independen (audit putaran-33, AUD33-ADV-2): `claim`
    // disimpan mentah, tidak seperti subjectRef di baris yang sama --
    // BigInt/non-finite/objek tak terbatas bisa tersimpan tanpa batas per
    // assessment; disaring lewat sanitizer yang sama.
    return Object.freeze({
        assessmentId, subjectRef: buildSafeCognitiveCopy(subjectRef, 0, undefined, undefined, bounds), claim: buildSafeCognitiveCopy(claim, 0, undefined, undefined, bounds),
        value, basis,
        evidenceQuality: Object.freeze(safeEvidenceQuality),
        calibrationRef
    });
}

function makeReview({ reviewId, trigger, findings = [], proposals = [], cost = { tokens: 0, ms: 0 }, bounds }) {
    // Bug review independen (audit putaran-25, AUD25-ADV-1): interpolasi
    // `${trigger}` mentah di pesan error meledakkan TypeError untuk Symbol
    // -- latent sampai sekarang karena index.js's openReview() sudah
    // menjaga TRIGGERS sebelum sampai sini (putaran-24), tapi builder ini
    // sendiri wajib aman untuk pemanggil lain/masa depan.
    if (!TRIGGERS.has(trigger)) fail(REASONS.INVALID_RECORD, `trigger '${typeof trigger === "string" ? trigger : typeof trigger}' tidak dikenal`);
    // Bug review independen (audit putaran-15, AUD15-P2-3): default `= []`
    // hanya berlaku untuk undefined, bukan null eksplisit -- findings:null/
    // proposals:null lolos lalu melempar TypeError mentah (bukan
    // INVALID_RECORD) di `.length`/`for...of`.
    // Bug review independen (audit putaran-43, W7R43-P2-3): Proxy yang
    // di-revoke melempar TypeError mentah pada `Array.isArray` di sini juga.
    let isFindingsArray, isProposalsArray;
    try {
        isFindingsArray = findings === undefined || Array.isArray(findings);
    } catch {
        fail(REASONS.INVALID_RECORD, "findings tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!isFindingsArray) fail(REASONS.INVALID_RECORD, "findings wajib array");
    try {
        isProposalsArray = proposals === undefined || Array.isArray(proposals);
    } catch {
        fail(REASONS.INVALID_RECORD, "proposals tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!isProposalsArray) fail(REASONS.INVALID_RECORD, "proposals wajib array");
    // Bug review independen (audit putaran-16, AUD16-P2-1): perbaikan
    // putaran-15 hanya menjaga WADAH array-nya -- elemen null/undefined di
    // dalamnya (mis. proposals: [null]) tetap melempar TypeError mentah di
    // `p.kind`. `cost` juga tidak pernah dijaga sama sekali -- cost:null
    // melempar TypeError mentah karena default `= {...}` hanya berlaku
    // untuk undefined.
    // Bug review independen (audit putaran-17, AUD17-P2-1): guard putaran-16
    // hanya memeriksa WADAH-nya -- BigInt/NaN/negatif di cost.tokens/ms
    // meledakkan aritmetika mentah atau meracuni anggaran refleksi di
    // openReview (index.js). Disamakan persis dengan guard di sana supaya
    // kedua tempat tidak berbeda predikat.
    // Bug review independen (audit putaran-35, AUD35-ADV-3): guard ini
    // membaca `cost.tokens`/`cost.ms` langsung, lalu penyimpanan di bawah
    // (`Object.freeze({...cost})`) membacanya LAGI secara independen --
    // kalau makeReview PERNAH dipanggil langsung dengan cost stateful
    // (openReview di index.js sudah lolos-aman lewat safeCost sejak
    // putaran-34, tapi builder ini sendiri wajib aman untuk pemanggil
    // lain/masa depan), nilai tersimpan bisa berbeda dari yang divalidasi.
    // Dibaca SEKALI ke lokal; disimpan dari lokal yang SAMA.
    if (!cost || typeof cost !== "object") {
        fail(REASONS.INVALID_RECORD, "cost wajib { tokens, ms } berupa number >= 0 yang valid");
    }
    const costTokens = cost.tokens;
    const costMs = cost.ms;
    if (typeof costTokens !== "number" || !Number.isFinite(costTokens) || costTokens < 0 ||
        typeof costMs !== "number" || !Number.isFinite(costMs) || costMs < 0) {
        fail(REASONS.INVALID_RECORD, "cost wajib { tokens, ms } berupa number >= 0 yang valid");
    }
    const safeCost = Object.freeze({ tokens: costTokens, ms: costMs });
    // Bug review independen (audit putaran-25, AUD25-P2-1; putaran-35,
    // AUD35-P2-2; putaran-38, AUD38-P2-2): interpolasi `${p.kind}` mentah
    // meledakkan TypeError kalau p.kind Symbol -- perbaikan putaran-25
    // menghindari interpolasi LANGSUNG dan putaran-35 membacanya sekali
    // ke lokal, tapi keduanya masih membaca `p.kind` lewat [[Get]] biasa
    // milik pemanggil SEBELUM buildSafeCognitiveCopy (descriptor-based)
    // sempat menolaknya -- getter kind tereksekusi meski proposal itu
    // akhirnya ditolak juga oleh sanitizer. Disaring SEKALI lewat
    // buildSafeCognitiveCopy lebih dulu; `kind` diturunkan dari salinan
    // aman itu, dan salinan yang SAMA dipakai untuk penyimpanan di bawah
    // (tidak disaring dua kali).
    // Bug review independen (audit putaran-39, AUD39-P2-2, regresi
    // diperkenalkan kandidat putaran-38): `Array.prototype.map` MELEWATI
    // lubang (hole) pada array jarang (sparse) -- `new Array(2).map(cb)`
    // tidak pernah memanggil `cb` sama sekali untuk indeks yang kosong,
    // jadi guard "setiap proposal wajib objek" tidak pernah tereksekusi
    // untuk elemen itu dan lubangnya lolos tersimpan (beda dengan
    // `for...of` sebelumnya, yang mengunjungi lubang sebagai `undefined`
    // lewat iterator array). `Array.from(arr, cb)` mengunjungi lubang
    // SEBAGAI `undefined` sama seperti `for...of`, menutup celah ini.
    const safeProposals = buildSafeArray(proposals, p => {
        if (!p || typeof p !== "object") fail(REASONS.INVALID_RECORD, "setiap proposal wajib objek");
        const sp = buildSafeCognitiveCopy(p, 0, undefined, undefined, bounds);
        const kind = sp?.kind;
        if (!PROPOSAL_KINDS.has(kind)) fail(REASONS.INVALID_RECORD, `proposal.kind '${typeof kind === "string" ? kind : typeof kind}' tidak dikenal`);
        return sp;
    });
    // Bug review independen (audit putaran-33, AUD33-P2-5; putaran-38,
    // AUD38-P2-2 sibling): komparator sort dulu membaca `severity` MENTAH
    // (sebelum buildSafeCognitiveCopy sempat menyaringnya) -- BigInt/
    // hostile valueOf meledakkan aritmetika `-` mentah, DAN getter
    // severity milik pemanggil tereksekusi meski finding-nya akhirnya
    // ditolak juga oleh sanitizer. Disaring SEKALI lewat
    // buildSafeCognitiveCopy lebih dulu (fail closed untuk objek non-form
    // di sini); severity untuk pengurutan diturunkan dari salinan aman.
    // Bug review independen (audit putaran-39, AUD39-P2-2 sibling): `.map`
    // melewati lubang array sparse -- `Array.from` dipakai supaya lubang
    // dikunjungi sebagai `undefined` dan ditolak oleh guard, sama seperti
    // perbaikan di atas untuk proposals.
    const safeFindings = buildSafeArray(findings, f => {
        if (!f || typeof f !== "object") fail(REASONS.INVALID_RECORD, "setiap finding wajib objek");
        return buildSafeCognitiveCopy(f, 0, undefined, undefined, bounds);
    });
    const safeSeverity = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : 0;
    const boundedFindings = safeFindings.length > bounds.MAX_FINDINGS_PER_REVIEW
        ? [...safeFindings].sort((a, b) => safeSeverity(b?.severity) - safeSeverity(a?.severity)).slice(0, bounds.MAX_FINDINGS_PER_REVIEW)
        : safeFindings;
    const boundedProposals = safeProposals.slice(0, bounds.MAX_PROPOSALS_PER_REVIEW);

    return Object.freeze({
        reviewId, trigger,
        findings: Object.freeze(boundedFindings),
        // Bug review independen (audit putaran-43, W7R43-P2-8): `findings.length`
        // dibaca ULANG di sini, TERPISAH dari `len` yang sudah di-cache SEKALI
        // di dalam buildSafeArray di atas -- getter `length` yang berbohong
        // antara dua baca membuat flag ini divergen dari `boundedFindings`
        // yang SUNGGUHAN tersimpan. `safeFindings.length` (array polos hasil
        // buildSafeArray, bukan Proxy pemanggil) dipakai, satu-satunya sumber
        // kebenaran yang sama dipakai `boundedFindings` di atas.
        findingsTruncated: safeFindings.length > bounds.MAX_FINDINGS_PER_REVIEW,
        proposals: Object.freeze(boundedProposals),
        cost: safeCost,
        state: "OPEN"
    });
}

/** §7: skor Brier — never LogLoss di sini demi kesederhanaan (dipilih via scoreKind). */
// Bug review independen (audit putaran-71, Codex, AUD71-P2-1): fungsi ini
// di-export LANGSUNG (module.exports di bawah) -- pemanggil LUAR bisa
// memanggilnya tanpa pernah melewati guard `typeof outcomeCorrect ===
// "boolean"` yang putaran-70 tambahkan di makeCalibrationRecord (guard di
// PEMANGGIL, bukan di FUNGSI ITU SENDIRI). Divalidasi di sini juga, supaya
// helper yang di-export ini aman dipanggil sendiri, tidak bergantung pada
// disiplin pemanggilnya.
function brierScore(predictedConfidence, outcomeCorrect) {
    if (typeof outcomeCorrect !== "boolean") {
        fail(REASONS.INVALID_RECORD, "outcomeCorrect wajib boolean");
    }
    const o = outcomeCorrect ? 1 : 0;
    return (predictedConfidence - o) ** 2;
}

function makeCalibrationRecord({ recordId, predictionRef, predictedValue, predictedConfidence, outcomeRef, outcomeValue, outcomeCorrect, scoreKind = "BRIER", windowFrom, windowTo, bounds = VALUE_BOUNDS }) {
    if (typeof recordId !== "string" || !recordId) fail(REASONS.INVALID_RECORD, "recordId wajib string");
    // Bug review independen (audit putaran-18, AUD18-A1): predictedConfidence
    // tidak pernah divalidasi -- BigInt meledakkan aritmetika mentah
    // (TypeError), NaN diam-diam menghasilkan skor kalibrasi error:NaN yang
    // meracuni statistik kalibrasi.
    if (typeof predictedConfidence !== "number" || !Number.isFinite(predictedConfidence)) {
        fail(REASONS.INVALID_RECORD, "predictedConfidence wajib number yang valid");
    }
    // Bug review independen (audit putaran-70, Codex, AUD70-P2-1): `outcomeCorrect
    // ? 1 : 0` (di brierScore dan cabang non-BRIER) menerima NILAI APA PUN --
    // string "false" bersifat truthy, jadi diperlakukan sebagai outcome BENAR,
    // meracuni statistik kalibrasi dengan data yang tidak pernah divalidasi.
    if (typeof outcomeCorrect !== "boolean") {
        fail(REASONS.INVALID_RECORD, "outcomeCorrect wajib boolean");
    }
    const error = scoreKind === "BRIER" ? brierScore(predictedConfidence, outcomeCorrect) : Math.abs(predictedConfidence - (outcomeCorrect ? 1 : 0));
    // Bug review independen (audit putaran-32, AUD32-ADV-1): sibling dari
    // AUD31-P2-5 -- predictionRef/predictedValue/outcomeRef/outcomeValue
    // disimpan sebagai referensi mentah milik pemanggil, tidak pernah
    // disaring/dibekukan; buildSafeCognitiveCopy menutup keduanya sekaligus.
    return Object.freeze({
        recordId,
        predictionRef: buildSafeCognitiveCopy(predictionRef, 0, undefined, undefined, bounds),
        predictedValue: buildSafeCognitiveCopy(predictedValue, 0, undefined, undefined, bounds),
        predictedConfidence,
        outcomeRef: buildSafeCognitiveCopy(outcomeRef, 0, undefined, undefined, bounds),
        outcomeValue: buildSafeCognitiveCopy(outcomeValue, 0, undefined, undefined, bounds),
        error, scoreKind,
        // Bug review independen (audit putaran-34, AUD34-ADV-3): `window`
        // disimpan mentah, tidak seperti predictionRef/outcomeValue di atas
        // -- BigInt/non-finite/accessor di windowFrom/windowTo lolos tanpa
        // disaring (sibling dari sanitisasi `window` yang sudah ada di
        // prospective's makeExpectation).
        window: buildSafeCognitiveCopy({ from: windowFrom, to: windowTo }, 0, undefined, undefined, bounds)
    });
}

module.exports = {
    TRIGGERS, PROPOSAL_KINDS, COGNITIVE_ONLY_PROPOSALS,
    makeAssessment, makeReview, makeCalibrationRecord, brierScore
};
