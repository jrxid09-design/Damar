/**
 * Sensorium — amplop event (B§5).
 *
 * Sensorium adalah lapisan indrawi: ia MELIHAT, bukan MEMUTUSKAN.
 * Semua perubahan state tubuh mengalir sebagai event dengan:
 *   - identitas event stabil (eventId)
 *   - timestamp + monotonic (jam dapat disuntik)
 *   - sumber/provenance terdaftar
 *   - subjek deviceId kanonik
 *   - payload ternormalisasi dan beku
 *
 * GAGAL-TUTUP: tipe/provenance/subjek yang tidak dikenal ditolak saat
 * konstruksi — event cacat tidak akan pernah sampai ke reducer.
 */

const crypto = require("node:crypto");
const { deepFreeze, structuredCopy, clamp01, fail } = require("../core/util");
const { validateDeviceId } = require("../core/identity");

const SCHEMA_VERSION = 1;

/** Sumber turunan internal sensorium — satu-satunya produsen event inti. */
const CORE_SOURCE = "sensorium.core";

const PROVENANCES = Object.freeze([
    "SYSTEM_SENSOR", "OBSERVATION", "EXTERNAL_SOURCE", "SYSTEM_EVENT"
].reduce((m, p) => (m[p] = p, m), {}));

/**
 * Tipe event tertutup. producerClass:
 *   "adapter" — hanya discovery adapter terdaftar yang boleh memproduksi
 *   "core"    — hanya sensorium.core (turunan/kebijakan operator)
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

    // Turunan — TIDAK boleh diproduksi adapter eksternal:
    DEVICE_DEFAULT_CHANGED: { producerClass: "core" },
    UNKNOWN_DEVICE_REQUIRES_ANALYSIS: { producerClass: "core" }
});

function isKnownEventType(type) {
    return Object.prototype.hasOwnProperty.call(EVENT_TYPES, type);
}

let seqCounter = 0;

/**
 * Amplop event sensorium. Melempar (gagal-tutup) untuk input kotor;
 * sisi ingest BodySchema menangkap penolakan ini secara diagnostik.
 */
function makeEvent({
    type, source, provenance, subject,
    payload = {}, confidence = 1, clock = null
} = {}) {

    if (!isKnownEventType(type)) {
        throw fail("EMB_UNKNOWN_EVENT_TYPE",
            `tipe event tidak terdaftar: '${type}'`);
    }
    if (!PROVENANCES[provenance]) {
        throw fail("EMB_UNKNOWN_PROVENANCE",
            `provenance tidak sah: '${provenance}'`);
    }
    if (typeof source !== "string" || source.length === 0 || source.length > 120) {
        throw fail("EMB_INVALID_SOURCE", "sumber event wajib string 1..120");
    }
    if (!validateDeviceId(subject)) {
        throw fail("EMB_INVALID_SUBJECT",
            `subjek event bukan deviceId kanonik: '${String(subject).slice(0, 60)}'`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw fail("EMB_INVALID_PAYLOAD", "payload wajib objek");
    }

    const nowMs = clock ? clock.nowMs() : Date.now();

    return Object.freeze({
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
    });
}

/**
 * Pemeriksaan bentuk non-meletup untuk sisi ingest. Event dari dunia
 * luar (jurnal, antrean, restore) bisa saja korup; ingest harus bisa
 * MENOLAK tanpa menghentikan proses.
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
    SCHEMA_VERSION, CORE_SOURCE, PROVENANCES, EVENT_TYPES,
    isKnownEventType, makeEvent, validateEventShape
};
