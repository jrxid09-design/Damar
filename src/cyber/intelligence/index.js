"use strict";

/**
 * DCD INTELLIGENCE PLANE — detection, correlation, hypothesis, triage.
 *
 * Enforces that detections are epistemic observations, never authorization grants.
 *
 * Invariants enforced here:
 *   DC-10: ALERT_NOT_FACT
 *   DC-11: ANOMALY_NOT_ATTACK — HYPOTHESIS_OPEN + corroborating before CONFIRMED
 *   DC-12: THREAT_SCORE_NOT_AUTHORITY — authorityRef always null
 *   DC-13: DETECTION_NOT_PERMISSION_TO_ACT
 *   DC-29: IOC_HIT_NOT_INCIDENT_TRUTH
 *   DC-70: INCIDENT_CONFIRMED_NOT_AUTHORIZED
 *   DC-71: NO_TRANSITION_FROM_CONFIRMED_TO_CONTAINING
 *   DC-72: INCIDENT_REJECTED_IS_RETAINED — closed graph, no delete
 */

const contracts = require("../contracts");
const {
    INCIDENT_STATES, canTransition,
    RISK_LEVELS, scoreFinding,
} = contracts;

/**
 * Create an incident detection engine instance.
 * Returns { createIncident, transition, getIncident, listIncidents, score }.
 *
 * Incidents are append-only (DC-72: never deleted).
 */
function createDetectionEngine() {
    // null-prototype map — no prototype pollution via caller-supplied incidentId keys
    const incidents = Object.create(null);

    /**
     * Create a new incident from a detection observation.
     * Initial state is always HYPOTHESIS_OPEN (DC-11).
     * A maximally-confident alert cannot produce CONFIRMED (DC-70).
     */
    function createIncident(params) {
        const { incidentId, sourceKind, alertRef, riskLevel, summary, evidence, nowMs } = params || {};

        if (typeof incidentId !== "string" || !incidentId) throw new Error("incidentId required");
        if (incidents[incidentId]) throw new Error(`incident '${incidentId}' already exists`);
        if (!RISK_LEVELS.includes(riskLevel)) throw new Error(`unknown riskLevel '${riskLevel}'`);

        const incident = Object.freeze({
            incidentId,
            // DC-10: initial state is HYPOTHESIS_OPEN — an alert is not a fact
            state:      "HYPOTHESIS_OPEN",
            sourceKind: typeof sourceKind === "string" && sourceKind ? sourceKind : "local_agent",
            alertRef:   typeof alertRef === "string" ? alertRef : null,
            riskLevel,
            summary:    typeof summary === "string" ? summary : "",
            // DC-70: INCIDENT_CONFIRMED_NOT_AUTHORIZED — confirmed carries no authority grant
            authorizedAction: null,
            evidence:   Array.isArray(evidence) ? Object.freeze([...evidence]) : Object.freeze([]),
            history:    Object.freeze([
                { state: "HYPOTHESIS_OPEN", at: nowMs || Date.now(), reason: "created" },
            ]),
            createdAt: nowMs || Date.now(),
        });

        incidents[incidentId] = incident;
        return incident;
    }

    /**
     * Transition an incident to a new state.
     * Enforces INCIDENT_TRANSITIONS closure (DC-71, DC-72).
     * Returns { ok, incident, reason }.
     */
    function transition(incidentId, toState, { reason, authorizedBy, nowMs } = {}) {
        const current = incidents[incidentId];
        if (!current) return { ok: false, reason: `incident '${incidentId}' not found`, incident: null };

        if (!INCIDENT_STATES.includes(toState)) {
            return { ok: false, reason: `unknown state '${toState}'`, incident: current };
        }

        const transResult = canTransition(current.state, toState);
        if (!transResult.ok) {
            return {
                ok: false,
                reason: transResult.reason === "UNKNOWN_STATE"
                    ? `unknown incident state '${current.state}'`
                    : `transition ${current.state} → ${toState} not in incident closure`,
                incident: current,
            };
        }

        const newIncident = Object.freeze({
            ...current,
            state: toState,
            // DC-70: CONFIRMED is epistemic only; authorizedAction stays null
            authorizedAction: null,
            history: Object.freeze([
                ...current.history,
                {
                    state: toState,
                    at: nowMs || Date.now(),
                    reason: typeof reason === "string" ? reason : "",
                    authorizedBy: typeof authorizedBy === "string" ? authorizedBy : null,
                },
            ]),
        });

        incidents[incidentId] = newIncident;
        return { ok: true, incident: newIncident, reason: null };
    }

    function getIncident(incidentId) { return incidents[incidentId] || null; }
    function listIncidents() { return Object.values(incidents); }

    /**
     * Score a finding deterministically.
     * DC-12: THREAT_SCORE_NOT_AUTHORITY — authorityRef must be null/absent.
     */
    function score(finding) {
        const result = scoreFinding(finding);
        if (result && result.authorityRef !== undefined && result.authorityRef !== null) {
            throw new Error("scoreFinding must not return authorityRef (DC-12)");
        }
        return result;
    }

    return Object.freeze({ createIncident, transition, getIncident, listIncidents, score });
}

module.exports = Object.freeze({
    createDetectionEngine,
    INCIDENT_STATES,
});
