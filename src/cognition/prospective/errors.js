"use strict";

const REASONS = Object.freeze({
    INVALID_RECORD: "INVALID_RECORD",
    INVALID_TRIGGER: "INVALID_TRIGGER",
    RECURRENCE_PERIOD_TOO_SHORT: "RECURRENCE_PERIOD_TOO_SHORT",
    RECURRENCE_UNBOUNDED: "RECURRENCE_UNBOUNDED",
    PROSPECTIVE_FULL: "PROSPECTIVE_FULL",
    PER_GOAL_LIMIT_EXCEEDED: "PER_GOAL_LIMIT_EXCEEDED",
    PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
    NO_LATEST_AT: "NO_LATEST_AT",
    UNKNOWN_REMINDER: "UNKNOWN_REMINDER",
    UNKNOWN_EXPECTATION: "UNKNOWN_EXPECTATION",
    EXECUTABLE_MATERIAL_REJECTED: "EXECUTABLE_MATERIAL_REJECTED",
    DUPLICATE_RECORD_ID: "DUPLICATE_RECORD_ID"
});

class ProspectiveError extends Error {
    constructor(reason, message, details = null) {
        super(message);
        this.name = "ProspectiveError";
        this.reason = reason;
        this.details = details;
    }
}

function fail(reason, message, details) {
    throw new ProspectiveError(reason, message, details);
}

module.exports = { REASONS, ProspectiveError, fail };
