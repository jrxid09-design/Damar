"use strict";

const REASONS = Object.freeze({
    INVALID_RECORD: "INVALID_RECORD",
    SIGNAL_RATE_EXCEEDED: "SIGNAL_RATE_EXCEEDED",
    QUEUE_FULL: "QUEUE_FULL",
    P0_ORIGIN_NOT_ALLOWLISTED: "P0_ORIGIN_NOT_ALLOWLISTED",
    UNKNOWN_TARGET: "UNKNOWN_TARGET",
    PREEMPTION_LIMIT_EXCEEDED: "PREEMPTION_LIMIT_EXCEEDED",
    EXECUTABLE_MATERIAL_REJECTED: "EXECUTABLE_MATERIAL_REJECTED"
});

class AttentionError extends Error {
    constructor(reason, message, details = null) {
        super(message);
        this.name = "AttentionError";
        this.reason = reason;
        this.details = details;
    }
}

function fail(reason, message, details) {
    throw new AttentionError(reason, message, details);
}

module.exports = { REASONS, AttentionError, fail };
