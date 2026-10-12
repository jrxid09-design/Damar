"use strict";

const REASONS = Object.freeze({
    INVALID_RECORD: "INVALID_RECORD",
    LOOP_RATE_EXCEEDED: "LOOP_RATE_EXCEEDED",
    COMPLETION_NOT_CANONICAL: "COMPLETION_NOT_CANONICAL",
    DUPLICATE_COMPLETION: "DUPLICATE_COMPLETION",
    COMPLETION_BINDING_MISMATCH: "COMPLETION_BINDING_MISMATCH",
    OBSERVATION_NOT_SENSORIUM: "OBSERVATION_NOT_SENSORIUM",
    UNVERIFIED_EVIDENCE: "UNVERIFIED_EVIDENCE",
    BOUND_EXCEEDED: "BOUND_EXCEEDED"
});

class ClosedLoopError extends Error {
    constructor(reason, message) {
        super(message);
        this.name = "ClosedLoopError";
        this.reason = reason;
    }
}

function fail(reason, message) { throw new ClosedLoopError(reason, message); }

module.exports = { REASONS, ClosedLoopError, fail };
