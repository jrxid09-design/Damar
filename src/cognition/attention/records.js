"use strict";

/** W7-L5 ATTENTION — pembangun record murni (spec §3). */

const { REASONS, fail } = require("./errors");
const { clamp01 } = require("../core/envelope");

const SOURCE_KINDS = new Set(["OWNER", "SENSOR", "GOAL", "REMINDER", "MISSION", "AGENT", "SELF", "SYSTEM"]);
const WORK_KINDS = new Set(["PERCEIVE", "REASON", "PLAN", "VERIFY", "EXPLAIN", "MAINTAIN"]);

/**
 * Bug review independen (audit putaran-9, AUD9-P2-1): `Object.freeze({...
 * subjectRef})` cuma satu level -- objek bersarang di dalam subjectRef
 * tetap referensi milik pemanggil, mutasi pasca-panggilan menulis ulang
 * signal/target tersimpan lewat jalur yang lebih dalam.
 */
function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

function makeSignal({ signalId, sourceKind, sourceId, subjectRef, proposedUrgency = 0, evidenceRef = null, createdAtMs, expiresAtMs = null }) {
    if (typeof signalId !== "string" || !signalId) fail(REASONS.INVALID_RECORD, "signalId wajib string");
    if (!SOURCE_KINDS.has(sourceKind)) fail(REASONS.INVALID_RECORD, `sourceKind '${sourceKind}' tidak dikenal`);
    if (typeof sourceId !== "string" || !sourceId) fail(REASONS.INVALID_RECORD, "sourceId wajib string");

    return Object.freeze({
        signalId, sourceKind, sourceId,
        subjectRef: deepFreeze({ ...subjectRef }),
        proposedUrgency: clamp01(Number(proposedUrgency)), // AT-1: saran saja, bukan class final
        // Bug review independen (audit putaran-24, AUD24-P2-3): evidenceRef
        // OBJEK dulu disimpan APA ADANYA, tidak seperti subjectRef --
        // pemanggil bisa memutasinya pasca-panggilan (menulis ulang bukti
        // korroborasi tersimpan). Primitif (string/number) sudah immutable
        // dengan sendirinya, tidak perlu (dan tidak boleh, `{...'x'}`
        // merusak bentuknya) disalin ke objek.
        evidenceRef: (evidenceRef !== null && typeof evidenceRef === "object")
            ? deepFreeze({ ...evidenceRef }) : evidenceRef,
        createdAtMs, expiresAtMs
    });
}

function makeTarget({ targetId, subjectRef, workKind, priorityClass, admittedAtMs }) {
    if (typeof targetId !== "string" || !targetId) fail(REASONS.INVALID_RECORD, "targetId wajib string");
    if (!WORK_KINDS.has(workKind)) fail(REASONS.INVALID_RECORD, `workKind '${workKind}' tidak dikenal`);

    return Object.freeze({
        targetId, subjectRef: deepFreeze({ ...subjectRef }), workKind, priorityClass,
        effectivePriority: 0, admittedAt: admittedAtMs, startedAt: null, completedAt: null,
        state: "QUEUED", preemptions: 0,
        supportingSignalIds: Object.freeze([]), lastComputedAtMs: admittedAtMs
    });
}

module.exports = { SOURCE_KINDS, WORK_KINDS, makeSignal, makeTarget };
