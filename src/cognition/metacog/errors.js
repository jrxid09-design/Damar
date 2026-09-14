"use strict";

const REASONS = Object.freeze({
    INVALID_RECORD: "INVALID_RECORD",
    OPEN_REVIEW_LIMIT_EXCEEDED: "OPEN_REVIEW_LIMIT_EXCEEDED",
    REVIEW_DEPTH_EXCEEDED: "REVIEW_DEPTH_EXCEEDED",
    BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
    UNKNOWN_REVIEW: "UNKNOWN_REVIEW",
    INVALID_OUTCOME: "INVALID_OUTCOME",
    NO_AUTHORITY_CALL_ALLOWED: "NO_AUTHORITY_CALL_ALLOWED",
    DUPLICATE_RECORD_ID: "DUPLICATE_RECORD_ID",
    EXECUTABLE_MATERIAL_REJECTED: "EXECUTABLE_MATERIAL_REJECTED"
});

class MetacogError extends Error {
    constructor(reason, message, details = null) {
        super(message);
        this.name = "MetacogError";
        this.reason = reason;
        this.details = details;
    }
}

function fail(reason, message, details) {
    throw new MetacogError(reason, message, details);
}

module.exports = { REASONS, MetacogError, fail };
