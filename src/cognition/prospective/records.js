"use strict";

/** W7-L4 PROSPECTIVE MEMORY — pembangun record murni (spec §3). */

const { REASONS, fail } = require("./errors");
const { BOUNDS } = require("./bounds");

const WAKE_CLASSES = new Set(["NOTIFY_OWNER", "RESUME_GOAL", "CHECK_EXPECTATION", "MAINTENANCE"]);
const TRIGGER_KINDS = new Set(["AT", "AFTER", "RECURRING", "ON_STATE", "ON_EVENT"]);

/** PM-A3: recurrence tanpa batas ditolak — wajib until ATAU maxOccurrences, dan ada lantai periode. */
function validateTrigger(trigger) {
    if (!trigger || !TRIGGER_KINDS.has(trigger.kind)) {
        fail(REASONS.INVALID_TRIGGER, `trigger.kind '${trigger?.kind}' tidak dikenal`);
    }
    if (trigger.kind === "AT") {
        if (typeof trigger.at !== "string" || !Number.isFinite(Date.parse(trigger.at))) {
            fail(REASONS.INVALID_TRIGGER, "trigger AT wajib 'at' ISO string sah");
        }
    }
    if (trigger.kind === "AFTER") {
        if (!Number.isFinite(trigger.delayMs) || trigger.delayMs <= 0) {
            fail(REASONS.INVALID_TRIGGER, "trigger AFTER wajib delayMs > 0");
        }
    }
    if (trigger.kind === "RECURRING") {
        if (!Number.isFinite(trigger.intervalMs) || trigger.intervalMs < BOUNDS.MIN_RECURRENCE_INTERVAL_MS) {
            fail(REASONS.RECURRENCE_PERIOD_TOO_SHORT,
                `interval recurring di bawah lantai ${BOUNDS.MIN_RECURRENCE_INTERVAL_MS}ms`);
        }
        const hasUntil = typeof trigger.until === "string" && Number.isFinite(Date.parse(trigger.until));
        const hasMax = Number.isFinite(trigger.maxOccurrences) && trigger.maxOccurrences > 0;
        if (!hasUntil && !hasMax) {
            fail(REASONS.RECURRENCE_UNBOUNDED, "recurring wajib 'until' atau 'maxOccurrences'");
        }
        if (hasMax && trigger.maxOccurrences > BOUNDS.MAX_RECURRENCE_OCCURRENCES) {
            fail(REASONS.RECURRENCE_UNBOUNDED, `maxOccurrences melebihi batas (${BOUNDS.MAX_RECURRENCE_OCCURRENCES})`);
        }
    }
    if (trigger.kind === "ON_STATE" && (typeof trigger.subject !== "object" || typeof trigger.attribute !== "string")) {
        fail(REASONS.INVALID_TRIGGER, "trigger ON_STATE wajib subject/attribute");
    }
    if (trigger.kind === "ON_EVENT" && typeof trigger.eventKind !== "string") {
        fail(REASONS.INVALID_TRIGGER, "trigger ON_EVENT wajib eventKind");
    }
    return Object.freeze({ ...trigger });
}

const FORBIDDEN_PAYLOAD_KEYS = Object.freeze(["capabilityId", "actuatorRef", "authProof", "authorityDecision", "intentTemplate"]);

const MAX_PAYLOAD_SCAN_DEPTH = 16;

/**
 * PM-1, rekursif: field eksekusi/otoritas ditolak di kedalaman manapun,
 * DAN materi eksekusi (fungsi/toJSON/accessor) ditolak SEBELUM
 * JSON.stringify pernah dipanggil. Bug diketemukan review independen
 * (Codex, putaran ke-5): validatePayloadRef sebelumnya memanggil
 * JSON.stringify LEBIH DAHULU untuk cek ukuran — jika payloadRef punya
 * `toJSON` (fungsi apa pun), itu dieksekusi sebelum pagar ini sempat
 * menolaknya. Sekarang pagar ini SELALU berjalan dulu, dan fungsi apa pun
 * (termasuk toJSON) ditolak sama seperti kunci terlarang lainnya.
 */
