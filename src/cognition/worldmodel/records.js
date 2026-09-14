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

function validateLabels(labels) {
    if (labels == null) return {};
    const keys = Object.keys(labels);
    if (keys.length > BOUNDS.MAX_ENTITY_LABEL_KEYS) {
        fail(REASONS.BOUND_EXCEEDED, "jumlah label melebihi batas");
    }
    const out = {};
    for (const key of keys) {
        const raw = labels[key];
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
    if (externalRefs !== undefined && externalRefs !== null && !Array.isArray(externalRefs)) {
        fail(REASONS.INVALID_RECORD, "externalRefs wajib array");
    }

    return Object.freeze({
        entityId, entityKind: entityKind.slice(0, 64),
        labels: validateLabels(labels),
        firstSeenAt: nowMs, lastSeenAt: nowMs,
        // Bug review independen (audit putaran-20, AUD20-P2-2): elemen
        // externalRefs tidak dijaga -- elemen `null` meledakkan `r.system`
        // jadi TypeError mentah alih-alih INVALID_RECORD.
        externalRefs: Object.freeze((externalRefs ?? []).slice(0, 32)
            .map(r => {
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
                const { system, id } = r;
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
    if (!subject) fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
    const { entityId, relationId, ...subjectRest } = subject;
    if (typeof entityId !== "string" && typeof relationId !== "string") {
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
    const { sensorId, modality, calibrationRef } = sensor ?? {};
    const { kind: frameKind, ref: frameRef } = frame ?? {};
    if (!sensor || typeof sensorId !== "string" || !sensorId) {
        fail(REASONS.MISSING_SENSOR_ID, "sensor.sensorId wajib ada (W-3)");
    }
    if (typeof observedAt !== "string" || !observedAt || !Number.isFinite(Date.parse(observedAt))) {
        // Bug review independen (Codex putaran-5): string tak-tanggal lolos cek
        // "ada"-saja lalu diam-diam diperlakukan sebagai now() oleh index.js.
        fail(REASONS.MISSING_SENSOR_ID, "observedAt wajib tanggal ISO yang sah (W-3)");
    }

    return Object.freeze({
        observationId, subject: Object.freeze({ ...subjectRest, entityId, relationId }),
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
    // Bug review independen (audit putaran-35, AUD35-ADV-6): `subject.entityId`/
    // `.relationId` dibaca langsung di sini SEBELUM buildSafeBeliefValue
    // (yang menolak accessor lewat descriptor) sempat memproses subject --
    // getter pemanggil tetap terpanggil satu kali sebelum ditolak tertutup.
    // Dibaca lewat destructuring SEKALI, dipakai untuk guard SAJA; subject
    // asli tetap diteruskan ke buildSafeBeliefValue seperti sebelumnya.
    const { entityId, relationId } = subject ?? {};
    if (!subject || (typeof entityId !== "string" && typeof relationId !== "string")) {
        fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
    }
    if (!Array.isArray(candidateValues) || candidateValues.length === 0) {
        fail(REASONS.INVALID_RECORD, "candidateValues wajib array tidak kosong");
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
        hypothesisId, subject: buildSafeBeliefValue(subject), attribute,
        // Bug review independen (audit putaran-20, AUD20-P2-2): elemen
        // candidateValues tidak dijaga -- elemen `null` meledakkan `c.value`
        // jadi TypeError mentah alih-alih INVALID_RECORD.
        candidateValues: Object.freeze(candidateValues.slice(0, 16).map(c => {
            if (!c || typeof c !== "object") fail(REASONS.INVALID_RECORD, "candidateValues elemen wajib objek");
            // Bug review independen (audit putaran-28, AUD28-P2-3; putaran-35,
            // AUD35-P2-4): `Number(c.weight)` mentah meledakkan TypeError
            // untuk Symbol dan mengeksekusi valueOf hostile untuk objek --
            // perbaikan putaran-28 menutup itu tapi `c.weight` masih dibaca
            // DUA KALI (guard tipe, lalu `Number()` di konstruksi) -- getter
            // stateful bisa lolos guard dengan angka sah lalu membalas
            // Symbol pada baca berikutnya, tetap meledakkan mentah. Dibaca
            // SEKALI ke lokal.
            const { weight, value } = c;
            if (typeof weight !== "number" && typeof weight !== "string" && typeof weight !== "boolean" && weight !== undefined) {
                fail(REASONS.INVALID_RECORD, "candidateValues[].weight wajib angka");
            }
            return Object.freeze({ value: buildSafeBeliefValue(value), weight: clamp01(Number(weight)) });
        })),
        discriminatingProbe: buildSafeBeliefValue(discriminatingProbe), expiresAt
    });
}

module.exports = { ADMISSIBLE_TIERS, makeEntity, makeRelation, makeObservation, makeHypothesis };
