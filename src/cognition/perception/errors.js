"use strict";

const REASONS = Object.freeze({
    INVALID_RECORD: "INVALID_RECORD",
    UNKNOWN_QUESTION: "UNKNOWN_QUESTION",
    UNKNOWN_CAPABILITY: "UNKNOWN_CAPABILITY",
    BOUND_EXCEEDED: "BOUND_EXCEEDED",
    BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
    PROBE_UNAVAILABLE: "PROBE_UNAVAILABLE",
    PROBE_EXPIRED: "PROBE_EXPIRED",
    AUDIT_UNAVAILABLE: "AUDIT_UNAVAILABLE",
    QUESTION_BLOCKED: "QUESTION_BLOCKED"
});

class PerceptionError extends Error {
    constructor(reason, message) {
        super(message);
        this.name = "PerceptionError";
        this.reason = reason;
    }
}

function fail(reason, message) { throw new PerceptionError(reason, message); }

module.exports = { REASONS, PerceptionError, fail };
