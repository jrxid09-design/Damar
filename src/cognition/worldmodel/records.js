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
        const value = String(labels[key] ?? "").slice(0, BOUNDS.MAX_ENTITY_LABEL_CHARS);
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
                return Object.freeze({ system: String(r.system).slice(0, 64), id: String(r.id).slice(0, 200) });
            })),
        source
    });
}

function makeRelation({ relationId, kind, from, to, directed = true, strength = 0.5 }) {
    if (typeof relationId !== "string" || !relationId) fail(REASONS.INVALID_RECORD, "relationId wajib string");
    if (typeof from !== "string" || typeof to !== "string") fail(REASONS.INVALID_RECORD, "from/to wajib entityId string");
    return Object.freeze({
        relationId, kind: String(kind).slice(0, 64), from, to,
        directed: Boolean(directed), strength: clamp01(Number(strength))
    });
}

/** W-2/W-3: tier admissible, sensor.sensorId + observedAt wajib ada. */
function makeObservation({ observationId, subject, attribute, value, sensor, frame = null, tier, observedAt }) {
    if (typeof observationId !== "string" || !observationId) fail(REASONS.INVALID_RECORD, "observationId wajib string");
    if (!subject || (typeof subject.entityId !== "string" && typeof subject.relationId !== "string")) {
        fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
    }
    if (typeof attribute !== "string" || !attribute) fail(REASONS.INVALID_RECORD, "attribute wajib string");

    if (tier === "SIMULATION") {
        fail(REASONS.SIMULATION_NOT_ADMISSIBLE, "rekaman simulasi ditolak di ingest (W-2)");
    }
    if (!ADMISSIBLE_TIERS.has(tier)) {
        fail(REASONS.INADMISSIBLE_TIER, `tier '${tier}' tidak admissible untuk ingest (hanya T1/T2/T4)`);
    }
    if (!sensor || typeof sensor.sensorId !== "string" || !sensor.sensorId) {
        fail(REASONS.MISSING_SENSOR_ID, "sensor.sensorId wajib ada (W-3)");
    }
    if (typeof observedAt !== "string" || !observedAt || !Number.isFinite(Date.parse(observedAt))) {
        // Bug review independen (Codex putaran-5): string tak-tanggal lolos cek
        // "ada"-saja lalu diam-diam diperlakukan sebagai now() oleh index.js.
        fail(REASONS.MISSING_SENSOR_ID, "observedAt wajib tanggal ISO yang sah (W-3)");
    }

    return Object.freeze({
        observationId, subject: Object.freeze({ ...subject }),
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
        sensor: Object.freeze({
            sensorId: sensor.sensorId,
            modality: sensor.modality ? String(sensor.modality).slice(0, 64) : null,
            calibrationRef: sensor.calibrationRef ? String(sensor.calibrationRef).slice(0, 200) : null
        }),
        frame: frame ? Object.freeze({ kind: String(frame.kind).slice(0, 32), ref: String(frame.ref).slice(0, 200) }) : null,
        tier, observedAt
    });
}

function makeHypothesis({ hypothesisId, subject, attribute, candidateValues, discriminatingProbe = null, expiresAt }) {
    if (typeof hypothesisId !== "string" || !hypothesisId) fail(REASONS.INVALID_RECORD, "hypothesisId wajib string");
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
            return Object.freeze({ value: buildSafeBeliefValue(c.value), weight: clamp01(Number(c.weight)) });
        })),
        discriminatingProbe: buildSafeBeliefValue(discriminatingProbe), expiresAt
    });
}

module.exports = { ADMISSIBLE_TIERS, makeEntity, makeRelation, makeObservation, makeHypothesis };
