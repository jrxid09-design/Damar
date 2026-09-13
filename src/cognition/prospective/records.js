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
 * PM-1, rekursif: field eksekusi/otoritas ditolak di kedalaman manapun.
 * Bug diketemukan review independen (Codex, putaran ke-2): pemotongan
 * kedalaman sebelumnya BERHENTI diam-diam alih-alih GAGAL KERAS, sehingga
 * payload bersarang lebih dalam dari batas lolos tanpa diperiksa —
 * kebalikan dari fail-closed. Sekarang melebihi batas kedalaman itu
 * SENDIRI adalah penolakan, bukan alasan untuk berhenti memeriksa.
 */
function assertNoForbiddenPayloadKeys(value, depth = 0) {
    if (!value || typeof value !== "object") return;
    if (depth > MAX_PAYLOAD_SCAN_DEPTH) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef terlalu dalam untuk diverifikasi dengan aman, ditolak");
    }
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `payloadRef tidak boleh membawa '${key}' (di kedalaman manapun)`);
        }
        assertNoForbiddenPayloadKeys(value[key], depth + 1);
    }
}

/** PM-1: payloadRef adalah REFERENSI saja — menolak materi eksekusi/fungsi. */
function validatePayloadRef(payloadRef) {
    if (payloadRef === null || payloadRef === undefined) return null;
    if (typeof payloadRef === "function") {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh berupa fungsi");
    }
    const serialized = JSON.stringify(payloadRef);
    if (serialized === undefined) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak dapat diserialisasi");
    if (Buffer.byteLength(serialized) > BOUNDS.MAX_PAYLOAD_REF_BYTES) {
        fail(REASONS.PAYLOAD_TOO_LARGE, "payloadRef melebihi batas ukuran");
    }
    // PM-1: tidak boleh membawa field bernuansa eksekusi/otoritas, DI
    // KEDALAMAN MANAPUN — bug diketemukan review independen (Codex):
    // pemeriksaan lama hanya level-atas, { nested: { capabilityId } } lolos.
    assertNoForbiddenPayloadKeys(payloadRef);
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
    if (!window || typeof window.latestAt !== "string") {
        // PM-5: ekspektasi tanpa latestAt ditolak.
        fail(REASONS.NO_LATEST_AT, "window.latestAt wajib ada (PM-5)");
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