function assertSafePayloadRef(value, depth = 0) {
    if (value === null || value === undefined) return;
    const t = typeof value;
    if (t === "function") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh membawa fungsi (termasuk toJSON)");
    if (t === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh membawa Symbol");
    if (t !== "object") return;
    if (depth > MAX_PAYLOAD_SCAN_DEPTH) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef terlalu dalam untuk diverifikasi dengan aman, ditolak");
    }
    // Bug review independen (Codex putaran-9): array jarang (mis. `new
    // Array(2**32-1)`) tidak punya kunci indeks OWN sama sekali, jadi lolos
    // pagar ini tanpa terdeteksi, lalu JSON.stringify mencoba memproses
    // tiap lubangnya SEBELUM cek ukuran 1KB sempat berjalan -- DoS memori/CPU.
    // Panjang array diperiksa eksplisit di sini, sebelum walk maupun stringify.
    if (Array.isArray(value) && value.length > BOUNDS.MAX_PAYLOAD_ARRAY_LENGTH) {
        fail(REASONS.PAYLOAD_TOO_LARGE, "panjang array pada payloadRef melebihi batas");
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh membawa kunci Symbol");
        if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `payloadRef tidak boleh membawa '${key}' (di kedalaman manapun)`);
        }
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `payloadRef tidak boleh membawa properti accessor: '${String(key)}'`);
        }
        assertSafePayloadRef(value[key], depth + 1);
    }
}

/** PM-1: payloadRef adalah REFERENSI saja — menolak materi eksekusi/fungsi. */
function validatePayloadRef(payloadRef) {
    if (payloadRef === null || payloadRef === undefined) return null;
    assertSafePayloadRef(payloadRef);
    const serialized = JSON.stringify(payloadRef);
    if (serialized === undefined) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak dapat diserialisasi");
    if (Buffer.byteLength(serialized) > BOUNDS.MAX_PAYLOAD_REF_BYTES) {
        fail(REASONS.PAYLOAD_TOO_LARGE, "payloadRef melebihi batas ukuran");
    }
    // Bug review independen (Codex putaran-9): panggilan ini menunjuk
    // fungsi yang tidak pernah ada lagi setelah PM-1 dipindah ke
    // assertSafePayloadRef (rekursif, sudah berjalan di atas) -- SETIAP
    // payloadRef non-null yang sah gagal dengan ReferenceError. Dihapus;
    // pemeriksaan kunci terlarang DI KEDALAMAN MANAPUN sudah dilakukan
    // assertSafePayloadRef sebelum baris ini.
    return JSON.parse(serialized);
}

function makeReminder({ reminderId, ownerRef = null, trigger, payloadRef = null, wakeClass, origin = { kind: "SELF" }, nowIso }) {
    if (typeof reminderId !== "string" || !reminderId) fail(REASONS.INVALID_RECORD, "reminderId wajib string");
    if (!WAKE_CLASSES.has(wakeClass)) fail(REASONS.INVALID_RECORD, `wakeClass '${wakeClass}' tidak dikenal`);

    return Object.freeze({
        reminderId, ownerRef,
        trigger: validateTrigger(trigger),
        payloadRef: validatePayloadRef(payloadRef),
        wakeClass, origin: Object.freeze({ ...origin }),
        state: "ARMED", firedAt: null, missedAt: null, retiredReason: null,
        occurrenceIndex: 0, armedAtMs: null, createdAt: nowIso
    });
}

function makeExpectation({ expectationId, subject, attribute, expectedValue, window, onSatisfied = "CLOSE", onViolated = "NOTIFY" }) {
    if (typeof expectationId !== "string" || !expectationId) fail(REASONS.INVALID_RECORD, "expectationId wajib string");
    if (!window || typeof window.latestAt !== "string" || !Number.isFinite(Date.parse(window.latestAt))) {
        // PM-5: ekspektasi tanpa latestAt YANG SAH ditolak. Bug diketemukan
        // review independen (Codex, putaran ke-4): string tak-tanggal lolos
        // dulu, lalu Date.parse -> NaN membuat checkExpectations() tidak
        // pernah bisa melewati window (tidak pernah VIOLATED).
        fail(REASONS.NO_LATEST_AT, "window.latestAt wajib tanggal ISO yang sah (PM-5)");
    }
    if (window.earliestAt !== undefined && window.earliestAt !== null &&
        !Number.isFinite(Date.parse(window.earliestAt))) {
        fail(REASONS.NO_LATEST_AT, "window.earliestAt, jika ada, wajib tanggal ISO yang sah");
    }
    return Object.freeze({
        expectationId, subject: Object.freeze({ ...subject }), attribute, expectedValue,
        window: Object.freeze({ ...window }),
        onSatisfied, onViolated, state: "PENDING"
    });
}

function makeWakeEvent({ reminderId, wakeClass, payloadRef, firedAt, occurrenceId, lateness = 0, missed = false }) {
    // PM-1: tidak ada capabilityId/actuatorRef/intent di sini secara struktural.
    return Object.freeze({
        reminderId, wakeClass, payloadRef, firedAt, occurrenceId, lateness, missed
    });
}

module.exports = {
    WAKE_CLASSES, TRIGGER_KINDS, validateTrigger, validatePayloadRef,
    makeReminder, makeExpectation, makeWakeEvent
};
