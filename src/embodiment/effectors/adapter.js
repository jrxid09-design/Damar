"use strict";

const { types } = require("node:util");
const { OUTCOME, HAZARD_CLASS } = require("./laws");
const { createLimitState, checkCommandLimits, recordCommand, validatedRequestSnapshot } = require("./limits");
const { validateEffectorDescriptor } = require("./descriptor");
const isProxy = types.isProxy.bind(types);

function isLedgerAcknowledgment(value, expectedEventType) {
    if (!value || typeof value !== "object" || isProxy(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const eventType = Object.getOwnPropertyDescriptor(value, "eventType");
    const source = Object.getOwnPropertyDescriptor(value, "source");
    const sequence = Object.getOwnPropertyDescriptor(value, "sequence");
    return Boolean(eventType && source && sequence &&
        Object.prototype.hasOwnProperty.call(eventType, "value") &&
        Object.prototype.hasOwnProperty.call(source, "value") &&
        Object.prototype.hasOwnProperty.call(sequence, "value") &&
        eventType.value === expectedEventType &&
        source.value === "embodiment.effector" && Number.isSafeInteger(sequence.value));
}

// The driver's own outcome description, read from the RAW report. Only an own
// DATA property of a non-Proxy object or function is readable; an accessor, an
// inherited description or a Proxy is `unreadable`, and the caller must fail
// closed as UNKNOWN_OUTCOME rather than let an ambiguous physical outcome fall
// through to EXECUTED.
function readReportOutcome(value) {
    try {
        if (value === null || (typeof value !== "object" && typeof value !== "function")) return { value: undefined };
        if (isProxy(value)) return { unreadable: true };
        if (Object.prototype.hasOwnProperty.call(value, "outcome")) {
            const descriptor = Object.getOwnPropertyDescriptor(value, "outcome");
            if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return { unreadable: true };
            return { value: descriptor.value };
        }
        if (Reflect.has(value, "outcome")) return { unreadable: true };
        return { value: undefined };
    } catch {
        // A report that throws while its outcome is being read (hostile
        // prototype trap) is unreadable, never "no outcome".
        return { unreadable: true };
    }
}

// This is a leaf adapter primitive, not a dispatcher or registration surface.
// The execution function is intended only as a binding in the private
// actuator registry in bootstrap.js; W8-IW1 owns concrete registrations.
function createEffectorAdapter({ descriptor, invoke, audit, isCanonicalRequest, verify = null, deadman = null, now = () => Date.now() }) {
    if (!descriptor || typeof invoke !== "function" || typeof audit !== "function" || typeof isCanonicalRequest !== "function" || typeof now !== "function" || (verify !== null && typeof verify !== "function")) {
        throw new TypeError("invalid effector adapter configuration");
    }
    const canonicalDescriptor = validateEffectorDescriptor(descriptor);
    let deadmanCheck = null;
    let deadmanTimeoutMs = null;
    let deadmanStopResult = null;
    if (deadman !== null) {
        if (typeof deadman !== "object" || isProxy(deadman)) throw new TypeError("deadman must be a trusted record");
        const checkDescriptor = Object.getOwnPropertyDescriptor(deadman, "check");
        const timeoutDescriptor = Object.getOwnPropertyDescriptor(deadman, "timeoutMs");
        const stopResultDescriptor = Object.getOwnPropertyDescriptor(deadman, "didStopSucceed");
        if (!checkDescriptor || !Object.prototype.hasOwnProperty.call(checkDescriptor, "value") || typeof checkDescriptor.value !== "function" ||
            !timeoutDescriptor || !Object.prototype.hasOwnProperty.call(timeoutDescriptor, "value") || typeof timeoutDescriptor.value !== "function") {
            throw new TypeError("deadman must provide synchronous check and timeoutMs methods");
        }
        deadmanCheck = checkDescriptor.value;
        deadmanTimeoutMs = timeoutDescriptor.value;
        if (stopResultDescriptor && Object.prototype.hasOwnProperty.call(stopResultDescriptor, "value") && typeof stopResultDescriptor.value === "function") {
            deadmanStopResult = stopResultDescriptor.value;
        }
    }
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
            const eventOutcome = outcome === OUTCOME.EXECUTED ? "ok"
                : outcome === OUTCOME.UNKNOWN_OUTCOME || outcome === OUTCOME.UNVERIFIED ? "partial"
                    : outcome === "" ? "unspecified" : "denied";
            const event = Object.freeze({
                eventType: `embodiment.effector.${eventType.replaceAll("-", ".")}`,
                source: "embodiment.effector",
                timestampMs: Math.floor(atMs),
                operation: "effector.command",
                outcome: eventOutcome,
                subject: Object.freeze({ kind: "device", id: canonicalDescriptor.effectorId }),
                metadata: Object.freeze({ executionId: typeof executionId === "string" ? executionId : "", detail: outcome })
            });
            const acknowledgment = audit(event);
            if (acknowledgment !== true && !isLedgerAcknowledgment(acknowledgment, event.eventType)) return false;
            return true;
        } catch {
            return false;
        }
    }
    function refusal(eventType, request, reason, extra = {}) {
        const acknowledged = note(eventType, request, reason);
        return Object.freeze({ outcome: OUTCOME.REFUSED, reason: acknowledged ? reason : "AUDIT_UNAVAILABLE", ...extra });
    }
    async function execute(gatedRequest, canonicalRequest) {
        let branded = false;
        try { branded = Boolean(canonicalRequest && typeof canonicalRequest === "object" && !isProxy(canonicalRequest) && isCanonicalRequest(canonicalRequest) === true); } catch { branded = false; }
        if (!gatedRequest || typeof gatedRequest !== "object" || isProxy(gatedRequest) || !branded) {
            return refusal("limit-refusal", null, "GATED_REQUEST_REQUIRED");
        }
        let safeRequest;
        try { safeRequest = validatedRequestSnapshot(gatedRequest, canonicalDescriptor); } catch {
            return refusal("limit-refusal", null, "INVALID_GATED_REQUEST");
        }
        const canonicalValues = Object.create(null);
        for (const key of ["executionId", "intentId", "capabilityId", "operation", "principal", "scope", "parameters"]) {
            const d = Object.getOwnPropertyDescriptor(canonicalRequest, key);
            if (!d || !Object.prototype.hasOwnProperty.call(d, "value")) {
                return refusal("limit-refusal", null, "INVALID_CANONICAL_REQUEST");
            }
            canonicalValues[key] = d.value;
        }
        if (canonicalValues.executionId !== safeRequest.executionId || canonicalValues.intentId !== safeRequest.intentId ||
            canonicalValues.capabilityId !== safeRequest.capabilityId || canonicalValues.operation !== safeRequest.operation ||
            canonicalValues.principal !== safeRequest.principal || canonicalValues.parameters !== gatedRequest.parameters ||
            canonicalValues.scope !== gatedRequest.scope) {
            return refusal("limit-refusal", null, "GATED_REQUEST_MISMATCH");
        }
        if (degraded) {
            return refusal("limit-refusal", safeRequest, "CAPABILITY_DEGRADED");
        }
        let deadmanReady = true;
        if (canonicalDescriptor.deadmanRequired) {
            try { deadmanReady = Boolean(deadmanCheck && deadmanCheck()); } catch { deadmanReady = false; }
        }
        if (!deadmanReady) {
            const acknowledged = note("deadman-stop", safeRequest, "DEADMAN_STOP");
            return Object.freeze({ outcome: OUTCOME.STOPPED, reason: acknowledged ? "DEADMAN_STOP" : "AUDIT_UNAVAILABLE" });
        }
        let at;
        try { at = now(); } catch { at = NaN; }
        if (!Number.isFinite(at)) {
            return refusal("limit-refusal", safeRequest, "CLOCK_UNAVAILABLE");
        }
        const parameters = safeRequest.parameters;
        const check = checkCommandLimits(canonicalDescriptor, parameters, state, at);
        if (!check.allowed) {
            return refusal("limit-refusal", safeRequest, check.reason, { parameter: check.parameter });
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
                const invocation = Promise.resolve().then(() => invoke(safeRequest));
                if (canonicalDescriptor.deadmanRequired) {
                    let pollHandle;
                    const stopSignal = new Promise((resolve) => {
                        const interval = Math.max(10, Math.min(50, Math.floor(deadmanTimeoutMs() / 4) || 10));
                        pollHandle = setInterval(() => {
                            let ready = false;
                            try { ready = Boolean(deadmanCheck()); } catch { ready = false; }
                            if (!ready) resolve({ deadmanLost: true });
                        }, interval);
                    });
                    try {
                        const raced = await Promise.race([invocation, stopSignal]);
                        if (raced && raced.deadmanLost === true) {
                            const stopFailed = deadmanStopResult && deadmanStopResult() === false;
                            note("command-result", safeRequest, OUTCOME.UNKNOWN_OUTCOME);
                            return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: stopFailed ? "DEADMAN_STOP_FAILED" : "DEADMAN_STOP" });
                        }
                        report = raced;
                    } finally {
                        clearInterval(pollHandle);
                    }
                } else {
                    report = await invocation;
                }
            } catch {
                note("command-result", safeRequest, OUTCOME.UNKNOWN_OUTCOME);
                return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: "TRANSPORT_FAILURE" });
            }
            const transport = readReportOutcome(report);
            if (transport.unreadable) {
                note("command-result", safeRequest, OUTCOME.UNKNOWN_OUTCOME);
                return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: "TRANSPORT_UNREADABLE" });
            }
            const transportOutcome = transport.value;
            if (transportOutcome === OUTCOME.REFUSED || transportOutcome === OUTCOME.STOPPED ||
                transportOutcome === OUTCOME.UNKNOWN_OUTCOME || transportOutcome === OUTCOME.UNVERIFIED) {
                note("command-result", safeRequest, transportOutcome);
                const reason = transportOutcome === OUTCOME.REFUSED ? "TRANSPORT_REFUSED"
                    : transportOutcome === OUTCOME.STOPPED ? "TRANSPORT_STOPPED"
                        : transportOutcome === OUTCOME.UNVERIFIED ? "TRANSPORT_UNVERIFIED" : "TRANSPORT_UNKNOWN";
                return Object.freeze({ outcome: transportOutcome, reason });
            }
            if (!verify && canonicalDescriptor.hazardClass === HAZARD_CLASS.NONE) {
                if (!note("command-result", safeRequest, OUTCOME.EXECUTED)) return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: "AUDIT_UNAVAILABLE" });
                return Object.freeze({ outcome: OUTCOME.EXECUTED, report });
            }
            let verified = false;
            // Never pass the command-channel report into postcondition
            // verification; an observation path must establish the effect.
            try { verified = await verify({ request: safeRequest }); } catch { verified = false; }
            if (!verified) {
                consecutiveUnverified++;
                if (canonicalDescriptor.hazardClass !== HAZARD_CLASS.NONE && canonicalDescriptor.hazardClass !== HAZARD_CLASS.DATA && consecutiveUnverified >= 2) degraded = true;
                if (!note("command-result", safeRequest, OUTCOME.UNVERIFIED)) return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: "AUDIT_UNAVAILABLE" });
                return Object.freeze({ outcome: OUTCOME.UNVERIFIED, degraded, report });
            }
            consecutiveUnverified = 0;
            if (!note("command-result", safeRequest, OUTCOME.EXECUTED)) return Object.freeze({ outcome: OUTCOME.UNKNOWN_OUTCOME, reason: "AUDIT_UNAVAILABLE" });
            // Deliberately NOT named `verified`: the canonical ExecutionResult's
            // `verified`/`verificationClaim` belong to the separate Lane 3/4
            // verification owner and must never be readable from an effector's
            // own command-channel report (EM-12 / EM-A9).
            return Object.freeze({ outcome: OUTCOME.EXECUTED, report, postconditionVerified: true });
        } finally {
            state.inFlight = false;
        }
    }
    return Object.freeze({ execute, state: Object.freeze({ isDegraded: () => degraded, isInFlight: () => state.inFlight }) });
}

module.exports = Object.freeze({ createEffectorAdapter });
