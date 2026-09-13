"use strict";

/** W7-L5 ATTENTION — pembangun record murni (spec §3). */

const { REASONS, fail } = require("./errors");
const { clamp01 } = require("../core/envelope");

const SOURCE_KINDS = new Set(["OWNER", "SENSOR", "GOAL", "REMINDER", "MISSION", "AGENT", "SELF", "SYSTEM"]);
const WORK_KINDS = new Set(["PERCEIVE", "REASON", "PLAN", "VERIFY", "EXPLAIN", "MAINTAIN"]);

function makeSignal({ signalId, sourceKind, sourceId, subjectRef, proposedUrgency = 0, evidenceRef = null, createdAtMs, expiresAtMs = null }) {
    if (typeof signalId !== "string" || !signalId) fail(REASONS.INVALID_RECORD, "signalId wajib string");
    if (!SOURCE_KINDS.has(sourceKind)) fail(REASONS.INVALID_RECORD, `sourceKind '${sourceKind}' tidak dikenal`);
    if (typeof sourceId !== "string" || !sourceId) fail(REASONS.INVALID_RECORD, "sourceId wajib string");

    return Object.freeze({
        signalId, sourceKind, sourceId,
        subjectRef: Object.freeze({ ...subjectRef }),
        proposedUrgency: clamp01(Number(proposedUrgency)), // AT-1: saran saja, bukan class final
        evidenceRef, createdAtMs, expiresAtMs
    });
}

function makeTarget({ targetId, subjectRef, workKind, priorityClass, admittedAtMs }) {
    if (typeof targetId !== "string" || !targetId) fail(REASONS.INVALID_RECORD, "targetId wajib string");
    if (!WORK_KINDS.has(workKind)) fail(REASONS.INVALID_RECORD, `workKind '${workKind}' tidak dikenal`);

    return Object.freeze({
        targetId, subjectRef: Object.freeze({ ...subjectRef }), workKind, priorityClass,
        effectivePriority: 0, admittedAt: admittedAtMs, startedAt: null, completedAt: null,
        state: "QUEUED", preemptions: 0,
        supportingSignalIds: Object.freeze([]), lastComputedAtMs: admittedAtMs
    });
}

module.exports = { SOURCE_KINDS, WORK_KINDS, makeSignal, makeTarget };
