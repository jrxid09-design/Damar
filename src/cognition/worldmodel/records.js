"use strict";

/**
 * W7-L2 WORLD MODEL — pembangun record murni (spec §4): WorldEntity,
 * WorldRelation, WorldObservation, WorldHypothesis. Tidak menyentuh state;
 * hanya validasi bentuk + batas, lalu mengembalikan objek beku.
 */

const { clamp01 } = require("../core/envelope");
const { REASONS, fail } = require("./errors");
const { BOUNDS } = require("./bounds");
const { buildSafeBeliefValue } = require("./beliefAlgebra");

const ADMISSIBLE_TIERS = new Set(["T1", "T2", "T4"]);

// Bug review independen (audit putaran-40, AUD40-P2-2; sibling dari
// AUD39-P2-2 di metacog): `arr.map(cb)` MELEWATI lubang (hole) pada array
// jarang (sparse) -- `cb` tidak pernah dipanggil untuk indeks kosong, jadi
// guard "elemen wajib objek" di dalam callback tidak pernah tereksekusi
// untuk lubang itu, dan lubangnya lolos tersimpan (serialize ke null).
// Loop indeks eksplisit mengunjungi SETIAP indeks (termasuk lubang, sebagai
// `undefined`) tanpa mengonsultasikan `Symbol.iterator` sama sekali --
// beda dengan `Array.from` (yang round-39 pakai di metacog), yang
// melempar TypeError mentah kalau `Symbol.iterator` ADA tapi bukan
// function (AUD40-ADV-1). Dipakai di semua situs elemen-array lintas lane
// (worldmodel, goals) untuk paritas dan menghindari kelas AUD40-ADV-1.
// Bug review independen (audit putaran-41, AUD41-P2-2, regresi
// diperkenalkan kandidat putaran-40): loop di atas dulu membaca
// `arr.length` di KONDISI loop -- dievaluasi ULANG setiap iterasi. Proxy
// dengan getter `length` yang TERUS BERTAMBAH membuat loop TIDAK PERNAH
// berhenti (DoS). Situs pemanggil di berkas ini sudah aman (dilewati
// `.slice()` dulu, memaksa salinan array polos), tapi diperbaiki di sini
// juga demi paritas dan menutup kelas ini permanen di helper bersama.
// `length` sekarang di-cache SEKALI ke lokal.
// Bug review independen (audit putaran-42, W7R42-P2-2/W7R42-ADV-1): `len`
// di-cache tapi tidak pernah divalidasi -- Proxy dengan getter `length`
// yang mengembalikan `Infinity` membuat loop TIDAK PERNAH berhenti (DoS).
// `length` sekarang divalidasi sebagai integer terhingga non-negatif dan
// dibatasi eksplisit sebelum loop dimulai.
// Bug review independen (audit putaran-43, W7R43-ADV-1): `65536` adalah
// konstanta arbitrer independen dari batas lane manapun -- dipakai kembali
// `BOUNDS.MAX_VALUE_ARRAY_LENGTH` (batas yang sudah dipakai buildSafeBeliefValue
// untuk array `value` di lane yang SAMA) supaya konsisten, bukan generik.
const MAX_SAFE_ARRAY_LENGTH = BOUNDS.MAX_VALUE_ARRAY_LENGTH;
function buildSafeArray(arr, mapFn) {
    // Bug review independen (audit putaran-53, AUD53-P2-1, sapuan
    // paritas): sibling dari goals/metacog's buildSafeArray -- kedua
    // pemanggil di file ini sudah `.slice()` lebih dulu, tapi helper
    // ITU SENDIRI tetap harus trap-safe supaya kelas ini tidak
    // terbuka lagi kalau ada pemanggil baru tanpa slice di masa depan.
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

function validateLabels(labels) {
    if (labels == null) return {};
    // Bug review independen (audit putaran-41, AUD41-P2-3): sebuah Proxy
    // yang sudah di-revoke melempar TypeError MENTAH pada `Object.keys`
    // (trap `ownKeys`), keluar dari `declareEntity` publik tanpa pernah
    // menjadi kesalahan domain. Dibungkus try/catch; kegagalan APA PUN di
    // sini diperlakukan sebagai penolakan tertutup.
    let keys;
    try {
        keys = Object.keys(labels);
    } catch {
        fail(REASONS.INVALID_RECORD, "labels tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (keys.length > BOUNDS.MAX_ENTITY_LABEL_KEYS) {
        fail(REASONS.BOUND_EXCEEDED, "jumlah label melebihi batas");
    }
    const out = {};
    for (const key of keys) {
        // Bug review independen (audit putaran-40, AUD40-ADV-2): `labels[key]`
        // adalah [[Get]] biasa -- accessor (getter) milik pemanggil
        // tereksekusi satu kali per kunci. Dibaca lewat
        // getOwnPropertyDescriptor (tidak pernah memanggil getter);
        // properti accessor diperlakukan sebagai absen (string kosong),
        // konsisten dengan perlakuan lenient nilai non-primitif di bawah.
        const desc = Object.getOwnPropertyDescriptor(labels, key);
        const raw = (desc && !desc.get && !desc.set) ? desc.value : undefined;
        // Bug review independen (audit putaran-28, AUD28-P2-7): `String(x)`
        // mentah mengeksekusi toString hostile milik pemanggil untuk objek,
        // dan meledakkan TypeError mentah untuk Symbol. Nilai label bukan
        // primitif aman diperlakukan sebagai string kosong (perilaku sama
        // lenient seperti null/undefined yang sudah ada), bukan crash.
        const safeRaw = (raw === undefined || raw === null || typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean")
            ? (raw ?? "") : "";
        const value = String(safeRaw).slice(0, BOUNDS.MAX_ENTITY_LABEL_CHARS);
        out[key.slice(0, 128)] = value;
    }
    return Object.freeze(out);
}

function makeEntity({ entityId, entityKind, labels, externalRefs = [], source, nowMs }) {
    if (typeof entityId !== "string" || !entityId) fail(REASONS.INVALID_RECORD, "entityId wajib string");
    if (typeof entityKind !== "string" || !entityKind) fail(REASONS.INVALID_RECORD, "entityKind wajib string");
    if (typeof source !== "string" || !source) fail(REASONS.INVALID_RECORD, "source wajib string (untuk kuota WM-A6)");
    // Bug review independen (audit putaran-21, AUD21-P2-1): round-20 menjaga
    // ELEMEN externalRefs tapi bukan KONTAINERNYA -- `externalRefs: 42` atau
    // string masih meledakkan `.slice(...).map(...)` jadi TypeError mentah.
    // Bug review independen (audit putaran-42, W7R42-P2-3): sebuah Proxy
    // yang sudah di-revoke melempar TypeError MENTAH pada `Array.isArray`
    // maupun `.slice()` -- keduanya dibungkus try/catch supaya kegagalan
    // APA PUN di sini gagal tertutup, bukan crash keluar dari API publik ini.
    let safeExternalRefs;
    if (externalRefs === undefined || externalRefs === null) {
        safeExternalRefs = [];
    } else {
        let isRefsArray;
        try {
            isRefsArray = Array.isArray(externalRefs);
        } catch {
            fail(REASONS.INVALID_RECORD, "externalRefs tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (!isRefsArray) fail(REASONS.INVALID_RECORD, "externalRefs wajib array");
        try {
            safeExternalRefs = externalRefs.slice(0, 32);
        } catch {
            fail(REASONS.INVALID_RECORD, "externalRefs tidak dapat diiris dengan aman, ditolak");
        }
    }

    return Object.freeze({
        entityId, entityKind: entityKind.slice(0, 64),
        labels: validateLabels(labels),
        firstSeenAt: nowMs, lastSeenAt: nowMs,
        // Bug review independen (audit putaran-20, AUD20-P2-2): elemen
        // externalRefs tidak dijaga -- elemen `null` meledakkan `r.system`
        // jadi TypeError mentah alih-alih INVALID_RECORD.
        externalRefs: Object.freeze(buildSafeArray(safeExternalRefs, r => {
            if (!r || typeof r !== "object") fail(REASONS.INVALID_RECORD, "externalRefs elemen wajib objek");
            // Bug review independen (audit putaran-28, AUD28-P2-7;
            // putaran-35, AUD35-P2-3): `String(r.system)`/`String(r.id)`
            // mentah mengeksekusi toString hostile milik pemanggil, dan
            // meledakkan TypeError mentah untuk Symbol -- perbaikan
            // putaran-28 menutup itu tapi `r.system`/`r.id` masih dibaca
            // TIGA KALI (typeof, truthy, `.slice()`) -- getter stateful
            // bisa lolos guard dengan string sah lalu membalas Symbol/
            // BigInt pada baca berikutnya, tetap meledakkan mentah.
            // Dikeluarkan sekali lewat destructuring.
            // Bug review independen (audit putaran-45, W7R45-P2-3): `r`
            // adalah ELEMEN array milik pemanggil -- round-21/42 menjaga
            // KONTAINER externalRefs, tapi setiap ELEMEN di dalamnya masih
            // didestrukturisasi mentah di sini.
            let system, id;
            try {
                ({ system, id } = r);
            } catch {
                fail(REASONS.INVALID_RECORD, "externalRefs elemen tidak dapat diverifikasi dengan aman, ditolak");
            }
            if (typeof system !== "string" || !system) fail(REASONS.INVALID_RECORD, "externalRefs[].system wajib string");
            if (typeof id !== "string" || !id) fail(REASONS.INVALID_RECORD, "externalRefs[].id wajib string");
            return Object.freeze({ system: system.slice(0, 64), id: id.slice(0, 200) });
        })),
        source
    });
}

function makeRelation({ relationId, kind, from, to, directed = true, strength = 0.5 }) {
    if (typeof relationId !== "string" || !relationId) fail(REASONS.INVALID_RECORD, "relationId wajib string");
    if (typeof from !== "string" || typeof to !== "string") fail(REASONS.INVALID_RECORD, "from/to wajib entityId string");
    // Bug review independen (audit putaran-28, AUD28-P2-3/AUD28-P2-7):
    // `String(kind)`/`Number(strength)` mentah -- objek hostile dengan
    // toString/valueOf tereksekusi, Symbol meledakkan TypeError mentah
    // SEBELUM sempat ditolak sebagai domain error.
    if (typeof kind !== "string" || !kind) fail(REASONS.INVALID_RECORD, "kind wajib string");
    if (typeof strength !== "number" && typeof strength !== "string" && typeof strength !== "boolean") {
        fail(REASONS.INVALID_RECORD, "strength wajib angka");
    }
    return Object.freeze({
        relationId, kind: kind.slice(0, 64), from, to,
        directed: Boolean(directed), strength: clamp01(Number(strength))
    });
}

/** W-2/W-3: tier admissible, sensor.sensorId + observedAt wajib ada. */
function makeObservation({ observationId, subject, attribute, value, sensor, frame = null, tier, observedAt }) {
    if (typeof observationId !== "string" || !observationId) fail(REASONS.INVALID_RECORD, "observationId wajib string");
    // Bug review independen (audit putaran-32, AUD32-P2-3): `subject.entityId`/
    // `subject.relationId` sebelumnya divalidasi lewat `subject.entityId`/
    // `.relationId` lalu subjek TERSIMPAN datang dari `{...subject}` (baca
    // KEDUA) -- getter stateful bisa lolos validasi dengan entityId yang sah
    // lalu menyimpan subjek lain (mis. undefined), melewati guard
    // UNKNOWN_ENTITY (W-3) dan membuat observasi jatuh ke kunci belief
    // sentinel "invalid:malformed-subject". Destructure SEKALI di sini.
    // Bug review independen (audit putaran-38, AUD38-P2-1): destructuring
    // `entityId`/`relationId` di atas membaca KEDUANYA tanpa syarat --
    // getter relationId pemanggil tereksekusi bahkan ketika entityId
    // sudah valid, dan tidak seperti makeHypothesis/ingestDeclaration
    // (yang sudah disaring lewat buildSafeBeliefValue sebelum divalidasi),
    // subject di sini masih dibaca lewat [[Get]] biasa milik pemanggil.
    // Disaring SEKALI lewat buildSafeBeliefValue lebih dulu (menolak
    // accessor lewat descriptor TANPA memanggilnya), lalu entityId/
    // relationId diturunkan dari salinan aman itu dengan short-circuit
    // (relationId hanya dibaca kalau entityId terbukti bukan string).
    if (!subject) fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
    const safeSubject = buildSafeBeliefValue(subject);
    const validEntity = typeof safeSubject?.entityId === "string";
    if (!validEntity && typeof safeSubject?.relationId !== "string") {
        fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
    }
    if (typeof attribute !== "string" || !attribute) fail(REASONS.INVALID_RECORD, "attribute wajib string");

    if (tier === "SIMULATION") {
        fail(REASONS.SIMULATION_NOT_ADMISSIBLE, "rekaman simulasi ditolak di ingest (W-2)");
    }
    if (!ADMISSIBLE_TIERS.has(tier)) {
        // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
        // `${tier}` mentah meledakkan TypeError untuk Symbol.
        fail(REASONS.INADMISSIBLE_TIER, `tier '${typeof tier === "string" ? tier : typeof tier}' tidak admissible untuk ingest (hanya T1/T2/T4)`);
    }
    // Bug review independen (audit putaran-35, AUD35-ADV-5): `sensor`/
    // `frame`'s field masing-masing dibaca berkali-kali (guard tipe, lalu
    // `String()` di konstruksi) -- latent hari ini (record observasi ini
    // transit, tidak durabel sendiri), tapi paritas dengan sanitizer lane
    // lain. Dikeluarkan sekali lewat destructuring.
    // Bug review independen (audit putaran-45, W7R45-P2-4): `sensor`/
    // `frame` adalah nilai bersarang milik pemanggil -- `?? {}` hanya
    // melindungi null/undefined, bukan Proxy yang di-revoke (tetap truthy).
    let sensorId, modality, calibrationRef, frameKind, frameRef;
    try {
        ({ sensorId, modality, calibrationRef } = sensor ?? {});
    } catch {
        fail(REASONS.MISSING_SENSOR_ID, "sensor tidak dapat diverifikasi dengan aman, ditolak");
    }
    try {
        ({ kind: frameKind, ref: frameRef } = frame ?? {});
    } catch {
        fail(REASONS.INVALID_RECORD, "frame tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!sensor || typeof sensorId !== "string" || !sensorId) {
        fail(REASONS.MISSING_SENSOR_ID, "sensor.sensorId wajib ada (W-3)");
    }
    if (typeof observedAt !== "string" || !observedAt || !Number.isFinite(Date.parse(observedAt))) {
        // Bug review independen (Codex putaran-5): string tak-tanggal lolos cek
        // "ada"-saja lalu diam-diam diperlakukan sebagai now() oleh index.js.
        fail(REASONS.MISSING_SENSOR_ID, "observedAt wajib tanggal ISO yang sah (W-3)");
    }

    return Object.freeze({
        observationId, subject: safeSubject,
        // Bug review independen (audit putaran-4, W7R4-P2-1; disempurnakan
        // putaran-5, W7R5-P1-2): validasi/salin `value` TIDAK dilakukan di
        // sini lagi -- applyRevision (beliefAlgebra.js, satu-satunya tempat
        // belief lahir/berevolusi) sudah memanggil buildSafeBeliefValue
        // sekali untuk SEMUA jalur (observasi maupun deklarasi). Memanggilnya
        // di sini JUGA berarti dua kali kerja penuh per observasi -- tidak
        // salah lagi sejak anggaran node ditambahkan, tapi tetap boros.
        // `value` di record observasi ini murni transit, belum aman dipakai
        // sendiri sampai applyRevision memprosesnya.
        attribute, value,
        // Bug review independen (audit putaran-28, AUD28-P2-7): `String(x)`
        // mentah pada field opsional ini mengeksekusi toString hostile milik
        // pemanggil untuk objek, dan meledakkan TypeError mentah untuk
        // Symbol. Field bukan primitif aman diperlakukan sebagai absen
        // (null), konsisten dengan perilaku falsy->null yang sudah ada.
        sensor: Object.freeze({
            sensorId,
            modality: (typeof modality === "string" || typeof modality === "number") ? String(modality).slice(0, 64) : null,
            calibrationRef: (typeof calibrationRef === "string" || typeof calibrationRef === "number") ? String(calibrationRef).slice(0, 200) : null
        }),
        frame: frame ? Object.freeze({
            kind: (typeof frameKind === "string" || typeof frameKind === "number") ? String(frameKind).slice(0, 32) : "",
            ref: (typeof frameRef === "string" || typeof frameRef === "number") ? String(frameRef).slice(0, 200) : ""
        }) : null,
        tier, observedAt
    });
}

function makeHypothesis({ hypothesisId, subject, attribute, candidateValues, discriminatingProbe = null, expiresAt }) {
    if (typeof hypothesisId !== "string" || !hypothesisId) fail(REASONS.INVALID_RECORD, "hypothesisId wajib string");
    // Bug review independen (audit putaran-23, AUD23-ADV-1): sibling
    // makeObservation memvalidasi subject wajib { entityId } atau
    // { relationId }; makeHypothesis tidak pernah, jadi subject:null lolos
    // tersimpan dan bisa bertabrakan kunci dengan hipotesis lain.
    // Bug review independen (audit putaran-35, AUD35-ADV-6; putaran-36,
    // AUD36-ADV-1): guard dulu membaca `subject.entityId`/`.relationId`
    // lewat [[Get]] biasa (trap `get` untuk Proxy) SEBELUM
    // buildSafeBeliefValue (trap `getOwnPropertyDescriptor`) sempat
    // memprosesnya -- Proxy yang membuat kedua trap tidak konsisten bisa
    // lolos guard dengan entityId yang TERLIHAT sah padahal bentuk yang
    // BENAR-BENAR tersimpan tidak sah (kelas yang sama dengan AUD36-P2-1
    // di ingestDeclaration). Disaring SEKALI di sini; guard DAN
    // penyimpanan di bawah memakai bentuk tersanitasi yang SAMA (bukan
    // `subject` mentah lagi). `relationId` hanya dibaca kalau `entityId`
    // terbukti bukan string (short-circuit, kelas AUD36-P2-2).
    const safeSubject = buildSafeBeliefValue(subject);
    const entityId = safeSubject?.entityId;
    const validEntity = typeof entityId === "string";
    const relationId = validEntity ? undefined : safeSubject?.relationId;
    if (!safeSubject || (!validEntity && typeof relationId !== "string")) {
        fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
    }
    // Bug review independen (audit putaran-42, W7R42-P2-3): sebuah Proxy
    // yang sudah di-revoke melempar TypeError MENTAH pada `Array.isArray`,
    // `.length`, maupun `.slice()` -- ketiganya dibungkus try/catch supaya
    // kegagalan APA PUN di sini gagal tertutup, bukan crash keluar dari
    // API publik ini.
    let isCandArray;
    try {
        isCandArray = Array.isArray(candidateValues);
    } catch {
        fail(REASONS.INVALID_RECORD, "candidateValues tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!isCandArray) fail(REASONS.INVALID_RECORD, "candidateValues wajib array tidak kosong");
    let candidateValuesLen;
    try {
        candidateValuesLen = candidateValues.length;
    } catch {
        fail(REASONS.INVALID_RECORD, "candidateValues tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!Number.isInteger(candidateValuesLen) || candidateValuesLen === 0) {
        fail(REASONS.INVALID_RECORD, "candidateValues wajib array tidak kosong");
    }
    let safeCandidateValues;
    try {
        safeCandidateValues = candidateValues.slice(0, 16);
    } catch {
        fail(REASONS.INVALID_RECORD, "candidateValues tidak dapat diiris dengan aman, ditolak");
    }
    // Proaktif (sapuan lengkap kelas AUD11/AUD12-P2, sebelum ditemukan
    // auditor independen sebagai finding terpisah): expiresAt diteruskan
    // mentah tanpa disaring -- BigInt di dalamnya meledakkan JSON.stringify
    // saat persist(), dan declareHypothesis's compaction (index.js) memakai
    // Date.parse(expiresAt) untuk mengurutkan korban kadaluwarsa.
    if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
        fail(REASONS.INVALID_RECORD, "expiresAt wajib tanggal ISO string yang sah");
    }
    // Bug review independen (audit putaran-13, AUD13-P2-1): perbaikan
    // proaktif sebelumnya menyaring `expiresAt` di fungsi yang SAMA tapi
    // melewatkan `attribute` -- BigInt di dalamnya meledakkan
    // JSON.stringify saat persist(), objek non-string mengumpulkan hipotesis
    // berbeda ke satu kunci yang sama.
    if (typeof attribute !== "string" || !attribute) fail(REASONS.INVALID_RECORD, "attribute wajib string");
    // Bug review independen (audit putaran-5, W7R5-P1-1): candidateValues[].value,
    // discriminatingProbe, dan subject dulu disimpan APA ADANYA -- lewat
    // referensi mentah, toJSON pemanggil bisa tereksekusi saat serialisasi
    // (mis. persist()) dan mutasi pasca-deklarasi menulis ulang hipotesis
    // tersimpan. Sekarang lewat buildSafeBeliefValue yang sama.
    return Object.freeze({
        hypothesisId, subject: safeSubject, attribute,
        // Bug review independen (audit putaran-20, AUD20-P2-2): elemen
        // candidateValues tidak dijaga -- elemen `null` meledakkan `c.value`
        // jadi TypeError mentah alih-alih INVALID_RECORD.
        candidateValues: Object.freeze(buildSafeArray(safeCandidateValues, c => {
            if (!c || typeof c !== "object") fail(REASONS.INVALID_RECORD, "candidateValues elemen wajib objek");
            // Bug review independen (audit putaran-28, AUD28-P2-3; putaran-35,
            // AUD35-P2-4): `Number(c.weight)` mentah meledakkan TypeError
            // untuk Symbol dan mengeksekusi valueOf hostile untuk objek --
            // perbaikan putaran-28 menutup itu tapi `c.weight` masih dibaca
            // DUA KALI (guard tipe, lalu `Number()` di konstruksi) -- getter
            // stateful bisa lolos guard dengan angka sah lalu membalas
            // Symbol pada baca berikutnya, tetap meledakkan mentah. Dibaca
            // SEKALI ke lokal.
            // Bug review independen (audit putaran-46, W7R46-P2-1): sibling
            // langsung dari externalRefs elemen (putaran-45, W7R45-P2-3, di
            // FILE yang sama) -- candidateValues elemen tidak pernah disapu.
            let weight, value;
            try {
                ({ weight, value } = c);
            } catch {
                fail(REASONS.INVALID_RECORD, "candidateValues elemen tidak dapat diverifikasi dengan aman, ditolak");
            }
            if (typeof weight !== "number" && typeof weight !== "string" && typeof weight !== "boolean" && weight !== undefined) {
                fail(REASONS.INVALID_RECORD, "candidateValues[].weight wajib angka");
            }
            return Object.freeze({ value: buildSafeBeliefValue(value), weight: clamp01(Number(weight)) });
        })),
        discriminatingProbe: buildSafeBeliefValue(discriminatingProbe), expiresAt
    });
}

module.exports = { ADMISSIBLE_TIERS, makeEntity, makeRelation, makeObservation, makeHypothesis };
