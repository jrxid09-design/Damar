"use strict";

const { types } = require("node:util");
const { OUTCOME } = require("./laws");
const { createLimitState, checkCommandLimits, recordCommand, validatedRequestSnapshot } = require("./limits");
const { validateEffectorDescriptor } = require("./descriptor");
const isProxy = types.isProxy.bind(types);

// This is a leaf adapter primitive, not a dispatcher or registration surface.
// The execution function is intended only as a binding in the private
// actuator registry in bootstrap.js; W8-IW1 owns concrete registrations.
function createEffectorAdapter({ descriptor, invoke, audit, verify = null, deadman = null, now = () => Date.now() }) {
    if (!descriptor || typeof invoke !== "function" || typeof audit !== "function" || typeof now !== "function" || (verify !== null && typeof verify !== "function")) {
        throw new TypeError("invalid effector adapter configuration");
    }
    const canonicalDescriptor = validateEffectorDescriptor(descriptor);
    const state = createLimitState();
    let consecutiveUnverified = 0;
    let degraded = false;
    function note(eventType, request, outcome = "") {
        try {
            const executionId = request && typeof request === "object"
                ? Object.getOwnPropertyDescriptor(request, "executionId")?.value
                : undefined;
            const atMs = now();
            if (!Number.isFinite(atMs)) return false;
            // The audit port is supplied by trusted IW1 wiring and is
            // synchronous. Its callback result is deliberately ignored; it
            // never grants authority or changes effector state.
            audit(Object.freeze({
                kind: "embodiment.effector",
                eventType,
                effectorId: canonicalDescriptor.effectorId,
                executionId: typeof executionId === "string" ? executionId : "",
                outcome,
                atMs
            }));
            return true;
        } catch {
            return false;
        }
    }
    async function execute(gatedRequest) {
        if (!gatedRequest || typeof gatedRequest !== "object" || isProxy(gatedRequest)) {
            note("limit-refusal", null, "GATED_REQUEST_REQUIRED");
            return Object.freeze({ outcome: OUTCOME.REFUSED, reason: "GATED_REQUEST_REQUIRED" });
        }
        let safeRequest;
        try { safeRequest = validatedRequestSnapshot(gatedRequest, canonicalDescriptor); } catch {
            note("limit-refusal", null, "INVALID_GATED_REQUEST");
            return Object.freeze({ outcome: OUTCOME.REFUSED, reason: "INVALID_GATED_REQUEST" });
        }
        if (degraded) {
            note("limit-refusal", safeRequest, "CAPABILITY_DEGRADED");
            return Object.freeze({ outcome: OUTCOME.REFUSED, reason: "CAPABILITY_DEGRADED" });
        }
        let deadmanReady = true;
        if (canonicalDescriptor.deadmanRequired) {
            try { deadmanReady = Boolean(deadman && deadman.check()); } catch { deadmanReady = false; }
        }
        if (!deadmanReady) {
            note("deadman-stop", safeRequest, "DEADMAN_STOP");
            return Object.freeze({ outcome: OUTCOME.STOPPED, reason: "DEADMAN_STOP" });
        }
        let at;
        try { at = now(); } catch { at = NaN; }
        if (!Number.isFinite(at)) {
            note("limit-refusal", safeRequest, "CLOCK_UNAVAILABLE");
            return Object.freeze({ outcome: OUTCOME.REFUSED, reason: "CLOCK_UNAVAILABLE" });
        }
        const parameters = safeRequest.parameters;
        const check = checkCommandLimits(canonicalDescriptor, parameters, state, at);
        if (!check.allowed) {
            note("limit-refusal", safeRequest, check.reason);
            return Object.freeze({ outcome: OUTCOME.REFUSED, reason: check.reason, parameter: check.parameter });
        }
        state.inFlight = true;
        try {
            if (!note("command-start", safeRequest)) {
                return Object.freeze({ outcome: OUTCOME.REFUSED, reason: "AUDIT_UNAVAILABLE" });
            }
            // A thrown or lost transport result is ambiguous; never retry here.
            let report;
            try {
                recordCommand(canonicalDescriptor, parameters, state, at);
                report = await invoke(safeRequest);
            } catch {
                note("command-result", safeRequest, OUTCOME.UNKNOWN_OUTCOME);
                return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: "TRANSPORT_FAILURE" });
            }
            if (!verify) {
                if (!note("command-result", safeRequest, OUTCOME.EXECUTED)) return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: "AUDIT_UNAVAILABLE" });
                return Object.freeze({ outcome: OUTCOME.EXECUTED, report });
            }
            let verified = false;
            // Never pass the command-channel report into postcondition
            // verification; an observation path must establish the effect.
            try { verified = await verify({ request: safeRequest }); } catch { verified = false; }
            if (!verified) {
                consecutiveUnverified++;
                if (canonicalDescriptor.hazardClass !== "DATA" && consecutiveUnverified >= 2) degraded = true;
                if (!note("command-result", safeRequest, OUTCOME.UNVERIFIED)) return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: "AUDIT_UNAVAILABLE" });
                return Object.freeze({ outcome: OUTCOME.UNVERIFIED, degraded, report });
            }
            consecutiveUnverified = 0;
            if (!note("command-result", safeRequest, OUTCOME.EXECUTED)) return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: "AUDIT_UNAVAILABLE" });
            return Object.freeze({ outcome: OUTCOME.EXECUTED, report, verified: true });
        } finally {
            state.inFlight = false;
        }
    }
    return Object.freeze({ execute, state: Object.freeze({ isDegraded: () => degraded, isInFlight: () => state.inFlight }) });
}

module.exports = Object.freeze({ createEffectorAdapter });
