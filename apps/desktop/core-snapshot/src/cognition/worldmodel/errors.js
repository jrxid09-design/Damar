"use strict";

const REASONS = Object.freeze({
    INVALID_RECORD: "INVALID_RECORD",
    INADMISSIBLE_TIER: "INADMISSIBLE_TIER",
    SIMULATION_NOT_ADMISSIBLE: "SIMULATION_NOT_ADMISSIBLE",
    MISSING_SENSOR_ID: "MISSING_SENSOR_ID",
    DUPLICATE_OBSERVATION: "DUPLICATE_OBSERVATION",
    UNRESOLVABLE_EVIDENCE: "UNRESOLVABLE_EVIDENCE",
    BOUND_EXCEEDED: "BOUND_EXCEEDED",
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
    UNKNOWN_ENTITY: "UNKNOWN_ENTITY",
    INVALID_QUERY: "INVALID_QUERY",
    SILENT_RESOLUTION_REJECTED: "SILENT_RESOLUTION_REJECTED",
    EXECUTABLE_MATERIAL_REJECTED: "EXECUTABLE_MATERIAL_REJECTED",
    DUPLICATE_RECORD_ID: "DUPLICATE_RECORD_ID"
});

class WorldModelError extends Error {
    constructor(reason, message, details = null) {
        super(message);
        this.name = "WorldModelError";
        this.reason = reason;
        this.details = details;
    }
}

function fail(reason, message, details) {
    throw new WorldModelError(reason, message, details);
}

module.exports = { REASONS, WorldModelError, fail };
