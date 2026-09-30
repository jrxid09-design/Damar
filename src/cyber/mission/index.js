"use strict";

/**
 * DCD MISSION PLANE — SecurityOperationEnvelope and scope management.
 *
 * A cyber mission is an envelope sub-record authorizing a bounded scope.
 * It does NOT own a second mission state machine (DCD-Q-02 / DC-82).
 *
 * Invariants enforced here:
 *   DC-25: PENTEST_MODE_NOT_UNLIMITED_AUTHORITY
 *   DC-54: NO_AUTHORITY_RECHECK_WHEN_ENVELOPE_VALID
 *   DC-57: BOUNDARY_PERMISSION_NOT_BOUNDARY_EVERY_STEP
 *   DC-81: CYBER_MISSION_INHERITS_NO_AUTHORITY
 *   DC-82: NO_SECOND_MISSION_STATE_MACHINE
 *   DC-106: THE_ENVELOPE_IS_IMMUTABLE_IN_DEPTH — deep-frozen on creation
 */

const contracts = require("../contracts");
const {
    makeMissionEnvelope, localEnvelopeDecision,
    envelopeShapeErrors, consumeBudget, OPERATION_MODES,
} = contracts;

/**
 * Create a mission from params.
 * Wraps makeMissionEnvelope; validates shape before storing.
 * Returns { ok, mission, errors }.
 */
function createMission(params) {
    const { missionId, operationMode, envelopeParams, nowMs } = params || {};

    if (typeof missionId !== "string" || !missionId) {
        return { ok: false, mission: null, errors: ["missionId required"] };
    }

    let envelope;
    try {
        // Bind mission_id to missionId so envelope and record are always consistent.
        envelope = makeMissionEnvelope({ ...(envelopeParams || {}), mission_id: missionId });
    } catch (err) {
        return { ok: false, mission: null, errors: [err.message || "envelope construction failed"] };
    }

    const shapeErrors = envelopeShapeErrors(envelope);
    if (shapeErrors.length) {
        return { ok: false, mission: null, errors: shapeErrors };
    }

    const resolvedMode = typeof operationMode === "string" && OPERATION_MODES.includes(operationMode)
        ? operationMode
        : "DCD_DEFENSE";
    const mission = Object.freeze({
        missionId,
        operationMode: resolvedMode,
        envelope,   // already deep-frozen by makeMissionEnvelope
        budgetLedger: Object.freeze({ hosts: 0, accounts: 0, processes: 0, elapsedMs: 0 }),
        createdAt: nowMs != null ? nowMs : Date.now(),
        closed: false,
    });

    return { ok: true, mission, errors: [] };
}

/**
 * Evaluate a single attempt against the mission envelope.
 * DC-54: no authority re-check when envelope is valid.
 * DC-81: CYBER_MISSION_INHERITS_NO_AUTHORITY — the envelope never mints T3.
 */
function evalDecision(mission, attempt, ledger, nowMs) {
    if (!mission || !mission.envelope) {
        return { decision: "DENY", reason: "no mission envelope", detail: {} };
    }
    if (mission.closed) {
        return { decision: "DENY", reason: "mission is closed", detail: {} };
    }
    const resolvedNow = nowMs != null ? nowMs : Date.now();
    // Normalize attempt.at to authoritative nowMs — prevents caller from backdating
    // attempt.at to bypass mission expiry (localEnvelopeDecision uses attempt.at for time).
    const sanitizedAttempt = { ...(attempt || {}), at: resolvedNow };
    return localEnvelopeDecision(mission.envelope, sanitizedAttempt, ledger, resolvedNow);
}

/**
 * Consume budget from the mission ledger.
 * Returns { ok, nextBudgetState, reason }.
 */
function debitBudget(mission, usage) {
    // consumeBudget(envelope, usage, state) — first arg must be the envelope, not the ledger
    const result = consumeBudget(mission.envelope, usage, mission.budgetLedger);
    if (!result.ok) return { ok: false, nextBudgetState: mission.budgetLedger, reason: result.reason };
    // consumeBudget returns next state as result.state (not result.nextBudgetState)
    return { ok: true, nextBudgetState: result.state, reason: null };
}

/**
 * Close a mission (produces a new frozen record with closed: true).
 * The lab MissionEngine owns the outer state machine (DC-82).
 */
function closeMission(mission) {
    return Object.freeze({ ...mission, closed: true });
}

module.exports = Object.freeze({
    createMission,
    evalDecision,
    debitBudget,
    closeMission,
});
