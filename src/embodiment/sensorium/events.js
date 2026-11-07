/**
 * Sensorium — amplop event (B§5, revisi v1).
 *
 * GAGAL-TUTUP: tipe/provenance/subjek/sumber yang tidak dikenal ditolak
 * saat konstruksi maupun pemeriksaan bentuk.
 *
 * PERLINDUNGAN EVENT INTI: tipe kelas "core" tidak bisa dibuat lewat
 * makeEvent() publik sama sekali. Satu-satunya jalan adalah
 * makeCoreEvent() — pabrik INTERNAL yang membubuhkan CORE_TOKEN, simbol
 * privat modul ini (tidak diekspor lewat pintu publik embodiment).
 * ingest() menolak event inti tanpa token: penyamaan string
 * "sensorium.core" saja tidak pernah cukup untuk memalsukan kepercayaan.
 */

const crypto = require("node:crypto");
const { deepFreeze, structuredCopy, clamp01, fail } = require("../core/util");
const { validateDeviceId } = require("../core/identity");

const SCHEMA_VERSION = 1;

/** Sumber turunan internal sensorium — satu-satunya produsen event inti. */
const CORE_SOURCE = "sensorium.core";

/**
 * Token kapabilitas inti — simbol PRIVAT modul. Sengaja TIDAK diekspor
 * dari src/embodiment/index.js; objek eksternal tidak mungkin memilikinya.
 */
const CORE_TOKEN = Symbol("embodiment.sensorium.core");

const PROVENANCES = Object.freeze([
    "SYSTEM_SENSOR", "OBSERVATION", "EXTERNAL_SOURCE", "SYSTEM_EVENT"
].reduce((m, p) => (m[p] = p, m), {}));

/** Provenance cadangan jalur inti — adapter eksternal tidak boleh memakai. */
const RESERVED_PROVENANCES = Object.freeze(new Set(["SYSTEM_EVENT"]));

/**
 * Tipe event tertutup. producerClass:
 *   "adapter" — hanya discovery adapter terdaftar yang boleh memproduksi
 *   "core"    — hanya sensorium.core bertoken (turunan/kebijakan operator)
 */
const EVENT_TYPES = Object.freeze({
    DEVICE_DISCOVERED: { producerClass: "adapter" },
    DEVICE_REMOVED: { producerClass: "adapter" },
    DEVICE_CHANGED: { producerClass: "adapter" },
    DEVICE_ONLINE: { producerClass: "adapter" },
    DEVICE_OFFLINE: { producerClass: "adapter" },
    DEVICE_HEALTH_CHANGED: { producerClass: "adapter" },
    CAPABILITY_DISCOVERED: { producerClass: "adapter" },
    SENSOR_OBSERVATION: { producerClass: "adapter" },

    // Turunan — TIDAK bisa dikonstruksi dari luar modul:
    DEVICE_DEFAULT_CHANGED: { producerClass: "core" },
    UNKNOWN_DEVICE_REQUIRES_ANALYSIS: { producerClass: "core" }
});

function isKnownEventType(type) {
    return Object.prototype.hasOwnProperty.call(EVENT_TYPES, type);
}

let seqCounter = 0;

