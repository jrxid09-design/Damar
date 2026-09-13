"use strict";

const REASONS = Object.freeze({
    INVALID_PORT: "INVALID_PORT",
    NO_DESCRIPTOR: "NO_DESCRIPTOR",
    INVALID_OUTCOME: "INVALID_OUTCOME",
    STALE_GENERATION: "STALE_GENERATION",
    INVALID_OBSERVATION: "INVALID_OBSERVATION",
    UNKNOWN_CAPABILITY: "UNKNOWN_CAPABILITY"
});

class SelfModelError extends Error {
    constructor(reason, message, details = null) {
        super(message);
        this.name = "SelfModelError";
        this.reason = reason;
        this.details = details;
    }
}

function fail(reason, message, details) {
    throw new SelfModelError(reason, message, details);
}

module.exports = { REASONS, SelfModelError, fail };
