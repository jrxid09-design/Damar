"use strict";

const REASONS = Object.freeze({
    INVALID_RECORD: "INVALID_RECORD",
    BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
    CONCURRENT_RUN_LIMIT_EXCEEDED: "CONCURRENT_RUN_LIMIT_EXCEEDED",
    RESULT_TOO_LARGE: "RESULT_TOO_LARGE",
    CROSS_STORE_WRITE_REJECTED: "CROSS_STORE_WRITE_REJECTED",
    DUPLICATE_RECORD_ID: "DUPLICATE_RECORD_ID",
    UNKNOWN_RUN: "UNKNOWN_RUN",
    EXECUTABLE_MATERIAL_REJECTED: "EXECUTABLE_MATERIAL_REJECTED"
});

class SimulationError extends Error {
    constructor(reason, message, details = null) {
        super(message);
        this.name = "SimulationError";
        this.reason = reason;
        this.details = details;
    }
}

function fail(reason, message, details) {
    throw new SimulationError(reason, message, details);
}

module.exports = { REASONS, SimulationError, fail };