function commonValidation({ type, source, provenance, subject, payload }) {

    if (!isKnownEventType(type)) {
        throw fail("EMB_UNKNOWN_EVENT_TYPE",
            `tipe event tidak terdaftar: '${type}'`);
    }
    if (!PROVENANCES[provenance]) {
        throw fail("EMB_UNKNOWN_PROVENANCE",
            `provenance tidak sah: '${provenance}'`);
    }
    if (typeof source !== "string" || !/^[^\s]{1,120}$/.test(source)) {
        throw fail("EMB_INVALID_SOURCE",
            "sumber event wajib string 1..120 tanpa spasi");
    }
    if (!validateDeviceId(subject)) {
        throw fail("EMB_INVALID_SUBJECT",
            `subjek event bukan deviceId kanonik: '${String(subject).slice(0, 60)}'`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw fail("EMB_INVALID_PAYLOAD", "payload wajib objek");
    }
}

function buildEnvelope({
    type, source, provenance, subject, payload = {}, confidence = 1, clock = null,
    core = false
}) {

    commonValidation({ type, source, provenance, subject, payload });

    if (!core && EVENT_TYPES[type].producerClass === "core") {
        // Pintu publik tidak pernah bisa menciptakan event inti.
        throw fail("EMB_CORE_EVENT_PROTECTED",
            `tipe '${type}' hanya dapat diproduksi jalur internal sensorium`);
    }

    const nowMs = clock ? clock.nowMs() : Date.now();

    const envelope = {
        eventId: crypto.randomUUID(),
        schemaVersion: SCHEMA_VERSION,
        type,
        timestamp: new Date(nowMs).toISOString(),
        timestampMs: nowMs,
        monotonic: ++seqCounter,
        source: String(source).slice(0, 120),
        provenance,
        subject,
        confidence: clamp01(confidence),
        payload: deepFreeze(structuredCopy(payload))
    };

    return Object.freeze(
        core ? { ...envelope, [CORE_TOKEN]: CORE_TOKEN } : envelope);
}

/** Amplop event adapter/publik. Melempar (gagal-tutup) pada input kotor. */
function makeEvent(options) {
    return buildEnvelope(options);
}

/**
 * Pabrik event inti — INTERNAL saja (tidak diekspor lewat pintu publik
 * embodiment). Membubuhkan CORE_TOKEN yang tak-dapat-dipalsukan objek
 * luar; ingest menolak event inti tanpa token ini.
 */
function makeCoreEvent({ type, subject, payload, clock }) {
    return buildEnvelope({
        type, source: CORE_SOURCE, provenance: "SYSTEM_EVENT",
        subject, payload, confidence: 1, clock, core: true
    });
}

/**
 * Pemeriksaan bentuk non-meletup untuk sisi ingest. Event dari dunia
 * luar (jurnal, antrean, pemanggil asing) bisa korup/dipalsukan;
 * ingest harus bisa MENOLAK tanpa menghentikan proses.
 */
function validateEventShape(event) {
    if (!event || typeof event !== "object") {
        return { ok: false, reason: "event-bukan-objek" };
    }
    for (const field of [
        "eventId", "schemaVersion", "type", "timestamp", "timestampMs",
        "monotonic", "source", "provenance", "subject", "confidence", "payload"
    ]) {
        if (!(field in event)) return { ok: false, reason: `field-hilang:${field}` };
    }
    if (!isKnownEventType(event.type)) {
        return { ok: false, reason: `tipe-tak-dikenal:${event.type}` };
    }
    if (!PROVENANCES[event.provenance]) {
        return { ok: false, reason: `provenance-tak-dikenal:${String(event.provenance)}` };
    }
    if (typeof event.source !== "string"
        || !/^[^\s]{1,120}$/.test(event.source)) {
        return { ok: false, reason: "sumber-tidak-sah" };
    }
    if (!validateDeviceId(event.subject)) {
        return { ok: false, reason: "subjek-tidak-sah" };
    }
    if (!Number.isInteger(event.monotonic) || !Number.isFinite(event.timestampMs)) {
        return { ok: false, reason: "urutan/waktu-tidak-sah" };
    }
    if (!Number.isFinite(Number(event.confidence))) {
        return { ok: false, reason: "confidence-tidak-sah" };
    }
    if (!event.payload || typeof event.payload !== "object") {
        return { ok: false, reason: "payload-tidak-sah" };
    }
    return { ok: true };
}

module.exports = {
    SCHEMA_VERSION, CORE_SOURCE, PROVENANCES, RESERVED_PROVENANCES,
    EVENT_TYPES, CORE_TOKEN,
    isKnownEventType, makeEvent, makeCoreEvent, validateEventShape
};
